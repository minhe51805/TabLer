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
  | "cloudflared1";

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
}

export interface QueryResult {
  columns: ColumnInfo[];
  rows: (string | number | boolean | null)[][];
  affected_rows: number;
  execution_time_ms: number;
  query: string;
  sandboxed: boolean;
}

export interface ColumnInfo {
  name: string;
  data_type: string;
  is_nullable: boolean;
  is_primary_key: boolean;
  max_length?: number;
  default_value?: string;
}

export interface TableInfo {
  name: string;
  schema?: string;
  table_type: string;
  row_count?: number;
  engine?: string;
}

export interface DatabaseInfo {
  name: string;
  size?: string;
}

export interface TableStructure {
  columns: ColumnDetail[];
  indexes: IndexInfo[];
  foreign_keys: ForeignKeyInfo[];
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

// UI State types
export interface Tab {
  id: string;
  type: "query" | "table" | "structure";
  title: string;
  connectionId: string;
  tableName?: string;
  database?: string;
  content?: string;
}
