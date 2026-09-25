import { describe, expect, it } from "vitest";
import { getAdminQueryPreset, killSessionMenuLabel } from "../../src/utils/admin-query-presets";
import { substituteParams } from "../../src/utils/sql-params";

describe("kill-session admin presets", () => {
  it("int placeholders render unquoted inside the oracle quoted literal", () => {
    const preset = getAdminQueryPreset("oracle", "kill-session");
    expect(preset.supported).toBe(true);
    const resolved = substituteParams(preset.content, {
      session_sid: "42",
      session_serial: "1337",
    });
    expect(resolved.sql).toBe("ALTER SYSTEM KILL SESSION '42,1337';");
  });

  it("string placeholders self-quote so presets never add their own quotes", () => {
    const resolved = substituteParams(getAdminQueryPreset("clickhouse", "kill-session").content, {
      session_id: "q-1",
    });
    expect(resolved.sql).toBe("KILL QUERY WHERE query_id = 'q-1';");
    const trino = substituteParams(getAdminQueryPreset("trino", "kill-session").content, {
      session_id: "20260925_1_x",
    });
    expect(trino.sql).toBe("CALL system.runtime.kill_query(query_id => '20260925_1_x');");
  });

  it("every supported preset resolves all placeholders", () => {
    const values: Record<string, string> = {
      session_id: "7",
      session_sid: "7",
      session_serial: "9",
    };
    for (const engine of [
      "mysql",
      "mariadb",
      "postgresql",
      "greenplum",
      "redshift",
      "cockroachdb",
      "mssql",
      "vertica",
      "clickhouse",
      "snowflake",
      "trino",
      "bigquery",
      "oracle",
      "redis",
      "mongodb",
    ] as const) {
      const preset = getAdminQueryPreset(engine, "kill-session");
      expect(preset.supported, engine).toBe(true);
      const resolved = substituteParams(preset.content, values);
      expect(resolved.sql, engine).not.toMatch(/\{\{/);
    }
  });

  it("engines with no kill primitive report an honest reason", () => {
    for (const engine of [
      "spanner",
      "dynamodb",
      "cassandra",
      "opensearch",
      "elasticsearch",
    ] as const) {
      const preset = getAdminQueryPreset(engine, "kill-session");
      expect(preset.supported, engine).toBe(false);
      expect(preset.reason, engine).toBeTruthy();
    }
    expect(getAdminQueryPreset("sqlite", "kill-session").supported).toBe(false);
  });
});

describe("process-list preset gating is engine-honest", () => {
  it.each(["bigquery", "trino", "spanner", "oracle"] as const)(
    "%s exposes a supported process list",
    (engine) => {
      expect(getAdminQueryPreset(engine, "process-list").supported).toBe(true);
    },
  );
  it("elasticsearch exposes the read-only tasks preset", () => {
    expect(getAdminQueryPreset("elasticsearch", "process-list")).toEqual({
      supported: true,
      content: "GET /_cat/tasks?format=json",
    });
    expect(getAdminQueryPreset("elasticsearch", "user-management").supported).toBe(false);
  });
  it("cloud IAM engines keep user management unsupported", () => {
    expect(getAdminQueryPreset("bigquery", "user-management").supported).toBe(false);
    expect(getAdminQueryPreset("spanner", "user-management").supported).toBe(false);
  });
});

describe("killSessionMenuLabel", () => {
  it("falls back to English for unknown locales", () => {
    expect(killSessionMenuLabel("en")).toBe("Kill session...");
    expect(killSessionMenuLabel("fr")).toBe("Kill session...");
    expect(killSessionMenuLabel("vi")).not.toBe("Kill session...");
  });
});
