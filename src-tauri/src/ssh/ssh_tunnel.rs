use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use ssh2::Session;
use std::collections::HashMap;
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SshAuthMethod {
    Password,
    PrivateKey,
    PrivateKeyWithPassphrase,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfig {
    pub enabled: bool,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth_type: SshAuthMethod,
    pub password: Option<String>,
    pub private_key: Option<String>,
    pub private_key_path: Option<String>,
    pub passphrase: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct TunnelHandle(usize);

pub struct SshTunnelManager {
    tunnels: Mutex<HashMap<TunnelHandle, Arc<SshSessionContext>>>,
    next_id: Mutex<usize>,
}

pub struct SshSessionContext {
    pub session: Arc<Session>,
    active: AtomicBool,
}

/// Authenticate an SSH session from an inline (pasted) private key.
///
/// libssh2's in-memory public-key auth is only compiled when OpenSSL is
/// available (always on Unix; on Windows it needs the `vendored-openssl` /
/// `openssl-on-win32` feature). Where it is present we use it directly so the
/// key never touches disk.
#[cfg(any(unix, feature = "vendored-openssl", feature = "openssl-on-win32"))]
fn authenticate_with_inline_key(
    sess: &Session,
    user: &str,
    key: &str,
    passphrase: Option<&str>,
) -> Result<()> {
    sess.userauth_pubkey_memory(user, None, key, passphrase)?;
    Ok(())
}

/// Windows default build has no in-memory pubkey auth (it requires OpenSSL), so
/// fall back to a short-lived temp key file that is removed on every exit path.
#[cfg(not(any(unix, feature = "vendored-openssl", feature = "openssl-on-win32")))]
fn authenticate_with_inline_key(
    sess: &Session,
    user: &str,
    key: &str,
    passphrase: Option<&str>,
) -> Result<()> {
    use std::io::Write;

    struct TempKey(std::path::PathBuf);
    impl Drop for TempKey {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    let mut path = std::env::temp_dir();
    path.push(format!("tabler-ssh-{}.key", uuid::Uuid::new_v4()));
    let guard = TempKey(path.clone());
    {
        let mut file = std::fs::File::create(&path)?;
        file.write_all(key.as_bytes())?;
        file.flush()?;
    }
    let result = sess.userauth_pubkey_file(user, None, &guard.0, passphrase);
    // `guard` drops here and deletes the temp key regardless of the outcome.
    result?;
    Ok(())
}

impl SshTunnelManager {
    pub fn new() -> Self {
        Self {
            tunnels: Mutex::new(HashMap::new()),
            next_id: Mutex::new(0),
        }
    }

    pub fn connect_tunnel(&self, config: SshConfig) -> Result<TunnelHandle> {
        let tcp = TcpStream::connect(format!("{}:{}", config.host, config.port))?;
        let mut sess = Session::new()?;
        sess.set_tcp_stream(tcp);
        sess.handshake()?;

        match config.auth_type {
            SshAuthMethod::Password => {
                let p = config.password.unwrap_or_default();
                sess.userauth_password(&config.user, &p)?;
            }
            SshAuthMethod::PrivateKey | SshAuthMethod::PrivateKeyWithPassphrase => {
                let pass = config.passphrase.as_deref();
                let inline_key = config
                    .private_key
                    .as_deref()
                    .map(str::trim)
                    .filter(|key| !key.is_empty());
                let key_path = config
                    .private_key_path
                    .as_deref()
                    .map(str::trim)
                    .filter(|path| !path.is_empty());
                // tech-debt audit D4: an inline key (pasted in the UI and kept in
                // the OS keyring) used to be stored but silently ignored here —
                // only a file path worked. Authenticate from the key contents when
                // present, and fall back to the file path otherwise.
                if let Some(key) = inline_key {
                    authenticate_with_inline_key(&sess, &config.user, key, pass)?;
                } else if let Some(path) = key_path {
                    sess.userauth_pubkey_file(
                        &config.user,
                        None,
                        std::path::Path::new(path),
                        pass,
                    )?;
                } else {
                    return Err(anyhow!(
                        "SSH private-key auth requires either an inline private key or a key file path."
                    ));
                }
            }
        }

        if !sess.authenticated() {
            return Err(anyhow!("SSH authentication failed"));
        }

        let ctx = Arc::new(SshSessionContext {
            session: Arc::new(sess),
            active: AtomicBool::new(true),
        });
        let mut guard = self.next_id.lock().unwrap();
        let handle = TunnelHandle(*guard);
        *guard += 1;

        self.tunnels.lock().unwrap().insert(handle, ctx);

        Ok(handle)
    }

    pub fn disconnect_tunnel(&self, handle: TunnelHandle) -> Result<()> {
        let mut map = self.tunnels.lock().unwrap();
        if let Some(context) = map.remove(&handle) {
            context.active.store(false, Ordering::Release);
            Ok(())
        } else {
            Err(anyhow!("Tunnel handle not found: {:?}", handle))
        }
    }

    pub fn forward_port(
        &self,
        handle: TunnelHandle,
        local_port: Option<u16>,
        remote_host: String,
        remote_port: u16,
    ) -> Result<u16> {
        let ctx = {
            let map = self.tunnels.lock().unwrap();
            map.get(&handle)
                .cloned()
                .ok_or_else(|| anyhow!("Tunnel handle not found"))?
        };

        let listener = TcpListener::bind(format!("127.0.0.1:{}", local_port.unwrap_or(0)))?;
        listener.set_nonblocking(true)?;
        let actual_port = listener.local_addr()?.port();

        thread::spawn(move || {
            while ctx.active.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((local_stream, _)) => {
                        let sess = ctx.session.clone();
                        let remote_h = remote_host.clone();
                        let remote_p = remote_port;

                        thread::spawn(move || {
                            if let Ok(channel) =
                                sess.channel_direct_tcpip(&remote_h, remote_p, None)
                            {
                                let mut local_read =
                                    local_stream.try_clone().expect("clone tcp stream");
                                let mut channel_read = channel.stream(0);

                                let mut channel_write = channel;
                                let mut local_write = local_stream;

                                let handle1 = thread::spawn(move || {
                                    let _ = std::io::copy(&mut local_read, &mut channel_write);
                                });
                                let handle2 = thread::spawn(move || {
                                    let _ = std::io::copy(&mut channel_read, &mut local_write);
                                });

                                let _ = handle1.join();
                                let _ = handle2.join();
                            }
                        });
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(25));
                    }
                    Err(error) => {
                        log::error!("Local listener error: {}", error);
                        break;
                    }
                }
            }
        });

        Ok(actual_port)
    }
}

impl Default for SshTunnelManager {
    fn default() -> Self {
        Self::new()
    }
}
