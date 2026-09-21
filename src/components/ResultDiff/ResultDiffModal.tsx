import { useMemo, type ReactNode } from "react";
import { X } from "lucide-react";
import { useI18n } from "../../i18n";
import { computeResultDiff, type ResultCellValue } from "./result-diff";
import { getResultDiffCopy } from "./result-diff-copy";
import { PINNED_RESULT_ROW_LIMIT, useResultDiffStore } from "./result-diff-store";
import "./ResultDiff.css";

const CHANGE_COLORS = {
  added: "var(--fintech-green, #22c55e)",
  removed: "var(--error, #ef4444)",
  changed: "#eab308",
} as const;

/** Rows rendered per group before a "showing first N" note appears. */
const RENDER_ROW_LIMIT = 500;

function formatCell(value: ResultCellValue): string {
  if (value === null || value === undefined) return "NULL";
  const text = String(value);
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

/**
 * Side-by-side diff between the pinned result snapshot and the result the user
 * chose to compare. Rows are grouped into only-in-current / only-in-pinned /
 * changed, reusing the schema-diff visual language (qs-panel, group headers,
 * +/-/~ markers).
 */
export function ResultDiffModal() {
  const compare = useResultDiffStore((state) => state.compare);
  const closeCompare = useResultDiffStore((state) => state.closeCompare);
  const { language } = useI18n();
  const copy = getResultDiffCopy(language);

  const diff = useMemo(
    () => (compare ? computeResultDiff(compare.a.result, compare.b) : null),
    [compare],
  );

  if (!compare || !diff) return null;

  const renderSideRow = (row: { key: string; values: ResultCellValue[] }, sign: "+" | "-") => (
    <div className="qs-item static result-diff-row">
      <span className="result-diff-row-key">
        {sign} {row.key}
      </span>
      <div className="result-diff-row-cells">
        {diff.columns.map((column, columnIndex) => (
          <span key={column} className="result-diff-cell">
            <span className="result-diff-cell-name">{column}</span>
            <span className="result-diff-cell-value">{formatCell(row.values[columnIndex])}</span>
          </span>
        ))}
      </div>
    </div>
  );

  const groups: Array<{ key: string; count: number; body: ReactNode }> = [
    {
      key: "added",
      count: diff.added.length,
      body: diff.added
        .slice(0, RENDER_ROW_LIMIT)
        .map((row) => <div key={row.key}>{renderSideRow(row, "+")}</div>),
    },
    {
      key: "removed",
      count: diff.removed.length,
      body: diff.removed
        .slice(0, RENDER_ROW_LIMIT)
        .map((row) => <div key={row.key}>{renderSideRow(row, "-")}</div>),
    },
    {
      key: "changed",
      count: diff.changed.length,
      body: diff.changed.slice(0, RENDER_ROW_LIMIT).map((row) => (
        <div key={row.key} className="qs-item static result-diff-row">
          <span className="result-diff-row-key">~ {row.key}</span>
          <div className="result-diff-row-cells">
            {row.cells.map((cell) => (
              <span key={cell.column} className="result-diff-cell is-changed">
                <span className="result-diff-cell-name">{cell.column}</span>
                <span className="result-diff-cell-value is-before">{formatCell(cell.before)}</span>
                <span className="result-diff-cell-arrow">→</span>
                <span className="result-diff-cell-value is-after">{formatCell(cell.after)}</span>
              </span>
            ))}
          </div>
        </div>
      )),
    },
  ].filter((group) => group.count > 0);

  const groupLabel = (key: string, count: number) =>
    key === "added"
      ? copy.groupAdded(count)
      : key === "removed"
        ? copy.groupRemoved(count)
        : copy.groupChanged(count);

  return (
    <div className="qs-overlay" role="presentation">
      <div
        className="qs-panel schema-diff-panel result-diff-panel"
        role="dialog"
        aria-label={copy.title}
      >
        <div className="qs-input-row">
          <strong>{copy.title}</strong>
          <button
            type="button"
            className="qs-clear-btn"
            aria-label={copy.close}
            onClick={closeCompare}
          >
            <X size={14} />
          </button>
        </div>

        <div className="schema-diff-summary result-diff-sides">
          <span title={compare.a.label}>
            {copy.pinnedSide}: {compare.a.label}
          </span>
          <span>→</span>
          <span title={compare.bLabel}>
            {copy.currentSide}: {compare.bLabel}
          </span>
        </div>

        <div className="schema-diff-summary">
          <span style={{ color: CHANGE_COLORS.added }}>{copy.summaryAdded(diff.added.length)}</span>
          <span style={{ color: CHANGE_COLORS.removed }}>
            {copy.summaryRemoved(diff.removed.length)}
          </span>
          <span style={{ color: CHANGE_COLORS.changed }}>
            {copy.summaryChanged(diff.changed.length)}
          </span>
          <span>{copy.summaryUnchanged(diff.unchangedCount)}</span>
          {compare.a.truncatedForDiff && (
            <span>{copy.pinnedTruncated(PINNED_RESULT_ROW_LIMIT)}</span>
          )}
        </div>

        <div className="schema-diff-summary result-diff-meta">
          <span>
            {diff.mode === "primary-key"
              ? copy.matchByPk(diff.keyColumns.join(", "))
              : copy.matchByIndex}
          </span>
          {diff.columnsOnlyInA.length > 0 && (
            <span>{copy.columnsOnlyInPinned(diff.columnsOnlyInA.join(", "))}</span>
          )}
          {diff.columnsOnlyInB.length > 0 && (
            <span>{copy.columnsOnlyInCurrent(diff.columnsOnlyInB.join(", "))}</span>
          )}
        </div>

        <div className="qs-list schema-diff-results">
          {groups.length === 0 && <div className="qs-empty">{copy.noDifferences}</div>}
          {groups.map((group) => (
            <div key={group.key}>
              <div
                className="qs-item static global-search-match-kind"
                style={{ color: CHANGE_COLORS[group.key as keyof typeof CHANGE_COLORS] }}
              >
                {groupLabel(group.key, group.count)}
              </div>
              {group.body}
              {group.count > RENDER_ROW_LIMIT && (
                <div className="qs-empty">{copy.showingFirst(RENDER_ROW_LIMIT, group.count)}</div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
