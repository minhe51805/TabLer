import { AlertTriangle, Copy, GripHorizontal, Play, Send, Sparkles, Target, Wand2, X } from "lucide-react";
import type { MouseEvent as ReactMouseEvent, Ref } from "react";
import { useI18n } from "../../i18n";
import type { AIWorkspaceBubbleData } from "./ai-workspace-types";
import { getAIWorkspaceCopy } from "./ai-workspace-copy";

interface AIWorkspaceBubbleProps {
  bubble: AIWorkspaceBubbleData;
  bubbleRef?: Ref<HTMLDivElement>;
  compact?: boolean;
  isGenerating: boolean;
  isRunning: boolean;
  onOpenDetail: (bubble: AIWorkspaceBubbleData) => void;
  onStartDrag: (bubbleId: string, event: ReactMouseEvent<HTMLDivElement>) => void;
  onStartPointerDrag: (bubbleId: string, event: ReactMouseEvent<HTMLButtonElement>) => void;
  onResetPointer: (bubbleId: string) => void;
  onCopy: (bubble: AIWorkspaceBubbleData) => void;
  onInsert: (bubble: AIWorkspaceBubbleData) => void;
  onRun: (bubble: AIWorkspaceBubbleData) => void;
  onDismiss: (bubbleId: string) => void;
}

function getBubbleTone(bubble: AIWorkspaceBubbleData) {
  if (bubble.kind === "error" || bubble.status === "error") return "danger";
  if (bubble.kind === "result") return "success";
  if (bubble.risk?.level === "dangerous") return "danger";
  if (bubble.risk?.level === "review") return "warning";
  return "accent";
}

function getBubbleMetaLabel(bubble: AIWorkspaceBubbleData, copy: ReturnType<typeof getAIWorkspaceCopy>) {
  if (bubble.status === "loading") return copy.bubbleMeta.thinking;
  if (bubble.kind === "result") return copy.bubbleMeta.sandboxRun;
  if (bubble.kind === "error" || bubble.status === "error") return copy.bubbleMeta.needsReview;
  if (bubble.risk?.level === "dangerous") return copy.bubbleMeta.blockedInsert;
  if (bubble.risk?.level === "review") return copy.bubbleMeta.reviewBeforeRun;
  return copy.bubbleMeta.ready;
}

function getBubbleIcon(bubble: AIWorkspaceBubbleData) {
  if (bubble.kind === "result") return <Play className="w-4 h-4" />;
  if (bubble.kind === "error" || bubble.status === "error") return <AlertTriangle className="w-4 h-4" />;
  return <Sparkles className="w-4 h-4" />;
}

function getBubbleCodePreview(sql?: string) {
  if (!sql) return null;
  return sql.split("\n").slice(0, 3).join("\n");
}

export function AIWorkspaceBubble({
  bubble,
  bubbleRef,
  compact = false,
  isGenerating,
  isRunning,
  onOpenDetail,
  onStartDrag,
  onStartPointerDrag,
  onResetPointer,
  onCopy,
  onInsert,
  onRun,
  onDismiss,
}: AIWorkspaceBubbleProps) {
  const { language } = useI18n();
  const copy = getAIWorkspaceCopy(language);
  const tone = getBubbleTone(bubble);
  const codePreview = getBubbleCodePreview(bubble.sql);
  const showMutationActions = bubble.kind === "assistant" && bubble.status === "ready";
  const showInsert = showMutationActions && Boolean(bubble.sql);
  const showRun = showMutationActions && Boolean(bubble.sql);

  return (
    <div
      ref={bubbleRef}
      className={`ai-workspace-bubble ai-workspace-bubble--${tone} ${bubble.status === "loading" ? "is-loading" : ""} ${compact ? "is-compact" : ""}`}
      style={{ transform: `translate3d(${bubble.x}px, ${bubble.y}px, 0)` }}
      onDoubleClick={() => onOpenDetail(bubble)}
    >
      <div className="ai-workspace-bubble-header" onMouseDown={(event) => onStartDrag(bubble.id, event)}>
        <button type="button" className="ai-workspace-bubble-grab" title={copy.bubbleActions.dragBubble}>
          <GripHorizontal className="w-3.5 h-3.5" />
        </button>

        <div className="ai-workspace-bubble-copy">
          <span className="ai-workspace-bubble-kicker">{getBubbleMetaLabel(bubble, copy)}</span>
          <strong className="ai-workspace-bubble-title">
            {getBubbleIcon(bubble)}
            {bubble.title}
          </strong>
          <span className="ai-workspace-bubble-subtitle">{bubble.subtitle}</span>
        </div>

        <div className="ai-workspace-bubble-head-actions">
          <button
            type="button"
            className="ai-workspace-pointer-handle"
            title={copy.bubbleActions.dragPointer}
            onMouseDown={(event) => onStartPointerDrag(bubble.id, event)}
            onDoubleClick={(event) => {
              event.stopPropagation();
              onResetPointer(bubble.id);
            }}
          >
            <Target className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            className="ai-workspace-bubble-dismiss"
            title={copy.bubbleActions.dismissBubble}
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onDismiss(bubble.id);
            }}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {!compact && (
        <div className="ai-workspace-bubble-body">
          <p className="ai-workspace-bubble-preview">{bubble.preview}</p>
          {codePreview && <pre className="ai-workspace-bubble-code">{codePreview}</pre>}
          {bubble.risk?.reason && bubble.status !== "loading" && (
            <div className={`ai-workspace-bubble-risk ai-workspace-bubble-risk--${bubble.risk.level}`}>
              {bubble.risk.reason}
            </div>
          )}
        </div>
      )}

      <div className="ai-workspace-bubble-footer">
        <button type="button" className="ai-workspace-bubble-action subtle" onClick={() => onOpenDetail(bubble)}>
          <Wand2 className="w-3.5 h-3.5" />
          {copy.bubbleActions.detail}
        </button>
        <button type="button" className="ai-workspace-bubble-action subtle" onClick={() => onCopy(bubble)}>
          <Copy className="w-3.5 h-3.5" />
          {copy.bubbleActions.copy}
        </button>
        {showInsert && (
          <button
            type="button"
            className="ai-workspace-bubble-action"
            onClick={() => onInsert(bubble)}
            disabled={bubble.risk?.level === "dangerous"}
          >
            <Send className="w-3.5 h-3.5" />
            {copy.bubbleActions.insert}
          </button>
        )}
        {showRun && (
          <button
            type="button"
            className="ai-workspace-bubble-action primary"
            onClick={() => onRun(bubble)}
            disabled={bubble.status === "loading" || isGenerating || isRunning}
          >
            <Play className="w-3.5 h-3.5" />
            {copy.bubbleActions.approveRun}
          </button>
        )}
      </div>
    </div>
  );
}
