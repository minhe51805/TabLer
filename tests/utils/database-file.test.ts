import { describe, expect, it } from "vitest";

import {
  buildDatabaseFileConnection,
  inferDatabaseFileType,
  normalizeDatabaseFilePath,
} from "@/utils/database-file";

describe("database file utilities", () => {
  it("recognizes supported local database files", () => {
    expect(inferDatabaseFileType("C:\\data\\app.sqlite3")).toBe("sqlite");
    expect(inferDatabaseFileType("/data/report.duckdb")).toBe("duckdb");
    expect(inferDatabaseFileType("backup.sql")).toBeNull();
  });

  it("normalizes Windows paths for saved connection matching", () => {
    expect(normalizeDatabaseFilePath("C:\\Data\\APP.DB")).toBe("c:/data/app.db");
  });

  it("builds a connection only for supported files", () => {
    expect(
      buildDatabaseFileConnection(
        { file_name: "app.db", file_path: "C:\\data\\app.db" },
        "file-1",
      ),
    ).toMatchObject({ id: "file-1", db_type: "sqlite", database: "app.db" });
    expect(
      buildDatabaseFileConnection(
        { file_name: "backup.sql", file_path: "C:\\data\\backup.sql" },
        "file-2",
      ),
    ).toBeNull();
  });
});
