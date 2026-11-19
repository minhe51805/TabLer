import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Profiler, memo, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
const listenMock = vi.fn();
const streamListeners: Array<(event: { payload: Record<string, unknown> }) => void> = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

interface ConversationRenderCapture {
  spyRenders: number;
  profilerCommits: Array<"mount" | "update" | "nested-update">;
  changedPropsPerRender: string[][];
  lastProps: Record<string, unknown> | null;
  reset: () => void;
}

const conversationCapture: ConversationRenderCapture = {
  spyRenders: 0,
  profilerCommits: [],
  changedPropsPerRender: [],
  lastProps: null,
  reset() {
    this.spyRenders = 0;
    this.profilerCommits = [];
    this.changedPropsPerRender = [];
    this.lastProps = null;
  },
};

vi.mock("@/components/AISlidePanel/AIConversationView", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/AISlidePanel/AIConversationView")>();
  const InstrumentedConversationView = memo(function InstrumentedConversationView(
    props: ComponentProps<typeof actual.AIConversationView>,
  ) {
    conversationCapture.spyRenders += 1;
    const record = props as unknown as Record<string, unknown>;
    if (conversationCapture.lastProps) {
      const prev = conversationCapture.lastProps;
      const changed = Object.keys(record).filter((key) => !Object.is(prev[key], record[key]));
      conversationCapture.changedPropsPerRender.push(changed);
    }
    conversationCapture.lastProps = { ...record };

    return (
      <Profiler
        id="AIConversationView"
        onRender={(_id, phase) => {
          conversationCapture.profilerCommits.push(phase);
        }}
      >
        <actual.AIConversationView {...props} />
      </Profiler>
    );
  });

  return {
    ...actual,
    AIConversationView: InstrumentedConversationView,
  };
});

import { AISlidePanel } from "@/components/AISlidePanel/AISlidePanel";
import {
  buildAIWorkspaceKey,
  type AIChatThread,
} from "@/components/AISlidePanel/ai-conversation-state";
import type { AIWorkspaceBubbleData } from "@/components/AISlidePanel/ai-workspace-types";
import {
  resetAIPanelStoreForTests,
  useAIPanelStore,
} from "@/components/AISlidePanel/store/aiPanelStore";
import { useAIChatWorkspaceStore } from "@/stores/aiChatWorkspaceStore";
import { useAIStore } from "@/stores/aiStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { useUIStore } from "@/stores/uiStore";
import type { AIProviderConfig, ConnectionConfig, TableInfo } from "@/types";

const CONNECTION_ID = "conn-adv-1";
const DATABASE_NAME = "analytics.db";
const WORKSPACE_KEY = buildAIWorkspaceKey(CONNECTION_ID, DATABASE_NAME, null);

const TEST_PROVIDER: AIProviderConfig = {
  id: "prov-adv-1",
  name: "OpenAI",
  provider_type: "openai",
  endpoint: "https://api.openai.com/v1",
  model: "gpt-4o",
  is_enabled: true,
  is_primary: true,
  allow_schema_context: true,
  allow_inline_completion: true,
};

const TEST_CONNECTION: ConnectionConfig = {
  id: CONNECTION_ID,
  name: "Analytics SQLite",
  db_type: "sqlite",
  host: "",
  port: 0,
  database: DATABASE_NAME,
  username: "",
  use_ssl: false,
};

const TEST_TABLES: TableInfo[] = [
  { name: "users", schema: "main", row_count: 120 } as TableInfo,
  { name: "orders", schema: "main", row_count: 540 } as TableInfo,
];

function makeThreads(): AIChatThread[] {
  return [
    {
      id: "thread-1",
      workspaceKey: WORKSPACE_KEY,
      label: "Users & Orders Analysis",
      createdAt: 1_000,
      updatedAt: 6_000,
      isAutoLabel: false,
    },
    {
      id: "thread-2",
      workspaceKey: WORKSPACE_KEY,
      label: "Revenue Cohort",
      createdAt: 2_000,
      updatedAt: 5_000,
      isAutoLabel: false,
    },
  ];
}

function makeSixRealisticBubbles(): AIWorkspaceBubbleData[] {
  return [
    {
      id: "b-1",
      threadId: "thread-1",
      workspaceKey: WORKSPACE_KEY,
      interactionMode: "agent",
      kind: "assistant",
      status: "ready",
      title: "Users schema",
      subtitle: "OpenAI",
      prompt: "Show me the users table columns",
      promptSummary: "Show me the users table columns",
      preview: "The users table has id, email, created_at.",
      detail: "The `users` table contains `id`, `email`, and `created_at`.",
      x: 0,
      y: 0,
      pointer: { visible: false, x: 0, y: 0 },
      createdAt: 1_000,
      settledAt: 1_400,
      tokensUsed: 180,
      modelUsed: "gpt-4o",
    },
    {
      id: "b-2",
      threadId: "thread-1",
      workspaceKey: WORKSPACE_KEY,
      interactionMode: "agent",
      kind: "assistant",
      status: "ready",
      title: "Active users SQL",
      subtitle: "OpenAI",
      prompt: "List recent active users",
      promptSummary: "List recent active users",
      preview: "SELECT id, email FROM users ORDER BY created_at DESC LIMIT 20;",
      detail: "Here is a query for the 20 most recently created users.",
      sql: "SELECT id, email FROM users ORDER BY created_at DESC LIMIT 20;",
      risk: { level: "safe", reason: "Read-only SELECT" },
      x: 0,
      y: 0,
      pointer: { visible: false, x: 0, y: 0 },
      createdAt: 2_000,
      settledAt: 2_500,
      tokensUsed: 240,
      modelUsed: "gpt-4o",
    },
    {
      id: "b-3",
      threadId: "thread-1",
      workspaceKey: WORKSPACE_KEY,
      interactionMode: "agent",
      kind: "result",
      status: "ready",
      title: "Order count",
      subtitle: "Sandbox query",
      prompt: "How many paid orders do we have?",
      promptSummary: "How many paid orders do we have?",
      preview: "540 paid orders found.",
      detail: "There are **540** paid orders in `orders`.",
      agentSteps: [
        {
          step: 1,
          action: "run_readonly_sql",
          message: "Count paid orders",
          observation: "540 rows",
          status: "done",
        },
      ],
      x: 0,
      y: 0,
      pointer: { visible: false, x: 0, y: 0 },
      createdAt: 3_000,
      settledAt: 3_600,
      tokensUsed: 320,
      modelUsed: "gpt-4o",
    },
    {
      id: "b-4",
      threadId: "thread-1",
      workspaceKey: WORKSPACE_KEY,
      interactionMode: "agent",
      kind: "assistant",
      status: "ready",
      title: "Top buyers",
      subtitle: "OpenAI",
      prompt: "Who are the top 5 buyers by spend?",
      promptSummary: "Who are the top 5 buyers by spend?",
      preview: "Aggregated orders by user_id.",
      detail: "Top 5 buyers aggregated across `orders`.",
      sql: "SELECT user_id, SUM(total_cents) AS spend FROM orders GROUP BY user_id ORDER BY spend DESC LIMIT 5;",
      risk: { level: "safe", reason: "Read-only SELECT" },
      x: 0,
      y: 0,
      pointer: { visible: false, x: 0, y: 0 },
      createdAt: 4_000,
      settledAt: 4_700,
      tokensUsed: 410,
      modelUsed: "gpt-4o",
    },
    {
      id: "b-5",
      threadId: "thread-1",
      workspaceKey: WORKSPACE_KEY,
      interactionMode: "agent",
      kind: "assistant",
      status: "cancelled",
      title: "Cancelled request",
      subtitle: "Stopped",
      prompt: "Export full raw dump",
      promptSummary: "Export full raw dump",
      preview: "Cancelled by user.",
      detail: "Cancelled by user.",
      x: 0,
      y: 0,
      pointer: { visible: false, x: 0, y: 0 },
      createdAt: 5_000,
      settledAt: 5_100,
    },
    {
      id: "b-6",
      threadId: "thread-1",
      workspaceKey: WORKSPACE_KEY,
      interactionMode: "agent",
      kind: "assistant",
      status: "ready",
      title: "Retention breakdown",
      subtitle: "OpenAI",
      prompt: "Summarize monthly signups",
      promptSummary: "Summarize monthly signups",
      preview: "Monthly signup summary ready.",
      detail: "Monthly signups grew 12% month-over-month.",
      x: 0,
      y: 0,
      pointer: { visible: false, x: 0, y: 0 },
      createdAt: 6_000,
      settledAt: 6_500,
      tokensUsed: 295,
      modelUsed: "gpt-4o",
    },
  ];
}

function makeThread2Bubble(): AIWorkspaceBubbleData {
  return {
    id: "b-t2-1",
    threadId: "thread-2",
    workspaceKey: WORKSPACE_KEY,
    interactionMode: "agent",
    kind: "assistant",
    status: "ready",
    title: "Cohort baseline",
    subtitle: "OpenAI",
    prompt: "Baseline cohort retention",
    promptSummary: "Baseline cohort retention",
    preview: "Week-1 retention is 42%.",
    detail: "Week-1 cohort retention is **42%**.",
    x: 0,
    y: 0,
    pointer: { visible: false, x: 0, y: 0 },
    createdAt: 2_500,
    settledAt: 2_900,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function seedRealisticState() {
  const threads = makeThreads();
  const bubbles = [...makeSixRealisticBubbles(), makeThread2Bubble()];

  useConnectionStore.setState({
    connections: [TEST_CONNECTION],
    activeConnectionId: CONNECTION_ID,
    connectedIds: new Set([CONNECTION_ID]),
    currentDatabase: DATABASE_NAME,
    databases: [{ name: DATABASE_NAME } as { name: string }],
    tables: TEST_TABLES,
    schemaObjects: [],
  });

  useAIStore.setState({
    aiConfigs: [TEST_PROVIDER],
    activeStreams: {},
    activeAIRequestId: null,
    requestPhase: "idle",
    streamingText: "",
    streamingReasoning: false,
    streamingReasoningText: "",
    streamingUsage: null,
    isProviderFailingOver: false,
  });

  useAIChatWorkspaceStore.setState({
    workspaces: [],
    activeWorkspaceId: null,
  });

  useUIStore.setState({
    tabs: [],
    activeTabId: null,
  });

  useAIPanelStore.setState({
    historyHydrated: true,
    chatThreads: threads,
    bubbles,
    activeThreadId: "thread-1",
    activeThreadIdsByWorkspace: { [WORKSPACE_KEY]: "thread-1" },
    workspaceInteractionModes: { [WORKSPACE_KEY]: "agent" },
  });

  return { threads, bubbles };
}

function installDefaultInvokeHandlers(
  threads: AIChatThread[],
  bubbles: AIWorkspaceBubbleData[],
  custom?: (command: string, args: Record<string, unknown>) => unknown,
) {
  invokeMock.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    if (custom) {
      const handled = await custom(command, args);
      if (handled !== undefined) return handled;
    }

    switch (command) {
      case "get_ai_workspace_history":
        return {
          version: 1,
          threads,
          bubbles,
          interactionModes: { [WORKSPACE_KEY]: "agent" },
          activeThreadIds: { [WORKSPACE_KEY]: "thread-1" },
        };
      case "save_ai_workspace_history":
      case "save_agent_trace":
      case "save_ai_attachments":
        return undefined;
      case "list_ai_attachments":
      case "list_latest_workspace_digests":
      case "list_thread_memories":
      case "list_agent_skills":
      case "list_agent_rules":
      case "list_database_checkpoints":
      case "list_agent_memories":
      case "get_linked_folders":
        return [];
      case "list_user_slash_commands":
        return { commands: [] };
      case "list_ai_skills":
        return { skills: [], errors: [] };
      case "get_agent_prompt_context":
        return { skills: [], rules: [] };
      case "get_table_structure":
        return {
          table_name: String(args.tableName ?? "users"),
          columns: [
            { name: "id", data_type: "INTEGER", is_nullable: false, is_primary_key: true },
            { name: "email", data_type: "TEXT", is_nullable: false, is_primary_key: false },
          ],
          indexes: [],
          foreign_keys: [],
        };
      case "get_ai_configs":
        return [[TEST_PROVIDER], { [TEST_PROVIDER.id]: true }];
      case "cancel_ai_request":
        return true;
      default:
        return null;
    }
  });
}

describe("AISlidePanel adversarial UI & lifecycle tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    resetAIPanelStoreForTests();
    conversationCapture.reset();
    streamListeners.length = 0;
    listenMock.mockImplementation(async (_eventName, listener) => {
      streamListeners.push(listener);
      return () => {
        const idx = streamListeners.indexOf(listener);
        if (idx >= 0) streamListeners.splice(idx, 1);
      };
    });
  });

  afterEach(() => {
    resetAIPanelStoreForTests();
  });

  it("causes ZERO AIConversationView re-renders during ordinary typing and measures exact /slash typing re-renders", async () => {
    const { threads, bubbles } = seedRealisticState();
    installDefaultInvokeHandlers(threads, bubbles);

    const onClose = vi.fn();
    const { container } = render(<AISlidePanel isOpen={true} onClose={onClose} />);

    // Allow mount effects (slash commands, digests, memories) to settle.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    const mountRenders = conversationCapture.spyRenders;
    const mountCommits = conversationCapture.profilerCommits.length;
    expect(mountRenders).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Monthly signups grew 12% month-over-month.")).toBeInTheDocument();

    const textarea = container.querySelector("textarea.ai-workspace-composer-textarea");
    expect(textarea).not.toBeNull();

    conversationCapture.reset();
    conversationCapture.lastProps = conversationCapture.lastProps ?? null;

    // Type 15 ordinary characters ("SELECT * FROM u") one keystroke at a time.
    const ordinaryText = "SELECT * FROM u";
    for (let i = 1; i <= ordinaryText.length; i += 1) {
      fireEvent.change(textarea!, { target: { value: ordinaryText.slice(0, i) } });
    }
    expect(useAIPanelStore.getState().promptDraft).toBe(ordinaryText);
    expect(conversationCapture.spyRenders).toBe(0);
    expect(conversationCapture.profilerCommits).toHaveLength(0);

    // Clear and type "/", "/b", "/ba", "/bac", "/backup" character by character.
    fireEvent.change(textarea!, { target: { value: "" } });
    expect(conversationCapture.spyRenders).toBe(0);

    const slashSequence = ["/", "/b", "/ba", "/bac", "/backup"];
    for (const value of slashSequence) {
      fireEvent.change(textarea!, { target: { value } });
    }

    // Record exact render count and changed prop keys on AIConversationView during /slash typing.
    expect(useAIPanelStore.getState().promptDraft).toBe("/backup");
    expect(screen.getByRole("listbox")).toHaveTextContent("/backup");

    // Assert the ACTUAL render count we observed (if non-zero, changedPropsPerRender exposes why).
    console.info(
      "[ADVERSARIAL-METRIC] ordinaryReRenders=0, slashSpyRenders=%d, slashProfilerCommits=%d, mountCommits=%d, changedProps=%j",
      conversationCapture.spyRenders,
      conversationCapture.profilerCommits.length,
      mountCommits,
      conversationCapture.changedPropsPerRender,
    );
    expect(conversationCapture.spyRenders).toBe(0);
    expect(conversationCapture.profilerCommits).toHaveLength(0);
  });

  it("cancels in-flight request via Stop button: invokes cancel_ai_request with active requestId, settles pending consents false without persisting localStorage, clears pendingQueue, and blocks stale resolution", async () => {
    const { threads, bubbles } = seedRealisticState();
    const deferredStream = createDeferred<{
      text: string;
      reasoning?: string;
      tool_calls: unknown[];
    }>();
    let capturedRequestId: string | null = null;
    const cancelCalls: Array<{ requestId: unknown }> = [];

    installDefaultInvokeHandlers(threads, bubbles, (command, args) => {
      if (command === "ask_ai_stream") {
        const req = args.request as { request_id?: string } | undefined;
        capturedRequestId = req?.request_id ?? null;
        return deferredStream.promise;
      }
      if (command === "cancel_ai_request") {
        cancelCalls.push({ requestId: args.requestId });
        return true;
      }
      return undefined;
    });

    const onClose = vi.fn();
    const { container } = render(<AISlidePanel isOpen={true} onClose={onClose} />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    const textarea = container.querySelector("textarea.ai-workspace-composer-textarea")!;
    fireEvent.change(textarea, { target: { value: "Analyze users table orders" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    // Wait until the real ask_ai_stream IPC has started and captured an active requestId.
    await waitFor(() => {
      expect(capturedRequestId).not.toBeNull();
      expect(useAIStore.getState().activeAIRequestId).toBe(capturedRequestId);
    });

    // Trigger a pending visualization data-read consent prompt on the active run with an
    // explicit onUserDecision spy to prove cancellation never invokes persistent user callbacks.
    const onUserDecisionSpy = vi.fn();
    let consentResolved: boolean | undefined;
    const consentPromise = useAIPanelStore
      .getState()
      .openVisualizationConsentPrompt(
        {
          title: "Allow AI to read data?",
          message: "Read orders table",
          confirmText: "Allow",
          cancelText: "Deny",
        },
        onUserDecisionSpy,
      )
      .then((value) => {
        consentResolved = value;
        return value;
      });

    // Enqueue 2 follow-up prompts into pendingQueue via the real composer while generating.
    fireEvent.change(textarea, { target: { value: "Follow-up prompt 1" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    fireEvent.change(textarea, { target: { value: "Follow-up prompt 2" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(useAIPanelStore.getState().pendingQueue).toHaveLength(2);
    expect(screen.getByText("Allow AI to read data?")).toBeInTheDocument();

    // Click the real Stop button (cancelGeneration).
    const stopButton = container.querySelector("button.ai-workspace-generate-btn.is-cancel");
    expect(stopButton).not.toBeNull();
    fireEvent.click(stopButton!);

    // 1) cancel_ai_request invoked strictly once with exact active requestId.
    await waitFor(() => {
      expect(cancelCalls).toEqual([{ requestId: capturedRequestId }]);
    });

    // 2) Pending consent promise resolves false immediately (no hung promise).
    await expect(consentPromise).resolves.toBe(false);
    expect(consentResolved).toBe(false);
    expect(useAIPanelStore.getState().visualizationConsentPending).toBeNull();

    // 3) localStorage data-read approval state is NOT mutated/persisted and onUserDecision NOT called.
    expect(onUserDecisionSpy).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("tabler.ai.dataReadApprovals.v1")).toBeNull();

    // 4) pendingQueue is cleared so neither follow-up prompt fires.
    expect(useAIPanelStore.getState().pendingQueue).toHaveLength(0);

    const streamCallsBeforeLateResolve = invokeMock.mock.calls.filter(
      ([cmd]) => cmd === "ask_ai_stream",
    ).length;

    // 5) Stale late resolution from the cancelled run arrives AFTER cancellation.
    await act(async () => {
      deferredStream.resolve({
        text: JSON.stringify({
          action: "finish",
          message: "Done",
          args: { response: "STALE_LATE_OVERWRITE_TEXT" },
        }),
        tool_calls: [],
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Stale text must NEVER overwrite bubbles in thread-1, and queued follow-ups must NOT start.
    const thread1Bubbles = useAIPanelStore
      .getState()
      .bubbles.filter((b) => b.threadId === "thread-1");
    expect(
      thread1Bubbles.some(
        (b) =>
          b.detail.includes("STALE_LATE_OVERWRITE_TEXT") ||
          b.preview.includes("STALE_LATE_OVERWRITE_TEXT"),
      ),
    ).toBe(false);
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "ask_ai_stream").length).toBe(
      streamCallsBeforeLateResolve,
    );
  });

  it("real tool-driven data-read consent pause inside <AISlidePanel /> settles false on Stop without mutating localStorage", async () => {
    const { threads, bubbles } = seedRealisticState();
    let streamTurn = 0;

    installDefaultInvokeHandlers(threads, bubbles, (command) => {
      if (command === "ask_ai_stream") {
        streamTurn += 1;
        if (streamTurn === 1) {
          // Turn 1 in driveAgentTurns is the planning call (buildAgentPlanPrompt).
          return Promise.resolve({
            text: "Plan: query the orders table count.",
            tool_calls: [],
          });
        }
        if (streamTurn === 2) {
          // Turn 2 is the first tool-loop turn; calling sample_table_data triggers requestDataReadConsent.
          return Promise.resolve({
            text: JSON.stringify({
              action: "sample_table_data",
              message: "Sample orders table rows",
              args: { table: "orders", limit: 5 },
            }),
            tool_calls: [],
          });
        }
        return Promise.resolve({
          text: JSON.stringify({
            action: "finish",
            message: "Done",
            args: { response: "STALE_POST_CONSENT_RESPONSE" },
          }),
          tool_calls: [],
        });
      }
      return undefined;
    });

    const { container } = render(<AISlidePanel isOpen={true} onClose={vi.fn()} />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    const textarea = container.querySelector("textarea.ai-workspace-composer-textarea")!;
    fireEvent.change(textarea, { target: { value: "Count orders in live db" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    // Real agent run pauses inside run_readonly_sql waiting on the real ConfirmDialog.
    await waitFor(() => {
      expect(screen.getByText("Allow Agent to read live data?")).toBeInTheDocument();
    });

    // Enqueue 2 follow-up prompts while paused on consent.
    fireEvent.change(textarea, { target: { value: "Queued 1" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    fireEvent.change(textarea, { target: { value: "Queued 2" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(useAIPanelStore.getState().pendingQueue).toHaveLength(2);

    const stopButton = container.querySelector("button.ai-workspace-generate-btn.is-cancel")!;
    fireEvent.click(stopButton);

    await waitFor(() => {
      expect(screen.queryByText("Allow Agent to read live data?")).not.toBeInTheDocument();
    });
    expect(window.localStorage.getItem("tabler.ai.dataReadApprovals.v1")).toBeNull();
    expect(useAIPanelStore.getState().pendingQueue).toHaveLength(0);

    // Let any remaining microtasks settle and verify neither STALE_POST_CONSENT_RESPONSE nor Queued prompts ran.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(
      useAIPanelStore
        .getState()
        .bubbles.some((b) => b.detail.includes("STALE_POST_CONSENT_RESPONSE")),
    ).toBe(false);
    console.info("[ADVERSARIAL-STOP-AFTER-CONSENT] streamTurn=%d", streamTurn);
    // Safe invariant: once Stop is clicked while paused on consent, NO further ask_ai_stream call may be dispatched.
    expect(streamTurn).toBe(2);
  });

  it("closing via X / reopening and thread-switching block stale late resolution from overwriting bubbles", async () => {
    const { threads, bubbles } = seedRealisticState();
    const deferredStream = createDeferred<{
      text: string;
      tool_calls: unknown[];
    }>();
    let capturedRequestId: string | null = null;
    const cancelCalls: Array<{ requestId: unknown }> = [];

    installDefaultInvokeHandlers(threads, bubbles, (command, args) => {
      if (command === "ask_ai_stream") {
        const req = args.request as { request_id?: string } | undefined;
        capturedRequestId = req?.request_id ?? null;
        return deferredStream.promise;
      }
      if (command === "cancel_ai_request") {
        cancelCalls.push({ requestId: args.requestId });
        return true;
      }
      return undefined;
    });

    let open = true;
    const onClose = vi.fn(() => {
      open = false;
    });

    const { container, rerender } = render(<AISlidePanel isOpen={open} onClose={onClose} />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    const textarea = container.querySelector("textarea.ai-workspace-composer-textarea")!;
    fireEvent.change(textarea, { target: { value: "Run slow query analysis" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(capturedRequestId).not.toBeNull();
    });

    // Enqueue 2 follow-up prompts while in flight.
    fireEvent.change(textarea, { target: { value: "Follow-up A" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    fireEvent.change(textarea, { target: { value: "Follow-up B" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(useAIPanelStore.getState().pendingQueue).toHaveLength(2);

    // Switch to thread-2 via the real history popover BEFORE closing/cancelling.
    const historyBtn = container.querySelector(
      "button.ai-workspace-history-toggle:not(.ai-ws-switcher-toggle)",
    )!;
    fireEvent.click(historyBtn);
    await waitFor(() => {
      expect(useAIPanelStore.getState().isHistoryOpen).toBe(true);
    });
    const thread2Btn = screen.getByText("Revenue Cohort").closest("button")!;
    fireEvent.click(thread2Btn);
    expect(useAIPanelStore.getState().activeThreadId).toBe("thread-2");

    // Click panel close (X) button, then reopen.
    const closeBtn = container.querySelector("button.toolbar-btn.icon-only.is-close")!;
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
    rerender(<AISlidePanel isOpen={false} onClose={onClose} />);
    rerender(<AISlidePanel isOpen={true} onClose={onClose} />);

    await waitFor(() => {
      expect(cancelCalls).toEqual([{ requestId: capturedRequestId }]);
    });

    // Late resolution from the cancelled run arrives while thread-2 is active.
    await act(async () => {
      deferredStream.resolve({
        text: JSON.stringify({
          action: "finish",
          message: "Done",
          args: { response: "STALE_SWITCHED_THREAD_PAYLOAD" },
        }),
        tool_calls: [],
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const allBubbles = useAIPanelStore.getState().bubbles;
    expect(
      allBubbles.some(
        (b) =>
          b.detail.includes("STALE_SWITCHED_THREAD_PAYLOAD") ||
          b.preview.includes("STALE_SWITCHED_THREAD_PAYLOAD"),
      ),
    ).toBe(false);
    // Thread-2 still has ONLY its original bubble.
    expect(allBubbles.filter((b) => b.threadId === "thread-2").map((b) => b.id)).toEqual([
      "b-t2-1",
    ]);
    expect(useAIPanelStore.getState().pendingQueue).toHaveLength(0);
  });

  it("closing via Escape cancels active request once, clears pendingQueue, and prevents queued prompts from running", async () => {
    const { threads, bubbles } = seedRealisticState();
    const deferredStream = createDeferred<{
      text: string;
      tool_calls: unknown[];
    }>();
    let capturedRequestId: string | null = null;
    const cancelCalls: Array<{ requestId: unknown }> = [];
    let streamCalls = 0;

    installDefaultInvokeHandlers(threads, bubbles, (command, args) => {
      if (command === "ask_ai_stream") {
        streamCalls += 1;
        const req = args.request as { request_id?: string } | undefined;
        capturedRequestId = req?.request_id ?? null;
        if (streamCalls === 1) return deferredStream.promise;
        return Promise.resolve({
          text: JSON.stringify({
            action: "finish",
            message: "Done",
            args: { response: "LEAKED_FOLLOWUP_AFTER_CLOSE" },
          }),
          tool_calls: [],
        });
      }
      if (command === "cancel_ai_request") {
        cancelCalls.push({ requestId: args.requestId });
        return true;
      }
      return undefined;
    });

    const onClose = vi.fn();
    const { container, rerender } = render(<AISlidePanel isOpen={true} onClose={onClose} />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    const textarea = container.querySelector("textarea.ai-workspace-composer-textarea")!;
    fireEvent.change(textarea, { target: { value: "Initial prompt before Escape" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(streamCalls).toBe(1);
      expect(capturedRequestId).not.toBeNull();
    });

    fireEvent.change(textarea, { target: { value: "Queued after Escape 1" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    fireEvent.change(textarea, { target: { value: "Queued after Escape 2" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(useAIPanelStore.getState().pendingQueue).toHaveLength(2);

    // Simulate Escape key followed by parent flipping isOpen={false}.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    rerender(<AISlidePanel isOpen={false} onClose={onClose} />);

    // Settle cancelled request and verify cancel_ai_request fired only once and queue stayed empty.
    await act(async () => {
      deferredStream.reject({ code: "cancelled", message: "Cancelled", retryable: false });
      await new Promise((r) => setTimeout(r, 40));
    });

    console.info(
      "[ADVERSARIAL-ESCAPE-CLOSE] pendingQueueRemaining=%d, streamCallsAfterClose=%d, cancelCallCount=%d, leakedBubble=%s",
      useAIPanelStore.getState().pendingQueue.length,
      streamCalls,
      cancelCalls.length,
      useAIPanelStore
        .getState()
        .bubbles.some((b) => b.detail.includes("LEAKED_FOLLOWUP_AFTER_CLOSE")),
    );

    expect(cancelCalls).toEqual([{ requestId: capturedRequestId }]);
    expect(useAIPanelStore.getState().pendingQueue).toHaveLength(0);
    expect(streamCalls).toBe(1);
  });

  it("closing via parent isOpen=false directly (without X or Escape) cancels request, settles consent false without localStorage, and clears pendingQueue", async () => {
    const { threads, bubbles } = seedRealisticState();
    const deferredStream = createDeferred<{
      text: string;
      tool_calls: unknown[];
    }>();
    let capturedRequestId: string | null = null;
    const cancelCalls: Array<{ requestId: unknown }> = [];
    let streamCalls = 0;

    installDefaultInvokeHandlers(threads, bubbles, (command, args) => {
      if (command === "ask_ai_stream") {
        streamCalls += 1;
        const req = args.request as { request_id?: string } | undefined;
        capturedRequestId = req?.request_id ?? null;
        if (streamCalls === 1) return deferredStream.promise;
        return Promise.resolve({
          text: JSON.stringify({
            action: "finish",
            message: "Done",
            args: { response: "LEAKED_AFTER_PARENT_CLOSE" },
          }),
          tool_calls: [],
        });
      }
      if (command === "cancel_ai_request") {
        cancelCalls.push({ requestId: args.requestId });
        return true;
      }
      return undefined;
    });

    const { container, rerender } = render(<AISlidePanel isOpen={true} onClose={vi.fn()} />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    const textarea = container.querySelector("textarea.ai-workspace-composer-textarea")!;
    fireEvent.change(textarea, { target: { value: "In-flight before parent closes" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(streamCalls).toBe(1);
      expect(capturedRequestId).not.toBeNull();
    });

    // Simulate a pending visualization consent and 2 queued follow-up prompts.
    const onUserDecisionSpy = vi.fn();
    let consentResolved: boolean | null = null;
    let consentPromise!: Promise<boolean>;
    act(() => {
      consentPromise = useAIPanelStore.getState().openVisualizationConsentPrompt(
        {
          title: "Allow AI to read data?",
          message: "Read live rows",
          confirmText: "Allow",
          cancelText: "Deny",
        },
        onUserDecisionSpy,
      );
      void consentPromise.then((v) => {
        consentResolved = v;
      });
    });

    fireEvent.change(textarea, { target: { value: "Queued parent close 1" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    fireEvent.change(textarea, { target: { value: "Queued parent close 2" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(useAIPanelStore.getState().pendingQueue).toHaveLength(2);

    // Parent flips isOpen={false} directly without clicking X or pressing Escape.
    rerender(<AISlidePanel isOpen={false} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(cancelCalls).toEqual([{ requestId: capturedRequestId }]);
    });
    await expect(consentPromise).resolves.toBe(false);
    expect(consentResolved).toBe(false);
    expect(onUserDecisionSpy).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("tabler.ai.dataReadApprovals.v1")).toBeNull();
    expect(useAIPanelStore.getState().pendingQueue).toHaveLength(0);

    await act(async () => {
      deferredStream.reject({ code: "cancelled", message: "Cancelled", retryable: false });
      await new Promise((r) => setTimeout(r, 40));
    });
    expect(streamCalls).toBe(1);
  });

  it("switching thread mid-generation denies pending consent without mutating localStorage, clears pendingQueue, and isolates switched thread", async () => {
    const { threads, bubbles } = seedRealisticState();
    const deferredStream = createDeferred<{
      text: string;
      tool_calls: unknown[];
    }>();
    let streamTurn = 0;

    installDefaultInvokeHandlers(threads, bubbles, (command) => {
      if (command === "ask_ai_stream") {
        streamTurn += 1;
        if (streamTurn === 1) {
          return Promise.resolve({ text: "Plan: sample orders.", tool_calls: [] });
        }
        if (streamTurn === 2) {
          return Promise.resolve({
            text: JSON.stringify({
              action: "sample_table_data",
              message: "Sample orders table rows",
              args: { table: "orders", limit: 5 },
            }),
            tool_calls: [],
          });
        }
        return deferredStream.promise;
      }
      return undefined;
    });

    const { container } = render(<AISlidePanel isOpen={true} onClose={vi.fn()} />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    const textarea = container.querySelector("textarea.ai-workspace-composer-textarea")!;
    fireEvent.change(textarea, { target: { value: "Sample orders mid-switch" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(screen.getByText("Allow Agent to read live data?")).toBeInTheDocument();
    });

    fireEvent.change(textarea, { target: { value: "Queued before thread switch" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(useAIPanelStore.getState().pendingQueue).toHaveLength(1);

    // Switch to thread-2 via the real history popover while paused on thread-1 consent.
    const historyBtn = container.querySelector(
      "button.ai-workspace-history-toggle:not(.ai-ws-switcher-toggle)",
    )!;
    fireEvent.click(historyBtn);
    await waitFor(() => {
      expect(useAIPanelStore.getState().isHistoryOpen).toBe(true);
    });
    const thread2Btn = screen.getByText("Revenue Cohort").closest("button")!;
    fireEvent.click(thread2Btn);
    expect(useAIPanelStore.getState().activeThreadId).toBe("thread-2");

    console.info(
      "[ADVERSARIAL-THREAD-SWITCH] consentStillOpen=%s, pendingQueueLen=%d, activeThread=%s",
      useAIPanelStore.getState().visualizationConsentPending !== null,
      useAIPanelStore.getState().pendingQueue.length,
      useAIPanelStore.getState().activeThreadId,
    );

    expect(useAIPanelStore.getState().visualizationConsentPending).toBeNull();
    expect(useAIPanelStore.getState().pendingQueue).toHaveLength(0);
    expect(window.localStorage.getItem("tabler.ai.dataReadApprovals.v1")).toBeNull();

    // Even if a late response resolves afterwards, thread-2 remains completely untouched.
    await act(async () => {
      deferredStream.resolve({
        text: JSON.stringify({
          action: "finish",
          message: "Done",
          args: { response: "STALE_POST_SWITCH_RESPONSE" },
        }),
        tool_calls: [],
      });
      await new Promise((r) => setTimeout(r, 30));
    });
    const allBubbles = useAIPanelStore.getState().bubbles;
    expect(allBubbles.some((b) => b.detail.includes("STALE_POST_SWITCH_RESPONSE"))).toBe(false);
    expect(allBubbles.filter((b) => b.threadId === "thread-2").map((b) => b.id)).toEqual([
      "b-t2-1",
    ]);
  });
});
