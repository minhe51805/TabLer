import { Check, Database, MessageSquarePlus, MessagesSquare, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatThreadTimestamp, type AIChatThread } from "./ai-conversation-state";
import type { AIWorkspaceCopy } from "./ai-workspace-copy";

interface AIWorkspaceChatActionModalProps {
  open: boolean;
  copy: AIWorkspaceCopy["workspace"];
  /** Display name of the workspace new chats will land in (null = auto mode). */
  workspaceName: string | null;
  /** Full list of chats living outside the active workspace. */
  threads: AIChatThread[];
  threadMemories: Record<string, { title: string; keywords: string[]; summary: string }>;
  language: string;
  onClose: () => void;
  onCreateNewChat: () => void;
  onAddThreads: (threadIds: string[]) => void;
}

/** Hard cap for chat titles in the pick list, so rows never look crowded. */
const MAX_TITLE_CHARS = 32;

function truncateTitle(text: string) {
  return text.length > MAX_TITLE_CHARS
    ? `${text.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…`
    : text;
}

/**
 * Two-step chat modal opened from the panel header's "new chat" button:
 * 1. pick an action — create a fresh chat in the workspace, or bring in
 *    existing chats;
 * 2. (bring-in only) multi-select from the full chat list with checkboxes.
 */
export function AIWorkspaceChatActionModal({
  open,
  copy,
  workspaceName,
  threads,
  threadMemories,
  language,
  onClose,
  onCreateNewChat,
  onAddThreads,
}: AIWorkspaceChatActionModalProps) {
  const [step, setStep] = useState<"menu" | "pick">("menu");
  const [query, setQuery] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const modalRef = useRef<HTMLDivElement>(null);

  // Re-opening always lands back on the action menu with a clean selection.
  useEffect(() => {
    if (open) {
      setStep("menu");
      setQuery("");
      setSelectedIds([]);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    // The modal layer has pointer-events: none, so outside-click dismissal
    // must listen on the window and check the target against the modal box.
    const handlePointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (modalRef.current?.contains(event.target)) return;
      onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("pointerdown", handlePointerDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [open, onClose]);

  const normalizedQuery = query.trim().toLowerCase();
  const filteredThreads = useMemo(
    () => threads.filter((thread) => {
      if (!normalizedQuery) return true;
      const memory = threadMemories[thread.id] ?? null;
      const haystack = [thread.label, memory?.title ?? "", memory?.keywords.join(" ") ?? ""]
        .join(" ")
        .toLowerCase();
      return normalizedQuery.split(/\s+/).every((token) => haystack.includes(token));
    }),
    [normalizedQuery, threadMemories, threads],
  );

  if (!open) return null;

  const toggleThread = (threadId: string) => {
    setSelectedIds((current) => (
      current.includes(threadId)
        ? current.filter((id) => id !== threadId)
        : [...current, threadId]
    ));
  };

  const confirmAdd = () => {
    if (selectedIds.length === 0) return;
    onAddThreads([...selectedIds]);
  };

  return (
    <div className="ai-workspace-modal-layer">
      <div
        ref={modalRef}
        className={`ai-workspace-modal ai-ws-chat-action ${step === "pick" ? "is-pick" : ""}`}
        role="dialog"
        aria-modal="true"
      >
        <div className="ai-workspace-modal-header">
          <h3 className="ai-workspace-modal-title">
            <MessagesSquare className="w-4 h-4" />
            {step === "menu" ? copy.chatActionTitle : copy.addChatsTitle}
          </h3>
          <button type="button" className="ai-workspace-modal-close" onClick={onClose}>
            <X className="w-4 h-4" />
          </button>
        </div>

        {step === "menu" ? (
          <div className="ai-ws-chat-action-body">
            <button type="button" className="ai-ws-chat-action-option" onClick={onCreateNewChat}>
              <span className="ai-ws-chat-action-option-icon">
                <MessageSquarePlus className="w-4 h-4" />
              </span>
              <span className="ai-ws-chat-action-option-title">{copy.chatActionCreate}</span>
            </button>
            <button
              type="button"
              className="ai-ws-chat-action-option"
              onClick={() => setStep("pick")}
              disabled={threads.length === 0}
            >
              <span className="ai-ws-chat-action-option-icon">
                <MessagesSquare className="w-4 h-4" />
              </span>
              <span className="ai-ws-chat-action-option-title">{copy.chatActionAdd}</span>
            </button>
          </div>
        ) : (
          <>
            <div className="ai-ws-chat-action-target">
              <span className="ai-ws-chat-action-target-name">
                <Database className="w-3 h-3" />
                <span className="ai-ws-chat-action-target-value">{workspaceName ?? copy.autoMode}</span>
              </span>
            </div>
            <div className="ai-ws-chat-action-search">
              <Search className="w-3.5 h-3.5" />
              <input
                type="search"
                placeholder={copy.importSearchPlaceholder}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <div className="ai-ws-chat-action-list">
              {filteredThreads.length === 0 ? (
                <div className="ai-ws-chat-action-empty">{copy.importEmpty}</div>
              ) : (
                filteredThreads.map((thread) => {
                  const memory = threadMemories[thread.id] ?? null;
                  const isSelected = selectedIds.includes(thread.id);
                  return (
                    <button
                      key={thread.id}
                      type="button"
                      className={`ai-ws-chat-action-item ${isSelected ? "is-selected" : ""}`}
                      onClick={() => toggleThread(thread.id)}
                    >
                      <span className={`ai-ws-chat-action-checkbox ${isSelected ? "is-checked" : ""}`}>
                        {isSelected ? <Check className="w-3 h-3" /> : null}
                      </span>
                      <span className="ai-ws-chat-action-item-copy">
                        <span className="ai-ws-chat-action-item-title">
                          {truncateTitle(memory?.title || thread.label)}
                        </span>
                        <span className="ai-ws-chat-action-item-meta">
                          {formatThreadTimestamp(thread.updatedAt || thread.createdAt, language)}
                        </span>
                      </span>
                    </button>
                  );
                })
              )}
            </div>
            <div className="ai-ws-chat-action-footer">
              <button type="button" className="ai-workspace-modal-btn" onClick={() => setStep("menu")}>
                {copy.chatActionBack}
              </button>
              <button
                type="button"
                className="ai-workspace-modal-btn primary"
                onClick={confirmAdd}
                disabled={selectedIds.length === 0}
              >
                {copy.addChatsConfirm}
                {selectedIds.length > 0 ? ` (${selectedIds.length})` : ""}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
