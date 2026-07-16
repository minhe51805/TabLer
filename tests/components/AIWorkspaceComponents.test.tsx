import { createRef } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AIComposerDock } from "@/components/AISlidePanel/AIComposerDock";
import { AIConversationView } from "@/components/AISlidePanel/AIConversationView";
import { getAIWorkspaceCopy } from "@/components/AISlidePanel/ai-workspace-copy";
import type { AIWorkspaceBubbleData } from "@/components/AISlidePanel/ai-workspace-types";
import type { AIProviderConfig } from "@/types";

const copy = getAIWorkspaceCopy("en");
const provider: AIProviderConfig = {
  id: "provider-1",
  name: "OpenAI",
  provider_type: "openai",
  endpoint: "",
  model: "gpt-test",
  is_enabled: true,
  is_primary: true,
  allow_schema_context: true,
  allow_inline_completion: false,
};

function renderComposer(overrides: Partial<React.ComponentProps<typeof AIComposerDock>> = {}) {
  const props: React.ComponentProps<typeof AIComposerDock> = {
    copy,
    prompt: "",
    textareaRef: createRef<HTMLTextAreaElement>(),
    footerNote: "",
    hasAttachedSelectionText: false,
    interactionMode: "prompt",
    agentAutonomy: "smart",
    activeProvider: provider,
    providers: [provider],
    isSwitchingProvider: false,
    isGenerating: false,
    isCancelling: false,
    isConnectionAvailable: true,
    isSessionDataReadEnabled: false,
    sessionDataReadLabel: "Data: Ask",
    sessionDataReadTitle: "Ask before reading data",
    showThinking: true,
    onPromptChange: vi.fn(),
    onKeyDown: vi.fn(),
    onDismissSelection: vi.fn(),
    onSelectInteractionMode: vi.fn(),
    onSelectAgentAutonomy: vi.fn(),
    onActivateProvider: vi.fn(),
    onSetSessionDataReadEnabled: vi.fn(),
    onSetShowThinking: vi.fn(),
    onOpenSettings: vi.fn(),
    onCloseHistory: vi.fn(),
    onGenerate: vi.fn(),
    onCancelGeneration: vi.fn(),
    ...overrides,
  };
  render(<AIComposerDock {...props} />);
  return props;
}

describe("AI workspace components", () => {
  it("routes composer input and generation through explicit commands", async () => {
    const user = userEvent.setup();
    const props = renderComposer({ prompt: "Show active users" });

    await user.type(screen.getByRole("textbox"), " now");
    await user.click(screen.getByRole("button", { name: copy.composer.generateBubble }));

    expect(props.onPromptChange).toHaveBeenCalled();
    expect(props.onGenerate).toHaveBeenCalledOnce();
  });

  it("keeps mode and provider menu state inside the composer", async () => {
    const user = userEvent.setup();
    const props = renderComposer();

    await user.click(screen.getByTitle(copy.composer.modePrompt));
    await user.click(screen.getByRole("menuitemradio", { name: new RegExp(copy.composer.modeAgent) }));
    expect(props.onSelectInteractionMode).toHaveBeenCalledWith("agent");

    await user.click(screen.getByTitle("gpt-test"));
    await user.click(screen.getByRole("menuitemradio", { name: /gpt-test/i }));
    expect(props.onActivateProvider).toHaveBeenCalledWith("provider-1");
    expect(props.onCloseHistory).toHaveBeenCalled();
  });

  it("turns the generate command into a stop command while AI is running", async () => {
    const user = userEvent.setup();
    const props = renderComposer({ isGenerating: true, prompt: "Long request" });

    await user.click(screen.getByRole("button", { name: copy.composer.cancelGeneration }));

    expect(props.onCancelGeneration).toHaveBeenCalledOnce();
    expect(props.onGenerate).not.toHaveBeenCalled();
  });

  it("renders empty suggestions and sends the selected prompt", async () => {
    const user = userEvent.setup();
    const onUseSuggestion = vi.fn();
    render(
      <AIConversationView
        bubbles={[]}
        copy={copy}
        showThinking
        threadRef={createRef<HTMLDivElement>()}
        onOpenDetail={vi.fn()}
        onInsert={vi.fn()}
        onRun={vi.fn()}
        onRetry={vi.fn()}
        onUseSuggestion={onUseSuggestion}
      />,
    );

    const firstIdea = copy.composer.promptIdeas[0];
    await user.click(screen.getByRole("button", { name: firstIdea.title }));
    expect(onUseSuggestion).toHaveBeenCalledWith(firstIdea.prompt);
  });

  it("exposes run, detail, and insert actions for an agent SQL response", async () => {
    const user = userEvent.setup();
    const onRun = vi.fn();
    const onOpenDetail = vi.fn();
    const onInsert = vi.fn();
    const bubble: AIWorkspaceBubbleData = {
      id: "bubble-1",
      threadId: "thread-1",
      workspaceKey: "connection::database",
      interactionMode: "agent",
      kind: "assistant",
      status: "ready",
      title: "Query ready",
      subtitle: "Grounded response",
      prompt: "Show users",
      preview: "This query returns users.",
      detail: "This query returns users.",
      sql: "SELECT * FROM users",
      x: 0,
      y: 0,
      pointer: { x: 0, y: 0, visible: false },
      createdAt: 1,
    };
    render(
      <AIConversationView
        bubbles={[bubble]}
        copy={copy}
        showThinking
        threadRef={createRef<HTMLDivElement>()}
        onOpenDetail={onOpenDetail}
        onInsert={onInsert}
        onRun={onRun}
        onRetry={vi.fn()}
        onUseSuggestion={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: copy.bubbleActions.approveRun }));
    expect(onRun).toHaveBeenCalledWith(bubble);

    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(screen.getByRole("menuitem", { name: copy.bubbleActions.detail }));
    expect(onOpenDetail).toHaveBeenCalledWith(bubble);

    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(screen.getByRole("menuitem", { name: copy.bubbleActions.insert }));
    expect(onInsert).toHaveBeenCalledWith(bubble);
  });

  it("offers retry when partial agent progress was preserved", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const bubble: AIWorkspaceBubbleData = {
      id: "partial-1",
      threadId: "thread-1",
      workspaceKey: "connection::database",
      interactionMode: "agent",
      kind: "assistant",
      status: "partial",
      title: copy.bubbleStates.partialTitle,
      subtitle: copy.bubbleStates.partialSubtitle,
      prompt: "Inspect users",
      preview: "Provider timed out",
      detail: "Provider timed out",
      retryable: true,
      requestErrorCode: "timeout",
      agentSteps: [{
        step: 1,
        action: "describe_table",
        message: "Inspect users",
        observation: "TABLE=users",
        status: "done",
      }],
      x: 0,
      y: 0,
      pointer: { x: 0, y: 0, visible: false },
      createdAt: 1,
    };

    render(
      <AIConversationView
        bubbles={[bubble]}
        copy={copy}
        showThinking
        threadRef={createRef<HTMLDivElement>()}
        onOpenDetail={vi.fn()}
        onInsert={vi.fn()}
        onRun={vi.fn()}
        onRetry={onRetry}
        onUseSuggestion={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: copy.bubbleActions.retry }));
    expect(onRetry).toHaveBeenCalledWith(bubble);
  });
});
