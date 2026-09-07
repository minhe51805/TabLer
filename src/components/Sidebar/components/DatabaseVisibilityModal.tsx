import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Database, Search } from "lucide-react";
import type { DatabaseInfo } from "../../../types";
import { useDbVisibilityStore, getHiddenDatabaseNames } from "../../../stores/dbVisibilityStore";

interface DatabaseVisibilityModalProps {
  open: boolean;
  connectionId: string | null;
  databases: DatabaseInfo[];
  t: (key: import("../../../i18n").TranslationKey, params?: Record<string, string | number>) => string;
  onClose: () => void;
}

/** SSMS-style modal that picks which databases the Explorer renders. */
export function DatabaseVisibilityModal({
  open,
  connectionId,
  databases,
  t,
  onClose,
}: DatabaseVisibilityModalProps) {
  const hiddenDatabases = useDbVisibilityStore((state) => state.hiddenDatabases);
  const setHiddenDatabases = useDbVisibilityStore((state) => state.setHiddenDatabases);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!open) return;
    const hidden = new Set(getHiddenDatabaseNames(connectionId, hiddenDatabases));
    setSelected(hidden);
    setQuery("");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset only when (re)opening
  }, [open, connectionId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const visibleList = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return databases;
    return databases.filter((db) => db.name.toLowerCase().includes(q));
  }, [databases, query]);

  if (!open) return null;

  const toggle = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const save = () => {
    if (!connectionId) return;
    const currentSet = new Set(databases.map((db) => db.name));
    setHiddenDatabases(
      connectionId,
      Array.from(selected).filter((name) => currentSet.has(name)),
    );
    onClose();
  };

  const rows = visibleList.map((db) => {
    return (
      <label key={db.name} className="db-visibility-row">
        <input type="checkbox" checked={!selected.has(db.name)} onChange={() => toggle(db.name)} />
        <Database className="db-visibility-row-icon" />
        <span className="db-visibility-row-name" title={db.name}>
          {db.name}
        </span>
        {db.size ? <span className="db-visibility-row-size">{db.size}</span> : null}
      </label>
    );
  });

  return createPortal(
    <div
      className="db-visibility-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="db-visibility-modal" role="dialog" aria-modal="true">
        <div className="db-visibility-head">
          <div className="db-visibility-head-text">
            <h2 className="db-visibility-title">{t("dbVisibility.title")}</h2>
            <p className="db-visibility-hint">{t("dbVisibility.hint")}</p>
          </div>
          <button type="button" className="db-visibility-close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="db-visibility-search">
          <Search className="db-visibility-search-icon" />
          <input
            type="text"
            value={query}
            placeholder={t("dbVisibility.searchPlaceholder")}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>

        <div className="db-visibility-list">
          {rows.length === 0 ? (
            <div className="db-visibility-empty">{t("dbVisibility.noResults")}</div>
          ) : (
            rows
          )}
        </div>

        <div className="db-visibility-footer">
          <div className="db-visibility-footer-left">
            <button
              type="button"
              className="db-visibility-btn ghost"
              onClick={() => setSelected(new Set())}
            >
              {t("dbVisibility.selectAll")}
            </button>
            <button
              type="button"
              className="db-visibility-btn ghost"
              onClick={() => setSelected(new Set(databases.map((db) => db.name)))}
            >
              {t("dbVisibility.clearSelection")}
            </button>
          </div>
          <div className="db-visibility-footer-right">
            <button type="button" className="db-visibility-btn cancel" onClick={onClose}>
              {t("common.cancel")}
            </button>
            <button type="button" className="db-visibility-btn primary" onClick={save}>
              {t("dbVisibility.save")}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
