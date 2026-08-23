import { memo } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Key } from "lucide-react";

/** Memoized column header: skips re-render unless sort state for this column changes. */
export const ColumnHeader = memo(function ColumnHeader({
  columnName,
  isPrimaryKey,
  isSorted,
  dir,
  priority,
  onSort,
}: {
  columnName: string;
  isPrimaryKey: boolean;
  isSorted: boolean;
  dir: "ASC" | "DESC";
  priority: number | null;
  onSort: (colName: string, event?: MouseEvent) => void;
}) {
  return (
    <button
      className="flex items-center gap-1.5 w-full text-left font-semibold group/header"
      onClick={(e) => onSort(columnName, e.nativeEvent)}
      title="Sort all loaded chunks by this column"
    >
      {isPrimaryKey && <Key className="w-3 h-3 text-[var(--warning)] shrink-0" />}
      <span className="truncate">{columnName}</span>
      {priority !== null ? (
        <span className="datagrid-sort-priority">{priority}</span>
      ) : isSorted ? (
        dir === "ASC" ? (
          <ArrowUp className="w-3 h-3 shrink-0 text-[var(--accent)]" />
        ) : (
          <ArrowDown className="w-3 h-3 shrink-0 text-[var(--accent)]" />
        )
      ) : (
        <ArrowUpDown className="w-3 h-3 shrink-0 opacity-0 group-hover/header:opacity-50 transition-opacity" />
      )}
    </button>
  );
});
