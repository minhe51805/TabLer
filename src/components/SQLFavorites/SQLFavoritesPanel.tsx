import {
  Bookmark,
  BookmarkPlus,
  Copy,
  Play,
  Search,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useSqlFavoritesStore } from "../../stores/sql-favorites-store";

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

function truncateQuery(sql: string, maxChars = 120): string {
  const compact = sql.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  return compact.slice(0, maxChars - 1) + "\u2026";
}

function FavoriteRow({
  favorite,
  onCopy,
  onRun,
  onDelete,
}: {
  favorite: import("../../types/query-history").SqlFavorite;
  onCopy: (sql: string) => void;
  onRun: (sql: string) => void;
  onDelete: (id: string) => void;
}) {
  const preview = truncateQuery(favorite.sql);

  return (
    <div className="fav-entry" title={favorite.sql}>
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
      {favorite.description && (
        <p className="fav-entry-desc">{favorite.description}</p>
      )}
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

export function SQLFavoritesPanel({
  isOpen,
  onClose,
  onRunQuery,
  currentEditorSql = "",
}: Props) {
  const { favorites, isLoading, loadFavorites, saveFavorite, deleteFavorite } =
    useSqlFavoritesStore();
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [saveDialog, setSaveDialog] = useState<SaveDialogState>({
    open: false,
    name: "",
    description: "",
    tags: "",
    sql: currentEditorSql,
  });

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
  }, [isOpen, loadFavorites]);

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
        if (saveDialog.open) {
          setSaveDialog((prev) => ({ ...prev, open: false }));
        } else {
          onClose();
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose, saveDialog.open]);

  const filteredFavorites = debouncedSearch
    ? favorites.filter(
        (f) =>
          f.name.toLowerCase().includes(debouncedSearch.toLowerCase()) ||
          f.description?.toLowerCase().includes(debouncedSearch.toLowerCase()) ||
          f.tags.some((t) => t.toLowerCase().includes(debouncedSearch.toLowerCase())) ||
          f.sql.toLowerCase().includes(debouncedSearch.toLowerCase())
      )
    : favorites;

  const handleCopy = useCallback(async (sql: string) => {
    try {
      await navigator.clipboard.writeText(sql);
    } catch {
      console.error("Failed to copy to clipboard");
    }
  }, []);

  const handleRun = useCallback(
    (sql: string) => {
      onRunQuery(sql);
    },
    [onRunQuery]
  );

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        await deleteFavorite(id);
      } catch {
        // error logged in store
      }
    },
    [deleteFavorite]
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
  }, [saveDialog, currentEditorSql, saveFavorite]);

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
            <button
              type="button"
              className="fav-close-btn"
              onClick={onClose}
            >
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
            <button
              type="button"
              className="fav-search-clear"
              onClick={() => setSearch("")}
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>

        <div className="fav-list">
          {saveDialog.open ? (
            <div className="fav-save-form">
              <div className="fav-form-field">
                <label className="fav-form-label">Name *</label>
                <input
                  type="text"
                  className="fav-form-input"
                  placeholder="e.g. Get active users"
                  value={saveDialog.name}
                  onChange={(e) =>
                    setSaveDialog((prev) => ({ ...prev, name: e.target.value }))
                  }
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
                  onChange={(e) =>
                    setSaveDialog((prev) => ({ ...prev, tags: e.target.value }))
                  }
                />
              </div>
              <div className="fav-form-field">
                <label className="fav-form-label">SQL</label>
                <textarea
                  className="fav-form-textarea"
                  rows={6}
                  value={saveDialog.sql}
                  onChange={(e) =>
                    setSaveDialog((prev) => ({ ...prev, sql: e.target.value }))
                  }
                  spellCheck={false}
                />
              </div>
              <div className="fav-form-actions">
                <button
                  type="button"
                  className="fav-form-cancel"
                  onClick={() =>
                    setSaveDialog((prev) => ({ ...prev, open: false }))
                  }
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="fav-form-submit"
                  onClick={() => void handleSaveFavorite()}
                  disabled={
                    !saveDialog.name.trim() || !saveDialog.sql.trim()
                  }
                >
                  Save Favorite
                </button>
              </div>
            </div>
          ) : isLoading ? (
            <div className="fav-empty">Loading...</div>
          ) : filteredFavorites.length === 0 ? (
            <div className="fav-empty">
              {debouncedSearch
                ? "No matching favorites found."
                : "No favorites yet. Click Save to store a query."}
            </div>
          ) : (
            filteredFavorites.map((fav) => (
              <FavoriteRow
                key={fav.id}
                favorite={fav}
                onCopy={handleCopy}
                onRun={handleRun}
                onDelete={handleDelete}
              />
            ))
          )}
        </div>
      </aside>
    </div>
  );
}
