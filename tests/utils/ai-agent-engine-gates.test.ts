import { describe, expect, it } from "vitest";
import {
  AGENT_QUERY_MODEL_BY_ENGINE,
  agentQueryModelForEngine,
  agentSqlToolBlockedMessage,
  agentToolAvailability,
  engineAwareDataPlaneHints,
  isAgentToolEnabled,
  nativeCatalogOptionsForEngine,
} from "@/components/AISlidePanel/ai-agent-engine-gates";
import { formatAgentToolCatalog } from "@/components/AISlidePanel/ai-agent-tool-schema";
import type { DatabaseType, QueryModel } from "@/types";
import capabilityMatrix from "../../docs/generated/driver-capabilities.json";

const SQL_ENGINES: DatabaseType[] = [
  "mysql",
  "mariadb",
  "sqlite",
  "duckdb",
  "cockroachdb",
  "snowflake",
  "postgresql",
  "greenplum",
  "redshift",
  "mssql",
  "vertica",
  "clickhouse",
  "bigquery",
  "libsql",
  "cloudflare_d1",
];

describe("agent engine tool gates", () => {
  it("classifies every configured engine", () => {
    expect(Object.keys(AGENT_QUERY_MODEL_BY_ENGINE).sort()).toEqual(
      [...SQL_ENGINES, "cassandra", "redis", "mongodb", "opensearch"].sort(),
    );
  });

  it.each(SQL_ENGINES)("keeps SQL read and write-preview tools on %s", (engine) => {
    const availability = agentToolAvailability(engine);
    expect(availability.queryModel).toBe("sql");
    expect(availability.sqlRead).toBe(true);
    expect(availability.sqlWritePreview).toBe(true);
    expect(isAgentToolEnabled("run_readonly_sql", availability)).toBe(true);
    expect(isAgentToolEnabled("preview_write", availability)).toBe(true);
    const catalog = formatAgentToolCatalog({ workspaceToolsEnabled: true, availability }).join("\n");
    expect(catalog).toContain('"action":"run_readonly_sql"');
    expect(catalog).toContain('"action":"preview_write"');
  });

  it("allows CQL SELECT but not SQL write previews on Cassandra", () => {
    const availability = agentToolAvailability("cassandra");
    expect(availability.queryModel).toBe("cql");
    expect(availability.sqlRead).toBe(true);
    expect(availability.sqlWritePreview).toBe(false);
    const catalog = formatAgentToolCatalog({ workspaceToolsEnabled: true, availability }).join("\n");
    expect(catalog).toContain('"action":"run_readonly_sql"');
    expect(catalog).not.toContain('"action":"preview_write"');
  });

  it.each(["redis", "mongodb", "opensearch"] as const)(
    "hides SQL tools on non-SQL engine %s",
    (engine) => {
      const availability = agentToolAvailability(engine);
      expect(availability.sqlRead).toBe(false);
      expect(availability.sqlWritePreview).toBe(false);
      expect(isAgentToolEnabled("run_readonly_sql", availability)).toBe(false);
      expect(isAgentToolEnabled("preview_write", availability)).toBe(false);
      expect(isAgentToolEnabled("sample_table_data", availability)).toBe(true);
      const catalog = formatAgentToolCatalog({ workspaceToolsEnabled: true, availability });
      const actions = catalog.map((line) => line.match(/"action":"([^"]+)"/)?.[1]);
      expect(actions).not.toContain("run_readonly_sql");
      expect(actions).not.toContain("preview_write");
      expect(actions).toContain("sample_table_data");
      expect(actions).toContain("list_tables");
    },
  );

  it("defaults unknown engines to SQL so existing workspaces stay enabled", () => {
    expect(agentQueryModelForEngine(null)).toBe("sql");
    expect(agentQueryModelForEngine("mystery")).toBe("sql");
  });

  it("explains the block in plain language", () => {
    const redis = agentToolAvailability("redis");
    expect(agentSqlToolBlockedMessage("run_readonly_sql", redis)).toContain("Redis");
    expect(agentSqlToolBlockedMessage("run_readonly_sql", redis)).not.toMatch(/SQL observations are not available/i);
    expect(agentSqlToolBlockedMessage("preview_write", redis)).toContain("Redis");
  });

  it("tells SQL engines to use run_readonly_sql and non-SQL engines to never call it", () => {
    const postgres = engineAwareDataPlaneHints(agentToolAvailability("postgresql"));
    expect(postgres.gather).toContain("run_readonly_sql");
    expect(postgres.mustRead).toContain("run_readonly_sql");
    expect(postgres.finishSql).toContain("finish.args.sql");

    const redis = engineAwareDataPlaneHints(agentToolAvailability("redis"));
    expect(redis.gather).toContain("Never call run_readonly_sql");
    expect(redis.mustRead).not.toContain("run_readonly_sql");
    expect(redis.finishSql).toContain("omit finish.args.sql");
    expect(nativeCatalogOptionsForEngine("redis").availability.sqlRead).toBe(false);
    expect(nativeCatalogOptionsForEngine("postgresql").availability.sqlRead).toBe(true);
  });

  it("stays in lockstep with the generated Rust capability matrix", () => {
    const fromRust = Object.fromEntries(
      (capabilityMatrix as Array<{ key: string; queryModel: QueryModel }>).map((row) => [
        row.key,
        row.queryModel,
      ]),
    );
    expect(fromRust).toEqual(AGENT_QUERY_MODEL_BY_ENGINE);
  });
});
