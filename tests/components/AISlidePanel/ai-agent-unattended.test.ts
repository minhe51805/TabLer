import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  UNATTENDED_BLOCKED_TOOLS,
  UNATTENDED_READ_ONLY_TOOLS,
  unattendedToolBlockReason,
} from "@/components/AISlidePanel/ai-agent-unattended";
import { AI_AGENT_TOOL_NAMES } from "@/components/AISlidePanel/tool-schema/constants";
import { createAgentToolExecutor } from "@/components/AISlidePanel/ai-agent-tool-executor";
import type { AIAgentToolAction } from "@/components/AISlidePanel/ai-agent-tools";
import { mkDeps } from "./ai-agent-test-harness";

vi.mock("@/utils/semantic-glossary", () => ({
  saveSemanticGlossaryEntry: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/utils/tauri-utils", () => ({
  invokeMutation: vi.fn(),
}));
vi.mock("@/components/AISlidePanel/hooks/use-agent-memory", () => ({
  invalidateAgentMemoryIndex: vi.fn(),
  getAgentMemoryIndex: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("UNATTENDED_BLOCKED_TOOLS allow-list complement", () => {
  it("contains exactly the tools outside the read-only allow-list (fail-closed)", () => {
    const expected = AI_AGENT_TOOL_NAMES.filter(
      (name) => !new Set<string>(UNATTENDED_READ_ONLY_TOOLS).has(name),
    );
    expect([...UNATTENDED_BLOCKED_TOOLS].sort()).toEqual([...expected].sort());
    // Every blocked tool is a real catalog tool — no phantom entries.
    for (const name of UNATTENDED_BLOCKED_TOOLS) {
      expect(AI_AGENT_TOOL_NAMES).toContain(name);
    }
    // The dangerous writes must be in the blocked set.
    for (const name of [
      "preview_write",
      "propose_seed_data",
      "edit_query_sql",
      "save_memory",
      "delete_memory",
      "remember_term",
      "create_checkpoint",
      "restore_checkpoint",
      "manage_schedule",
      "manage_metrics_widget",
      "manage_skill",
      "manage_rule",
      "switch_database",
      "open_table_tab",
      "ask_user",
    ]) {
      expect(UNATTENDED_BLOCKED_TOOLS, name).toContain(name);
    }
  });
});

describe("executor-layer refusals (unattendedReadOnly: true)", () => {
  it("refuses preview_write / save_memory / ask_user with corrective text", async () => {
    const deps = mkDeps({ unattendedReadOnly: true });
    const executor = createAgentToolExecutor(deps);

    const write = await executor.runAgentTool({
      action: "preview_write",
      args: { statements: ["UPDATE users SET email = 'x'"] },
    } as AIAgentToolAction);
    expect(write).toContain("Tool blocked");
    expect(write).toContain("read-only");

    const memory = await executor.runAgentTool({
      action: "save_memory",
      args: { name: "fact", description: "d", body: "b" },
    } as AIAgentToolAction);
    expect(memory).toContain("Tool blocked");
    expect(memory).toContain("cannot change stored memory");

    const ask = await executor.runAgentTool({
      action: "ask_user",
      args: { question: "go?" },
    } as AIAgentToolAction);
    expect(ask).toContain("Tool blocked");
    expect(ask).toContain("no human is present");

    // Each refused tool is reported once, sorted.
    expect(executor.getUnattendedBlockedTools()).toEqual(
      ["ask_user", "preview_write", "save_memory"].sort(),
    );
  });

  it("still allows read tools and records nothing as blocked", async () => {
    const deps = mkDeps({ unattendedReadOnly: true });
    const executor = createAgentToolExecutor(deps);
    const obs = await executor.runAgentTool({
      action: "list_tables",
      args: {},
    } as AIAgentToolAction);
    expect(obs).not.toContain("Tool blocked");
    expect(executor.getUnattendedBlockedTools()).toEqual([]);
  });

  it("a batch carrying a write sub-call refuses only that call", async () => {
    const deps = mkDeps({ unattendedReadOnly: true });
    const executor = createAgentToolExecutor(deps);
    const obs = await executor.runAgentTool({
      action: "batch",
      args: {
        calls: [
          { action: "list_tables", args: {} },
          { action: "preview_write", args: { statements: ["UPDATE users SET email = 'x'"] } },
          { action: "describe_table", args: { table: "users" } },
        ],
      },
    } as AIAgentToolAction);
    expect(obs).toContain("--- call 1: list_tables ---");
    expect(obs).toContain("--- call 2: preview_write ---");
    expect(obs).toContain("--- call 3: describe_table ---");
    // The write sub-call is refused; its read siblings still ran.
    const sections = obs.split("--- call ");
    expect(sections[2]).toContain("Tool blocked");
    expect(sections[3]).toContain("TABLE=public.users");
    expect(executor.getUnattendedBlockedTools()).toEqual(["preview_write"]);
  });

  it("unknown tool names are refused fail-closed and reported as blocked", async () => {
    const deps = mkDeps({ unattendedReadOnly: true });
    const executor = createAgentToolExecutor(deps);
    const obs = await executor.runAgentTool({
      action: "teleport",
      args: {},
    } as unknown as AIAgentToolAction);
    // The unattended guard wins over the unknown-tool hint: anything outside
    // the allow-list is a blocked tool by definition.
    expect(obs).toContain("Tool blocked");
    expect(obs).toContain("read-only tool surface");
    expect(executor.getUnattendedBlockedTools()).toEqual(["teleport"]);
  });
});

describe("unattendedToolBlockReason", () => {
  it("gives a corrective hint per blocked tool family", () => {
    expect(unattendedToolBlockReason("ask_user")).toContain("no human is present");
    expect(unattendedToolBlockReason("preview_write")).toContain("read-only");
    expect(unattendedToolBlockReason("save_memory")).toContain("cannot change stored memory");
    expect(unattendedToolBlockReason("create_checkpoint")).toContain("checkpoints and rollbacks");
    expect(unattendedToolBlockReason("manage_schedule")).toContain(
      "not part of the read-only tool surface",
    );
  });
});
