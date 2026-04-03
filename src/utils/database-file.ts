import type { ConnectionConfig, DatabaseType } from "../types";
import { getLastPathSegment } from "./path-utils";

export interface DatabaseFileSelection {
  file_name: string;
  file_path: string;
}

type LocalFileDatabaseType = Extract<DatabaseType, "sqlite" | "duckdb">;

const SQLITE_EXTENSIONS = new Set(["db", "db3", "sqlite", "sqlite3"]);
const DUCKDB_EXTENSIONS = new Set(["duckdb"]);

function getFileExtension(filePath: string) {
  const normalized = getLastPathSegment(filePath).toLowerCase();
  const parts = normalized.split(".");
  return parts.length > 1 ? parts[parts.length - 1] : "";
}

export function inferDatabaseFileType(filePath: string): LocalFileDatabaseType | null {
  const extension = getFileExtension(filePath);
  if (DUCKDB_EXTENSIONS.has(extension)) return "duckdb";
  if (SQLITE_EXTENSIONS.has(extension)) return "sqlite";
  return null;
}

export function buildDatabaseFileConnection(
  selection: DatabaseFileSelection,
  id: string,
): ConnectionConfig | null {
  const dbType = inferDatabaseFileType(selection.file_path);
  if (!dbType) return null;

  return {
    id,
    name: "",
    db_type: dbType,
    database: selection.file_name,
    file_path: selection.file_path,
    use_ssl: false,
    additional_fields: {},
  };
}
