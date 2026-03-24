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
  use_ssl: boolean;
  color?: string;
  /** Assigned connection group ID */
  groupId?: string;
  /** Assigned connection tag ID */
  tagId?: string;
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
  row_count?: number;
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
  rowCount?: number;
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
}
