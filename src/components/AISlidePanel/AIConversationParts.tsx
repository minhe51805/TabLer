import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CornerDownLeft,
  FileText,
  Info,
  ListTree,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AIWorkspaceCopy } from "./ai-workspace-copy";
import type {
  AIWorkspaceAttachment,
  AIWorkspaceFailoverNote,
  AIWorkspaceRunTraceEntry,
} from "./ai-workspace-types";
import { fetchAttachmentDataUrl } from "../../utils/ai-attachments";
import { AIWorkspaceSqlBlock } from "./AIWorkspaceMarkdown";
import { useI18n } from "../../i18n";
import { formatPanelCopy, getAIPanelCopy, type AIPanelCopy } from "./ai-panel-copy";

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
export function AIAttachmentImages({
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
export function AIAttachmentFileChips({ attachments }: { attachments: AIWorkspaceAttachment[] }) {
  const files = attachments.filter((attachment) => attachment.kind !== "image");
  if (files.length === 0) return null;
  return (
    <div className="ai-workspace-attachment-strip">
      {files.map((attachment) => (
        <span
          key={attachment.id}
          className="ai-workspace-attachment-strip-chip"
          title={attachment.name}
        >
          <FileText className="w-3 h-3" />
          {attachment.name}
        </span>
      ))}
    </div>
  );
}

/** Provider-failover footer: a terse "Provider X bị lỗi" summary per failover
 *  event with an info button that toggles the raw provider error inline, so the
 *  long payload stays out of the answer body but one click away. */
export function AIFailoverNotes({
  notes,
  copy,
}: {
  notes: AIWorkspaceFailoverNote[];
  copy: AIWorkspaceCopy;
}) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  return (
    <div className="ai-workspace-failover-notes">
      {notes.map((note, index) => (
        <div key={`${note.summary}-${index}`} className="ai-workspace-failover-note">
          <div className="ai-workspace-failover-note-head">
            <span className="ai-workspace-failover-note-summary">{note.summary}</span>
            {note.detail && (
              <button
                type="button"
                className="ai-workspace-failover-note-info"
                aria-label={copy.bubbleStates.failoverErrorDetails}
                aria-expanded={openIndex === index}
                title={copy.bubbleStates.failoverErrorDetails}
                onClick={() => setOpenIndex((current) => (current === index ? null : index))}
              >
                <Info className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          {note.detail && openIndex === index && (
            <pre className="ai-workspace-failover-note-detail">{note.detail}</pre>
          )}
        </div>
      ))}
    </div>
  );
}

/** "320ms" / "1.2s" / "1m 12s" for per-call and total durations. */
function formatRunDetailMs(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) {
    const rounded = Math.round(totalSeconds * 10) / 10;
    return `${rounded}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

/** Collapsible audit trail of a finished agent run: every tool call in order
 *  (name, args summary, duration, ok/fail) plus the SQL each call executed.
 *  Hidden entirely when the run recorded no tool calls. */
export function AIRunDetails({
  trace,
  totalMs,
}: {
  trace: AIWorkspaceRunTraceEntry[];
  totalMs?: number;
}) {
  const { language } = useI18n();
  const panelCopy = getAIPanelCopy(language);
  const [expanded, setExpanded] = useState(false);
  if (trace.length === 0) return null;
  const showTotal = totalMs !== undefined && totalMs > 0;
  return (
    <div className={`ai-run-details ${expanded ? "" : "is-collapsed"}`}>
      <button
        type="button"
        className="ai-run-details-head"
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
      >
        <ListTree className="w-3.5 h-3.5" />
        <span>{panelCopy.runDetails.label}</span>
        <span className="ai-run-details-head-right">
          <span>
            {formatPanelCopy(panelCopy.runDetails.callCount, {
              count: String(trace.length),
            })}
          </span>
          {showTotal && (
            <span>
              {formatPanelCopy(panelCopy.runDetails.total, {
                duration: formatRunDetailMs(totalMs as number),
              })}
            </span>
          )}
          {expanded ? (
            <ChevronDown className="w-3.5 h-3.5" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5" />
          )}
        </span>
      </button>
      {expanded && (
        <>
          <ol className="ai-run-details-list">
            {trace.map((entry, index) => (
              <li key={`${index}-${entry.tool}`} className="ai-run-details-call">
                <div className="ai-run-details-call-line">
                  <span className="ai-run-details-tool">{entry.tool}</span>
                  {entry.argsSummary && (
                    <span className="ai-run-details-args" title={entry.argsSummary}>
                      {entry.argsSummary}
                    </span>
                  )}
                  <span className="ai-run-details-ms">{formatRunDetailMs(entry.ms)}</span>
                  <span
                    className={`ai-run-details-status ai-run-details-status--${entry.ok ? "ok" : "fail"}`}
                  >
                    {entry.ok ? (
                      <CheckCircle2 className="w-3 h-3" />
                    ) : (
                      <AlertCircle className="w-3 h-3" />
                    )}
                    {entry.ok ? panelCopy.runDetails.ok : panelCopy.runDetails.failed}
                  </span>
                </div>
                {entry.sql && (
                  <>
                    <span className="ai-run-details-sql-label">
                      {panelCopy.runDetails.sqlLabel}
                    </span>
                    <AIWorkspaceSqlBlock code={entry.sql} />
                  </>
                )}
              </li>
            ))}
          </ol>
          {showTotal && (
            <div className="ai-run-details-total">
              {formatPanelCopy(panelCopy.runDetails.total, {
                duration: formatRunDetailMs(totalMs as number),
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** ask_user reply block: renders the model's options as one-click buttons and,
 *  when the user picks "type your own", reveals an inline text field right
 *  under the options so they can send a free-form answer without hunting for
 *  the composer at the bottom of the panel. Submitting routes through the same
 *  path as an option click (sends the text as the next message). */
export function AIAskUserReply({
  options,
  copy,
  onSelectOption,
}: {
  options: string[];
  copy: AIWorkspaceCopy;
  onSelectOption: (value: string) => void;
}) {
  const [isCustomOpen, setIsCustomOpen] = useState(false);
  const [customValue, setCustomValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isCustomOpen) inputRef.current?.focus();
  }, [isCustomOpen]);

  const submitCustom = () => {
    const trimmed = customValue.trim();
    if (!trimmed) return;
    onSelectOption(trimmed);
    setCustomValue("");
    setIsCustomOpen(false);
  };

  return (
    <div className="ai-workspace-ask-user">
      {options.map((option) => (
        <button
          key={option}
          type="button"
          className="ai-workspace-ask-user-option"
          onClick={() => onSelectOption(option)}
        >
          {option}
        </button>
      ))}
      {isCustomOpen ? (
        <form
          className="ai-workspace-ask-user-custom"
          onSubmit={(event) => {
            event.preventDefault();
            submitCustom();
          }}
        >
          <input
            ref={inputRef}
            type="text"
            className="ai-workspace-ask-user-custom-input"
            value={customValue}
            placeholder={copy.bubbleStates.askUserCustomPlaceholder}
            onChange={(event) => setCustomValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setCustomValue("");
                setIsCustomOpen(false);
              }
            }}
          />
          <button
            type="submit"
            className="ai-workspace-ask-user-custom-send"
            disabled={!customValue.trim()}
            title={copy.bubbleStates.askUserCustomSend}
            aria-label={copy.bubbleStates.askUserCustomSend}
          >
            <CornerDownLeft className="w-3.5 h-3.5" />
          </button>
        </form>
      ) : (
        <button
          type="button"
          className="ai-workspace-ask-user-option is-custom"
          onClick={() => setIsCustomOpen(true)}
        >
          {copy.bubbleStates.askUserCustomAnswer}
        </button>
      )}
    </div>
  );
}

/** Preset 👎 reasons, keyed so the stored feedback stays locale-independent
 *  while the chip labels come from the panel copy pack. */
const FEEDBACK_REASON_KEYS = ["wrongSql", "misunderstood", "tooSlow", "other"] as const;
type FeedbackReasonKey = (typeof FEEDBACK_REASON_KEYS)[number];

/** "What was wrong?" popover behind the 👎 button: preset chips plus a
 *  free-text note. Submitting hands a structured feedback record to the
 *  parent, which mirrors it into agent memory for the learning loop. */
export function AIFeedbackPopover({
  copy,
  onSubmit,
  onClose,
}: {
  copy: AIPanelCopy;
  onSubmit: (reasons: string[], comment: string) => void;
  onClose: () => void;
}) {
  const [selectedReasons, setSelectedReasons] = useState<FeedbackReasonKey[]>([]);
  const [comment, setComment] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Click-outside / Escape dismiss — the popover is a transient annotation,
  // not a modal, so nothing it holds should trap the user.
  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  const toggleReason = (key: FeedbackReasonKey) => {
    setSelectedReasons((current) =>
      current.includes(key) ? current.filter((value) => value !== key) : [...current, key],
    );
  };

  const submit = () => {
    onSubmit(selectedReasons, comment.trim());
    onClose();
  };

  return (
    <div ref={rootRef} className="ai-workspace-feedback-popover" role="dialog">
      <p className="ai-workspace-feedback-title">{copy.responseActions.feedbackTitle}</p>
      <div className="ai-workspace-feedback-chips">
        {FEEDBACK_REASON_KEYS.map((key) => (
          <button
            key={key}
            type="button"
            className={`ai-workspace-suggestion-chip${
              selectedReasons.includes(key) ? " is-selected" : ""
            }`}
            onClick={() => toggleReason(key)}
          >
            {copy.responseActions.feedbackReasons[key]}
          </button>
        ))}
      </div>
      <textarea
        className="ai-workspace-feedback-input"
        value={comment}
        placeholder={copy.responseActions.feedbackPlaceholder}
        rows={2}
        onChange={(event) => setComment(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <button
        type="button"
        className="ai-workspace-mode-action-btn primary ai-workspace-feedback-submit"
        onClick={submit}
      >
        {copy.responseActions.feedbackSubmit}
      </button>
    </div>
  );
}
