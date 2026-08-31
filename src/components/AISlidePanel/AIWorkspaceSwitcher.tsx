import { Fragment, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Check,
  ChevronDown,
  Database,
  FolderKanban,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import type { AIWorkspaceCopy } from "./ai-workspace-copy";

export interface AIWorkspaceSwitcherWorkspace {
  id: string;
  name: string;
  /** Database this workspace is bound to (AI context follows it). */
  database?: string | null;
  contextUpdatedAt: number | null;
}

interface AIWorkspaceSwitcherProps {
  copy: AIWorkspaceCopy["workspace"];
  workspaces: AIWorkspaceSwitcherWorkspace[];
  activeWorkspaceId: string | null;
  /** Databases offered for (re)binding a workspace. */
  databases?: string[];
  /** Database currently open in the explorer (marked in the rebind picker). */
  currentDatabase?: string | null;
  onSelectWorkspace: (id: string | null) => void;
  onCreateWorkspace: () => void;
  onRenameWorkspace: (id: string, name: string) => void;
  onDeleteWorkspace: (id: string) => void;
  /** Pin/unpin a workspace to a database (rebind clears its compacted context). */
  onRebindWorkspace?: (id: string, database: string) => void;
}

/**
 * Workspace picker for the AI chat panel: user workspaces scope threads and
 * carry their own compacted context ("player bao bên ngoài" around chats).
 * Importing existing chats lives in AIWorkspaceChatActionModal (header +).
 */
export function AIWorkspaceSwitcher({
  copy,
  workspaces,
  activeWorkspaceId,
  databases = [],
  currentDatabase = null,
  onSelectWorkspace,
  onCreateWorkspace,
  onRenameWorkspace,
  onDeleteWorkspace,
  onRebindWorkspace,
}: AIWorkspaceSwitcherProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  /** Open rebind picker: workspace id + fixed-position anchor (viewport px). */
  const [rebindState, setRebindState] = useState<{ id: string; top: number; left: number } | null>(null);
  const rebindId = rebindState?.id ?? null;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const pickerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      // Clicks inside the portaled picker must not close anything.
      if (pickerRef.current?.contains(target)) return;
      if (rootRef.current?.contains(target)) {
        setRebindState(null);
        return;
      }
      setIsOpen(false);
      setRebindState(null);
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [isOpen]);

  // The popover content unmounts when closed; never leave a stale anchor.
  useEffect(() => {
    if (!isOpen) setRebindState(null);
  }, [isOpen]);

  // The picker floats with fixed coordinates — repositioning sources (popover
  // scroll, window resize) invalidate them, so just close it.
  useEffect(() => {
    if (!rebindState) return;
    const invalidate = (event: Event) => {
      if (event.target instanceof Node && pickerRef.current?.contains(event.target)) return;
      setRebindState(null);
    };
    window.addEventListener("resize", invalidate);
    window.addEventListener("scroll", invalidate, true);
    return () => {
      window.removeEventListener("resize", invalidate);
      window.removeEventListener("scroll", invalidate, true);
    };
  }, [rebindState]);

  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null;
  const displayLabel = activeWorkspace?.name ?? copy.autoMode;
  const pickerWorkspace = workspaces.find((workspace) => workspace.id === rebindState?.id) ?? null;

  const openRebindPicker = (workspaceId: string, anchor: HTMLElement) => {
    const rect = anchor.getBoundingClientRect();
    const PICKER_WIDTH = 224;
    const PICKER_HEIGHT = 236;
    const left = Math.max(8, Math.min(rect.right - PICKER_WIDTH, window.innerWidth - PICKER_WIDTH - 8));
    const top = Math.min(rect.bottom + 4, Math.max(8, window.innerHeight - PICKER_HEIGHT));
    setRebindState({ id: workspaceId, top, left });
  };

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
          <div className="ai-ws-popover-head">
            <div className="ai-ws-popover-section">{copy.switcherTitle}</div>
            <div className="ai-ws-popover-hint">{copy.switcherHint}</div>
          </div>

          <button
            type="button"
            className={`ai-ws-item ${activeWorkspaceId === null ? "is-active" : ""}`}
            onClick={() => {
              onSelectWorkspace(null);
              setIsOpen(false);
            }}
          >
            <span className="ai-ws-item-main">
              <span className="ai-ws-item-name">{copy.autoMode}</span>
            </span>
            {activeWorkspaceId === null ? <Check className="w-3.5 h-3.5 ai-ws-item-check" /> : null}
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
              <Fragment key={workspace.id}>
                <div
                  className={`ai-ws-item ${activeWorkspaceId === workspace.id ? "is-active" : ""}`}
                >
                  <button
                    type="button"
                    className="ai-ws-item-main"
                    onClick={() => {
                      onSelectWorkspace(workspace.id);
                      setIsOpen(false);
                    }}
                  >
                    <span className="ai-ws-item-name" title={workspace.name}>
                      {workspace.name}
                    </span>
                    <span className="ai-ws-item-meta">
                      <button
                        type="button"
                        className={`ai-ws-db-chip ${workspace.database ? "" : "is-auto"}`}
                        title={workspace.database ? `${copy.rebindAction}: ${workspace.database}` : copy.rebindAction}
                        onClick={(event) => {
                          event.stopPropagation();
                          if (!onRebindWorkspace) return;
                          if (rebindId === workspace.id) {
                            setRebindState(null);
                            return;
                          }
                          openRebindPicker(workspace.id, event.currentTarget);
                        }}
                      >
                        <Database className="w-3 h-3" />
                        <span className="ai-ws-db-chip-name">
                          {workspace.database ?? copy.dbAuto}
                        </span>
                        <ChevronDown className="w-3 h-3 ai-ws-db-caret" />
                      </button>
                      {workspace.contextUpdatedAt ? (
                        <span className="ai-ws-context-dot" title={copy.contextBadge} />
                      ) : null}
                    </span>
                  </button>
                  <div className="ai-ws-item-actions">
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
                </div>
              </Fragment>
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
        </div>
      )}

      {/* Rebind picker is portaled to <body> with fixed coordinates so it
          floats above the popover: its scroll area can neither clip it nor
          be stretched by it. */}
      {isOpen && rebindState && pickerWorkspace ? createPortal(
        <div
          ref={pickerRef}
          className="ai-ws-db-picker"
          style={{ top: rebindState.top, left: rebindState.left }}
          onClick={(event) => event.stopPropagation()}
          role="presentation"
        >
          <span className="ai-ws-db-picker-title">{copy.rebindAction}</span>
          <button
            type="button"
            className={`ai-ws-db-option ${pickerWorkspace.database ? "" : "is-active"}`}
            onClick={() => {
              onRebindWorkspace?.(pickerWorkspace.id, "");
              setRebindState(null);
            }}
          >
            <span className="ai-ws-db-option-name">{copy.dbAuto}</span>
            {!pickerWorkspace.database ? <Check className="w-3 h-3" /> : null}
          </button>
          {databases.map((database) => (
            <button
              key={database}
              type="button"
              className={`ai-ws-db-option ${pickerWorkspace.database === database ? "is-active" : ""}`}
              title={
                database === currentDatabase
                  ? copy.dbCurrentHint
                  : database
              }
              onClick={() => {
                onRebindWorkspace?.(pickerWorkspace.id, database);
                setRebindState(null);
              }}
            >
              <span className="ai-ws-db-option-name">
                {database}
                {database === currentDatabase ? (
                  <span className="ai-ws-db-open-dot" title={copy.dbCurrentHint} />
                ) : null}
              </span>
              {pickerWorkspace.database === database ? <Check className="w-3 h-3" /> : null}
            </button>
          ))}
        </div>,
        document.body,
      ) : null}
    </div>
  );
}

