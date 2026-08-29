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
  onSelectWorkspace,
  onCreateWorkspace,
  onRenameWorkspace,
  onDeleteWorkspace,
  onImportThread,
}: AIWorkspaceSwitcherProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setIsOpen(false);
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [isOpen]);

  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null;
  const displayLabel = activeWorkspace?.name ?? copy.autoMode;

  const commitRename = () => {
    if (editingId && draftName.trim()) onRenameWorkspace(editingId, draftName);
    setEditingId(null);
  };

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
              <div className="ai-ws-import-list">
                {importableThreads.map((thread) => (
                  <button
                    key={thread.id}
                    type="button"
                    className="ai-ws-item"
                    title={copy.importAction}
                    onClick={() => {
                      onImportThread(thread.id);
                      setIsOpen(false);
                    }}
                  >
                    <Import className="w-3.5 h-3.5" />
                    <span className="ai-ws-item-name">{thread.label}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

