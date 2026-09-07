/**
 * SSL/TLS mode definitions for database connections.
 * Applies to PostgreSQL, MySQL, and MariaDB.
 */
export type SSLMode =
  | "disable"   // No SSL
  | "prefer"    // Try SSL, fall back to non-SSL
  | "require"   // Require SSL, fail if not available
  | "verify_ca" // Require SSL, verify server certificate against CA
  | "verify_full"; // Require SSL, verify server certificate + hostname match

export const SSL_MODE_LABELS: Record<SSLMode, { short: string; long: string; description: string }> = {
  disable: {
    short: "Disable",
    long: "Disable SSL",
    description: "No SSL encryption. Not recommended for production.",
  },
  prefer: {
    short: "Prefer",
    long: "Prefer SSL",
    description: "Attempt SSL, fall back to unencrypted if server does not support it.",
  },
  require: {
    short: "Require",
    long: "Require SSL",
    description: "Require SSL encryption. Connection fails if SSL is unavailable.",
  },
  verify_ca: {
    short: "Verify CA",
    long: "Verify CA Certificate",
    description: "Require SSL and verify the server certificate against the configured CA.",
  },
  verify_full: {
    short: "Verify Full",
    long: "Verify Full",
    description: "Require SSL, verify CA certificate, and match server hostname.",
  },
};

/** Whether a given SSL mode requires certificate configuration fields. */
export function sslModeRequiresCertificates(mode: SSLMode): boolean {
  return mode === "verify_ca" || mode === "verify_full";
}

/** Convert frontend SSLMode to Rust PgSslMode string. */
export function toRustPgSslMode(mode: SSLMode): string {
  switch (mode) {
    case "disable": return "disable";
    case "prefer": return "prefer";
    case "require": return "require";
    case "verify_ca": return "verify_ca";
    case "verify_full": return "verify_full";
  }
}

/** Convert frontend SSLMode to Rust MySqlSslMode string. */
export function toRustMysqlSslMode(mode: SSLMode): string {
  switch (mode) {
    case "disable": return "disabled";
    case "prefer": return "preferred";
    case "require": return "required";
    case "verify_ca": return "verify_ca";
    case "verify_full": return "verify_identity";
  }
}

export interface SSLConfig {
  mode: SSLMode;
  caCertPath?: string;
  clientCertPath?: string;
  clientKeyPath?: string;
  skipHostVerification?: boolean;
}

/** Default SSL config. */
export const DEFAULT_SSL_CONFIG: SSLConfig = {
  mode: "prefer",
  caCertPath: undefined,
  clientCertPath: undefined,
  clientKeyPath: undefined,
  skipHostVerification: false,
};
