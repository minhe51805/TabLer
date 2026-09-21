import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { BarChart3, X } from "lucide-react";
import { useI18n } from "../../i18n";
import { getDataGridChartCopy } from "./datagrid-chart-copy";
import type { ResolvedColumn } from "./hooks/useDataGrid";
import {
  aggregateChartRows,
  cleanSeries,
  formatCategoryValue,
  isNumericColumn,
  isTemporalColumn,
  sampleChartRows,
  tryParseNumeric,
  type ChartType,
} from "./chart-utils";
import { EmptyState } from "./chart-primitives";
import { ChartCanvas } from "./chart-series";

interface DataGridChartModalProps {
  resolvedColumns: ResolvedColumn[];
  rows: (string | number | boolean | null)[][];
  onClose: () => void;
}

/** The quick-chart modal intentionally offers the three everyday chart types. */
const MODAL_CHART_TYPES: Array<{ type: ChartType; label: string }> = [
  { type: "bar", label: "Bar" },
  { type: "line", label: "Line" },
  { type: "pie", label: "Pie" },
];

/**
 * "Chart this" modal: pick bar/line/pie, an X column (defaults to the first
 * text/date column) and one or more numeric Y columns, then render the current
 * grid rows with recharts via the shared ChartCanvas.
 */
export function DataGridChartModal({ resolvedColumns, rows, onClose }: DataGridChartModalProps) {
  const { language } = useI18n();
  const copy = getDataGridChartCopy(language).chart;

  const numericColumns = useMemo(() => {
    const candidates = resolvedColumns.filter((column, index) =>
      isNumericColumn(column, rows, index),
    );
    const metrics = candidates.filter((column) => !column.is_primary_key);
    return metrics.length > 0 ? metrics : candidates;
  }, [resolvedColumns, rows]);

  // X axis candidates: text/date columns first; fall back to every column so a
  // numeric-only result can still chart against one of its measures.
  const xAxisColumns = useMemo(() => {
    const categorical = resolvedColumns.filter(
      (column, index) => !isNumericColumn(column, rows, index),
    );
    return categorical.length > 0 ? categorical : resolvedColumns;
  }, [resolvedColumns, rows]);

  const [chartType, setChartType] = useState<ChartType>("bar");
  const [selectedX, setSelectedX] = useState(() => xAxisColumns[0]?.name ?? "");
  const [selectedY, setSelectedY] = useState<string[]>(() =>
    numericColumns[0] ? [numericColumns[0].name] : [],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const selectedXColumn = useMemo(
    () => resolvedColumns.find((column) => column.name === selectedX) ?? xAxisColumns[0],
    [resolvedColumns, selectedX, xAxisColumns],
  );
  const isTemporalX = isTemporalColumn(selectedXColumn);
  const isPie = chartType === "pie";

  const columnIndexByName = useMemo(
    () => new Map(resolvedColumns.map((column, index) => [column.name, index])),
    [resolvedColumns],
  );
  const xIndex = selectedXColumn ? (columnIndexByName.get(selectedXColumn.name) ?? -1) : -1;
  const xKey = selectedXColumn?.name ?? "__label";

  const selectedYColumns = useMemo(
    () => numericColumns.filter((column) => selectedY.includes(column.name)),
    [numericColumns, selectedY],
  );

  const handleYToggle = useCallback((columnName: string) => {
    setSelectedY((current) => {
      if (!current.includes(columnName)) return [...current, columnName];
      return current.length > 1 ? current.filter((value) => value !== columnName) : current;
    });
  }, []);

  const chartData = useMemo(() => {
    if (!selectedXColumn) return [];
    return sampleChartRows(rows).map((row, rowIndex) => {
      const entry: Record<string, unknown> = {
        [xKey]:
          xIndex >= 0
            ? (row[xIndex] ?? formatCategoryValue(null, rowIndex))
            : formatCategoryValue(null, rowIndex),
      };
      selectedYColumns.forEach((column) => {
        const columnIndex = columnIndexByName.get(column.name) ?? -1;
        entry[column.name] = columnIndex >= 0 ? tryParseNumeric(row[columnIndex]) : null;
      });
      return entry;
    });
  }, [columnIndexByName, rows, selectedXColumn, selectedYColumns, xIndex, xKey]);

  const cleanYKeys = useMemo(
    () =>
      cleanSeries(
        selectedYColumns.map((column) => column.name),
        chartData,
      ),
    [chartData, selectedYColumns],
  );

  // Categorical X axes get bucketed + summed so thousands of rows collapse into
  // a readable chart; temporal axes keep row order.
  const seriesData = useMemo(
    () => (isTemporalX ? chartData : aggregateChartRows(chartData, xKey, cleanYKeys)),
    [chartData, cleanYKeys, isTemporalX, xKey],
  );

  const categoryData = useMemo(() => {
    if (!selectedXColumn || selectedYColumns.length === 0) return [];
    const labelKey = selectedXColumn.name;
    const valueKey = selectedYColumns[0].name;
    const totals = new Map<string, number>();
    seriesData.forEach((row, rowIndex) => {
      const label = formatCategoryValue(row[labelKey], rowIndex);
      const value = tryParseNumeric(row[valueKey]);
      if (value === null) return;
      totals.set(label, (totals.get(label) ?? 0) + value);
    });
    return [...totals.entries()]
      .map(([name, value]) => ({ name, value }))
      .filter((item) => item.value !== 0);
  }, [selectedXColumn, selectedYColumns, seriesData]);

  return createPortal(
    <div className="qs-overlay" role="presentation" onClick={onClose}>
      <div
        className="qs-panel datagrid-chart-modal"
        role="dialog"
        aria-label={copy.title}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="qs-input-row">
          <strong>
            <BarChart3 size={14} className="inline-block mr-1" />
            {copy.title}
          </strong>
          <button type="button" className="qs-clear-btn" aria-label={copy.close} onClick={onClose}>
            <X size={14} />
          </button>
        </div>

        {rows.length === 0 ? (
          <EmptyState icon="table" title={copy.noRows} />
        ) : numericColumns.length === 0 ? (
          <EmptyState icon="chart" title={copy.noNumeric} />
        ) : (
          <div className="datachart-container datagrid-chart-modal-body">
            <div className="datachart-toolbar">
              <div className="datachart-group datachart-group--types">
                <label className="datachart-label">{copy.type}</label>
                <div className="datachart-toggle-group">
                  {MODAL_CHART_TYPES.map(({ type, label }) => (
                    <button
                      key={type}
                      type="button"
                      className={`datachart-toggle-btn${chartType === type ? " active" : ""}`}
                      onClick={() => setChartType(type)}
                    >
                      <span className="datachart-toggle-text">{label}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="datachart-group">
                <label className="datachart-label" htmlFor="datagrid-chart-x-select">
                  {copy.xAxis}
                </label>
                <select
                  id="datagrid-chart-x-select"
                  className="datachart-select"
                  value={selectedX}
                  onChange={(event) => setSelectedX(event.target.value)}
                >
                  {xAxisColumns.map((column) => (
                    <option key={column.name} value={column.name}>
                      {column.name}
                    </option>
                  ))}
                </select>
              </div>

              {isPie ? (
                <div className="datachart-group">
                  <label className="datachart-label" htmlFor="datagrid-chart-value-select">
                    {copy.value}
                  </label>
                  <select
                    id="datagrid-chart-value-select"
                    className="datachart-select"
                    value={selectedY[0] ?? ""}
                    onChange={(event) => setSelectedY([event.target.value])}
                  >
                    {numericColumns.map((column) => (
                      <option key={column.name} value={column.name}>
                        {column.name}
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <div className="datachart-group">
                  <label className="datachart-label">{copy.yAxis}</label>
                  <div className="datachart-y-pills">
                    {numericColumns.map((column) => (
                      <button
                        key={column.name}
                        type="button"
                        className={`datachart-y-pill${selectedY.includes(column.name) ? " active" : ""}`}
                        onClick={() => handleYToggle(column.name)}
                        aria-pressed={selectedY.includes(column.name)}
                      >
                        {column.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="datachart-body">
              <ChartCanvas
                chartType={chartType}
                chartData={seriesData}
                xKey={xKey}
                cleanYKeys={cleanYKeys}
                categoryData={categoryData}
                radarData={[]}
                scatterSeries={[]}
                scatterUsesRowIndex={false}
                selectedXName={selectedXColumn?.name ?? "X"}
              />
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
