import { beforeEach, describe, expect, it, vi } from "vitest";

// Boundary mock only: @tauri-apps/api/core + event (same pattern as the
// existing engine adversarial harness). The four Zustand stores the engine
// used to read directly are spied, and must NEVER be called during a turn.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => null),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => undefined),
}));

import {
  runAgentAssist,
  type AgentAssistContext,
} from "@/components/AISlidePanel/ai-agent-generate";
import { useAIAutonomyStore } from "@/stores/aiAutonomyStore";
import { useAIStore } from "@/stores/aiStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { useUIStore } from "@/stores/uiStore";

function mockContext(): AgentAssistContext {
  return {
    activeDbType: "postgresql",
    activeProvider: {
      id: "test-openai",
      name: "Test OpenAI",
      provider_type: "openai",
      endpoint: "https://api.openai.com/v1",
      model: "gpt-test",
      is_enabled: true,
      allow_schema_context: true,
      allow_inline_completion: true,
    },
    askAI: vi
      .fn()
      .mockResolvedValue(
        '{"action":"finish","args":{"response":"There are 42 users.","sql":"SELECT COUNT(*) FROM users"}}',
      ),
    cancelAIRequest: vi.fn().mockResolvedValue(undefined),
    connectionId: "conn-1",
    currentDatabase: "appdb",
    executeAgentParameterizedQuery: vi.fn().mockResolvedValue({ columns: [], rows: [] }),
    executeAgentReadonlyQuery: vi.fn().mockResolvedValue({ columns: [], rows: [] }),
    executeSandboxQuery: vi.fn().mockResolvedValue({ columns: [], rows: [] }),
    fetchTables: vi.fn().mockResolvedValue(undefined),
    getTableColumnsPreview: vi.fn().mockResolvedValue([]),
    getTableData: vi.fn().mockResolvedValue({ columns: [], rows: [] }),
    getTableStructure: vi.fn().mockResolvedValue({ columns: [], indexes: [], foreign_keys: [] }),
    isLocalProvider: false,
    listCheckpoints: vi.fn().mockResolvedValue([]),
    previewWriteTransaction: vi.fn().mockResolvedValue(undefined),
    restoreCheckpoint: vi.fn().mockResolvedValue(undefined),
    setError: vi.fn(),
    setIsGenerating: vi.fn(),
    requestIdRef: { current: 0 },
    lastReasoningRef: { current: undefined },
    lastModelUsedRef: { current: undefined },
    aiSchemaCodecCacheRef: { current: new Map() },
    // The seven new contract fields — all spies, none of which touches Zustand.
    getAutonomyForConnection: vi.fn().mockReturnValue("review"),
    listTabs: vi.fn().mockReturnValue([]),
    openQueryTab: vi.fn(),
    getDbTypeForConnection: vi.fn().mockReturnValue("postgresql"),
    getActiveAIRequestId: vi.fn().mockReturnValue(null),
    getAIConfigs: vi.fn().mockReturnValue([]),
    restoreProvider: vi.fn(),
  };
}

describe("agent engine DI contract — no direct Zustand reads during a turn", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("runs a turn without any getState call ORIGINATING from turn-driver.ts", async () => {
    // Other modules in the call chain (model transport, context loader,
    // runner) legitimately read Zustand. The guard this test exists for is
    // narrower and exact: NO getState call may have turn-driver.ts in its
    // stack. Capture originals BEFORE spying (otherwise the wrapper would
    // recurse into itself).
    const originals = {
      autonomy: useAIAutonomyStore.getState,
      ai: useAIStore.getState,
      connection: useConnectionStore.getState,
      ui: useUIStore.getState,
    };
    const stacksByStore: Record<string, string[]> = {};

    const capture = (name: string, original: () => any) => {
      stacksByStore[name] = [];
      return () => {
        stacksByStore[name].push(new Error().stack ?? "");
        return original();
      };
    };
    vi.spyOn(useAIAutonomyStore, "getState").mockImplementation(
      capture("useAIAutonomyStore", originals.autonomy),
    );
    vi.spyOn(useAIStore, "getState").mockImplementation(capture("useAIStore", originals.ai));
    vi.spyOn(useConnectionStore, "getState").mockImplementation(
      capture("useConnectionStore", originals.connection),
    );
    vi.spyOn(useUIStore, "getState").mockImplementation(capture("useUIStore", originals.ui));

    const result = await runAgentAssist(mockContext(), "How many users?", []);
    expect(result).toBeDefined();

    for (const [storeName, stacks] of Object.entries(stacksByStore)) {
      const driverFrames = stacks.filter((stack) => stack.includes("turn-driver"));
      expect(driverFrames, `${storeName}.getState was called from turn-driver.ts`).toEqual([]);
    }
  });
});
