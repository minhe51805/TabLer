import {
  Check,
  Copy,
  CornerDownLeft,
  ExternalLink,
  Play,
  PencilLine,
  RefreshCw,
  RotateCcw,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
} from "lucide-react";
import { memo, useState, type RefObject } from "react";
import type { AIWorkspaceCopy } from "./ai-workspace-copy";
import {
  aiModeAllowsInsert,
  aiModeAllowsRun,
  type AIWorkspaceBubbleData,
  type AIWorkspaceBubbleFeedback,
} from "./ai-workspace-types";
import {
  getBubbleConversationText,
  stripAskUserTrailingOptions,
  summarizePromptForDisplay,
} from "./ai-conversation-state";
import { AIWorkspaceSqlBlock } from "./AIWorkspaceMarkdown";
import { AIImageViewer } from "./AIImageViewer";
import { AIAgentSteps } from "./AIAgentSteps";
import "../../styles/ai-prompt-edit.css";
import { extractAgentRecordLinks, type AIAgentRecordLink } from "./ai-agent-record-links";
import { AIWorkspaceMarkdown } from "./AIWorkspaceMarkdown";
import { AIThinkingTrace } from "./AIThinkingTrace";
import { useI18n } from "../../i18n";
import { formatPanelCopy, getAIPanelCopy } from "./ai-panel-copy";
import {
  DEFAULT_AGENT_TOKEN_BUDGET,
  estimateUsageCostUsd,
  formatSessionCostUsd,
} from "./ai-agent-cost";
import {
  AIAttachmentFileChips,
  AIAttachmentImages,
  AIFailoverNotes,
  AIFeedbackPopover,
  AIAskUserReply,
  AIRunDetails,
} from "./AIConversationParts";

interface AIConversationViewProps {
  bubbles: AIWorkspaceBubbleData[];
  copy: AIWorkspaceCopy;
  threadRef: RefObject<HTMLDivElement | null>;
  onInsert: (bubble: AIWorkspaceBubbleData) => void;
  onRun: (bubble: AIWorkspaceBubbleData) => void;
  onRetry: (bubble: AIWorkspaceBubbleData) => void;
  onCopy: (bubble: AIWorkspaceBubbleData) => Promise<boolean> | void;
  onOpenRecord: (link: AIAgentRecordLink) => void;
  onUseSuggestion: (prompt: string) => void;
  /** One-click reply: sends the chosen ask_user option (or an inline
   *  free-form answer) as a new message. */
  onAskUserOptionSelect?: (option: string) => void;
  /** Re-runs the prompt that produced this bubble and swaps the answer into
   *  the same chat slot; the old answer stays when the run fails. */
  onRegenerate?: (bubble: AIWorkspaceBubbleData) => void;
  /** Edit the prompt of a finished turn and re-run it into the same slot. */
  onEditRerun?: (bubble: AIWorkspaceBubbleData, editedPrompt: string) => void;
  /** Records 👍/👎 on a finished answer; 👎 carries the popover's reasons and
   *  free-text note into the learning loop. */
  onFeedback?: (bubble: AIWorkspaceBubbleData, feedback: AIWorkspaceBubbleFeedback) => void;
  /** Legacy composer-focus fallback. Retained for backward compatibility; the
   *  custom reply now opens an inline text field via {@link AIAskUserReply}. */
  onAskUserCustomInput?: () => void;
}

export const AIConversationView = memo(function AIConversationView({
  bubbles,
  copy,
  threadRef,
  onInsert,
  onRun,
  onRetry,
  onCopy,
  onOpenRecord,
  onUseSuggestion,
  onAskUserOptionSelect,
  onRegenerate,
  onEditRerun,
  onFeedback,
}: AIConversationViewProps) {
  const [viewerImage, setViewerImage] = useState<{ url: string; name: string } | null>(null);
  const [copiedBubbleId, setCopiedBubbleId] = useState<string | null>(null);
  // Bubble whose 👎 popover is open; only one feedback form at a time.
  const [feedbackBubbleId, setFeedbackBubbleId] = useState<string | null>(null);
  // Bubble whose user prompt is being edited inline; only one at a time.
  const [editingBubbleId, setEditingBubbleId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState("");
  const hasConversation = bubbles.length > 0;
  const { language } = useI18n();
  const panelCopy = getAIPanelCopy(language);

  const handleCopyClick = (bubble: AIWorkspaceBubbleData) => {
    void Promise.resolve(onCopy(bubble)).then((copied) => {
      // `onCopy` returns false only when the clipboard write failed; a void
      // return (legacy callers) is treated as success.
      if (copied === false) return;
      setCopiedBubbleId(bubble.id);
      window.setTimeout(() => {
        setCopiedBubbleId((current) => (current === bubble.id ? null : current));
      }, 1600);
    });
  };

  return (
    <div className="ai-workspace-chat-shell">
      <div className={`ai-workspace-chat-surface ${hasConversation ? "" : "is-empty"}`}>
        {hasConversation ? (
          <div ref={threadRef} className="ai-workspace-chat-thread">
            {bubbles.map((bubble, bubbleIndex) => {
              const conversationText = getBubbleConversationText(bubble);
              // The model's live chain-of-thought: streamed token by token from
              // `reasoning_delta` while loading, retained afterwards. Powers the
              // collapsible "Thinking" trace panel below.
              const reasoningText = bubble.reasoning?.trim();
              // ask_user bubbles at the tail of the thread render their
              // options as one-click reply buttons instead of plain text.
              const askUserOptions =
                bubble.askUserOptions?.length &&
                bubbleIndex === bubbles.length - 1 &&
                bubble.status === "ready"
                  ? bubble.askUserOptions
                  : null;
              const displayConversationText = askUserOptions
                ? stripAskUserTrailingOptions(conversationText)
                : conversationText;
              // Keep the agent step log available after the answer lands: it
              // collapses automatically once every step settles, so users can
              // re-open the reasoning without the toggle.
              // While the opening plan turn streams, its text lands in
              // bubble.detail — feed it into the running plan step so the
              // acknowledgement grows inside the steps card instead of
              // appearing below it and then jumping inside on completion.
              const planStreamingInCard =
                bubble.status === "loading" &&
                Boolean(bubble.detail?.trim()) &&
                bubble.agentSteps?.[bubble.agentSteps.length - 1]?.action === "plan" &&
                bubble.agentSteps[bubble.agentSteps.length - 1].status === "running";
              const liveSteps = planStreamingInCard
                ? bubble.agentSteps?.map((step, index, arr) =>
                    index === arr.length - 1 ? { ...step, message: bubble.detail ?? "" } : step,
                  )
                : bubble.agentSteps;
              const hasVisibleAgentProgress =
                bubble.interactionMode === "agent" && (liveSteps?.length ?? 0) > 0;
              const recordLinks = extractAgentRecordLinks(liveSteps);
              const agentReadLiveData =
                bubble.interactionMode === "agent" &&
                liveSteps?.some(
                  (step) =>
                    (step.action === "run_readonly_sql" || step.action === "sample_table_data") &&
                    step.status === "done",
                ) === true;
              const hasRunnableSql =
                Boolean(bubble.sql) &&
                bubble.kind !== "result" &&
                aiModeAllowsRun(bubble.interactionMode);
              const hasInsertableSql =
                Boolean(bubble.sql) && aiModeAllowsInsert(bubble.interactionMode);
              // After the agent already read live data, Run/Insert stay
              // visible but disabled — hiding them made the answer look like
              // it had no SQL at all.
              const canInsert = hasInsertableSql && !agentReadLiveData;
              const canRun = hasRunnableSql && !agentReadLiveData;
              const canRetry =
                bubble.retryable !== false &&
                (bubble.status === "error" ||
                  bubble.status === "partial" ||
                  bubble.status === "cancelled");
              const canCopy =
                bubble.status !== "loading" &&
                Boolean(bubble.sql || bubble.detail || bubble.preview);
              // Regenerate + 👍/👎 only on finished answers: a loading turn is
              // still being written, a failed/cancelled one has Retry instead.
              // Regenerate is ready-only because partial turns already offer
              // Retry; feedback also accepts partial (a truncated answer can
              // still be rated).
              const isFinishedAnswer =
                bubble.kind !== "error" &&
                (bubble.status === "ready" || bubble.status === "partial");
              const canRegenerate =
                bubble.status === "ready" && bubble.kind !== "error" && Boolean(onRegenerate);
              const canFeedback = isFinishedAnswer && Boolean(onFeedback);

              return (
                <article key={`chat-${bubble.id}`} className="ai-workspace-chat-turn">
                  <div className="ai-workspace-chat-turn-header">
                    <strong className="ai-workspace-chat-turn-label">
                      {copy.modal.originalRequest}
                    </strong>
                  </div>
                  {bubble.attachments && bubble.attachments.length > 0 && (
                    <AIAttachmentImages
                      attachments={bubble.attachments}
                      onOpenImage={(url, name) => setViewerImage({ url, name })}
                    />
                  )}
                  <div className="ai-workspace-chat-message ai-workspace-chat-message--user">
                    {editingBubbleId === bubble.id ? (
                      <div className="ai-workspace-prompt-edit">
                        <textarea
                          className="ai-workspace-prompt-edit-input"
                          value={editingDraft}
                          autoFocus
                          rows={Math.min(8, Math.max(2, editingDraft.split("\n").length))}
                          onChange={(event) => setEditingDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (
                              event.key === "Enter" &&
                              !event.shiftKey &&
                              !event.nativeEvent.isComposing
                            ) {
                              event.preventDefault();
                              if (editingDraft.trim()) {
                                setEditingBubbleId(null);
                                onEditRerun?.(bubble, editingDraft);
                              }
                            }
                            if (event.key === "Escape") {
                              event.preventDefault();
                              setEditingBubbleId(null);
                            }
                          }}
                        />
                        <div className="ai-workspace-prompt-edit-actions">
                          <button
                            type="button"
                            className="ai-workspace-mode-action-btn"
                            onClick={() => setEditingBubbleId(null)}
                          >
                            {panelCopy.responseActions.editPromptCancel}
                          </button>
                          <button
                            type="button"
                            className="ai-workspace-mode-action-btn primary"
                            disabled={!editingDraft.trim()}
                            onClick={() => {
                              setEditingBubbleId(null);
                              onEditRerun?.(bubble, editingDraft);
                            }}
                          >
                            {panelCopy.responseActions.editPromptSave}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <p className="ai-workspace-chat-text">
                          {bubble.promptSummary || summarizePromptForDisplay(bubble.prompt)}
                        </p>
                        {bubble.attachments && bubble.attachments.length > 0 && (
                          <AIAttachmentFileChips attachments={bubble.attachments} />
                        )}
                        {onEditRerun && bubble.status !== "loading" && (
                          <button
                            type="button"
                            className="ai-workspace-chat-action-icon ai-workspace-prompt-edit-btn"
                            title={panelCopy.responseActions.editPrompt}
                            aria-label={panelCopy.responseActions.editPrompt}
                            onClick={() => {
                              setEditingBubbleId(bubble.id);
                              setEditingDraft(bubble.prompt);
                            }}
                          >
                            <PencilLine className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </>
                    )}
                  </div>
                  <div className="ai-workspace-chat-turn-header ai-workspace-chat-turn-header--assistant">
                    <strong className="ai-workspace-chat-turn-label">
                      {copy.modal.assistantExplanation}
                    </strong>
                    <span
                      className={`ai-workspace-chat-state ${bubble.status === "loading" ? "is-thinking" : ""}`}
                    >
                      {bubble.status === "loading" ? (
                        <>
                          <span className="ai-workspace-thinking-dots" aria-hidden="true">
                            <span />
                            <span />
                            <span />
                          </span>
                          <span className="sr-only">{copy.bubbleMeta.thinking}</span>
                        </>
                      ) : bubble.status === "partial" ? (
                        copy.bubbleStates.partialTitle
                      ) : bubble.status === "cancelled" ? (
                        copy.bubbleStates.cancelledTitle
                      ) : bubble.sql && !agentReadLiveData ? (
                        copy.modal.sql
                      ) : (
                        copy.bubbleMeta.ready
                      )}
                    </span>
                  </div>
                  <div className="ai-workspace-chat-message ai-workspace-chat-message--assistant">
                    {bubble.subtitle && bubble.subtitle !== bubble.title && (
                      <p className="ai-workspace-chat-subtitle">{bubble.subtitle}</p>
                    )}
                    {hasVisibleAgentProgress && (
                      <AIAgentSteps
                        steps={liveSteps ?? []}
                        compact
                        durationMs={
                          bubble.settledAt
                            ? Math.max(0, bubble.settledAt - bubble.createdAt)
                            : undefined
                        }
                      />
                    )}
                    {reasoningText && !hasVisibleAgentProgress && (
                      <AIThinkingTrace
                        text={reasoningText}
                        streaming={bubble.status === "loading"}
                        copy={copy}
                      />
                    )}
                    {bubble.status === "loading" &&
                      bubble.detail?.trim() &&
                      conversationText &&
                      !planStreamingInCard && (
                        // Streamed answer text renders as live markdown while the
                        // turn is still loading — the reply fills in token by
                        // token instead of appearing all at once when the run
                        // settles. Agent turns stream a JSON tool action, so the
                        // finish answer is pulled from the partial JSON (aiStore)
                        // and rendered here under the step log. Gate on the
                        // streamed `detail` (not the preview fallback) so the
                        // body stays empty between phases: the opening
                        // acknowledgement already shows as the "plan" step, so
                        // it must not also duplicate here once the tool loop
                        // starts.
                        <AIWorkspaceMarkdown
                          className="ai-workspace-chat-text"
                          text={displayConversationText}
                        />
                      )}
                    {bubble.status === "loading" && !hasVisibleAgentProgress ? (
                      // The live thinking trace above already carries the "model
                      // is working" feedback while it streams reasoning, and once
                      // real answer text lands the markdown block above takes
                      // over — so the shimmer only covers the gap before the
                      // first token (or the whole wait when the model streams
                      // nothing at all).
                      !(bubble.detail?.trim() && conversationText) &&
                      (conversationText || !reasoningText) ? (
                        <div className="ai-workspace-thinking-line">
                          <span className="ai-workspace-thinking-orb" aria-hidden="true" />
                          <span className="ai-workspace-thinking-shimmer">
                            {conversationText || copy.bubbleMeta.thinking}
                          </span>
                        </div>
                      ) : null
                    ) : bubble.status !== "loading" ? (
                      conversationText && (
                        <AIWorkspaceMarkdown
                          className="ai-workspace-chat-text"
                          text={displayConversationText}
                        />
                      )
                    ) : null}
                    {bubble.failoverNotes && bubble.failoverNotes.length > 0 && (
                      <AIFailoverNotes notes={bubble.failoverNotes} copy={copy} />
                    )}
                    {askUserOptions && (
                      <AIAskUserReply
                        options={askUserOptions}
                        copy={copy}
                        onSelectOption={(value) => onAskUserOptionSelect?.(value)}
                      />
                    )}
                    {recordLinks.length > 0 && (
                      <div className="ai-workspace-agent-record-links">
                        {recordLinks.map((link) => (
                          <button
                            key={`${link.tableName}-${JSON.stringify(link.rowKey)}`}
                            type="button"
                            className="ai-workspace-agent-record-link"
                            onClick={() => onOpenRecord(link)}
                          >
                            <ExternalLink className="w-3.5 h-3.5" />
                            <span>{link.label}</span>
                          </button>
                        ))}
                      </div>
                    )}
                    {bubble.sql && bubble.status !== "error" && (
                      <AIWorkspaceSqlBlock code={bubble.sql} />
                    )}
                    {bubble.status !== "loading" && (bubble.runTrace?.length ?? 0) > 0 && (
                      // Audit trail: the executor recorded every tool call of
                      // this run; collapsed by default, expand for the trace.
                      <AIRunDetails
                        trace={bubble.runTrace ?? []}
                        totalMs={
                          bubble.settledAt
                            ? Math.max(0, bubble.settledAt - bubble.createdAt)
                            : undefined
                        }
                      />
                    )}
                    {(canInsert ||
                      canRun ||
                      canRetry ||
                      canCopy ||
                      canRegenerate ||
                      canFeedback) && (
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
                        {hasRunnableSql && (
                          <button
                            type="button"
                            className="ai-workspace-mode-action-btn primary"
                            onClick={() => onRun(bubble)}
                            disabled={!canRun}
                            title={
                              canRun
                                ? copy.bubbleActions.approveRun
                                : copy.bubbleActions.liveDataDisabledHint
                            }
                          >
                            <Play className="w-3.5 h-3.5" />
                            <span>{copy.bubbleActions.approveRun}</span>
                          </button>
                        )}
                        {canCopy && (
                          <button
                            type="button"
                            className="ai-workspace-chat-action-icon"
                            onClick={() => handleCopyClick(bubble)}
                            title={copy.bubbleActions.copy}
                            aria-label={copy.bubbleActions.copy}
                          >
                            {copiedBubbleId === bubble.id ? (
                              <Check className="w-3.5 h-3.5" />
                            ) : (
                              <Copy className="w-3.5 h-3.5" />
                            )}
                          </button>
                        )}
                        {(canInsert || hasInsertableSql) && (
                          <button
                            type="button"
                            className="ai-workspace-chat-action-icon"
                            onClick={() => onInsert(bubble)}
                            disabled={!canInsert}
                            title={
                              canInsert
                                ? copy.bubbleActions.insert
                                : copy.bubbleActions.liveDataDisabledHint
                            }
                            aria-label={copy.bubbleActions.insert}
                          >
                            <CornerDownLeft className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {canRegenerate && (
                          <button
                            type="button"
                            className="ai-workspace-chat-action-icon"
                            onClick={() => {
                              setFeedbackBubbleId(null);
                              onRegenerate?.(bubble);
                            }}
                            title={panelCopy.responseActions.regenerate}
                            aria-label={panelCopy.responseActions.regenerate}
                          >
                            <RefreshCw className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {canFeedback && (
                          <>
                            <button
                              type="button"
                              className={`ai-workspace-chat-action-icon${
                                bubble.feedback?.sentiment === "up" ? " is-active" : ""
                              }`}
                              onClick={() =>
                                onFeedback?.(bubble, {
                                  sentiment: "up",
                                  recordedAt: Date.now(),
                                })
                              }
                              title={panelCopy.responseActions.helpful}
                              aria-label={panelCopy.responseActions.helpful}
                            >
                              <ThumbsUp className="w-3.5 h-3.5" />
                            </button>
                            <div
                              className={`ai-workspace-chat-action-menu${
                                feedbackBubbleId === bubble.id ? " is-open" : ""
                              }`}
                            >
                              <button
                                type="button"
                                className={`ai-workspace-chat-action-icon${
                                  bubble.feedback?.sentiment === "down" ? " is-active" : ""
                                }`}
                                onClick={() =>
                                  setFeedbackBubbleId((current) =>
                                    current === bubble.id ? null : bubble.id,
                                  )
                                }
                                title={panelCopy.responseActions.notHelpful}
                                aria-label={panelCopy.responseActions.notHelpful}
                              >
                                <ThumbsDown className="w-3.5 h-3.5" />
                              </button>
                              {feedbackBubbleId === bubble.id && (
                                <AIFeedbackPopover
                                  copy={panelCopy}
                                  onClose={() => setFeedbackBubbleId(null)}
                                  onSubmit={(reasons, comment) =>
                                    onFeedback?.(bubble, {
                                      sentiment: "down",
                                      reasons: reasons.length > 0 ? reasons : undefined,
                                      comment: comment || undefined,
                                      recordedAt: Date.now(),
                                    })
                                  }
                                />
                              )}
                            </div>
                          </>
                        )}
                      </div>
                    )}
                    {bubble.status !== "loading" &&
                      ((bubble.tokensUsed ?? 0) > 0 || bubble.modelUsed) && (
                        // Run footer: what the turn actually cost, against the
                        // per-run token budget the runner enforces, plus the
                        // model that answered (the fast model on trivial asks)
                        // and a rough list-price estimate when the model is known.
                        <div className="ai-workspace-chat-run-cost" title={panelCopy.runCost.title}>
                          {formatPanelCopy(panelCopy.runCost.label, {
                            used: (bubble.tokensUsed ?? 0).toLocaleString(),
                            budget: DEFAULT_AGENT_TOKEN_BUDGET.toLocaleString(),
                          })}
                          {bubble.modelUsed ? ` · ${bubble.modelUsed}` : ""}
                          {bubble.tokenBudgetExhausted && (
                            <span
                              className="ai-workspace-chat-run-cost-warning"
                              title={panelCopy.tokenBudgetReached}
                            >
                              {" "}
                              · ⚠ {panelCopy.tokenBudgetReached}
                            </span>
                          )}
                          {(() => {
                            const runCost = estimateUsageCostUsd(bubble.modelUsed, {
                              promptTokens: 0,
                              completionTokens: 0,
                              totalTokens: bubble.tokensUsed ?? 0,
                            });
                            return runCost !== null ? ` · ~${formatSessionCostUsd(runCost)}` : "";
                          })()}
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
      <AIImageViewer
        image={viewerImage}
        labels={copy.imageViewer}
        onClose={() => setViewerImage(null)}
      />
    </div>
  );
});
