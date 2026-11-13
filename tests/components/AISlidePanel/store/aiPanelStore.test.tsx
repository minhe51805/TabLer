import { fireEvent, render } from "@testing-library/react";
import { createRef, Profiler } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AIComposerDockConnected } from "@/components/AISlidePanel/AIComposerDockConnected";
import { AIConversationView } from "@/components/AISlidePanel/AIConversationView";
import { getAIWorkspaceCopy } from "@/components/AISlidePanel/ai-workspace-copy";
import {
  DEFAULT_AI_WORKSPACE_AGENT_AUTONOMY,
  type AIWorkspaceBubbleData,
} from "@/components/AISlidePanel/ai-workspace-types";
import {
  resetAIPanelStoreForTests,
  useAIPanelStore,
} from "@/components/AISlidePanel/store/aiPanelStore";
import { AI_WORKSPACE_AGENT_AUTONOMY_STORAGE_KEY } from "@/components/AISlidePanel/store/sessionSlice";

describe("aiPanelStore slices & zero-keystroke-rerender isolation", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetAIPanelStoreForTests();
  });

  it("updates composer draft, resets slash flags, and manages pending queue atomically", () => {
    const store = useAIPanelStore.getState();
    store.setSlashDismissed(true);
    store.setSlashActiveIndex(3);

    store.updateComposerDraft("SELECT * FROM users");
    const afterDraft = useAIPanelStore.getState();
    expect(afterDraft.promptDraft).toBe("SELECT * FROM users");
    expect(afterDraft.slashDismissed).toBe(false);
    expect(afterDraft.slashActiveIndex).toBe(0);

    afterDraft.enqueuePendingPrompt({
      kind: "prompt",
      draft: "first",
      attachments: [],
      selection: null,
    });
    afterDraft.enqueuePendingPrompt({
      kind: "rerun",
      bubbleId: "b-1",
      prompt: "second",
    });
    expect(useAIPanelStore.getState().pendingQueue).toHaveLength(2);

    const first = useAIPanelStore.getState().shiftPendingPrompt();
    expect(first).toEqual({
      kind: "prompt",
      draft: "first",
      attachments: [],
      selection: null,
    });
    expect(useAIPanelStore.getState().pendingQueue).toHaveLength(1);

    useAIPanelStore.getState().clearPendingQueue();
    expect(useAIPanelStore.getState().pendingQueue).toHaveLength(0);
  });

  it("settles all pending consents to false on denyPendingConsents without circular refs", async () => {
    const store = useAIPanelStore.getState();
    const vizSideEffect = vi.fn();

    const vizPromise = store.openVisualizationConsentPrompt(
      {
        title: "Allow data read?",
        message: "Read orders table",
        confirmText: "Allow",
        cancelText: "Deny",
      },
      vizSideEffect,
    );
    const destructivePromise = store.openDestructiveConsentPrompt({
      title: "Delete memory?",
      message: "Confirm delete",
      confirmText: "Delete",
      cancelText: "Cancel",
    });
    store.setIsFailoverConsentPending(true);

    expect(useAIPanelStore.getState().visualizationConsentPending?.title).toBe("Allow data read?");
    expect(useAIPanelStore.getState().destructiveConsentPending?.title).toBe("Delete memory?");
    expect(useAIPanelStore.getState().isFailoverConsentPending).toBe(true);

    // Cancelling a run or closing the panel denies every open prompt WITHOUT
    // running persistent side-effects (`vizSideEffect` must NOT be called).
    useAIPanelStore.getState().denyPendingConsents();

    await expect(vizPromise).resolves.toBe(false);
    await expect(destructivePromise).resolves.toBe(false);
    expect(vizSideEffect).not.toHaveBeenCalled();
    expect(useAIPanelStore.getState().visualizationConsentPending).toBeNull();
    expect(useAIPanelStore.getState().destructiveConsentPending).toBeNull();
    expect(useAIPanelStore.getState().isFailoverConsentPending).toBe(false);
  });

  it("persists workspaceAgentAutonomy to localStorage via sessionSlice", () => {
    useAIPanelStore.getState().setWorkspaceAgentAutonomy({
      "conn-1:main": "full",
    });
    const raw = window.localStorage.getItem(AI_WORKSPACE_AGENT_AUTONOMY_STORAGE_KEY);
    expect(raw).toBe(JSON.stringify({ "conn-1:main": "full" }));
  });

  it("causes ZERO re-renders of AIConversationView while typing in AIComposerDockConnected", () => {
    const copy = getAIWorkspaceCopy("en");
    const bubbles: AIWorkspaceBubbleData[] = [
      {
        id: "b-1",
        threadId: "t-1",
        workspaceKey: "ws-1",
        interactionMode: "agent",
        kind: "assistant",
        status: "ready",
        title: "Answer",
        subtitle: "OpenAI",
        prompt: "Count orders",
        promptSummary: "Count orders",
        preview: "There are 42 orders.",
        detail: "There are 42 orders.",
        x: 0,
        y: 0,
        pointer: { visible: false, x: 0, y: 0 },
        createdAt: 1_000,
      },
    ];

    const noop = vi.fn();
    const noopAsync = vi.fn(async () => true);
    const threadRef = createRef<HTMLDivElement>();
    const textareaRef = createRef<HTMLTextAreaElement>();
    let conversationRenderCount = 0;

    function TestHarness() {
      const updateComposerDraft = useAIPanelStore((state) => state.updateComposerDraft);
      return (
        <div>
          <Profiler
            id="conversation"
            onRender={() => {
              conversationRenderCount += 1;
            }}
          >
            <AIConversationView
              bubbles={bubbles}
              copy={copy}
              threadRef={threadRef}
              onInsert={noop}
              onRun={noop}
              onRetry={noop}
              onRegenerate={noop}
              onFeedback={noop}
              onEditRerun={noop}
              onCopy={noopAsync}
              onOpenRecord={noop}
              onUseSuggestion={updateComposerDraft}
              onAskUserOptionSelect={noop}
              onAskUserCustomInput={noop}
            />
          </Profiler>
          <AIComposerDockConnected
            copy={copy}
            textareaRef={textareaRef}
            baseContextChars={240}
            contextLimitTokens={128_000}
            interactionMode="agent"
            agentAutonomy={DEFAULT_AI_WORKSPACE_AGENT_AUTONOMY}
            activeProvider={undefined}
            providers={[]}
            isSwitchingProvider={false}
            isGenerating={false}
            isCancelling={false}
            isConnectionAvailable={true}
            isSessionDataReadEnabled={false}
            sessionDataReadLabel="Data: Ask"
            sessionDataReadTitle="Ask before reading live data"
            showThinking={true}
            onPromptChange={updateComposerDraft}
            onKeyDown={noop}
            onDismissSelection={noop}
            onSelectInteractionMode={noop}
            onSelectAgentAutonomy={noop}
            onActivateProvider={noop}
            onToggleModelVisibility={noop}
            onSetSessionDataReadEnabled={noop}
            onSetShowThinking={noop}
            onOpenSettings={noop}
            onCloseHistory={noop}
            onGenerate={noop}
            onCancelGeneration={noop}
          />
        </div>
      );
    }

    const { container } = render(<TestHarness />);
    expect(conversationRenderCount).toBe(1);

    const textarea = container.querySelector("textarea");
    expect(textarea).not.toBeNull();

    const keystrokes = [
      "S",
      "SE",
      "SEL",
      "SELECT * FROM orders",
      "SELECT * FROM orders WHERE status = 'paid'",
      "/",
      "/h",
      "/he",
      "/help",
    ];
    for (const value of keystrokes) {
      fireEvent.change(textarea!, { target: { value } });
    }

    expect(useAIPanelStore.getState().promptDraft).toBe("/help");
    // Initial mount = 1; 9 keystrokes in the composer = 0 extra AIConversationView commits!
    expect(conversationRenderCount).toBe(1);
  });
});
