import {
  Bookmark,
  BookmarkPlus,
  Check,
  Copy,
  Folder,
  FolderPlus,
  MoreHorizontal,
  Play,
  Search,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSqlFavoritesStore } from "../../stores/sql-favorites-store";
import { useConnectionStore } from "../../stores/connectionStore";
import {
  assignFavoriteToFolder,
  createFavoriteFolder,
  deleteFavoriteFolder,
  getCollapsedFavoriteFolderIds,
  getFavoriteFolderAssignments,
  getFavoriteFolders,
  renameFavoriteFolder,
  toggleFavoriteFolderCollapse,
  type FavoriteFolder,
} from "../../stores/favorite-folder-store";
import type { SqlFavorite } from "../../types/query-history";
import { extractParams, type SqlParam } from "../../utils/sql-params";
import { ParamFillDialog } from "./ParamFillDialog";
import "../../styles/lazy-overlays.css";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onRunQuery: (sql: string) => void;
  /** Current SQL in the editor — pre-fills the save dialog */
  currentEditorSql?: string;
}

interface SaveDialogState {
  open: boolean;
  name: string;
  description: string;
  tags: string;
  sql: string;
}

type FavContextMenu =
  | { kind: "favorite"; x: number; y: number; favoriteId: string }
  | { kind: "folder"; x: number; y: number; folderId: string };

type FavListItem =
  | { type: "folder"; folder: FavoriteFolder; count: number }
  | { type: "favorite"; favorite: SqlFavorite };

function truncateQuery(sql: string, maxChars = 120): string {
  const compact = sql.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  return compact.slice(0, maxChars - 1) + "…";
}

function FavoriteRow({
  favorite,
  onCopy,
  onRun,
  onDelete,
  onContextMenu,
}: {
  favorite: SqlFavorite;
  onCopy: (sql: string) => void;
  onRun: (sql: string) => void;
  onDelete: (id: string) => void;
  onContextMenu: (e: React.MouseEvent<HTMLDivElement>) => void;
}) {
  const preview = truncateQuery(favorite.sql);

  return (
    <div className="fav-entry" title={favorite.sql} onContextMenu={onContextMenu}>
      <div className="fav-entry-header">
        <Bookmark className="w-3.5 h-3.5 text-[var(--accent)]" />
        <span className="fav-entry-name">{favorite.name}</span>
        {favorite.tags.length > 0 && (
          <div className="fav-entry-tags">
            {favorite.tags.slice(0, 3).map((tag) => (
              <span key={tag} className="fav-tag">
                <Tag className="w-2.5 h-2.5" />
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>
      {favorite.description && <p className="fav-entry-desc">{favorite.description}</p>}
      <pre className="fav-entry-query">{preview}</pre>
      <div className="fav-entry-actions">
        <button
          type="button"
          className="fav-action-btn"
          onClick={() => onCopy(favorite.sql)}
          title="Copy SQL"
        >
          <Copy className="w-3 h-3.5" />
        </button>
        <button
          type="button"
          className="fav-action-btn primary"
          onClick={() => onRun(favorite.sql)}
          title="Run in editor"
        >
          <Play className="w-3 h-3.5" />
        </button>
        <button
          type="button"
          className="fav-action-btn danger"
          onClick={() => onDelete(favorite.id)}
          title="Delete"
        >
          <Trash2 className="w-3 h-3.5" />
        </button>
      </div>
    </div>
  );
}

/** Collapsible folder header; right-click or the hover "⋯" button opens the
 *  folder context menu (rename / delete). Reuses the startup-connection group
 *  header styles. */
function FavoriteFolderHeader({
  folder,
  count,
  isCollapsed,
  isRenaming,
  onToggle,
  onRename,
  onContextMenu,
}: {
  folder: FavoriteFolder;
  count: number;
  isCollapsed: boolean;
  isRenaming: boolean;
  onToggle: () => void;
  /** Commits a new name; null/empty cancels. */
  onRename: (name: string | null) => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  return (
    <div className="startup-connection-group-header-row" onContextMenu={onContextMenu}>
      <button
        type="button"
        className="startup-connection-group-header"
        onClick={onToggle}
        aria-expanded={!isCollapsed}
        title={`${folder.name} — ${count} favorite${count !== 1 ? "s" : ""}`}
      >
        <span className={`startup-connection-group-chevron ${isCollapsed ? "" : "expanded"}`}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path
              d="M4 2.5L7.5 6L4 9.5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <Folder className="w-3.5 h-3.5" />
        {isRenaming ? (
          <input
            className="startup-connection-group-rename-input"
            defaultValue={folder.name}
            autoFocus
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") {
                onRename((e.target as HTMLInputElement).value);
              }
              if (e.key === "Escape") onRename(null);
            }}
            onBlur={(e) => onRename(e.target.value)}
          />
        ) : (
          <span className="startup-connection-group-name">{folder.name}</span>
        )}
        <span className="startup-connection-group-count">{count}</span>
      </button>
      <div className="startup-connection-group-actions">
        <button
          type="button"
          className="startup-connection-group-menu-btn"
          onClick={onContextMenu}
          title="Folder actions"
        >
          <MoreHorizontal className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

export function SQLFavoritesPanel({ isOpen, onClose, onRunQuery, currentEditorSql = "" }: Props) {
  const { favorites, isLoading, loadFavorites, saveFavorite, deleteFavorite } =
    useSqlFavoritesStore();
  const activeConnectionId = useConnectionStore((state) => state.activeConnectionId);
  const currentDatabase = useConnectionStore((state) => state.currentDatabase);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [saveDialog, setSaveDialog] = useState<SaveDialogState>({
    open: false,
    name: "",
    description: "",
    tags: "",
    sql: currentEditorSql,
  });

  // ── Folders (localStorage-backed; backend favorites have no folder field) ──

  const [folders, setFolders] = useState<FavoriteFolder[]>(() => getFavoriteFolders());
  const [assignments, setAssignments] = useState<Record<string, string>>(() =>
    getFavoriteFolderAssignments(),
  );
  const [collapsedFolderIds, setCollapsedFolderIds] = useState<Set<string>>(() =>
    getCollapsedFavoriteFolderIds(),
  );
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [contextMenu, setContextMenu] = useState<FavContextMenu | null>(null);
  // "New folder…" naming mode inside the favorite context menu.
  const [isNamingFolder, setIsNamingFolder] = useState(false);
  const [menuFolderName, setMenuFolderName] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  const refreshFolders = useCallback(() => {
    setFolders(getFavoriteFolders());
    setAssignments(getFavoriteFolderAssignments());
    setCollapsedFolderIds(getCollapsedFavoriteFolderIds());
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
    setIsNamingFolder(false);
    setMenuFolderName("");
  }, []);

  useEffect(() => {
    if (!contextMenu) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeContextMenu();
    };
    const handleScroll = () => closeContextMenu();
    window.addEventListener("click", closeContextMenu);
    window.addEventListener("contextmenu", closeContextMenu);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", handleScroll);
    const listEl = listRef.current;
    listEl?.addEventListener("scroll", handleScroll);
    return () => {
      window.removeEventListener("click", closeContextMenu);
      window.removeEventListener("contextmenu", closeContextMenu);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", handleScroll);
      listEl?.removeEventListener("scroll", handleScroll);
    };
  }, [contextMenu, closeContextMenu]);

  const openFavoriteContextMenu = (e: React.MouseEvent<HTMLDivElement>, favoriteId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setIsNamingFolder(false);
    setMenuFolderName("");
    setContextMenu({ kind: "favorite", x: e.clientX, y: e.clientY, favoriteId });
  };

  const openFolderContextMenu = (e: React.MouseEvent, folderId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ kind: "folder", x: e.clientX, y: e.clientY, folderId });
  };

  const handleToggleFolder = (folderId: string) => {
    toggleFavoriteFolderCollapse(folderId);
    setCollapsedFolderIds(getCollapsedFavoriteFolderIds());
  };

  const handleAssign = (favoriteId: string, folderId: string | null) => {
    assignFavoriteToFolder(favoriteId, folderId);
    setAssignments(getFavoriteFolderAssignments());
  };

  const handleCreateAndAssign = (favoriteId: string, name: string) => {
    const folder = createFavoriteFolder(name);
    assignFavoriteToFolder(favoriteId, folder.id);
    refreshFolders();
  };

  const handleCreateFolder = () => {
    const name = newFolderName.trim();
    if (!name) return;
    createFavoriteFolder(name);
    setNewFolderName("");
    setIsCreatingFolder(false);
    refreshFolders();
  };

  const handleRenameFolder = (folderId: string, name: string | null) => {
    const trimmed = name?.trim();
    if (trimmed) renameFavoriteFolder(folderId, trimmed);
    setRenamingFolderId(null);
    refreshFolders();
  };

  const handleDeleteFolder = (folderId: string) => {
    deleteFavoriteFolder(folderId);
    refreshFolders();
  };

  // Debounce search
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(search);
    }, 200);
    return () => window.clearTimeout(timer);
  }, [search]);

  // Load favorites when panel opens
  useEffect(() => {
    if (!isOpen) return;
    void loadFavorites();
    refreshFolders();
  }, [isOpen, loadFavorites, refreshFolders]);

  // Sync current editor SQL into save dialog
  useEffect(() => {
    if (saveDialog.open) {
      setSaveDialog((prev) => ({ ...prev, sql: currentEditorSql }));
    }
  }, [currentEditorSql, saveDialog.open]);

  // Keyboard shortcuts
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // The context menu and inline inputs handle their own Escape.
        if (contextMenu) return;
        if (isCreatingFolder) {
          setIsCreatingFolder(false);
          setNewFolderName("");
        } else if (saveDialog.open) {
          setSaveDialog((prev) => ({ ...prev, open: false }));
        } else {
          onClose();
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose, saveDialog.open, contextMenu, isCreatingFolder]);

  const filteredFavorites = debouncedSearch
    ? favorites.filter(
        (f) =>
          f.name.toLowerCase().includes(debouncedSearch.toLowerCase()) ||
          f.description?.toLowerCase().includes(debouncedSearch.toLowerCase()) ||
          f.tags.some((t) => t.toLowerCase().includes(debouncedSearch.toLowerCase())) ||
          f.sql.toLowerCase().includes(debouncedSearch.toLowerCase()),
      )
    : favorites;

  // Grouped flat list: folder headers (with their favorites) first, then
  // ungrouped favorites — same shape as the connection manager's group list.
  const folderIds = new Set(folders.map((f) => f.id));
  const flatItems: FavListItem[] = [];
  {
    const grouped = new Map<string, SqlFavorite[]>();
    const ungrouped: SqlFavorite[] = [];
    for (const fav of filteredFavorites) {
      const folderId = assignments[fav.id];
      if (folderId && folderIds.has(folderId)) {
        const list = grouped.get(folderId) ?? [];
        list.push(fav);
        grouped.set(folderId, list);
      } else {
        ungrouped.push(fav);
      }
    }
    for (const folder of folders) {
      const folderFavs = grouped.get(folder.id) ?? [];
      // Empty folders stay visible so a freshly created folder is discoverable.
      flatItems.push({ type: "folder", folder, count: folderFavs.length });
      if (!collapsedFolderIds.has(folder.id)) {
        for (const fav of folderFavs) {
          flatItems.push({ type: "favorite", favorite: fav });
        }
      }
    }
    for (const fav of ungrouped) {
      flatItems.push({ type: "favorite", favorite: fav });
    }
  }

  const handleCopy = useCallback(async (sql: string) => {
    try {
      await navigator.clipboard.writeText(sql);
    } catch {
      console.error("Failed to copy to clipboard");
    }
  }, []);

  const [paramDialog, setParamDialog] = useState<{
    sql: string;
    params: SqlParam[];
  } | null>(null);

  const handleRun = useCallback(
    (sql: string) => {
      const params = extractParams(sql);
      if (params.length === 0) {
        onRunQuery(sql);
        return;
      }
      setParamDialog({ sql, params });
    },
    [onRunQuery],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        await deleteFavorite(id);
        // deleteFavorite drops the folder assignment; refresh local state.
        setAssignments(getFavoriteFolderAssignments());
      } catch {
        // error logged in store
      }
    },
    [deleteFavorite],
  );

  const handleSaveFavorite = useCallback(async () => {
    if (!saveDialog.name.trim() || !saveDialog.sql.trim()) return;
    try {
      await saveFavorite({
        name: saveDialog.name.trim(),
        description: saveDialog.description.trim() || undefined,
        sql: saveDialog.sql,
        tags: saveDialog.tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        connectionId: activeConnectionId || undefined,
        database: currentDatabase || undefined,
      });
      setSaveDialog((prev) => ({
        ...prev,
        open: false,
        name: "",
        description: "",
        tags: "",
        sql: currentEditorSql,
      }));
    } catch {
      // error logged in store
    }
  }, [activeConnectionId, currentDatabase, saveDialog, currentEditorSql, saveFavorite]);

  if (!isOpen) return null;

  return (
    <div className="fav-overlay">
      <aside className="fav-panel">
        <div className="fav-panel-header">
          <div className="fav-panel-title">
            <Bookmark className="w-4 h-4" />
            <span>SQL Favorites</span>
          </div>
          <div className="fav-header-actions">
            <button
              type="button"
              className="fav-save-btn"
              onClick={() => {
                setIsCreatingFolder(true);
              }}
              title="New folder"
            >
              <FolderPlus className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              className="fav-save-btn"
              onClick={() => {
                setSaveDialog((prev) => ({
                  ...prev,
                  open: true,
                  sql: currentEditorSql,
                }));
              }}
              title="Save current editor SQL"
            >
              <BookmarkPlus className="w-3.5 h-3.5" />
              <span>Save</span>
            </button>
            <button type="button" className="fav-close-btn" onClick={onClose}>
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        <div className="fav-search-bar">
          <Search className="w-3.5 h-3.5 fav-search-icon" />
          <input
            type="text"
            className="fav-search-input"
            placeholder="Search favorites..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
          />
          {search && (
            <button type="button" className="fav-search-clear" onClick={() => setSearch("")}>
              <X className="w-3 h-3" />
            </button>
          )}
        </div>

        <div className="fav-list" ref={listRef}>
          {paramDialog ? (
            <ParamFillDialog
              sql={paramDialog.sql}
              params={paramDialog.params}
              onSubmit={(resolved) => {
                setParamDialog(null);
                onRunQuery(resolved);
              }}
              onCancel={() => setParamDialog(null)}
            />
          ) : saveDialog.open ? (
            <div className="fav-save-form">
              <div className="fav-form-field">
                <label className="fav-form-label">Name *</label>
                <input
                  type="text"
                  className="fav-form-input"
                  placeholder="e.g. Get active users"
                  value={saveDialog.name}
                  onChange={(e) => setSaveDialog((prev) => ({ ...prev, name: e.target.value }))}
                  autoFocus
                />
              </div>
              <div className="fav-form-field">
                <label className="fav-form-label">Description</label>
                <input
                  type="text"
                  className="fav-form-input"
                  placeholder="Optional description"
                  value={saveDialog.description}
                  onChange={(e) =>
                    setSaveDialog((prev) => ({
                      ...prev,
                      description: e.target.value,
                    }))
                  }
                />
              </div>
              <div className="fav-form-field">
                <label className="fav-form-label">Tags (comma-separated)</label>
                <input
                  type="text"
                  className="fav-form-input"
                  placeholder="e.g. users, analytics, report"
                  value={saveDialog.tags}
                  onChange={(e) => setSaveDialog((prev) => ({ ...prev, tags: e.target.value }))}
                />
              </div>
              <div className="fav-form-field">
                <label className="fav-form-label">SQL</label>
                <textarea
                  className="fav-form-textarea"
                  rows={6}
                  value={saveDialog.sql}
                  onChange={(e) => setSaveDialog((prev) => ({ ...prev, sql: e.target.value }))}
                  spellCheck={false}
                />
              </div>
              <div className="fav-form-actions">
                <button
                  type="button"
                  className="fav-form-cancel"
                  onClick={() => setSaveDialog((prev) => ({ ...prev, open: false }))}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="fav-form-submit"
                  onClick={() => void handleSaveFavorite()}
                  disabled={!saveDialog.name.trim() || !saveDialog.sql.trim()}
                >
                  Save Favorite
                </button>
              </div>
            </div>
          ) : isLoading ? (
            <div className="fav-empty">Loading...</div>
          ) : filteredFavorites.length === 0 && folders.length === 0 ? (
            <div className="fav-empty">
              {debouncedSearch
                ? "No matching favorites found."
                : "No favorites yet. Click Save to store a query."}
            </div>
          ) : (
            <>
              {isCreatingFolder && (
                <div className="startup-connection-context-new-group fav-folder-create">
                  <input
                    type="text"
                    autoFocus
                    value={newFolderName}
                    placeholder="Folder name"
                    onChange={(e) => setNewFolderName(e.target.value)}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter") handleCreateFolder();
                      if (e.key === "Escape") {
                        setIsCreatingFolder(false);
                        setNewFolderName("");
                      }
                    }}
                  />
                  <button
                    type="button"
                    disabled={!newFolderName.trim()}
                    onClick={handleCreateFolder}
                  >
                    Create
                  </button>
                </div>
              )}
              {flatItems.map((item) =>
                item.type === "folder" ? (
                  <FavoriteFolderHeader
                    key={`folder-${item.folder.id}`}
                    folder={item.folder}
                    count={item.count}
                    isCollapsed={collapsedFolderIds.has(item.folder.id)}
                    isRenaming={renamingFolderId === item.folder.id}
                    onToggle={() => handleToggleFolder(item.folder.id)}
                    onRename={(name) => handleRenameFolder(item.folder.id, name)}
                    onContextMenu={(e) => openFolderContextMenu(e, item.folder.id)}
                  />
                ) : (
                  <FavoriteRow
                    key={item.favorite.id}
                    favorite={item.favorite}
                    onCopy={handleCopy}
                    onRun={handleRun}
                    onDelete={handleDelete}
                    onContextMenu={(e) => openFavoriteContextMenu(e, item.favorite.id)}
                  />
                ),
              )}
            </>
          )}
        </div>

        {contextMenu ? (
          <div
            className="startup-connection-context-menu"
            style={{
              left: Math.max(8, Math.min(contextMenu.x, window.innerWidth - 240)),
              top: Math.max(8, Math.min(contextMenu.y, window.innerHeight - 260)),
            }}
            onClick={(e) => e.stopPropagation()}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
          >
            {contextMenu.kind === "favorite" ? (
              isNamingFolder ? (
                <div className="startup-connection-context-new-group">
                  <input
                    type="text"
                    autoFocus
                    value={menuFolderName}
                    placeholder="Folder name"
                    onChange={(e) => setMenuFolderName(e.target.value)}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter") {
                        const name = menuFolderName.trim();
                        if (name) {
                          handleCreateAndAssign(contextMenu.favoriteId, name);
                          closeContextMenu();
                        }
                      }
                      if (e.key === "Escape") closeContextMenu();
                    }}
                  />
                  <button
                    type="button"
                    disabled={!menuFolderName.trim()}
                    onClick={() => {
                      const name = menuFolderName.trim();
                      if (name) {
                        handleCreateAndAssign(contextMenu.favoriteId, name);
                        closeContextMenu();
                      }
                    }}
                  >
                    Create
                  </button>
                </div>
              ) : (
                <>
                  <div className="startup-connection-context-label">Move to folder</div>
                  {folders.map((folder) => (
                    <button
                      key={folder.id}
                      type="button"
                      className="startup-connection-group-menu-item"
                      onClick={() => {
                        handleAssign(contextMenu.favoriteId, folder.id);
                        closeContextMenu();
                      }}
                    >
                      <Folder className="w-3.5 h-3.5" />
                      <span className="startup-connection-context-item-label">{folder.name}</span>
                      {assignments[contextMenu.favoriteId] === folder.id ? (
                        <Check className="w-3.5 h-3.5" />
                      ) : null}
                    </button>
                  ))}
                  {assignments[contextMenu.favoriteId] ? (
                    <button
                      type="button"
                      className="startup-connection-group-menu-item"
                      onClick={() => {
                        handleAssign(contextMenu.favoriteId, null);
                        closeContextMenu();
                      }}
                    >
                      No folder
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="startup-connection-group-menu-item"
                    onClick={() => setIsNamingFolder(true)}
                  >
                    <FolderPlus className="w-3.5 h-3.5" />
                    <span className="startup-connection-context-item-label">New folder…</span>
                  </button>
                </>
              )
            ) : (
              <>
                <button
                  type="button"
                  className="startup-connection-group-menu-item"
                  onClick={() => {
                    setRenamingFolderId(contextMenu.folderId);
                    closeContextMenu();
                  }}
                >
                  Rename
                </button>
                <button
                  type="button"
                  className="startup-connection-group-menu-item danger"
                  onClick={() => {
                    handleDeleteFolder(contextMenu.folderId);
                    closeContextMenu();
                  }}
                >
                  Delete folder
                </button>
              </>
            )}
          </div>
        ) : null}
      </aside>
    </div>
  );
}
