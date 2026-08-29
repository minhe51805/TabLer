import { useEffect, useRef, useState } from "react";
import { Check, FolderKanban, Import, Pencil, Plus, Trash2 } from "lucide-react";
import type { AIChatThread } from "./ai-conversation-state";
import type { AIWorkspaceCopy } from "./ai-workspace-copy";

export interface AIWorkspaceSwitcherWorkspace {
  id: string;
  name: string;
  contextUpdatedAt: number | null;
}

interface AIWorkspaceSwitcherProps {
  copy: AIWorkspaceCopy["workspace"];
  workspaces: AIWorkspaceSwitcherWorkspace[];
  activeWorkspaceId: string | null;
  importableThreads: AIChatThread[];
  threadMemories: Record<string, { title: string; keywords: string[]; summary: string }>;
  onSelectWorkspace: (id: string | null) => void;
  onCreateWorkspace: () => void;
  onRenameWorkspace: (id: string, name: string) => void;
  onDeleteWorkspace: (id: string) => void;
  onImportThread: (threadId: string) => void;
}

/**
 * Workspace picker for the AI chat panel: user workspaces scope threads and
 * carry their own compacted context ("player bao bên ngoài" around chats).
 */
export function AIWorkspaceSwitcher({
  copy,
  workspaces,
  activeWorkspaceId,
  importableThreads,
  threadMemories,
  onSelectWorkspace,
  onCreateWorkspace,
  onRenameWorkspace,
  onDeleteWorkspace,
  onImportThread,
}: AIWorkspaceSwitcherProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [importQuery, setImportQuery] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setIsOpen(false);
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) setImportQuery("");
  }, [isOpen]);

  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null;
  const displayLabel = activeWorkspace?.name ?? copy.autoMode;

  const commitRename = () => {
    if (editingId && draftName.trim()) onRenameWorkspace(editingId, draftName);
    setEditingId(null);
  };

  const normalizedImportQuery = importQuery.trim().toLowerCase();
  const importableEntries = importableThreads
    .map((thread) => {
      const memory = threadMemories[thread.id] ?? null;
      const haystack = [thread.label, memory?.title ?? "", memory?.keywords.join(" ") ?? ""]
        .join(" ")
        .toLowerCase();
      const matchScore = normalizedImportQuery
        ? normalizedImportQuery.split(/\s+/).reduce(
            (score, token) =>
              haystack.includes(token)
                || memory?.keywords.some((keyword) => keyword.includes(token))
                ? score + 1
                : score,
            0,
          )
        : memory
          ? 0.5
          : 0;
      return { thread, memory, matchScore };
    })
    .filter((entry) => !normalizedImportQuery || entry.matchScore > 0)
    .sort((left, right) => right.matchScore - left.matchScore);

  return (
    <div ref={rootRef} className={`ai-workspace-history-dropdown ai-ws-switcher ${isOpen ? "is-open" : ""}`}>
      <button
        type="button"
        className="ai-workspace-history-toggle ai-ws-switcher-toggle"
        onClick={() => setIsOpen((value) => !value)}
        title={copy.switcherTitle}
      >
        <FolderKanban className="w-3.5 h-3.5" />
        <span className="ai-ws-switcher-name">{displayLabel}</span>
        {activeWorkspace?.contextUpdatedAt ? <span className="ai-ws-context-dot" title={copy.contextBadge} /> : null}
      </button>

      {isOpen && (
        <div className="ai-workspace-history-popover ai-ws-switcher-popover">
          <div className="ai-ws-popover-section">{copy.switcherTitle}</div>

          <button
            type="button"
            className={`ai-ws-item ${activeWorkspaceId === null ? "is-active" : ""}`}
            onClick={() => {
              onSelectWorkspace(null);
              setIsOpen(false);
            }}
          >
            <FolderKanban className="w-3.5 h-3.5" />
            <span className="ai-ws-item-name">{copy.autoMode}</span>
            {activeWorkspaceId === null && <Check className="w-3.5 h-3.5 ai-ws-item-check" />}
          </button>

          {workspaces.map((workspace) => (
            editingId === workspace.id ? (
              <div key={workspace.id} className="ai-ws-item is-editing">
                <input
                  autoFocus
                  className="ai-ws-rename-input"
                  value={draftName}
                  onChange={(event) => setDraftName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") commitRename();
                    if (event.key === "Escape") setEditingId(null);
                  }}
                  onBlur={commitRename}
                />
              </div>
            ) : (
              <div
                key={workspace.id}
                className={`ai-ws-item ${activeWorkspaceId === workspace.id ? "is-active" : ""}`}
              >
                <button
                  type="button"
                  className="ai-ws-item-select"
                  onClick={() => {
                    onSelectWorkspace(workspace.id);
                    setIsOpen(false);
                  }}
                >
                  <FolderKanban className="w-3.5 h-3.5" />
                  <span className="ai-ws-item-name">{workspace.name}</span>
                  {workspace.contextUpdatedAt ? <span className="ai-ws-context-dot" title={copy.contextBadge} /> : null}
                </button>
                <button
                  type="button"
                  className="ai-ws-item-action"
                  title={copy.renameAction}
                  onClick={() => {
                    setEditingId(workspace.id);
                    setDraftName(workspace.name);
                  }}
                >
                  <Pencil className="w-3 h-3" />
                </button>
                <button
                  type="button"
                  className="ai-ws-item-action is-danger"
                  title={copy.deleteAction}
                  onClick={() => {
                    onDeleteWorkspace(workspace.id);
                    setEditingId(null);
                  }}
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            )
          ))}

          <button
            type="button"
            className="ai-ws-item ai-ws-new"
            onClick={() => {
              onCreateWorkspace();
              setIsOpen(false);
            }}
          >
            <Plus className="w-3.5 h-3.5" />
            <span className="ai-ws-item-name">{copy.newWorkspace}</span>
          </button>

          {importableThreads.length > 0 && (
            <>
              <div className="ai-ws-popover-section ai-ws-import-title">{copy.importTitle}</div>
              {importableThreads.length > 3 && (
                <input
                  type="search"
                  className="ai-ws-import-search"
                  placeholder={copy.importSearchPlaceholder}
                  value={importQuery}
                  onChange={(event) => setImportQuery(event.target.value)}
                  onKeyDown={(event) => event.stopPropagation()}
                />
              )}
              {importableEntries.length > 0 ? (
                <div className="ai-ws-import-list">
                  {importableEntries.map(({ thread, memory }) => (
                    <button
                      key={thread.id}
                      type="button"
                      className="ai-ws-item ai-ws-import-item"
                      title={memory?.summary ? `${memory.title}\n\n${memory.summary}` : copy.importAction}
                      onClick={() => {
                        onImportThread(thread.id);
                        setIsOpen(false);
                      }}
                    >
                      <Import className="w-3.5 h-3.5" />
                      <span className="ai-ws-import-meta">
                        <span className="ai-ws-item-name">{memory?.title || thread.label}</span>
                        {memory && memory.keywords.length > 0 && (
                          <span className="ai-ws-import-keywords">
                            {memory.keywords.slice(0, 4).join(" · ")}
                          </span>
                        )}
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="ai-ws-import-empty">{copy.importSearchPlaceholder}</div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

