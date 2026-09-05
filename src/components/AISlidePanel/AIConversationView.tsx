import { CornerDownLeft, ExternalLink, Eye, FileText, MoreHorizontal, Play, RotateCcw, Sparkles } from "lucide-react";
import { memo, useEffect, useState, type RefObject } from "react";
import type { AIWorkspaceCopy } from "./ai-workspace-copy";
import {
  aiModeAllowsInsert,
  aiModeAllowsRun,
  type AIWorkspaceAttachment,
  type AIWorkspaceBubbleData,
} from "./ai-workspace-types";
import {
  getBubbleConversationText,
  summarizePromptForDisplay,
} from "./ai-conversation-state";
import { fetchAttachmentDataUrl } from "../../utils/ai-attachments";
import { AIWorkspaceSqlBlock } from "./AIWorkspaceMarkdown";
import { AIImageViewer } from "./AIImageViewer";
import { AIAgentSteps } from "./AIAgentSteps";
import { extractAgentRecordLinks, type AIAgentRecordLink } from "./ai-agent-record-links";
import { AIWorkspaceMarkdown } from "./AIWorkspaceMarkdown";

interface AIConversationViewProps {
  bubbles: AIWorkspaceBubbleData[];
  copy: AIWorkspaceCopy;
  threadRef: RefObject<HTMLDivElement | null>;
  onOpenDetail: (bubble: AIWorkspaceBubbleData) => void;
  onInsert: (bubble: AIWorkspaceBubbleData) => void;
  onRun: (bubble: AIWorkspaceBubbleData) => void;
  onRetry: (bubble: AIWorkspaceBubbleData) => void;
  onOpenRecord: (link: AIAgentRecordLink) => void;
  onUseSuggestion: (prompt: string) => void;
}

/** Fetches a persisted image attachment's data URL (metadata-only bubbles). */
function AIAttachmentImageCard({
  attachment,
  onOpen,
}: {
  attachment: AIWorkspaceAttachment;
  onOpen: (url: string, name: string) => void;
}) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    setDataUrl(null);
    void fetchAttachmentDataUrl(attachment.id).then((url) => {
      if (cancelled) return;
      if (url) setDataUrl(url);
      else setFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [attachment.id]);

  if (failed) {
    return (
      <span className="ai-workspace-attachment-strip-chip" title={attachment.name}>
        <FileText className="w-3 h-3" />
        {attachment.name}
      </span>
    );
  }

  if (!dataUrl) {
    return (
      <span
        className="ai-workspace-attachment-image-card is-loading"
        title={attachment.name}
        aria-label={attachment.name}
      />
    );
  }

  return (
    <button
      type="button"
      className="ai-workspace-attachment-image-card"
      onClick={() => onOpen(dataUrl, attachment.name)}
      title={attachment.name}
    >
      <img src={dataUrl} alt={attachment.name} draggable={false} />
    </button>
  );
}

/** Claude-style gallery: images render above the message text, click to zoom. */
function AIAttachmentImages({
  attachments,
  onOpenImage,
}: {
  attachments: AIWorkspaceAttachment[];
  onOpenImage: (url: string, name: string) => void;
}) {
  const images = attachments.filter((attachment) => attachment.kind === "image");
  if (images.length === 0) return null;
  return (
    <div className="ai-workspace-attachment-images">
      {images.map((attachment) => (
        <AIAttachmentImageCard key={attachment.id} attachment={attachment} onOpen={onOpenImage} />
      ))}
    </div>
  );
}

/** Non-image attachments render as file chips under the message text. */
function AIAttachmentFileChips({ attachments }: { attachments: AIWorkspaceAttachment[] }) {
  const files = attachments.filter((attachment) => attachment.kind !== "image");
  if (files.length === 0) return null;
  return (
    <div className="ai-workspace-attachment-strip">
      {files.map((attachment) => (
        <span key={attachment.id} className="ai-workspace-attachment-strip-chip" title={attachment.name}>
          <FileText className="w-3 h-3" />
          {attachment.name}
        </span>
      ))}
    </div>
  );
}

export const AIConversationView = memo(function AIConversationView({
  bubbles,
  copy,
  threadRef,
  onOpenDetail,
  onInsert,
  onRun,
  onRetry,
  onOpenRecord,
  onUseSuggestion,
}: AIConversationViewProps) {
  const [openActionMenuId, setOpenActionMenuId] = useState<string | null>(null);
  const [viewerImage, setViewerImage] = useState<{ url: string; name: string } | null>(null);
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
              // Keep the agent step log available after the answer lands: it
              // collapses automatically once every step settles, so users can
              // re-open the reasoning without the toggle.
              const hasVisibleAgentProgress = bubble.interactionMode === "agent"
                && (bubble.agentSteps?.length ?? 0) > 0;
              const recordLinks = extractAgentRecordLinks(bubble.agentSteps);
              const agentReadLiveData = bubble.interactionMode === "agent"
                && bubble.agentSteps?.some(
                  (step) =>
                    (step.action === "run_readonly_sql" || step.action === "sample_table_data")
                    && step.status === "done",
                ) === true;
              const canShowDetail = !agentReadLiveData
                && bubble.status !== "loading"
                && Boolean(bubble.detail || bubble.preview || bubble.sql);
              const canInsert = !agentReadLiveData && Boolean(bubble.sql) && aiModeAllowsInsert(bubble.interactionMode);
              const canRun = Boolean(bubble.sql)
                && bubble.kind !== "result"
                && !agentReadLiveData
                && aiModeAllowsRun(bubble.interactionMode);
              const canRetry = bubble.retryable !== false
                && (bubble.status === "error" || bubble.status === "partial" || bubble.status === "cancelled");

              return (
                <article key={`chat-${bubble.id}`} className="ai-workspace-chat-turn">
                  <div className="ai-workspace-chat-turn-header">
                    <strong className="ai-workspace-chat-turn-label">{copy.modal.originalRequest}</strong>
                  </div>
                  {bubble.attachments && bubble.attachments.length > 0 && (
                    <AIAttachmentImages
                      attachments={bubble.attachments}
                      onOpenImage={(url, name) => setViewerImage({ url, name })}
                    />
                  )}
                  <div className="ai-workspace-chat-message ai-workspace-chat-message--user">
                    <p className="ai-workspace-chat-text">
                      {bubble.promptSummary || summarizePromptForDisplay(bubble.prompt)}
                    </p>
                    {bubble.attachments && bubble.attachments.length > 0 && (
                      <AIAttachmentFileChips attachments={bubble.attachments} />
                    )}
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
                          <span className="sr-only">{copy.bubbleMeta.thinking}</span>
                        </>
                      ) : bubble.status === "partial"
                        ? copy.bubbleStates.partialTitle
                        : bubble.status === "cancelled"
                          ? copy.bubbleStates.cancelledTitle
                          : bubble.sql && !agentReadLiveData ? copy.modal.sql : copy.bubbleMeta.ready}
                    </span>
                  </div>
                  <div className="ai-workspace-chat-message ai-workspace-chat-message--assistant">
                    {bubble.subtitle && bubble.subtitle !== bubble.title && (
                      <p className="ai-workspace-chat-subtitle">{bubble.subtitle}</p>
                    )}
                    {hasVisibleAgentProgress
                      && <AIAgentSteps steps={bubble.agentSteps ?? []} compact durationMs={bubble.settledAt ? Math.max(0, bubble.settledAt - bubble.createdAt) : undefined} />}
                    {bubble.status === "loading" && !hasVisibleAgentProgress ? (
                      <div className="ai-workspace-thinking-line">
                        <span className="ai-workspace-thinking-orb" aria-hidden="true" />
                        <span className="ai-workspace-thinking-shimmer">
                          {conversationText || copy.bubbleMeta.thinking}
                        </span>
                      </div>
                    ) : bubble.status !== "loading" ? (
                      conversationText
                        && <AIWorkspaceMarkdown className="ai-workspace-chat-text" text={conversationText} />
                    ) : null}
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
      <AIImageViewer
        image={viewerImage}
        labels={copy.imageViewer}
        onClose={() => setViewerImage(null)}
      />
    </div>
  );
})
