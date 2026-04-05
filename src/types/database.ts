// Database types matching the frontend picker and Rust backend
export type DatabaseType =
  | "mysql"
  | "mariadb"
  | "sqlite"
  | "duckdb"
  | "cassandra"
  | "cockroachdb"
  | "snowflake"
  | "postgresql"
  | "greenplum"
  | "redshift"
  | "mssql"
  | "redis"
  | "mongodb"
  | "vertica"
  | "clickhouse"
  | "bigquery"
  | "libsql"
  | "cloudflare_d1";

export interface ConnectionConfig {
  id: string;
  name: string;
  db_type: DatabaseType;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  database?: string;
  file_path?: string;
  /** @deprecated Use `ssl_mode` instead for fine-grained SSL control. `use_ssl` is kept for backward compatibility. */
  use_ssl: boolean;
  /** Fine-grained SSL/TLS mode (PostgreSQL, MySQL, MariaDB). Falls back to `use_ssl` when undefined. */
  ssl_mode?: "disable" | "prefer" | "require" | "verify_ca" | "verify_full";
  /** Path to CA certificate file (for verify_ca / verify_full modes). */
  ssl_ca_cert_path?: string;
  /** Path to client certificate file (for verify_ca / verify_full modes). */
  ssl_client_cert_path?: string;
  /** Path to client key file (for verify_ca / verify_full modes). */
  ssl_client_key_path?: string;
  /** Skip hostname verification in SSL handshake (for verify_ca / verify_full modes). */
  ssl_skip_host_verification?: boolean;
  color?: string;
  additional_fields?: Record<string, string>;
  /** Assigned connection group ID */
  groupId?: string;
  /** Assigned connection tag ID */
  tagId?: string;
  /** SQL commands to execute immediately after connecting. */
  startupCommands?: string;
}

export interface QueryResult {
  columns: ColumnInfo[];
  rows: (string | number | boolean | null)[][];
  affected_rows: number;
  execution_time_ms: number;
  query: string;
  sandboxed: boolean;
  truncated: boolean;
}

export interface ColumnInfo {
  name: string;
  data_type: string;
  is_nullable: boolean;
  is_primary_key: boolean;
  max_length?: number;
  default_value?: string;
}

export interface RowKeyValue {
  column: string;
  value: string | number | boolean | null;
}

export interface TableCellUpdateRequest {
  table: string;
  database?: string;
  target_column: string;
  value: string | number | boolean | null;
  primary_keys: RowKeyValue[];
}

export interface TableRowDeleteRequest {
  table: string;
  database?: string;
  rows: RowKeyValue[][];
}

export interface TableInfo {
  name: string;
  schema?: string;
  table_type: string;
  row_count?: number | null;
  engine?: string;
}

export interface SchemaObjectInfo {
  name: string;
  schema?: string;
  object_type: string;
  related_table?: string;
  definition?: string;
}

export interface DatabaseInfo {
  name: string;
  size?: string;
}

export interface TableStructure {
  columns: ColumnDetail[];
  indexes: IndexInfo[];
  foreign_keys: ForeignKeyInfo[];
  triggers: TriggerInfo[];
  view_definition?: string;
  object_type?: string;
}

export interface ColumnDetail {
  name: string;
  data_type: string;
  is_nullable: boolean;
  is_primary_key: boolean;
  default_value?: string;
  extra?: string;
  column_type?: string;
  comment?: string;
}

export interface IndexInfo {
  name: string;
  columns: string[];
  is_unique: boolean;
  index_type?: string;
}

export interface ForeignKeyInfo {
  name: string;
  column: string;
  referenced_table: string;
  referenced_column: string;
  on_update?: string;
  on_delete?: string;
}

export interface TriggerInfo {
  name: string;
  timing?: string;
  event?: string;
  related_table?: string;
  definition?: string;
}

export type MetricsWidgetType = "table" | "scoreboard" | "bar" | "line" | "pie";

export interface MetricsWidgetDefinition {
  id: string;
  type: MetricsWidgetType;
  title: string;
  query: string;
  refresh_seconds: number;
  col_span: number;
  row_span: number;
  grid_x: number;
  grid_y: number;
}

export interface MetricsBoardDefinition {
  id: string;
  name: string;
  connection_id: string;
  database?: string;
  widgets: MetricsWidgetDefinition[];
  created_at: number;
  updated_at: number;
}

// ER Diagram types
export interface ERDiagramSchema {
  tables: TableSchema[];
  relationships: ERRelationship[];
}

export interface TableSchema {
  name: string;
  schema?: string;
  columns: ColumnDetail[];
  indexes: IndexInfo[];
  rowCount?: number | null;
}

export interface ERRelationship {
  id: string;
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  label?: string;
  isCustom?: boolean;
}

export type StructureFocusSection =
  | "columns"
  | "indexes"
  | "foreign_keys"
  | "triggers"
  | "view_definition";

// UI State types
export interface Tab {
  id: string;
  type: "query" | "table" | "structure" | "metrics" | "er-diagram";
  title: string;
  connectionId: string;
  tableName?: string;
  database?: string;
  content?: string;
  metricsBoardId?: string;
  structureFocusSection?: StructureFocusSection;
  structureFocusColumn?: string;
  structureFocusToken?: string;
}
