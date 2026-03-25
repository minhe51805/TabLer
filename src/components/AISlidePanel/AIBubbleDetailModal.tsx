import { Copy, Play, Send, Sparkles, Wand2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n";
import { aiModeAllowsInsert, aiModeAllowsRun, type AIWorkspaceBubbleData } from "./ai-workspace-types";
import { getAIWorkspaceCopy } from "./ai-workspace-copy";
import { AIWorkspaceMarkdown } from "./AIWorkspaceMarkdown";

interface AIBubbleDetailModalProps {
  bubble: AIWorkspaceBubbleData;
  isGenerating: boolean;
  isRunning: boolean;
  onClose: () => void;
  onCopy: (bubble: AIWorkspaceBubbleData) => void;
  onInsert: (bubble: AIWorkspaceBubbleData) => void;
  onRun: (bubble: AIWorkspaceBubbleData) => void;
  onRewrite: (bubble: AIWorkspaceBubbleData, note: string) => void;
}

export function AIBubbleDetailModal({
  bubble,
  isGenerating,
  isRunning,
  onClose,
  onCopy,
  onInsert,
  onRun,
  onRewrite,
}: AIBubbleDetailModalProps) {
  const { language } = useI18n();
  const copy = getAIWorkspaceCopy(language);
  const [rewriteNote, setRewriteNote] = useState("");
  const modalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setRewriteNote("");
  }, [bubble.id]);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (modalRef.current?.contains(target)) return;
      onClose();
    };

    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [onClose]);

  const canRewrite = bubble.kind !== "result" && bubble.status !== "loading";
  const canInsert = Boolean(bubble.sql) && aiModeAllowsInsert(bubble.interactionMode);
  const canApproveRun = Boolean(bubble.sql) && aiModeAllowsRun(bubble.interactionMode);

  return (
    <div className="ai-workspace-modal-layer">
      <div ref={modalRef} className="ai-workspace-modal" role="dialog" aria-modal="false">
        <div className="ai-workspace-modal-header">
          <div className="ai-workspace-modal-copy">
            <span className="ai-workspace-modal-kicker">{copy.modal.kicker}</span>
            <h3 className="ai-workspace-modal-title">
              <Sparkles className="w-4 h-4" />
              {bubble.title}
            </h3>
            <p className="ai-workspace-modal-subtitle">{bubble.subtitle}</p>
          </div>

          <button type="button" className="ai-workspace-modal-close" onClick={onClose}>
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="ai-workspace-modal-body">
          <section className="ai-workspace-modal-section">
            <span className="ai-workspace-modal-label">{copy.modal.originalRequest}</span>
            <div className="ai-workspace-modal-textblock ai-workspace-modal-textblock--plain">{bubble.prompt || copy.modal.noRequest}</div>
          </section>

          <section className="ai-workspace-modal-section">
            <span className="ai-workspace-modal-label">
              {bubble.kind === "result" ? copy.modal.executionSummary : copy.modal.assistantExplanation}
            </span>
            <AIWorkspaceMarkdown
              className="ai-workspace-modal-textblock"
              text={bubble.status === "loading" ? copy.modal.loadingExplanation : bubble.detail || bubble.preview}
            />
          </section>

          {bubble.sql && (
            <section className="ai-workspace-modal-section">
              <span className="ai-workspace-modal-label">{copy.modal.sql}</span>
              <pre className="ai-workspace-modal-code">{bubble.sql}</pre>
              <div className="ai-workspace-modal-agentic-note">
                {copy.modal.agenticNote}
              </div>
            </section>
          )}

          {canRewrite && (
            <section className="ai-workspace-modal-section">
              <div className="ai-workspace-modal-section-head">
                <span className="ai-workspace-modal-label">{copy.modal.rewriteTitle}</span>
                <span className="ai-workspace-modal-hint">{copy.modal.rewriteHint}</span>
              </div>
              <textarea
                value={rewriteNote}
                onChange={(event) => setRewriteNote(event.target.value)}
                className="ai-workspace-modal-textarea"
                placeholder={copy.modal.rewritePlaceholder}
              />
              <button
                type="button"
                className="ai-workspace-modal-btn primary"
                onClick={() => onRewrite(bubble, rewriteNote)}
                disabled={isGenerating || !rewriteNote.trim()}
              >
                <Wand2 className="w-4 h-4" />
                {isGenerating ? copy.modal.rewriting : copy.modal.rewriteBubble}
              </button>
            </section>
          )}
        </div>

        <div className="ai-workspace-modal-footer">
          <button type="button" className="ai-workspace-modal-btn" onClick={() => onCopy(bubble)}>
            <Copy className="w-4 h-4" />
            {copy.bubbleActions.copy}
          </button>
          {canInsert && (
            <button
              type="button"
              className="ai-workspace-modal-btn"
              onClick={() => onInsert(bubble)}
              disabled={bubble.risk?.level === "dangerous"}
            >
              <Send className="w-4 h-4" />
              {copy.bubbleActions.insert}
            </button>
          )}
          {canApproveRun && (
            <button
              type="button"
              className="ai-workspace-modal-btn primary"
              onClick={() => onRun(bubble)}
              disabled={isRunning || bubble.status === "loading"}
            >
              <Play className="w-4 h-4" />
              {isRunning ? copy.modal.running : copy.modal.approveAgenticRun}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
