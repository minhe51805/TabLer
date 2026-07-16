import { CornerDownLeft, Eye, MoreHorizontal, Play, RotateCcw, Sparkles } from "lucide-react";
import { useEffect, useState, type RefObject } from "react";
import type { AIWorkspaceCopy } from "./ai-workspace-copy";
import {
  aiModeAllowsInsert,
  aiModeAllowsRun,
  type AIWorkspaceBubbleData,
} from "./ai-workspace-types";
import {
  getBubbleConversationText,
  summarizePromptForDisplay,
} from "./ai-conversation-state";
import { AIAgentSteps } from "./AIAgentSteps";
import { AIWorkspaceMarkdown } from "./AIWorkspaceMarkdown";

interface AIConversationViewProps {
  bubbles: AIWorkspaceBubbleData[];
  copy: AIWorkspaceCopy;
  showThinking: boolean;
  threadRef: RefObject<HTMLDivElement | null>;
  onOpenDetail: (bubble: AIWorkspaceBubbleData) => void;
  onInsert: (bubble: AIWorkspaceBubbleData) => void;
  onRun: (bubble: AIWorkspaceBubbleData) => void;
  onRetry: (bubble: AIWorkspaceBubbleData) => void;
  onUseSuggestion: (prompt: string) => void;
}

export function AIConversationView({
  bubbles,
  copy,
  showThinking,
  threadRef,
  onOpenDetail,
  onInsert,
  onRun,
  onRetry,
  onUseSuggestion,
}: AIConversationViewProps) {
  const [openActionMenuId, setOpenActionMenuId] = useState<string | null>(null);
  const hasConversation = bubbles.length > 0;

  useEffect(() => {
    if (!openActionMenuId) return;

    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Element | null;
      if (target?.closest(".ai-workspace-chat-action-menu")) return;
      setOpenActionMenuId(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenActionMenuId(null);
    };

    window.addEventListener("mousedown", handlePointerDown, true);
    window.addEventListener("touchstart", handlePointerDown, true);
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown, true);
      window.removeEventListener("touchstart", handlePointerDown, true);
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [openActionMenuId]);

  return (
    <div className="ai-workspace-chat-shell">
      <div className={`ai-workspace-chat-surface ${hasConversation ? "" : "is-empty"}`}>
        {hasConversation ? (
          <div ref={threadRef} className="ai-workspace-chat-thread">
            {bubbles.map((bubble) => {
              const conversationText = getBubbleConversationText(bubble);
              const canShowDetail = bubble.status !== "loading"
                && Boolean(bubble.detail || bubble.preview || bubble.sql);
              const canInsert = Boolean(bubble.sql) && aiModeAllowsInsert(bubble.interactionMode);
              const canRun = Boolean(bubble.sql)
                && bubble.kind !== "result"
                && aiModeAllowsRun(bubble.interactionMode);
              const canRetry = bubble.retryable !== false
                && (bubble.status === "error" || bubble.status === "partial" || bubble.status === "cancelled");

              return (
                <article key={`chat-${bubble.id}`} className="ai-workspace-chat-turn">
                  <div className="ai-workspace-chat-turn-header">
                    <strong className="ai-workspace-chat-turn-label">{copy.modal.originalRequest}</strong>
                  </div>
                  <div className="ai-workspace-chat-message ai-workspace-chat-message--user">
                    <p className="ai-workspace-chat-text">
                      {bubble.promptSummary || summarizePromptForDisplay(bubble.prompt)}
                    </p>
                  </div>
                  <div className="ai-workspace-chat-turn-header ai-workspace-chat-turn-header--assistant">
                    <strong className="ai-workspace-chat-turn-label">{copy.modal.assistantExplanation}</strong>
                    <span className={`ai-workspace-chat-state ${bubble.status === "loading" ? "is-thinking" : ""}`}>
                      {bubble.status === "loading" ? (
                        <>
                          <span className="ai-workspace-thinking-dots" aria-hidden="true">
                            <span />
                            <span />
                            <span />
                          </span>
                          {copy.bubbleMeta.thinking}
                        </>
                      ) : bubble.status === "partial"
                        ? copy.bubbleStates.partialTitle
                        : bubble.status === "cancelled"
                          ? copy.bubbleStates.cancelledTitle
                          : bubble.sql ? copy.modal.sql : copy.bubbleMeta.ready}
                    </span>
                  </div>
                  <div className="ai-workspace-chat-message ai-workspace-chat-message--assistant">
                    {bubble.subtitle && bubble.subtitle !== bubble.title && (
                      <p className="ai-workspace-chat-subtitle">{bubble.subtitle}</p>
                    )}
                    {showThinking
                      && bubble.interactionMode === "agent"
                      && (bubble.agentSteps?.length ?? 0) > 0
                      && <AIAgentSteps steps={bubble.agentSteps ?? []} compact />}
                    {bubble.status === "loading" ? (
                      <div className="ai-workspace-thinking-line">
                        <span className="ai-workspace-thinking-orb" aria-hidden="true" />
                        <span className="ai-workspace-thinking-shimmer">
                          {conversationText || copy.bubbleMeta.thinking}
                        </span>
                      </div>
                    ) : (
                      conversationText
                        && <AIWorkspaceMarkdown className="ai-workspace-chat-text" text={conversationText} />
                    )}
                    {bubble.sql && bubble.status !== "error" && (
                      <pre className="ai-workspace-chat-code">{bubble.sql}</pre>
                    )}
                    {(canShowDetail || canInsert || canRun || canRetry) && (
                      <div className="ai-workspace-chat-actions">
                        {canRetry && (
                          <button
                            type="button"
                            className="ai-workspace-mode-action-btn"
                            onClick={() => onRetry(bubble)}
                          >
                            <RotateCcw className="w-3.5 h-3.5" />
                            <span>{copy.bubbleActions.retry}</span>
                          </button>
                        )}
                        {canRun && (
                          <button
                            type="button"
                            className="ai-workspace-mode-action-btn primary"
                            onClick={() => onRun(bubble)}
                          >
                            <Play className="w-3.5 h-3.5" />
                            <span>{copy.bubbleActions.approveRun}</span>
                          </button>
                        )}
                        {(canShowDetail || canInsert) && (
                          <div className={`ai-workspace-chat-action-menu ${openActionMenuId === bubble.id ? "is-open" : ""}`}>
                            <button
                              type="button"
                              className="ai-workspace-chat-action-menu-trigger"
                              aria-expanded={openActionMenuId === bubble.id}
                              aria-haspopup="menu"
                              title="More actions"
                              aria-label="More actions"
                              onClick={() => setOpenActionMenuId((current) => current === bubble.id ? null : bubble.id)}
                            >
                              <MoreHorizontal className="w-3.5 h-3.5" />
                            </button>
                            {openActionMenuId === bubble.id && (
                              <div className="ai-workspace-chat-action-popover" role="menu">
                                {canShowDetail && (
                                  <button
                                    type="button"
                                    role="menuitem"
                                    className="ai-workspace-chat-action-item"
                                    onClick={() => {
                                      setOpenActionMenuId(null);
                                      onOpenDetail(bubble);
                                    }}
                                  >
                                    <Eye className="w-3.5 h-3.5" />
                                    <span>{copy.bubbleActions.detail}</span>
                                  </button>
                                )}
                                {canInsert && (
                                  <button
                                    type="button"
                                    role="menuitem"
                                    className="ai-workspace-chat-action-item"
                                    onClick={() => {
                                      setOpenActionMenuId(null);
                                      onInsert(bubble);
                                    }}
                                  >
                                    <CornerDownLeft className="w-3.5 h-3.5" />
                                    <span>{copy.bubbleActions.insert}</span>
                                  </button>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="ai-workspace-chat-empty">
            <div className="ai-workspace-chat-empty-illustration">
              <Sparkles className="w-4 h-4" />
            </div>
            <div className="ai-workspace-chat-empty-copy">
              <strong className="ai-workspace-chat-empty-title">{copy.composer.title}</strong>
              <p className="ai-workspace-chat-empty-text">{copy.composer.note}</p>
              <div className="ai-workspace-chat-empty-suggestions">
                {copy.composer.promptIdeas.slice(0, 3).map((idea) => (
                  <button
                    key={idea.title}
                    type="button"
                    className="ai-workspace-suggestion-chip"
                    onClick={() => onUseSuggestion(idea.prompt)}
                  >
                    {idea.title}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
