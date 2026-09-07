use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use ssh2::Session;
use std::collections::HashMap;
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
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

/// Upper bound for concurrently forwarded tunnel streams. Each active stream
/// keeps three OS threads alive (accept handler + two copy workers), so an
/// unbounded number of connections would exhaust threads under load.
const MAX_TUNNEL_STREAMS: usize = 256;

pub struct SshTunnelManager {
    tunnels: Mutex<HashMap<TunnelHandle, Arc<SshSessionContext>>>,
    next_id: Mutex<usize>,
    in_flight_streams: Arc<AtomicUsize>,
}

pub struct SshSessionContext {
    pub session: Arc<Session>,
    active: AtomicBool,
}

/// Releases the tunnel-stream slot when the handler thread exits — including
/// the early-return error paths — so the cap can never leak capacity.
struct StreamSlotGuard(Arc<AtomicUsize>);

impl Drop for StreamSlotGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Relaxed);
    }
}

impl SshTunnelManager {
    pub fn new() -> Self {
        Self {
            tunnels: Mutex::new(HashMap::new()),
            next_id: Mutex::new(0),
            in_flight_streams: Arc::new(AtomicUsize::new(0)),
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
                if let Some(path) = config.private_key_path {
                    let path = std::path::Path::new(&path);
                    let pass = config.passphrase.as_deref();
                    sess.userauth_pubkey_file(&config.user, None, path, pass)?;
                } else {
                    return Err(anyhow!(
                        "PrivateKey auth without a file path is not fully supported yet"
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
        let mut guard = self.next_id.lock().unwrap_or_else(PoisonError::into_inner);
        let handle = TunnelHandle(*guard);
        *guard += 1;

        self.tunnels
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(handle, ctx);

        Ok(handle)
    }

    pub fn disconnect_tunnel(&self, handle: TunnelHandle) -> Result<()> {
        let mut map = self.tunnels.lock().unwrap_or_else(PoisonError::into_inner);
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
            let map = self.tunnels.lock().unwrap_or_else(PoisonError::into_inner);
            map.get(&handle)
                .cloned()
                .ok_or_else(|| anyhow!("Tunnel handle not found"))?
        };
        let in_flight = Arc::clone(&self.in_flight_streams);

        let listener = TcpListener::bind(format!("127.0.0.1:{}", local_port.unwrap_or(0)))?;
        listener.set_nonblocking(true)?;
        let actual_port = listener.local_addr()?.port();

        thread::spawn(move || {
            while ctx.active.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((local_stream, _)) => {
                        if in_flight.load(Ordering::Relaxed) >= MAX_TUNNEL_STREAMS {
                            log::warn!(
                                "SSH tunnel dropped a new connection: {MAX_TUNNEL_STREAMS} streams already active"
                            );
                            continue;
                        }
                        in_flight.fetch_add(1, Ordering::Relaxed);
                        let sess = ctx.session.clone();
                        let remote_h = remote_host.clone();
                        let remote_p = remote_port;
                        let slot = Arc::clone(&in_flight);

                        thread::spawn(move || {
                            let _slot = StreamSlotGuard(slot);
                            if let Ok(channel) =
                                sess.channel_direct_tcpip(&remote_h, remote_p, None)
                            {
                                let mut local_read = match local_stream.try_clone() {
                                    Ok(stream) => stream,
                                    Err(error) => {
                                        log::error!(
                                            "SSH tunnel could not clone the local stream: {error}"
                                        );
                                        return;
                                    }
                                };
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
