import type { DatabaseType } from "../../types";

export type ConnectionEngineMode = "network" | "file";
export type ConnectionFieldMode = "required" | "optional" | "hidden";
export type PasswordKind = "password" | "token";
export type LocalBootstrapStatus = "ready" | "planned" | "none";
export type EngineExtraFieldType = "text" | "password" | "number";

export interface EngineExtraField {
  key: string;
  type?: EngineExtraFieldType;
  label: string;
  labelVi?: string;
  placeholder?: string;
  placeholderVi?: string;
  hint?: string;
  hintVi?: string;
  required?: boolean;
}

export interface DbEntry {
  key: DatabaseType;
  abbr: string;
  label: string;
  color: string;
  supported: boolean;
  connectionMode: ConnectionEngineMode;
  defaultPort?: number;
  supportsSsl: boolean;
  localBootstrap: LocalBootstrapStatus;
  isFile: boolean;
  defaultHost?: string;
  hostPlaceholder?: string;
  usernameMode: ConnectionFieldMode;
  usernamePlaceholder?: string;
  passwordMode: ConnectionFieldMode;
  passwordKind: PasswordKind;
  passwordPlaceholder?: string;
  databaseMode: ConnectionFieldMode;
  databasePlaceholder?: string;
  extraFields?: EngineExtraField[];
}

type DbFieldConfig = Pick<
  DbEntry,
  | "usernameMode"
  | "usernamePlaceholder"
  | "passwordMode"
  | "passwordKind"
  | "passwordPlaceholder"
  | "databaseMode"
  | "databasePlaceholder"
>;

type DbFieldProfileKey =
  | "standardSql"
  | "sqliteFile"
  | "duckdbFile"
  | "cassandra"
  | "snowflake"
  | "optionalUserSecretNoDatabase"
  | "optionalUserSecretWithDatabase"
  | "tokenNoDatabase"
  | "tokenWithDatabase";

type DbEntryInput = Omit<DbEntry, keyof DbFieldConfig | "extraFields"> & {
  fieldProfile: DbFieldProfileKey;
  extraFields?: EngineExtraField[];
};

const FIELD_PROFILES: Record<DbFieldProfileKey, DbFieldConfig> = {
  standardSql: {
    usernameMode: "required",
    usernamePlaceholder: "db_username",
    passwordMode: "optional",
    passwordKind: "password",
    databaseMode: "optional",
    databasePlaceholder: "database_name",
  },
  sqliteFile: {
    usernameMode: "hidden",
    passwordMode: "hidden",
    passwordKind: "password",
    databaseMode: "optional",
    databasePlaceholder: "local-database",
  },
  duckdbFile: {
    usernameMode: "hidden",
    passwordMode: "hidden",
    passwordKind: "password",
    databaseMode: "optional",
    databasePlaceholder: "local-database",
  },
  cassandra: {
    usernameMode: "required",
    usernamePlaceholder: "cluster_username",
    passwordMode: "optional",
    passwordKind: "password",
    databaseMode: "optional",
    databasePlaceholder: "keyspace_name",
  },
  snowflake: {
    usernameMode: "hidden",
    passwordMode: "optional",
    passwordKind: "token",
    passwordPlaceholder: "credential_value",
    databaseMode: "optional",
    databasePlaceholder: "database_name",
  },
  optionalUserSecretNoDatabase: {
    usernameMode: "optional",
    usernamePlaceholder: "optional_username",
    passwordMode: "optional",
    passwordKind: "password",
    databaseMode: "hidden",
  },
  optionalUserSecretWithDatabase: {
    usernameMode: "optional",
    usernamePlaceholder: "optional_username",
    passwordMode: "optional",
    passwordKind: "password",
    databaseMode: "optional",
    databasePlaceholder: "database_name",
  },
  tokenNoDatabase: {
    usernameMode: "hidden",
    passwordMode: "optional",
    passwordKind: "token",
    passwordPlaceholder: "credential_value",
    databaseMode: "hidden",
  },
  tokenWithDatabase: {
    usernameMode: "hidden",
    passwordMode: "optional",
    passwordKind: "token",
    passwordPlaceholder: "credential_value",
    databaseMode: "optional",
    databasePlaceholder: "database_name",
  },
};

export const ENGINE_EXTRA_FIELDS = {
  duckdb: [
    {
      key: "read_only",
      label: "Open mode",
      labelVi: "Che do mo",
      placeholder: "read_write or read_only",
      placeholderVi: "read_write hoac read_only",
      hint: "Choose read_only when you want to inspect an existing DuckDB file safely.",
      hintVi: "Chon read_only neu ban muon xem file DuckDB san co theo che do an toan.",
    },
  ] satisfies EngineExtraField[],
  cassandra: [
    {
      key: "datacenter",
      label: "Datacenter",
      labelVi: "Datacenter",
      placeholder: "datacenter_name",
      placeholderVi: "ten_datacenter",
    },
  ] satisfies EngineExtraField[],
  snowflake: [
    {
      key: "warehouse",
      label: "Warehouse",
      labelVi: "Warehouse",
      placeholder: "warehouse_name",
      hint: "Required when the session does not already have a default warehouse.",
      hintVi: "Can khi session chua co default warehouse.",
    },
    {
      key: "schema",
      label: "Schema",
      labelVi: "Schema",
      placeholder: "schema_name",
      hint: "Optional. Used as the default schema for unqualified table names.",
      hintVi: "Tuy chon. Dung lam schema mac dinh cho bang chua ghi ro schema.",
    },
    {
      key: "role",
      label: "Role",
      labelVi: "Role",
      placeholder: "role_name",
      hint: "Optional. Uses the default role when left empty.",
      hintVi: "Tuy chon. De trong se dung role mac dinh.",
    },
  ] satisfies EngineExtraField[],
  mssql: [
    {
      key: "instance_name",
      label: "Instance name",
      labelVi: "Ten instance",
      placeholder: "instance_name",
    },
  ] satisfies EngineExtraField[],
  redis: [
    {
      key: "redis_database",
      type: "number",
      label: "Database index",
      labelVi: "Chi so database",
      placeholder: "0",
      hint: "Redis usually starts from logical database 0.",
      hintVi: "Redis thuong bat dau tu database logic so 0.",
    },
  ] satisfies EngineExtraField[],
  mongodb: [
    {
      key: "auth_source",
      label: "Auth source",
      labelVi: "Auth source",
      placeholder: "authentication_database",
    },
    {
      key: "replica_set",
      label: "Replica set",
      labelVi: "Replica set",
      placeholder: "replica_set_name",
    },
  ] satisfies EngineExtraField[],
  bigquery: [
    {
      key: "project_id",
      label: "Project ID",
      labelVi: "Project ID",
      placeholder: "gcp_project_id",
    },
    {
      key: "dataset",
      label: "Dataset",
      labelVi: "Dataset",
      placeholder: "dataset_name",
    },
    {
      key: "location",
      label: "Location",
      labelVi: "Location",
      placeholder: "region_name",
    },
  ] satisfies EngineExtraField[],
  cloudflareD1: [
    {
      key: "account_id",
      label: "Account ID",
      labelVi: "Account ID",
      placeholder: "cloudflare_account_id",
    },
    {
      key: "database_id",
      label: "Database ID",
      labelVi: "Database ID",
      placeholder: "cloudflare_database_id",
    },
  ] satisfies EngineExtraField[],
} as const;

export function buildDbEntry({ fieldProfile, extraFields, ...entry }: DbEntryInput): DbEntry {
  return {
    ...entry,
    ...FIELD_PROFILES[fieldProfile],
    ...(extraFields ? { extraFields } : {}),
  };
}
