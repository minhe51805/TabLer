import { MoreHorizontal } from "lucide-react";
import { useState, useRef, useEffect } from "react";
import { useI18n } from "../../i18n";
import type { ConnectionGroup } from "./types";

interface Props {
  group: ConnectionGroup;
  count: number;
  isCollapsed: boolean;
  onToggle: () => void;
  onRename: (name: string) => void;
  onChangeColor: (color: string) => void;
  onDelete: () => void;
}

const GROUP_COLORS = [
  "#e74c3c", "#e67e22", "#f1c40f", "#2ecc71",
  "#1abc9c", "#3498db", "#9b59b6", "#e91e63",
  "#6c7a89", "#2c3e50",
];

export function ConnectionGroupHeader({
  group,
  count,
  isCollapsed,
  onToggle,
  onRename,
  onChangeColor,
  onDelete,
}: Props) {
  const { t } = useI18n();
  const [showMenu, setShowMenu] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(group.name);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Close menu on outside click
  useEffect(() => {
    if (!showMenu) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showMenu]);

  // Focus input when renaming
  useEffect(() => {
    if (isRenaming) inputRef.current?.focus();
  }, [isRenaming]);

  const handleRenameSubmit = () => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== group.name) {
      onRename(trimmed);
    } else {
      setRenameValue(group.name);
    }
    setIsRenaming(false);
  };

  return (
    <div className="startup-connection-group-header-row">
      <button
        type="button"
        className="startup-connection-group-header"
        onClick={onToggle}
        aria-expanded={!isCollapsed}
        title={`${group.name} — ${count} connection${count !== 1 ? "s" : ""}`}
      >
        <span className={`startup-connection-group-chevron ${isCollapsed ? "" : "expanded"}`}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M4 2.5L7.5 6L4 9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </span>
        <span
          className="startup-connection-group-color-dot"
          style={{ backgroundColor: group.color }}
        />
        {isRenaming ? (
          <input
            ref={inputRef}
            className="startup-connection-group-rename-input"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={handleRenameSubmit}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleRenameSubmit();
              if (e.key === "Escape") { setRenameValue(group.name); setIsRenaming(false); }
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="startup-connection-group-name">{group.name}</span>
        )}
        <span className="startup-connection-group-count">{count}</span>
      </button>

      <div className="startup-connection-group-actions" ref={menuRef}>
        <button
          type="button"
          className="startup-connection-group-menu-btn"
          onClick={(e) => { e.stopPropagation(); setShowMenu(!showMenu); }}
          aria-label="More actions"
          title="More actions"
        >
          <MoreHorizontal className="w-3.5 h-3.5" />
        </button>

        {showMenu ? (
          <div className="startup-connection-group-menu">
            <button
              type="button"
              className="startup-connection-group-menu-item"
              onClick={() => { setIsRenaming(true); setShowMenu(false); }}
            >
              {t("common.rename")}
            </button>
            <div className="startup-connection-group-color-picker">
              {GROUP_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`startup-connection-group-color-swatch ${group.color === c ? "active" : ""}`}
                  style={{ backgroundColor: c }}
                  onClick={() => { onChangeColor(c); setShowMenu(false); }}
                  aria-label={c}
                  title={c}
                />
              ))}
            </div>
            <button
              type="button"
              className="startup-connection-group-menu-item danger"
              onClick={() => { onDelete(); setShowMenu(false); }}
            >
              {t("common.delete")}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
