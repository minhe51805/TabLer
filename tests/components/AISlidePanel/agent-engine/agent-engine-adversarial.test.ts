import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Boundary-ONLY mocks: @tauri-apps/api/core (invoke) and @tauri-apps/api/event
// (listen). All internal agent-engine/* modules, aiStore, queryStore,
// tauri-error, tauri-utils, and ai-request-errors run REAL code.
// ---------------------------------------------------------------------------

interface RecordedInvokeCall {
  command: string;
  args: Record<string, unknown> | undefined;
}

type StreamEventListener = (event: { payload: Record<string, unknown> }) => void;

const invokeHandlerRef: {
  current: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
} = {
  current: async () => null,
};

const recordedInvokeCalls: RecordedInvokeCall[] = [];
const streamListeners = new Map<string, Set<StreamEventListener>>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
    const clonedArgs =
      args === undefined
        ? undefined
        : (JSON.parse(JSON.stringify(args)) as Record<string, unknown>);
    recordedInvokeCalls.push({ command, args: clonedArgs });
    return invokeHandlerRef.current(command, clonedArgs);
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (eventName: string, listener: StreamEventListener) => {
    let set = streamListeners.get(eventName);
    if (!set) {
      set = new Set();
      streamListeners.set(eventName, set);
    }
    set.add(listener);
    return () => {
      streamListeners.get(eventName)?.delete(listener);
    };
  }),
}));

import { AI_REQUEST_REPLACED_MESSAGE } from "@/components/AISlidePanel/ai-agent-action-requestor";
import {
  runAgentAssist,
  type AgentAssistContext,
} from "@/components/AISlidePanel/ai-agent-generate";
import { parseCanonicalToolCall } from "@/components/AISlidePanel/ai-agent-tools";
import { invalidateAgentSchemaSummary } from "@/components/AISlidePanel/ai-schema-summary";
import { invalidateAgentMemoryIndex } from "@/components/AISlidePanel/hooks/use-agent-memory";
import { useAIStore } from "@/stores/aiStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { useSafeModeStore } from "@/stores/safeModeStore";
import type { AIProviderConfig, TableInfo } from "@/types";
import { setAIFailoverConsent } from "@/utils/ai-failover-consent";
import { clearQueryResultCache } from "@/utils/query-result-cache";

function emitTauriEvent(eventName: string, payload: Record<string, unknown>) {
  const listeners = streamListeners.get(eventName);
  if (!listeners) return;
  for (const listener of [...listeners]) {
    listener({ payload });
  }
}

const openAiPrimary: AIProviderConfig = {
  id: "openai-primary",
  name: "OpenAI",
  provider_type: "openai",
  endpoint: "https://api.openai.com",
  model: "gpt-4o",
  models: ["gpt-4o", "gpt-4o-mini", "gpt-4.1"],
  is_enabled: true,
  is_primary: true,
  allow_schema_context: true,
  allow_inline_completion: true,
};

const anthropicSecondary: AIProviderConfig = {
  id: "anthropic-secondary",
  name: "Anthropic",
  provider_type: "anthropic",
  endpoint: "https://api.anthropic.com",
  model: "claude-sonnet-4-5",
  is_enabled: true,
  is_primary: false,
  allow_schema_context: true,
  allow_inline_completion: false,
};

const sampleTables: TableInfo[] = [
  { name: "users", schema: "public", table_type: "BASE TABLE", row_count: 42 },
  { name: "orders", schema: "public", table_type: "BASE TABLE", row_count: 150 },
];

function createRealAgentContext(overrides: Partial<AgentAssistContext> = {}): {
  ctx: AgentAssistContext;
  getIsGenerating: () => boolean;
  getLastError: () => string | null;
} {
  let isGenerating = false;
  let lastError: string | null = null;
  const queryStore = useQueryStore.getState();

  const ctx: AgentAssistContext = {
    activeDbType: "postgresql",
    activeProvider: openAiPrimary,
    askAI: (...args) => useAIStore.getState().askAI(...args),
    // Omit askAIAgentTurn so runAgentAssist exercises its default useAIStore.getState().askAIAgentTurn path.
    cancelAIRequest: () => useAIStore.getState().cancelAIRequest(),
    connectionId: "conn-1",
    currentDatabase: "appdb",
    executeAgentParameterizedQuery: queryStore.executeAgentParameterizedQuery,
    executeAgentReadonlyQuery: queryStore.executeAgentReadonlyQuery,
    executeSandboxQuery: queryStore.executeSandboxQuery,
    fetchTables: vi.fn().mockResolvedValue(undefined),
    getTableColumnsPreview: queryStore.getTableColumnsPreview,
    getTableData: queryStore.getTableData,
    getTableStructure: queryStore.getTableStructure,
    isLocalProvider: false,
    listCheckpoints: async () => [],
    previewWriteTransaction: queryStore.previewWriteTransaction,
    restoreCheckpoint: async () => undefined,
    setError: (message) => {
      lastError = message;
    },
    setIsGenerating: (generating) => {
      isGenerating = generating;
    },
    requestIdRef: { current: 0 },
    lastReasoningRef: { current: undefined },
    lastModelUsedRef: { current: undefined },
    aiSchemaCodecCacheRef: { current: new Map() },
    ...overrides,
  };

  return {
    ctx,
    getIsGenerating: () => isGenerating,
    getLastError: () => lastError,
  };
}

function defaultStorageAndSchemaHandler(command: string, args?: Record<string, unknown>): unknown {
  switch (command) {
    case "get_table_columns_preview":
      return [
        { name: "id", data_type: "integer", is_nullable: false, is_primary_key: true },
        { name: "email", data_type: "text", is_nullable: false, is_primary_key: false },
      ];
    case "get_table_structure":
      return {
        columns: [
          { name: "id", data_type: "integer", is_nullable: false, is_primary_key: true },
          { name: "email", data_type: "text", is_nullable: false, is_primary_key: false },
        ],
        indexes: [],
        foreign_keys: [],
      };
    case "get_semantic_entries":
    case "list_agent_memory":
      return [];
    case "list_ai_skills":
      return { skills: [] };
    case "save_agent_trace":
      return "ok";
    case "cancel_ai_request":
      return true;
    case "save_ai_configs":
      return [(args?.providers as AIProviderConfig[]) ?? [], {}];
    case "classify_sql_safety": {
      const sql = String(args?.sql ?? "");
      const readOnly = /^\s*(SELECT|EXPLAIN|SHOW|WITH|DESCRIBE)\b/i.test(sql);
      return {
        statements: [{ sql, kind: readOnly ? "read" : "write", readOnly }],
        readOnly,
        hasSchemaMutation: false,
        parseError: null,
      };
    }
    case "execute_agent_readonly_query":
      return {
        columns: [
          { name: "total", data_type: "bigint", is_nullable: false, is_primary_key: false },
        ],
        rows: [[42]],
        affected_rows: 0,
        execution_time_ms: 4,
        query: String((args?.statements as string[] | undefined)?.[0] ?? ""),
        sandboxed: true,
        truncated: false,
      };
    case "execute_sandboxed_query":
      return {
        columns: [
          { name: "total", data_type: "bigint", is_nullable: false, is_primary_key: false },
        ],
        rows: [[42]],
        affected_rows: 0,
        execution_time_ms: 5,
        query: String((args?.statements as string[] | undefined)?.[0] ?? ""),
        sandboxed: true,
        truncated: false,
      };
    default:
      throw new Error(`Unexpected Tauri IPC command in test: ${command}`);
  }
}

describe("agent-engine adversarial IPC wire & store integration", () => {
  beforeEach(() => {
    recordedInvokeCalls.length = 0;
    streamListeners.clear();
    window.localStorage.clear();
    clearQueryResultCache();
    invalidateAgentSchemaSummary();
    invalidateAgentMemoryIndex();
    window.dispatchEvent(new Event("agent-skills-changed"));

    useAIStore.setState({
      aiConfigs: [openAiPrimary],
      activeStreams: {},
      activeAIRequestId: null,
      requestPhase: "idle",
      streamingText: "",
      streamingReasoning: false,
      streamingReasoningText: "",
      streamingUsage: null,
      isProviderFailingOver: false,
    });

    useConnectionStore.setState({
      connections: [
        {
          id: "conn-1",
          name: "Local PG",
          db_type: "postgresql",
          host: "localhost",
          port: 5432,
          database: "appdb",
          username: "postgres",
          use_ssl: false,
          ssl_mode: "disable",
        },
      ],
      activeConnectionId: "conn-1",
      currentDatabase: "appdb",
      tables: sampleTables,
      databases: [{ name: "appdb" }],
    });

    useSafeModeStore.setState({
      settings: {
        globalLevel: 1,
        connectionOverrides: [],
        connectionEnvironments: {},
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("drives a 3-turn multi-tool native loop, preserves 1:1 agent_turns + thought_signature, and exposes missing maxRows on validateSql", async () => {
    let agentTurnIndex = 0;
    const capturedAgentRequests: Array<Record<string, unknown>> = [];

    invokeHandlerRef.current = async (command, args) => {
      if (command === "ask_ai_stream") {
        const req = (args?.request ?? {}) as Record<string, unknown>;
        if (req.intent !== "agent") {
          // Planning call emitted by turn-driver before the tool loop starts.
          return {
            text: "1. Inspect tables\n2. Count users",
            tool_calls: [],
            usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
          };
        }

        agentTurnIndex += 1;
        capturedAgentRequests.push(req);

        if (agentTurnIndex === 1) {
          return {
            text: "Listing tables and describing users.",
            reasoning: "Need schema confirmation first.",
            thought_signature: "sig-turn-1",
            tool_calls: [
              { id: "call_t1_list", name: "list_tables", arguments: {} },
              { id: "call_t1_desc", name: "describe_table", arguments: { table: "users" } },
            ],
            usage: { input_tokens: 100, output_tokens: 40, total_tokens: 140 },
          };
        }

        if (agentTurnIndex === 2) {
          return {
            text: "Running count query on public.users.",
            thought_signature: "sig-turn-2",
            tool_calls: [
              {
                id: "call_t2_sql",
                name: "run_readonly_sql",
                arguments: { sql: "SELECT COUNT(*) AS total FROM public.users" },
              },
            ],
            usage: { input_tokens: 180, output_tokens: 30, total_tokens: 210 },
          };
        }

        return {
          text: '{"action":"finish","args":{"response":"There are 42 users.","sql":"SELECT COUNT(*) AS total FROM public.users"}}',
          tool_calls: [
            {
              id: "call_t3_finish",
              name: "finish",
              arguments: {
                response: "There are 42 users.",
                sql: "SELECT COUNT(*) AS total FROM public.users",
              },
            },
          ],
          usage: { input_tokens: 220, output_tokens: 35, total_tokens: 255 },
        };
      }
      return defaultStorageAndSchemaHandler(command, args);
    };

    const { ctx } = createRealAgentContext();
    const result = await runAgentAssist(ctx, "How many users are in the database?", [], {
      interactionMode: "agent",
      requestDataReadConsent: vi.fn().mockResolvedValue(true),
    });

    expect(agentTurnIndex).toBe(3);
    expect(result.sql).toBe("SELECT COUNT(*) AS total FROM public.users");
    expect(result.rawResponse).toContain("There are 42 users.");

    // Turn 1 sends the initial prompt without agent_turns.
    expect(capturedAgentRequests[0].agent_turns).toBeUndefined();
    expect(String(capturedAgentRequests[0].prompt)).toContain(
      "How many users are in the database?",
    );

    // Turn 2: inspect exact IPC `request.agent_turns`.
    // Note: the initial user turn is carried by `request.prompt` (Rust `AIRequest::prompt`),
    // so `request.agent_turns` begins directly with the Turn 1 assistant turn followed by 1:1 tool_result turns.
    const turn2Turns = capturedAgentRequests[1].agent_turns as Array<Record<string, unknown>>;
    expect(String(capturedAgentRequests[1].prompt)).toContain(
      "How many users are in the database?",
    );
    expect(Array.isArray(turn2Turns)).toBe(true);
    expect(turn2Turns).toHaveLength(3);
    expect(turn2Turns[0]).toMatchObject({
      role: "assistant",
      thought_signature: "sig-turn-1",
      tool_calls: [
        { id: "call_t1_list", name: "list_tables", arguments: {} },
        { id: "call_t1_desc", name: "describe_table", arguments: { table: "users" } },
      ],
    });
    expect(turn2Turns[1]).toMatchObject({
      role: "tool_result",
      call_id: "call_t1_list",
      tool_name: "list_tables",
    });
    expect(turn2Turns[2]).toMatchObject({
      role: "tool_result",
      call_id: "call_t1_desc",
      tool_name: "describe_table",
    });

    // Turn 3 carries both Turn 1 and Turn 2 atomic groups with exact 1:1 call_id pairing in order.
    const turn3Turns = capturedAgentRequests[2].agent_turns as Array<Record<string, unknown>>;
    expect(turn3Turns).toHaveLength(5);
    expect(turn3Turns.map((t) => t.role)).toEqual([
      "assistant",
      "tool_result",
      "tool_result",
      "assistant",
      "tool_result",
    ]);
    expect(turn3Turns[3]).toMatchObject({
      role: "assistant",
      thought_signature: "sig-turn-2",
      tool_calls: [
        {
          id: "call_t2_sql",
          name: "run_readonly_sql",
          arguments: { sql: "SELECT COUNT(*) AS total FROM public.users" },
        },
      ],
    });
    expect(turn3Turns[4]).toMatchObject({
      role: "tool_result",
      call_id: "call_t2_sql",
      tool_name: "run_readonly_sql",
    });

    // Inspect post-run-pipeline `validateSql` -> `execute_sandboxed_query` IPC payload.
    const sandboxCalls = recordedInvokeCalls.filter((c) => c.command === "execute_sandboxed_query");
    expect(sandboxCalls).toHaveLength(1);
    const sandboxArgs = sandboxCalls[0].args!;
    expect(sandboxArgs.connectionId).toBe("conn-1");
    expect(sandboxArgs.statements).toEqual(["SELECT COUNT(*) AS total FROM public.users"]);
    expect(sandboxArgs.requireReadOnly).toBe(true);
    // EXPECTED CONTRACT (currently RED — bug in post-run-pipeline.ts:191 -> queryStore.ts:401):
    // Agent SQL validation must pass `maxRows` so Rust `execute_sandboxed_query` enters
    // `SandboxCallerScope::Agent` and enforces `SANDBOX_AGENT_MAX_ROWS`.
    expect(sandboxArgs.maxRows).toEqual(expect.any(Number));
    expect(sandboxArgs.maxRows).toBeGreaterThan(0);
  });

  it("gates mid-run Turn 2 503 failover on SEC-T04 consent and preserves full agent_turns when approved", async () => {
    useAIStore.setState({ aiConfigs: [openAiPrimary, anthropicSecondary] });

    // --- Part A: SEC-T04 consent = false -> must NOT call secondary provider ---
    setAIFailoverConsent("declined");
    let turnCountDeclined = 0;
    const providerCallsDeclined: Array<{ providerId: unknown; intent: unknown }> = [];

    invokeHandlerRef.current = async (command, args) => {
      if (command === "ask_ai_stream") {
        const req = (args?.request ?? {}) as Record<string, unknown>;
        providerCallsDeclined.push({ providerId: req.provider_id, intent: req.intent });
        if (req.intent !== "agent") {
          return { text: "1. List tables", tool_calls: [] };
        }
        turnCountDeclined += 1;
        if (turnCountDeclined === 1) {
          return {
            text: "Listing tables.",
            thought_signature: "sig-declined-1",
            tool_calls: [{ id: "call_d1", name: "list_tables", arguments: {} }],
          };
        }
        // Raw Rust AppError JSON (NO `new Error(...)`).
        throw {
          code: "ai-provider-transient",
          message: "503 Service Unavailable",
          retryable: true,
        };
      }
      return defaultStorageAndSchemaHandler(command, args);
    };

    const declinedSetup = createRealAgentContext();
    const declinedResult = await runAgentAssist(
      declinedSetup.ctx,
      "Show me the tables and count rows in users",
      [],
      { interactionMode: "agent" },
    );

    expect(
      providerCallsDeclined.filter((c) => c.providerId === "anthropic-secondary"),
    ).toHaveLength(0);
    expect(declinedResult.failoverNotes?.length ?? 0).toBeGreaterThanOrEqual(1);

    // --- Part B: SEC-T04 consent = true -> fails over to secondary WITH full agent_turns preserved ---
    recordedInvokeCalls.length = 0;
    invalidateAgentSchemaSummary();
    invalidateAgentMemoryIndex();
    useAIStore.setState({ aiConfigs: [openAiPrimary, anthropicSecondary] });
    setAIFailoverConsent("approved");

    let turnCountApproved = 0;
    let secondaryFailoverRequest: Record<string, unknown> | undefined;

    invokeHandlerRef.current = async (command, args) => {
      if (command === "ask_ai_stream") {
        const req = (args?.request ?? {}) as Record<string, unknown>;
        if (req.intent !== "agent") {
          return { text: "1. Inspect users", tool_calls: [] };
        }
        if (req.provider_id === "openai-primary") {
          turnCountApproved += 1;
          if (turnCountApproved === 1) {
            return {
              text: "Checking tables and users schema.",
              thought_signature: "sig-turn-1",
              tool_calls: [
                { id: "call_f1", name: "list_tables", arguments: {} },
                { id: "call_f2", name: "describe_table", arguments: { table: "users" } },
              ],
            };
          }
          throw {
            code: "ai-provider-transient",
            message: "503 Service Unavailable",
            retryable: true,
          };
        }
        if (req.provider_id === "anthropic-secondary") {
          secondaryFailoverRequest ??= req;
          return {
            text: '{"action":"finish","args":{"response":"Users listed on backup provider.","sql":"SELECT id FROM public.users LIMIT 5"}}',
            tool_calls: [
              {
                id: "call_backup_finish",
                name: "finish",
                arguments: {
                  response: "Users listed on backup provider.",
                  sql: "SELECT id FROM public.users LIMIT 5",
                },
              },
            ],
          };
        }
      }
      return defaultStorageAndSchemaHandler(command, args);
    };

    const approvedSetup = createRealAgentContext();
    const approvedResult = await runAgentAssist(
      approvedSetup.ctx,
      "Write a SELECT query for users",
      [],
      {
        interactionMode: "agent",
        requestDataReadConsent: vi.fn().mockResolvedValue(true),
      },
    );

    expect(secondaryFailoverRequest).toBeDefined();
    expect(secondaryFailoverRequest?.provider_id).toBe("anthropic-secondary");
    const failoverTurns = secondaryFailoverRequest?.agent_turns as Array<Record<string, unknown>>;
    expect(failoverTurns).toHaveLength(3);
    expect(failoverTurns[0]).toMatchObject({
      role: "assistant",
      thought_signature: "sig-turn-1",
      tool_calls: [
        { id: "call_f1", name: "list_tables", arguments: {} },
        { id: "call_f2", name: "describe_table", arguments: { table: "users" } },
      ],
    });
    expect(failoverTurns[1]).toMatchObject({
      role: "tool_result",
      call_id: "call_f1",
      tool_name: "list_tables",
    });
    expect(failoverTurns[2]).toMatchObject({
      role: "tool_result",
      call_id: "call_f2",
      tool_name: "describe_table",
    });
    expect(approvedResult.sql).toBe("SELECT id FROM public.users LIMIT 5");
    expect(useAIStore.getState().aiConfigs.find((c) => c.id === "openai-primary")?.is_primary).toBe(
      true,
    );
    expect(recordedInvokeCalls.filter((c) => c.command === "save_ai_configs")).toHaveLength(0);
  }, 15_000);

  it("aborts both askAIAgentTurn and runAgentAssist after 1 invoke on ai-auth across 3 catalog models", async () => {
    // Primary provider has 3 catalog models configured and NO fallback provider.
    useAIStore.setState({ aiConfigs: [openAiPrimary] });

    invokeHandlerRef.current = async (command, args) => {
      if (command === "ask_ai_stream") {
        throw {
          code: "ai-auth",
          message: "401 Invalid API key",
          retryable: false,
        };
      }
      return defaultStorageAndSchemaHandler(command, args);
    };

    // 1. Direct useAIStore.getState().askAIAgentTurn: MUST call ask_ai_stream ONLY ONCE.
    await expect(
      useAIStore.getState().askAIAgentTurn("List tables", "DB=appdb", []),
    ).rejects.toMatchObject({
      code: "provider",
      backendCode: "ai-auth",
      retryable: false,
    });

    const directStreamCalls = recordedInvokeCalls.filter((c) => c.command === "ask_ai_stream");
    expect(directStreamCalls).toHaveLength(1);
    expect((directStreamCalls[0].args?.request as Record<string, unknown>).model).toBe("gpt-4o");

    // 2. Full `runAgentAssist` must fast-abort on `ai-auth` (401) during planning without
    //    falling through into Turn 1, recoverAgentFinishAction, or wasting extra calls.
    recordedInvokeCalls.length = 0;
    const { ctx } = createRealAgentContext();
    await expect(
      runAgentAssist(ctx, "Count users", [], {
        interactionMode: "agent",
      }),
    ).rejects.toMatchObject({
      code: "provider",
      backendCode: "ai-auth",
      retryable: false,
    });
    const assistStreamCalls = recordedInvokeCalls.filter((c) => c.command === "ask_ai_stream");
    expect(assistStreamCalls).toHaveLength(1);
  });

  it("aborts immediately on local rate-limited (even with retryable: true & retryAfterMs: 1200) without failover storm", async () => {
    useAIStore.setState({ aiConfigs: [openAiPrimary, anthropicSecondary] });
    setAIFailoverConsent("approved");

    invokeHandlerRef.current = async (command, args) => {
      if (command === "ask_ai_stream") {
        const req = (args?.request ?? {}) as Record<string, unknown>;
        if (req.intent !== "agent") {
          return { text: "1. List tables", tool_calls: [] };
        }
        throw {
          code: "rate-limited",
          message: "Too many requests",
          retryable: true,
          retryAfterMs: 1200,
        };
      }
      return defaultStorageAndSchemaHandler(command, args);
    };

    // 1. Direct askAIAgentTurn aborts after 1 invoke call (no retry sleep, no model fallback, no cross-provider failover).
    const startedAt = Date.now();
    await expect(
      useAIStore.getState().askAIAgentTurn("List tables", "DB=appdb", []),
    ).rejects.toMatchObject({
      code: "provider",
      backendCode: "rate-limited",
      retryable: false,
      providerRetryAfterMs: 1200,
    });
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(recordedInvokeCalls.filter((c) => c.command === "ask_ai_stream")).toHaveLength(1);

    // 2. Full runAgentAssist aborts Turn 1 immediately after 1 controller invoke call (turn-driver.ts:1049).
    recordedInvokeCalls.length = 0;
    const { ctx, getLastError } = createRealAgentContext();
    await expect(
      runAgentAssist(ctx, "Count users", [], { interactionMode: "agent" }),
    ).rejects.toMatchObject({
      backendCode: "rate-limited",
      providerRetryAfterMs: 1200,
    });

    const controllerCalls = recordedInvokeCalls
      .filter((c) => c.command === "ask_ai_stream")
      .filter((c) => (c.args?.request as Record<string, unknown>).intent === "agent");
    expect(controllerCalls).toHaveLength(1);
    expect(getLastError()).toBe("Too many requests");
  });

  it("isolates foreground panel stream (fg-1) from interleaved background trackInPanel:false stream (bg-1)", async () => {
    const uuidQueue = ["plan-1", "fg-1", "bg-1"];
    vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(
      () =>
        (uuidQueue.shift() ?? "extra-uuid") as `${string}-${string}-${string}-${string}-${string}`,
    );

    let resolveFgStream: ((value: unknown) => void) | undefined;
    let resolveBgStream: ((value: unknown) => void) | undefined;
    let fgStartedResolve: (() => void) | undefined;
    let bgStartedResolve: (() => void) | undefined;
    const fgStarted = new Promise<void>((resolve) => {
      fgStartedResolve = resolve;
    });
    const bgStarted = new Promise<void>((resolve) => {
      bgStartedResolve = resolve;
    });

    invokeHandlerRef.current = async (command, args) => {
      if (command === "ask_ai_stream") {
        const req = (args?.request ?? {}) as Record<string, unknown>;
        const requestId = String(req.request_id ?? "");
        if (requestId === "plan-1") {
          return { text: "1. Answer question", tool_calls: [] };
        }
        if (requestId === "fg-1") {
          fgStartedResolve?.();
          return await new Promise((resolve) => {
            resolveFgStream = resolve;
          });
        }
        if (requestId === "bg-1") {
          bgStartedResolve?.();
          return await new Promise((resolve) => {
            resolveBgStream = resolve;
          });
        }
      }
      return defaultStorageAndSchemaHandler(command, args);
    };

    const { ctx, getIsGenerating } = createRealAgentContext();

    const fgPromise = runAgentAssist(ctx, "How many users are in the database?", [], {
      interactionMode: "agent",
      requestDataReadConsent: vi.fn().mockResolvedValue(true),
    });

    await fgStarted;
    expect(getIsGenerating()).toBe(true);
    expect(useAIStore.getState().activeAIRequestId).toBe("fg-1");
    expect(useAIStore.getState().requestPhase).toBe("requesting");

    // Emit initial foreground chunks for `fg-1`.
    emitTauriEvent("ai-stream-event", {
      requestId: "fg-1",
      kind: "reasoning_delta",
      text: "Thinking about users count...",
    });
    emitTauriEvent("ai-stream-event", {
      requestId: "fg-1",
      kind: "text_delta",
      text: '{"action":"finish","args":{"response":"Use SELECT COUNT(*) ',
    });

    expect(useAIStore.getState().streamingText).toBe("Use SELECT COUNT(*) ");
    expect(useAIStore.getState().streamingReasoning).toBe(true);
    expect(useAIStore.getState().streamingReasoningText).toBe("Thinking about users count...");

    // Start overlapping background `trackInPanel: false` agent turn (`bg-1`).
    const bgPromise = useAIStore
      .getState()
      .askAIAgentTurn("Summarize table", "ctx", [], undefined, {
        trackInPanel: false,
      });
    await bgStarted;

    // Interleave events across BOTH active streams while both are in-flight.
    emitTauriEvent("ai-stream-event", {
      requestId: "bg-1",
      kind: "reasoning_delta",
      text: "Background private reasoning",
    });
    emitTauriEvent("ai-stream-event", {
      requestId: "bg-1",
      kind: "text_delta",
      text: '{"action":"finish","args":{"response":"Background helper summary"}}',
    });
    emitTauriEvent("ai-stream-event", {
      requestId: "bg-1",
      kind: "usage",
      usage: { input_tokens: 15, output_tokens: 5, total_tokens: 20 },
    });
    emitTauriEvent("ai-stream-event", {
      requestId: "fg-1",
      kind: "text_delta",
      text: "from ",
    });
    emitTauriEvent("ai-stream-event", {
      requestId: "bg-1",
      kind: "done",
    });

    // Resolve `bg-1` FIRST while `fg-1` is still in-flight.
    resolveBgStream?.({
      text: '{"action":"finish","args":{"response":"Background helper summary"}}',
      tool_calls: [
        {
          id: "call_bg_done",
          name: "finish",
          arguments: { response: "Background helper summary" },
        },
      ],
      usage: { input_tokens: 15, output_tokens: 5, total_tokens: 20 },
    });
    const bgResult = await bgPromise;
    expect(bgResult.text).toBe(
      '{"action":"finish","args":{"response":"Background helper summary"}}',
    );

    // Assert foreground state remains completely intact after `bg-1` finished!
    expect(getIsGenerating()).toBe(true);
    expect(useAIStore.getState().activeAIRequestId).toBe("fg-1");
    expect(useAIStore.getState().requestPhase).toBe("requesting");
    expect(useAIStore.getState().streamingText).toBe("Use SELECT COUNT(*) from ");
    expect(useAIStore.getState().streamingReasoning).toBe(true);
    expect(useAIStore.getState().streamingReasoningText).toBe("Thinking about users count...");
    expect(useAIStore.getState().streamingUsage).toBeNull();
    expect(useAIStore.getState().activeStreams["bg-1"]).toBeUndefined();
    expect(useAIStore.getState().activeStreams["fg-1"]).toBeDefined();

    // Finish foreground stream `fg-1`.
    emitTauriEvent("ai-stream-event", {
      requestId: "fg-1",
      kind: "text_delta",
      text: 'public.users."}}',
    });
    emitTauriEvent("ai-stream-event", {
      requestId: "fg-1",
      kind: "done",
    });
    resolveFgStream?.({
      text: '{"action":"finish","args":{"response":"Use SELECT COUNT(*) from public.users.","sql":"SELECT COUNT(*) AS total FROM public.users"}}',
      tool_calls: [
        {
          id: "call_fg_done",
          name: "finish",
          arguments: {
            response: "Use SELECT COUNT(*) from public.users.",
            sql: "SELECT COUNT(*) AS total FROM public.users",
          },
        },
      ],
      usage: { input_tokens: 50, output_tokens: 20, total_tokens: 70 },
    });

    const fgResult = await fgPromise;
    expect(fgResult.rawResponse).toBe("Use SELECT COUNT(*) from public.users.");
    expect(fgResult.sql).toBe("SELECT COUNT(*) AS total FROM public.users");
    expect(getIsGenerating()).toBe(false);
    expect(useAIStore.getState().requestPhase).toBe("idle");
    expect(useAIStore.getState().activeAIRequestId).toBeNull();
  });

  it("aborts cleanly without firing another turn when Stop occurs while awaiting requestDataReadConsent", async () => {
    useAIStore.setState({ aiConfigs: [openAiPrimary] });
    let agentTurnCalls = 0;
    let resolveConsent: ((approved: boolean) => void) | undefined;

    invokeHandlerRef.current = async (command, args) => {
      if (command === "ask_ai_stream") {
        const req = (args?.request ?? {}) as Record<string, unknown>;
        if (req.intent !== "agent") {
          return { text: "1. Describe users, then query rows", tool_calls: [] };
        }
        agentTurnCalls += 1;
        if (agentTurnCalls === 1) {
          return {
            text: "Describing users first.",
            tool_calls: [
              {
                id: "call_desc_stop",
                name: "describe_table",
                arguments: { table: "users" },
              },
            ],
          };
        }
        return {
          text: "Running readonly query.",
          tool_calls: [
            {
              id: "call_sql_stop",
              name: "run_readonly_sql",
              arguments: { sql: "SELECT id FROM public.users LIMIT 5" },
            },
          ],
        };
      }
      return defaultStorageAndSchemaHandler(command, args);
    };

    let markConsentPending: (() => void) | undefined;
    const consentPendingPromise = new Promise<void>((resolve) => {
      markConsentPending = resolve;
    });

    const { ctx } = createRealAgentContext();
    const runPromise = runAgentAssist(ctx, "Show users summary", [], {
      interactionMode: "agent",
      requestDataReadConsent: () => {
        markConsentPending?.();
        return new Promise<boolean>((resolve) => {
          resolveConsent = resolve;
        });
      },
    });

    await consentPendingPromise;
    expect(agentTurnCalls).toBe(2);

    // Simulate user clicking Stop: bump requestIdRef, cancel store request, and settle pending consent as denied.
    ctx.requestIdRef.current += 1;
    void ctx.cancelAIRequest();
    resolveConsent?.(false);

    await expect(runPromise).rejects.toThrow(AI_REQUEST_REPLACED_MESSAGE);
    // Must NEVER fire a third agent ask_ai_stream turn after Stop!
    expect(agentTurnCalls).toBe(2);
    expect(recordedInvokeCalls.filter((c) => c.command === "execute_readonly_query")).toHaveLength(
      0,
    );
  });

  it("aborts runAgentAssist immediately when rate-limited occurs during plan and when ai-cancelled occurs without manual switch", async () => {
    useAIStore.setState({ aiConfigs: [openAiPrimary, anthropicSecondary] });
    setAIFailoverConsent("approved");

    // 1. rate-limited during plan -> 1 ask_ai_stream call total (must NOT proceed to Turn 1).
    invokeHandlerRef.current = async (command, args) => {
      if (command === "ask_ai_stream") {
        throw {
          code: "rate-limited",
          message: "Too many requests during planning",
          retryable: true,
          retryAfterMs: 900,
        };
      }
      return defaultStorageAndSchemaHandler(command, args);
    };

    const planRateLimitSetup = createRealAgentContext();
    await expect(
      runAgentAssist(planRateLimitSetup.ctx, "Count orders", [], { interactionMode: "agent" }),
    ).rejects.toMatchObject({
      backendCode: "rate-limited",
      providerRetryAfterMs: 900,
    });
    expect(recordedInvokeCalls.filter((c) => c.command === "ask_ai_stream")).toHaveLength(1);

    // 2. ai-cancelled on Turn 1 WITHOUT manual provider switch -> aborts immediately (no silent retry).
    recordedInvokeCalls.length = 0;
    let turnCalls = 0;
    invokeHandlerRef.current = async (command, args) => {
      if (command === "ask_ai_stream") {
        const req = (args?.request ?? {}) as Record<string, unknown>;
        if (req.intent !== "agent") {
          return { text: "1. List tables", tool_calls: [] };
        }
        turnCalls += 1;
        throw {
          code: "ai-cancelled",
          message: "Request cancelled",
          retryable: true,
        };
      }
      return defaultStorageAndSchemaHandler(command, args);
    };

    const cancelSetup = createRealAgentContext();
    await expect(
      runAgentAssist(cancelSetup.ctx, "Count orders", [], { interactionMode: "agent" }),
    ).rejects.toMatchObject({
      code: "cancelled",
      backendCode: "ai-cancelled",
    });
    expect(turnCalls).toBe(1);
  });

  it("rejects non-object canonical tool arguments and malformed unparsedArguments explicitly instead of falling back to {}", async () => {
    expect(() =>
      parseCanonicalToolCall({
        id: "call_str",
        name: "list_tables",
        arguments: "not-an-object" as unknown as Record<string, unknown>,
      }),
    ).toThrow("invalid tool arguments");

    expect(() =>
      parseCanonicalToolCall({
        id: "call_arr",
        name: "list_tables",
        arguments: ["users"] as unknown as Record<string, unknown>,
      }),
    ).toThrow("invalid tool arguments");

    expect(() =>
      parseCanonicalToolCall({
        id: "call_null",
        name: "list_tables",
        arguments: null as unknown as Record<string, unknown>,
      }),
    ).toThrow("invalid tool arguments");

    expect(() =>
      parseCanonicalToolCall({
        id: "call_bad_unparsed_type",
        name: "list_tables",
        arguments: { unparsedArguments: 12345 },
      }),
    ).toThrow("malformed tool arguments");

    expect(() =>
      parseCanonicalToolCall({
        id: "call_bad_unparsed_str",
        name: "list_tables",
        arguments: { unparsedArguments: "definitely not json" },
      }),
    ).toThrow("malformed tool arguments");

    // End-to-end: single native tool call with non-object `arguments` triggers the 1x repair round
    // instead of silently executing `list_tables({})`.
    useAIStore.setState({ aiConfigs: [openAiPrimary] });
    let agentTurnCalls = 0;
    let repairPromptSawInvalidArgs = false;
    invokeHandlerRef.current = async (command, args) => {
      if (command === "ask_ai_stream") {
        const req = (args?.request ?? {}) as Record<string, unknown>;
        if (req.intent !== "agent") {
          return { text: "1. List tables", tool_calls: [] };
        }
        agentTurnCalls += 1;
        if (agentTurnCalls === 1) {
          return {
            text: "",
            tool_calls: [
              {
                id: "call_malformed_1",
                name: "list_tables",
                arguments: "raw-malformed-string",
              },
            ],
          };
        }
        if (agentTurnCalls === 2) {
          repairPromptSawInvalidArgs = String(req.prompt ?? "").includes("invalid tool arguments");
          return {
            text: "",
            tool_calls: [
              {
                id: "call_repaired_desc",
                name: "describe_table",
                arguments: { table: "users" },
              },
            ],
          };
        }
        return {
          text: '{"action":"finish","args":{"response":"Users table has id and email.","sql":"SELECT id FROM public.users LIMIT 5"}}',
          tool_calls: [
            {
              id: "call_repaired_finish",
              name: "finish",
              arguments: {
                response: "Users table has id and email.",
                sql: "SELECT id FROM public.users LIMIT 5",
              },
            },
          ],
        };
      }
      return defaultStorageAndSchemaHandler(command, args);
    };

    const { ctx } = createRealAgentContext();
    const repairedResult = await runAgentAssist(ctx, "Write a SELECT query for users", [], {
      interactionMode: "agent",
    });
    expect(agentTurnCalls).toBe(3);
    expect(repairPromptSawInvalidArgs).toBe(true);
    expect(repairedResult.rawResponse).toBe("Users table has id and email.");
    expect(repairedResult.sql).toBe("SELECT id FROM public.users LIMIT 5");
  });
});
