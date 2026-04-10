/**
 * SSH Tunnel configuration types.
 * Used for connecting to databases through SSH bastion/jump hosts.
 *
 * @todo These types define the intended API surface but have NO Rust backend
 * implementation yet. No `.rs` file in src-tauri contains SSH tunnel logic.
 * To implement SSH tunnels, add an `ssh2` or `async-ssh2-tokio` crate to
 * Cargo.toml and create `src-tauri/src/commands/ssh.rs` with tunnel
 * lifecycle commands (create, connect, disconnect, reconnect).
 * See Phase 45 in the development roadmap for full requirements.
 */

export type SshAuthMethod = "password" | "privateKey" | "privateKeyPassphrase";

export interface SshConfig {
  /** Enable SSH tunnel for this connection */
  enabled: boolean;
  /** Bastion/jump host address */
  host: string;
  /** SSH port (default 22) */
  port: number;
  /** SSH username */
  username: string;
  /** Authentication method */
  authMethod: SshAuthMethod;
  /** Password (used when authMethod = password) */
  password?: string;
  /** Private key content (used when authMethod = privateKey or privateKeyPassphrase) */
  privateKey?: string;
  /** Path to private key file (alternative to inline privateKey) */
  privateKeyPath?: string;
  /** Passphrase for encrypted private key (used when authMethod = privateKeyPassphrase) */
  passphrase?: string;
  /** ProxyJump hosts (comma-separated, e.g. "jump1:22,jump2:22") */
  proxyJump?: string;
  /** Auto-select local port (0 = let OS choose) */
  localPort: number;
  /** Remote database host (the host we're forwarding to) */
  remoteHost: string;
  /** Remote database port (the port we're forwarding to) */
  remotePort: number;
  /** Known hosts file path (for host key verification) */
  knownHostsPath?: string;
  /** Connection timeout in seconds */
  timeoutSeconds: number;
}

export interface SshTunnelStatus {
  /** Whether a tunnel is currently active */
  isConnected: boolean;
  /** Local port the tunnel is bound to */
  localPort?: number;
  /** Error message if connection failed */
  error?: string;
  /** Connection start time */
  connectedAt?: number;
}

export interface SshTunnelHandle {
  /** Unique tunnel ID */
  id: string;
  /** Local port the tunnel is listening on */
  localPort: number;
  /** Connection ID this tunnel is associated with */
  connectionId: string;
}

/** Default SSH config with safe defaults */
export const DEFAULT_SSH_CONFIG: Omit<SshConfig, "host" | "username" | "remoteHost"> = {
  enabled: false,
  port: 22,
  authMethod: "password",
  localPort: 0,
  remotePort: 3306,
  timeoutSeconds: 30,
};
