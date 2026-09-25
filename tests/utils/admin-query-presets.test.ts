import { describe, expect, it } from "vitest";
import {
  getAdminQueryPreset,
  killSessionMenuLabel,
  adminQueryMenuLabel,
} from "../../src/utils/admin-query-presets";
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
      "typesense",
      "surrealdb",
      "weaviate",
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
  it("typesense, weaviate and surrealdb keep all admin surfaces unsupported", () => {
    for (const engine of ["typesense", "surrealdb", "weaviate"] as const) {
      expect(getAdminQueryPreset(engine, "process-list").supported).toBe(false);
      expect(getAdminQueryPreset(engine, "user-management").supported).toBe(false);
      expect(getAdminQueryPreset(engine, "kill-session").supported).toBe(false);
    }
  });
});
describe("read-only admin presets", () => {
  const kinds = ["server-info", "locks", "table-stats", "index-usage", "slow-queries"] as const;

  it("new presets never carry param placeholders", () => {
    for (const kind of kinds) {
      for (const engine of [
        "mysql",
        "postgresql",
        "mssql",
        "oracle",
        "clickhouse",
        "snowflake",
        "trino",
        "bigquery",
        "spanner",
        "mongodb",
        "redis",
        "cassandra",
      ] as const) {
        const preset = getAdminQueryPreset(engine, kind);
        if (preset.supported) {
          expect(preset.content, `${engine}/${kind}`).not.toMatch(/\{\{/);
          expect(preset.content.trim().length, `${engine}/${kind}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it("server-info covers the server engines and stays honest about serverless ones", () => {
    for (const engine of ["mysql", "postgresql", "mssql", "oracle", "trino", "mongodb"] as const) {
      expect(getAdminQueryPreset(engine, "server-info").supported, engine).toBe(true);
    }
    for (const engine of ["bigquery", "spanner", "dynamodb"] as const) {
      const preset = getAdminQueryPreset(engine, "server-info");
      expect(preset.supported, engine).toBe(false);
      expect(preset.reason, engine).toContain("serverless");
    }
  });

  it("locks reports an honest reason on engines without a lock surface", () => {
    for (const engine of ["clickhouse", "redis", "cassandra", "dynamodb"] as const) {
      const preset = getAdminQueryPreset(engine, "locks");
      expect(preset.supported, engine).toBe(false);
      expect(preset.reason, engine).toBeTruthy();
    }
    expect(getAdminQueryPreset("postgresql", "locks").supported).toBe(true);
    expect(getAdminQueryPreset("mongodb", "locks").supported).toBe(true);
  });

  it("table-stats and index-usage cover the engines that track them", () => {
    expect(getAdminQueryPreset("mysql", "table-stats").supported).toBe(true);
    expect(getAdminQueryPreset("postgresql", "table-stats").supported).toBe(true);
    expect(getAdminQueryPreset("duckdb", "table-stats").supported).toBe(true);
    expect(getAdminQueryPreset("surrealdb", "table-stats").supported).toBe(true);
    expect(getAdminQueryPreset("postgresql", "index-usage").supported).toBe(true);
    expect(getAdminQueryPreset("mysql", "index-usage").supported).toBe(true);
    expect(getAdminQueryPreset("vertica", "index-usage").reason).toContain("no secondary indexes");
    expect(getAdminQueryPreset("snowflake", "index-usage").reason).toContain("index-free");
  });

  it("slow-queries stays honest on engines without a query catalog", () => {
    for (const engine of [
      "postgresql",
      "mssql",
      "clickhouse",
      "snowflake",
      "trino",
      "bigquery",
    ] as const) {
      expect(getAdminQueryPreset(engine, "slow-queries").supported, engine).toBe(true);
    }
    for (const engine of ["opensearch", "elasticsearch", "mongodb", "weaviate"] as const) {
      const preset = getAdminQueryPreset(engine, "slow-queries");
      expect(preset.supported, engine).toBe(false);
      expect(preset.reason, engine).toBeTruthy();
    }
    expect(getAdminQueryPreset("sqlite", "slow-queries").supported).toBe(false);
  });

  it("adminQueryMenuLabel localizes and falls back", () => {
    expect(adminQueryMenuLabel("en", "server-info")).toBe("Server info...");
    expect(adminQueryMenuLabel("vi", "locks")).toContain("Khoá");
    expect(adminQueryMenuLabel("fr", "slow-queries")).toBe("Slow queries...");
  });
});

describe("killSessionMenuLabel", () => {
  it("falls back to English for unknown locales", () => {
    expect(killSessionMenuLabel("en")).toBe("Kill session...");
    expect(killSessionMenuLabel("fr")).toBe("Kill session...");
    expect(killSessionMenuLabel("vi")).not.toBe("Kill session...");
  });
});
