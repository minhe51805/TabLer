import { describe, expect, it } from "vitest";
import { agentToolAvailability } from "@/components/AISlidePanel/ai-agent-engine-gates";
import {
  buildAgentControllerPrompt,
  buildAgentPlanPrompt,
  buildAgentRecoveryContext,
  buildAgentVisibleTableNames,
  buildSchemaCapsuleContext,
  buildSchemaCapsulePreview,
  buildWorkspaceTableIdentifier,
  joinAgentInstructions,
  type AgentTraceStep,
} from "@/components/AISlidePanel/ai-agent-context";

describe("AI agent context builder", () => {
  it("builds workspace identifiers without duplicating the active database qualifier", () => {
    expect(buildWorkspaceTableIdentifier({ name: "users", schema: "public" }, "public"))
      .toBe("users");
    expect(buildWorkspaceTableIdentifier({ name: "users", schema: "analytics" }, "public"))
      .toBe("analytics.users");
    expect(buildWorkspaceTableIdentifier({ name: "public.users", schema: "public" }, "public"))
      .toBe("public.users");
  });

  it("prioritizes relevant tables, removes duplicates, and respects the limit", () => {
    expect(buildAgentVisibleTableNames(
      ["users", "orders", "events", "audit_logs"],
      ["events", "USERS"],
      3,
    )).toEqual(["events", "USERS", "orders"]);
  });

  it("builds a bounded schema capsule with explicit grounding rules", () => {
    const schemas = ["T=users", "T=orders", "T=events", "T=logs", "T=ignored"];

    expect(buildSchemaCapsulePreview(schemas)).toBe("T=users\nT=orders\nT=events\nT=logs");
    expect(buildSchemaCapsuleContext({
      currentDatabase: "analytics",
      totalTableCount: 8,
      visibleTableNames: ["users", "orders"],
      allVisible: false,
      tableSchemas: schemas.slice(0, 2),
      schemaCodecMode: "relational",
      truncatedOverview: true,
    })).toContain("DB=analytics\nTC=8\nTV=users,orders,...");
    expect(buildSchemaCapsuleContext({
      currentDatabase: "analytics",
      totalTableCount: 8,
      visibleTableNames: ["users"],
      allVisible: false,
      tableSchemas: ["T=users"],
      schemaCodecMode: "relational",
      truncatedOverview: true,
    })).toContain("NOTE=Overview limited to current capsule tables.");
  });

  it("builds recovery context that advertises missing catalog entries", () => {
    expect(buildAgentRecoveryContext({
      currentDatabase: "analytics",
      availableTableNames: ["users", "orders", "events"],
      visibleTableNames: ["users", "orders"],
      schemaCapsulePreview: "T=users",
    })).toBe([
      "DB=analytics",
      "TC=3",
      "TV=users,orders,...",
      "SCHEMA_PREVIEW=\nT=users",
      "RULE=list_tables for catalog; search_schema for unknown fields; describe_table before assuming columns; stay inside verified schema.",
    ].join("\n"));
  });

  it("builds localized planning prompts from a bounded table catalog", () => {
    const prompt = buildAgentPlanPrompt({
      userPrompt: "Show revenue by month",
      assistIntent: "sql",
      currentDatabase: "analytics",
      availableTableNames: ["orders", "customers"],
      appLanguage: "vi",
    });

    expect(prompt).toContain("Reply in Vietnamese.");
    expect(prompt).toContain("Known tables: orders, customers");
    expect(prompt).toContain("User request:\nShow revenue by month");
  });

  it("keeps only recent full observations and excludes narration steps", () => {
    const steps: AgentTraceStep[] = [
      { step: 1, action: "plan", message: "Plan", observation: "narration" },
      ...Array.from({ length: 6 }, (_, index): AgentTraceStep => ({
        step: index + 2,
        action: "describe_table",
        message: `Inspect ${index}`,
        observation: `schema-${index}`,
      })),
    ];
    const prompt = buildAgentControllerPrompt({
      userPrompt: "Analyze customers",
      assistIntent: "overview",
      currentDatabase: "analytics",
      availableTableNames: ["customers"],
      steps,
      workspaceToolsEnabled: true,
    });

    expect(prompt).toContain('"action":"run_readonly_sql"');
    expect(prompt).toContain('"action":"search_schema"');
    expect(prompt).toContain('"action":"sample_table_data"');
    expect(prompt).toContain('"action":"describe_tables"');
    expect(prompt).toContain('"action":"ask_user"');
    expect(prompt).toContain("every table in FROM or JOIN must be inspected");
    expect(prompt).toContain("Observation (older, condensed)");
    expect(prompt).not.toContain("narration");
    expect(prompt).toContain("schema-5");
  });

  it("truncates oversized recent observations instead of inlining them whole", () => {
    const steps: AgentTraceStep[] = [
      { step: 1, action: "run_readonly_sql", message: "Query", observation: "x".repeat(3_000) },
    ];
    const prompt = buildAgentControllerPrompt({
      userPrompt: "Analyze",
      assistIntent: "sql",
      currentDatabase: null,
      availableTableNames: [],
      steps,
      workspaceToolsEnabled: true,
    });

    expect(prompt).toContain("[observation truncated]");
    expect(prompt).not.toContain("x".repeat(2_500));
  });

  it("omits SQL tools and SQL-only rules on document/KV engines", () => {
    const prompt = buildAgentControllerPrompt({
      userPrompt: "Show recent orders",
      assistIntent: "sql",
      currentDatabase: "shop",
      availableTableNames: ["orders"],
      steps: [],
      workspaceToolsEnabled: true,
      toolAvailability: agentToolAvailability("mongodb"),
    });

    expect(prompt).toContain("Engine: MongoDB (document)");
    expect(prompt).not.toContain('"action":"run_readonly_sql"');
    expect(prompt).not.toContain('"action":"preview_write"');
    expect(prompt).toContain('"action":"sample_table_data"');
    expect(prompt).toContain("Omit finish.args.sql");
    expect(prompt).not.toContain("run run_readonly_sql before finishing");
  });

  it("keeps SQL tools on ClickHouse", () => {
    const prompt = buildAgentControllerPrompt({
      userPrompt: "Count events",
      assistIntent: "sql",
      currentDatabase: "analytics",
      availableTableNames: ["events"],
      steps: [],
      workspaceToolsEnabled: true,
      toolAvailability: agentToolAvailability("clickhouse"),
    });
    expect(prompt).toContain('"action":"run_readonly_sql"');
    expect(prompt).toContain('"action":"preview_write"');
  });

  it("injects pre-inspected summaries and caps them to save describe_table steps", () => {
    const prompt = buildAgentControllerPrompt({
      userPrompt: "Show recent orders",
      assistIntent: "sql",
      currentDatabase: "analytics",
      availableTableNames: ["orders", "customers"],
      steps: [],
      workspaceToolsEnabled: true,
      cachedTableSummaries: [
        "T=orders|C:id:bigint!pk",
        "T=customers|C:id:bigint!pk",
        ...Array.from({ length: 8 }, (_, index) => `T=extra_${index}|C:id:bigint`),
      ],
    });

    expect(prompt).toContain("Pre-inspected tables");
    expect(prompt).toContain("T=orders|C:id:bigint!pk");
    expect(prompt).toContain("do NOT call describe_table for these");
    expect(prompt).not.toContain("T=extra_6");
  });

  it("caps oversized controller prompts and composes optional instructions", () => {
    const prompt = buildAgentControllerPrompt({
      userPrompt: "x".repeat(60_000),
      assistIntent: "general",
      currentDatabase: null,
      availableTableNames: [],
      steps: [],
      workspaceToolsEnabled: false,
      forceFinish: true,
    });

    expect(prompt.length).toBeLessThanOrEqual(48_000);
    expect(prompt).toContain("Trace truncated to fit the prompt budget");
    expect(joinAgentInstructions(" first ", undefined, "", " second ")).toBe("first second");
  });
});
