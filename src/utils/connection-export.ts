/**
 * Connection export/import utilities.
 * Uses AES-256-GCM encryption via Rust backend.
 */
import { invoke } from "@tauri-apps/api/core";
import type { ConnectionConfig } from "../types/database";

export interface ExportableConnection {
  name: string;
  dbType: string;
  host?: string;
  port?: number;
  username?: string;
  database?: string;
  filePath?: string;
  useSsl: boolean;
  sslMode?: string;
  sslCaCertPath?: string;
  sslClientCertPath?: string;
  sslClientKeyPath?: string;
  sslSkipHostVerification?: boolean;
  color?: string;
  additionalFields?: Record<string, string>;
  groupId?: string;
  tagId?: string;
  startupCommands?: string;
  queryTimeoutSeconds?: number;
}

/** One entry the external importer could not map (unsupported engine, malformed row). */
export interface SkippedConnection {
  name: string;
  reason: string;
}

/** Preview payload returned by `import_external_connections`. */
export interface ExternalImportResult {
  connections: ExportableConnection[];
  skipped: SkippedConnection[];
}

export interface ExportResult {
  success: boolean;
  filePath?: string;
  error?: string;
}

export interface ImportResult {
  success: boolean;
  connections?: ExportableConnection[];
  error?: string;
}

/**
 * Export selected connections to an encrypted TableR connection file.
 */
export async function exportConnections(
  connections: ConnectionConfig[],
  password: string,
): Promise<ExportResult> {
  // Strip password and internal ID before sending to backend
  const sanitized = connections.map((c) => ({
    id: c.id,
    name: c.name,
    db_type: c.db_type,
    host: c.host,
    port: c.port,
    username: c.username,
    database: c.database,
    file_path: c.file_path,
    use_ssl: c.use_ssl,
    ssl_mode: c.ssl_mode,
    ssl_ca_cert_path: c.ssl_ca_cert_path,
    ssl_client_cert_path: c.ssl_client_cert_path,
    ssl_client_key_path: c.ssl_client_key_path,
    ssl_skip_host_verification: c.ssl_skip_host_verification,
    color: c.color,
    additional_fields: c.additional_fields,
    group_id: c.groupId,
    tag_id: c.tagId,
    startup_commands: c.startupCommands,
    query_timeout_seconds: c.query_timeout_seconds,
  }));

  try {
    const filePath = await invoke<string>("export_connections_to_file", {
      connections: sanitized,
      password,
    });
    return { success: true, filePath };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "No file selected.") {
      return { success: false, error: undefined };
    }
    return { success: false, error: msg };
  }
}

/**
 * Import connections from an encrypted TableR connection file.
 */
export async function importConnections(filePath: string, password: string): Promise<ImportResult> {
  try {
    const connections = await invoke<ExportableConnection[]>("import_connections_from_file", {
      filePath,
      password,
    });
    return { success: true, connections };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "No file selected.") {
      return { success: false, error: undefined };
    }
    return { success: false, error: msg };
  }
}

/**
 * Preview connections from a DBeaver or DataGrip export file
 * (`.dbeaver/data-sources.json`, legacy `data-sources.xml`, or DataGrip
 * `dataSources.xml` / `dataSources.local.xml`). Nothing is persisted.
 */
export async function previewExternalConnections(filePath: string): Promise<ExternalImportResult> {
  return invoke<ExternalImportResult>("import_external_connections", { filePath });
}

/**
 * Persist the selected entries from a previously previewed external file.
 * `passwords` maps preview index -> password typed in the dialog; entries
 * without one land credential-less (the source tools never export secrets).
 */
export async function importExternalConnections(
  filePath: string,
  selectedIndices: number[],
  passwords: Record<number, string>,
): Promise<ExternalImportResult> {
  return invoke<ExternalImportResult>("import_external_connections", {
    filePath,
    selectedIndices,
    passwords,
  });
}

/** Convert exported connection back to ConnectionConfig format. */
export function exportableToConnectionConfig(
  ec: ExportableConnection,
  password: string,
): Omit<ConnectionConfig, "id"> & { password?: string } {
  return {
    name: ec.name,
    db_type: ec.dbType as ConnectionConfig["db_type"],
    host: ec.host,
    port: ec.port,
    username: ec.username,
    password,
    database: ec.database,
    file_path: ec.filePath,
    use_ssl: ec.useSsl,
    ssl_mode: ec.sslMode as ConnectionConfig["ssl_mode"],
    ssl_ca_cert_path: ec.sslCaCertPath,
    ssl_client_cert_path: ec.sslClientCertPath,
    ssl_client_key_path: ec.sslClientKeyPath,
    ssl_skip_host_verification: ec.sslSkipHostVerification,
    color: ec.color,
    additional_fields: ec.additionalFields,
    groupId: ec.groupId,
    tagId: ec.tagId,
    startupCommands: ec.startupCommands,
    query_timeout_seconds: ec.queryTimeoutSeconds,
  };
}
