import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { EyeOff, X } from "lucide-react";
import { useI18n } from "../../i18n";
import { getDataGridMaskingCopy } from "./datagrid-masking-copy";
import type { AnonymizerStrategy } from "../../utils/anonymizer";
import "./datagrid-masking.css";

interface DataGridMaskIndicatorProps {
  /** column name → strategy for every masked column (revealed or not). */
  maskedColumns: Record<string, AnonymizerStrategy>;
  /** Remove the mask rule for one column. */
  onUnmaskColumn: (column: string) => void;
  /** Remove every mask rule in the current table scope. */
  onUnmaskAll: () => void;
}

/**
 * Toolbar indicator for view-time column masking: an eye-off badge with the
 * masked-column count. Clicking opens a popover listing each masked column
 * with its strategy, a per-column unmask action, and "Unmask all".
 * Self-contained (own popover + outside-click) so the toolbar only wires props.
 */
export function DataGridMaskIndicator({
  maskedColumns,
  onUnmaskColumn,
  onUnmaskAll,
}: DataGridMaskIndicatorProps) {
  const { language } = useI18n();
  const copy = getDataGridMaskingCopy(language);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const entries = Object.entries(maskedColumns);
  const count = entries.length;

  // Close on outside click / Escape while the popover is open.
  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && rootRef.current?.contains(target)) return;
      if (target && menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  if (count === 0) return null;

  const rect = rootRef.current?.getBoundingClientRect();
  const menu =
    open && rect
      ? createPortal(
          <div
            ref={menuRef}
            className="datagrid-export-menu datagrid-mask-menu"
            style={{ position: "fixed", top: rect.bottom + 6, left: rect.left, zIndex: 9999 }}
            role="menu"
          >
            <div className="datagrid-mask-menu-title">{copy.maskedColumns(count)}</div>
            {entries.map(([column, strategy]) => (
              <div key={column} className="datagrid-mask-menu-row">
                <EyeOff className="!w-3.5 !h-3.5" />
                <span className="datagrid-mask-menu-column" title={column}>
                  {column}
                </span>
                <span className="datagrid-mask-menu-strategy">{copy.strategies[strategy]}</span>
                <button
                  type="button"
                  className="datagrid-mask-menu-unmask"
                  title={copy.unmask}
                  aria-label={`${copy.unmask}: ${column}`}
                  onClick={() => {
                    onUnmaskColumn(column);
                    if (count <= 1) setOpen(false);
                  }}
                >
                  <X className="!w-3 !h-3" />
                </button>
              </div>
            ))}
            <button
              type="button"
              className="datagrid-sort-menu-item danger"
              onClick={() => {
                onUnmaskAll();
                setOpen(false);
              }}
            >
              <X className="!w-3.5 !h-3.5" />
              <span>{copy.unmaskAll}</span>
            </button>
          </div>,
          document.body,
        )
      : null;

  return (
    <span ref={rootRef} className="popover-container" data-popover={copy.maskedHint}>
      <button
        type="button"
        className={`datagrid-footer-action datagrid-mask-indicator${open ? " active" : ""}`}
        onClick={() => setOpen((v) => !v)}
        title={copy.maskedHint}
        aria-label={copy.maskedColumns(count)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <EyeOff className="!w-3.5 !h-3.5" />
        <span>{copy.maskedColumns(count)}</span>
      </button>
      {menu}
    </span>
  );
}
