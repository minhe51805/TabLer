import { memo } from "react";
import { Eye, EyeOff, Key } from "lucide-react";
import { getCurrentAppLanguage } from "../../i18n";
import { getDataGridMaskingCopy } from "./datagrid-masking-copy";

/** Memoized column header: skips re-render unless sort state for this column changes. */
export const ColumnHeader = memo(function ColumnHeader({
  columnName,
  isPrimaryKey,
  isSorted: _isSorted,
  dir: _dir,
  priority: _priority,
  onSort,
  isMasked = false,
  isRevealed = false,
  onToggleMaskReveal,
}: {
  columnName: string;
  isPrimaryKey: boolean;
  isSorted: boolean;
  dir: "ASC" | "DESC";
  priority: number | null;
  onSort: (colName: string, event?: MouseEvent) => void;
  /** Column has a mask rule (badge shows even while revealed). */
  isMasked?: boolean;
  /** Session-only reveal is active — badge switches to the eye icon. */
  isRevealed?: boolean;
  onToggleMaskReveal?: (colName: string) => void;
}) {
  const maskingCopy = getDataGridMaskingCopy(getCurrentAppLanguage());
  return (
    <div className="flex items-center gap-1.5 w-full text-left font-semibold group/header">
      <button
        type="button"
        className="flex items-center gap-1.5 min-w-0 text-left font-semibold"
        onClick={(e) => onSort(columnName, e.nativeEvent)}
        title="Sort all loaded chunks by this column"
      >
        {isPrimaryKey && <Key className="w-3 h-3 text-[var(--warning)] shrink-0" />}
        <span className="truncate">{columnName}</span>
      </button>
      {isMasked && (
        <button
          type="button"
          className={`datagrid-mask-badge${isRevealed ? " revealed" : ""}`}
          title={isRevealed ? maskingCopy.badgeRevealed : maskingCopy.badgeMasked}
          onClick={(event) => {
            event.stopPropagation();
            onToggleMaskReveal?.(columnName);
          }}
        >
          {isRevealed ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
        </button>
      )}
    </div>
  );
});
