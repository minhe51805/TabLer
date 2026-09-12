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
import { PLUGIN_HTTP_PROTOCOLS, PLUGIN_NATIVE_PROTOCOLS } from "@/utils/plugin-driver-runtime";

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

  it("enables propose_seed_data on SQL and document engines, not on cql/kv/search", () => {
    const mongo = agentToolAvailability("mongodb");
    expect(mongo.documentPropose).toBe(true);
    expect(isAgentToolEnabled("propose_seed_data", mongo)).toBe(true);

    for (const engine of ["postgresql", "mysql", "sqlite", "mssql"] as const) {
      const availability = agentToolAvailability(engine);
      expect(availability.sqlWritePreview).toBe(true);
      expect(isAgentToolEnabled("propose_seed_data", availability)).toBe(true);
    }

    for (const engine of ["cassandra", "redis", "opensearch"] as const) {
      const availability = agentToolAvailability(engine);
      expect(availability.documentPropose).toBe(false);
      expect(availability.sqlWritePreview).toBe(false);
      expect(isAgentToolEnabled("propose_seed_data", availability)).toBe(false);
    }
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

  it("keeps engine display labels in lockstep with the generated Rust capability matrix", () => {
    // Tech-debt audit D8: the display label is single-sourced from the Rust
    // capability matrix (`driver_capabilities().label`). The backend
    // `connection_engine_label` now delegates to that matrix, so this test is
    // the frontend half of the same contract — it fails if `ENGINE_LABEL`
    // (surfaced via `agentToolAvailability().engineLabel`) drifts from the
    // canonical labels the way Redshift/Cassandra/BigQuery once did.
    const labelsFromRust = Object.fromEntries(
      (capabilityMatrix as Array<{ key: string; label: string }>).map((row) => [
        row.key,
        row.label,
      ]),
    );
    const labelsFromAgent = Object.fromEntries(
      Object.keys(AGENT_QUERY_MODEL_BY_ENGINE).map((key) => [
        key,
        agentToolAvailability(key).engineLabel,
      ]),
    );
    expect(labelsFromAgent).toEqual(labelsFromRust);
  });

  it("keeps the plugin-split distribution in lockstep with the generated Rust matrix", () => {
    // Plugin-split Phase 0: the packaging tier is single-sourced from
    // `driver_distribution()` in capabilities.rs. This binds the frontend to the
    // generated matrix so the built-in vs plugin decision cannot silently drift.
    const byKey = Object.fromEntries(
      (capabilityMatrix as Array<{ key: string; distribution: string }>).map((row) => [
        row.key,
        row.distribution,
      ]),
    );
    // Built-in: the five shipped wire drivers plus their wire-compatible variants.
    for (const key of [
      "mysql",
      "mariadb",
      "postgresql",
      "cockroachdb",
      "greenplum",
      "redshift",
      "vertica",
      "sqlite",
      "mssql",
      "mongodb",
    ]) {
      expect(byKey[key]).toBe("builtin");
    }
    // HTTP engines: candidates for downloadable HTTP plugin manifests.
    for (const key of ["clickhouse", "bigquery", "snowflake", "cloudflare_d1", "opensearch"]) {
      expect(byKey[key]).toBe("plugin_http");
    }
    // Native-crate engines: feature-flag build or sidecar only.
    for (const key of ["duckdb", "cassandra", "redis", "libsql"]) {
      expect(byKey[key]).toBe("plugin_native");
    }
  });

  it("PLUGIN_HTTP_PROTOCOLS matches the plugin_http engines in the generated matrix", () => {
    // The frontend gating set (which engines require an installed HTTP plugin)
    // must equal the Rust taxonomy so the connection picker never drifts from
    // what the backend `require_installed_http_plugin` gate enforces.
    const fromMatrix = (capabilityMatrix as Array<{ key: string; distribution: string }>)
      .filter((row) => row.distribution === "plugin_http")
      .map((row) => row.key)
      .sort();
    expect([...PLUGIN_HTTP_PROTOCOLS].sort()).toEqual(fromMatrix);
  });

  it("PLUGIN_NATIVE_PROTOCOLS matches the plugin_native engines in the generated matrix", () => {
    // The frontend gating set (which engines are feature-flag/native builds that
    // a lean binary may drop) must equal the Rust taxonomy, so the connection
    // picker's build-availability check never drifts from the backend
    // `compiled_native_driver_availability` / `get_native_driver_availability`
    // surface it reads at runtime.
    const fromMatrix = (capabilityMatrix as Array<{ key: string; distribution: string }>)
      .filter((row) => row.distribution === "plugin_native")
      .map((row) => row.key)
      .sort();
    expect([...PLUGIN_NATIVE_PROTOCOLS].sort()).toEqual(fromMatrix);
  });
});
