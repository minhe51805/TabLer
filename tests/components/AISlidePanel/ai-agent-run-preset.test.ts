import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentToolAvailability } from "@/components/AISlidePanel/ai-agent-engine-gates";
import { ADMIN_PRESET_KINDS } from "@/utils/admin-query-presets";
import { AI_REQUEST_REPLACED_MESSAGE } from "@/components/AISlidePanel/ai-agent-action-requestor";
import type { AIAgentRunPresetArgs } from "@/components/AISlidePanel/ai-agent-tools";
import { mkDeps, parseObservation, runTool } from "./ai-agent-test-harness";

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

describe("run_preset", () => {
  it("is blocked when the engine sandbox cannot run presets", async () => {
    const deps = mkDeps({ dbType: "sqlite" });
    deps.toolAvailability = agentToolAvailability("sqlite");
    const obs = await runTool(deps, {
      action: "run_preset",
      args: { presetId: "process-list" },
    });
    expect(obs).toContain("Tool blocked");
    expect(obs).toContain("run_preset is not available on SQLite");
    expect(deps.executeReadonlyQuery).not.toHaveBeenCalled();
  });

  it("list mode enumerates every preset id with per-engine support flags", async () => {
    const deps = mkDeps({ dbType: "postgresql" });
    deps.toolAvailability = agentToolAvailability("postgresql");
    const obs = await runTool(deps, { action: "run_preset", args: { list: true } });
    const data = parseObservation(obs);
    const presets = data.availablePresets;
    expect(Array.isArray(presets)).toBe(true);
    if (!Array.isArray(presets)) return;
    const ids = presets.map((preset) =>
      typeof preset === "object" && preset !== null && "presetId" in preset
        ? preset.presetId
        : undefined,
    );
    expect(ids).toEqual([...ADMIN_PRESET_KINDS]);
    // Supported flags must be surfaced per preset for this engine.
    const serverInfo = presets.find(
      (preset) =>
        typeof preset === "object" &&
        preset !== null &&
        "presetId" in preset &&
        preset.presetId === "server-info",
    );
    expect(serverInfo).toMatchObject({ presetId: "server-info", supported: true });
    // Listing alone never executes SQL.
    expect(deps.executeReadonlyQuery).not.toHaveBeenCalled();
  });

  it("refuses a preset the engine does not support", async () => {
    const deps = mkDeps({ dbType: "sqlite" });
    deps.toolAvailability = agentToolAvailability("sqlite");
    // Force availability past the transport gate to reach the per-engine check.
    deps.toolAvailability = { ...deps.toolAvailability, presets: true };
    const obs = await runTool(deps, {
      action: "run_preset",
      // presetId's type union trails the real catalog; the executor accepts
      // any string and falls back for ids it does not recognize.
      args: { presetId: "kill-session" } as unknown as AIAgentRunPresetArgs,
    });
    expect(obs).toContain("Tool blocked");
    expect(obs).toContain("kill-session");
    expect(obs).toContain("no server-side sessions");
    expect(deps.executeReadonlyQuery).not.toHaveBeenCalled();
  });

  it("an unrecognized presetId falls back to process-list instead of running garbage", async () => {
    const deps = mkDeps({ dbType: "postgresql" });
    deps.toolAvailability = agentToolAvailability("postgresql");
    const obs = await runTool(deps, {
      action: "run_preset",
      args: { presetId: "definitely-not-a-preset" } as unknown as AIAgentRunPresetArgs,
    });
    const data = parseObservation(obs);
    expect(data.presetId).toBe("process-list");
    // It ran a real preset query, not the hallucinated id.
    expect(deps.executeReadonlyQuery).toHaveBeenCalledTimes(1);
    expect(data.note).toContain("pre-vetted");
  });

  it("executes a supported preset and summarizes like run_readonly_sql", async () => {
    const deps = mkDeps({ dbType: "postgresql" });
    deps.toolAvailability = agentToolAvailability("postgresql");
    const obs = await runTool(deps, {
      action: "run_preset",
      args: { presetId: "server-info" } as unknown as AIAgentRunPresetArgs,
    });
    const data = parseObservation(obs);
    expect(data.presetId).toBe("server-info");
    expect(deps.executeReadonlyQuery).toHaveBeenCalledTimes(1);
    // The executed statement is the preset's curated SQL, surfaced via frame.sql.
    const [callArgs] = vi.mocked(deps.executeReadonlyQuery).mock.calls;
    expect(callArgs?.[0]).toBe("conn-1");
    expect(String(callArgs?.[1]?.[0] ?? "")).not.toContain("{{");
  });

  it("consent denial blocks the preset before the backend call", async () => {
    const deps = mkDeps({ dbType: "postgresql" });
    deps.toolAvailability = agentToolAvailability("postgresql");
    deps.requestDataReadConsent = vi.fn().mockResolvedValue(false);
    const obs = await runTool(deps, {
      action: "run_preset",
      args: { presetId: "server-info" } as unknown as AIAgentRunPresetArgs,
    });
    expect(obs).toContain("Tool blocked");
    expect(obs).toContain("did not grant permission");
    expect(deps.executeReadonlyQuery).not.toHaveBeenCalled();
  });

  it("a superseded run never reaches the database", async () => {
    const deps = mkDeps({ dbType: "postgresql", requestId: 1, requestIdRef: { current: 2 } });
    deps.toolAvailability = agentToolAvailability("postgresql");
    await expect(
      runTool(deps, {
        action: "run_preset",
        args: { presetId: "server-info" } as unknown as AIAgentRunPresetArgs,
      }),
    ).rejects.toThrow(AI_REQUEST_REPLACED_MESSAGE);
    expect(deps.executeReadonlyQuery).not.toHaveBeenCalled();
  });
});
