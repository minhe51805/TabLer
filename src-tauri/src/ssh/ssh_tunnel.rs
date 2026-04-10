use anyhow::{anyhow, Result};
use std::collections::HashMap;
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;
use ssh2::Session;
use serde::{Deserialize, Serialize};

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
                if let Some(path) = config.private_key_path {
                    let path = std::path::Path::new(&path);
                    let pass = config.passphrase.as_deref();
                    sess.userauth_pubkey_file(&config.user, None, path, pass)?;
                } else {
                    return Err(anyhow!("PrivateKey auth without a file path is not fully supported yet"));
                }
            }
        }

        if !sess.authenticated() {
            return Err(anyhow!("SSH authentication failed"));
        }

        let ctx = Arc::new(SshSessionContext { session: Arc::new(sess) });
        let mut guard = self.next_id.lock().unwrap();
        let handle = TunnelHandle(*guard);
        *guard += 1;

        self.tunnels.lock().unwrap().insert(handle, ctx);

        Ok(handle)
    }

    pub fn disconnect_tunnel(&self, handle: TunnelHandle) -> Result<()> {
        let mut map = self.tunnels.lock().unwrap();
        if map.remove(&handle).is_some() {
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
            map.get(&handle).cloned().ok_or_else(|| anyhow!("Tunnel handle not found"))?
        };

        let listener = TcpListener::bind(format!("127.0.0.1:{}", local_port.unwrap_or(0)))?;
        let actual_port = listener.local_addr()?.port();
        
        thread::spawn(move || {
            for stream_res in listener.incoming() {
                match stream_res {
                    Ok(local_stream) => {
                        let sess = ctx.session.clone();
                        let remote_h = remote_host.clone();
                        let remote_p = remote_port;
                        
                        thread::spawn(move || {
                            if let Ok(channel) = sess.channel_direct_tcpip(&remote_h, remote_p, None) {
                                let mut local_read = local_stream.try_clone().expect("clone tcp stream");
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
                    Err(e) => {
                        log::error!("Local listener error: {}", e);
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
