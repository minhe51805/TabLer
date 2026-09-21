import { createPortal } from "react-dom";
import { Loader2, X } from "lucide-react";
import { useI18n } from "../../../i18n";
import { getDataGridPowerCopy } from "../datagrid-power-copy";

/** Aggregate values collected for one column. Optional fields stay undefined
 *  when the column isn't numeric (or the aggregate query failed). */
export interface ColumnStats {
  total: number | null;
  distinct: number | null;
  nulls: number | null;
  min?: string | number | boolean | null;
  max?: string | number | boolean | null;
  avg?: string | number | boolean | null;
}

interface ColumnStatsPopoverProps {
  columnName: string;
  stats: ColumnStats | null;
  isLoading: boolean;
  error: string | null;
  onClose: () => void;
}

function formatStatValue(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && !Number.isInteger(value)) {
    // Averages land here — trim float noise without hiding precision.
    return String(Math.round(value * 10000) / 10000);
  }
  return String(value);
}

/**
 * Floating popover with per-column aggregates (COUNT / DISTINCT / NULLs and
 * MIN/MAX/AVG for numeric columns). Reuses the FK-preview card styling.
 */
export function ColumnStatsPopover({
  columnName,
  stats,
  isLoading,
  error,
  onClose,
}: ColumnStatsPopoverProps) {
  const { language } = useI18n();
  const copy = getDataGridPowerCopy(language).stats;

  const rows: Array<{ label: string; value: string }> = stats
    ? [
        { label: copy.rows, value: formatStatValue(stats.total) },
        { label: copy.distinct, value: formatStatValue(stats.distinct) },
        { label: copy.nulls, value: formatStatValue(stats.nulls) },
        ...(stats.min !== undefined || stats.max !== undefined || stats.avg !== undefined
          ? [
              { label: copy.min, value: formatStatValue(stats.min) },
              { label: copy.max, value: formatStatValue(stats.max) },
              { label: copy.avg, value: formatStatValue(stats.avg) },
            ]
          : []),
      ]
    : [];

  return createPortal(
    <div className="datagrid-fk-preview" role="dialog" aria-label={`${copy.title}: ${columnName}`}>
      <div className="datagrid-fk-preview-header">
        <span className="datagrid-fk-preview-title">{copy.title}</span>
        <span className="datagrid-fk-preview-value">{columnName}</span>
        <button
          type="button"
          className="datagrid-fk-preview-close"
          onClick={onClose}
          aria-label={copy.close}
        >
          <X className="!w-3.5 !h-3.5" />
        </button>
      </div>
      <div className="datagrid-fk-preview-body">
        {isLoading ? (
          <div className="datagrid-fk-preview-loading">
            <Loader2 className="!w-3.5 !h-3.5 animate-spin" /> {copy.loading}
          </div>
        ) : error ? (
          <div className="datagrid-fk-preview-empty">
            {copy.failed}: {error}
          </div>
        ) : (
          <table className="datagrid-fk-preview-table">
            <tbody>
              {rows.map((row) => (
                <tr key={row.label}>
                  <td>{row.label}</td>
                  <td style={{ fontFamily: "monospace", textAlign: "right" }}>{row.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>,
    document.body,
  );
}
