import { beforeEach, describe, expect, it, vi } from "vitest";
import hookSource from "@/components/AISlidePanel/hooks/use-ai-slide-panel.ts?raw";
import {
  getAgentMemoryIndex,
  invalidateAgentMemoryIndex,
} from "@/components/AISlidePanel/hooks/use-agent-memory";

vi.mock("@/utils/tauri-utils", () => ({
  invokeMutation: vi.fn(),
}));

import { invokeMutation } from "@/utils/tauri-utils";

const mockedInvoke = vi.mocked(invokeMutation);

beforeEach(() => {
  vi.clearAllMocks();
  invalidateAgentMemoryIndex();
});

describe("agent memory index wiring (use-agent-memory)", () => {
  it("returns undefined without touching the backend when workspace tools are off", async () => {
    const result = await getAgentMemoryIndex({
      workspaceToolsEnabled: false,
      connectionId: "conn-1",
      database: "appdb",
    });
    expect(result).toBeUndefined();
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it("fetches the index with the run's (connection, database) scope", async () => {
    mockedInvoke.mockResolvedValue([
      { name: "metric-definitions", description: "metrics", updatedAt: "2026-01-01T00:00:00Z" },
    ]);
    const entries = await getAgentMemoryIndex({
      workspaceToolsEnabled: true,
      connectionId: "conn-1",
      database: "appdb",
    });
    expect(entries).toHaveLength(1);
    expect(mockedInvoke).toHaveBeenCalledWith("list_agent_memory", {
      connectionId: "conn-1",
      database: "appdb",
    });
  });

  it("caches per scope: same scope reuses the cache, a new scope refetches", async () => {
    mockedInvoke.mockResolvedValue([]);
    await getAgentMemoryIndex({
      workspaceToolsEnabled: true,
      connectionId: "conn-1",
      database: "appdb",
    });
    await getAgentMemoryIndex({
      workspaceToolsEnabled: true,
      connectionId: "conn-1",
      database: "appdb",
    });
    expect(mockedInvoke).toHaveBeenCalledTimes(1);
    await getAgentMemoryIndex({
      workspaceToolsEnabled: true,
      connectionId: "conn-1",
      database: "other",
    });
    expect(mockedInvoke).toHaveBeenCalledTimes(2);
    expect(mockedInvoke).toHaveBeenLastCalledWith("list_agent_memory", {
      connectionId: "conn-1",
      database: "other",
    });
  });

  it("degrades to an empty index on backend failure and does not cache the failure", async () => {
    mockedInvoke.mockRejectedValueOnce("backend down");
    const failed = await getAgentMemoryIndex({
      workspaceToolsEnabled: true,
      connectionId: "conn-1",
      database: "appdb",
    });
    expect(failed).toEqual([]);
    mockedInvoke.mockResolvedValue([
      { name: "later", description: "", updatedAt: "2026-02-02T00:00:00Z" },
    ]);
    const retried = await getAgentMemoryIndex({
      workspaceToolsEnabled: true,
      connectionId: "conn-1",
      database: "appdb",
    });
    expect(retried).toHaveLength(1);
  });

  it("invalidateAgentMemoryIndex forces the next call to refetch", async () => {
    mockedInvoke.mockResolvedValue([]);
    await getAgentMemoryIndex({
      workspaceToolsEnabled: true,
      connectionId: "conn-1",
      database: "appdb",
    });
    invalidateAgentMemoryIndex("conn-1");
    await getAgentMemoryIndex({
      workspaceToolsEnabled: true,
      connectionId: "conn-1",
      database: "appdb",
    });
    expect(mockedInvoke).toHaveBeenCalledTimes(2);
  });
});

describe("memory seam pin (hook wiring tripwire)", () => {
  // Regression tripwire for the "great storage, forgotten wiring" bug class:
  // the seam between use-ai-slide-panel and the memory subsystem once broke
  // silently when a patch died mid-way. If any of these strings disappears
  // from the hook, the <agent_memory> index stops being injected or saves
  // land in the wrong scope — fail loudly here instead.
  it("fetches the memory index and passes it to the controller prompt", () => {
    expect(hookSource).toContain("getAgentMemoryIndex({");
    expect(hookSource).toContain("agentMemoryIndex,");
  });

  it("passes the run's memoryScope into the executor", () => {
    expect(hookSource).toContain(
      "memoryScope: { connectionId, database: currentDatabase ?? null },",
    );
  });
});
