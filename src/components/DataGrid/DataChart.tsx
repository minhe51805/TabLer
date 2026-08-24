import { useCallback, useEffect, useMemo, useState } from "react";
import type { ResolvedColumn } from "./hooks/useDataGrid";
import type { QueryResult } from "../../types";
import {
  CHART_TYPES,
  aggregateChartRows,
  cleanSeries,
  detectXAxis,
  formatCategoryValue,
  isNumericColumn,
  isTemporalColumn,
  sampleChartRows,
  selectRelevantChartTypes,
  tryParseNumeric,
  type ChartType,
  type ScatterSeries,
} from "./chart-utils";

export { selectRelevantChartTypes };
export type { ChartType };
import { EmptyState } from "./chart-primitives";
import { ChartCanvas } from "./chart-series";

interface DataChartProps {
  resolvedColumns: ResolvedColumn[];
  queryResult: QueryResult | null;
}

export function DataChart({ resolvedColumns, queryResult }: DataChartProps) {
  const rows = queryResult?.rows ?? [];

  const numericColumns = useMemo(() => {
    const candidates = resolvedColumns.filter((column, index) => isNumericColumn(column, rows, index));
    const metrics = candidates.filter((column) => !column.is_primary_key);

    // A primary key is not a useful metric when real measures exist, but it is
    // a practical fallback for text-only tables so the Chart view never dead-ends.
    return metrics.length > 0 ? metrics : candidates;
  }, [resolvedColumns, rows]);

  const defaultXColumnName = useMemo(
    () => detectXAxis(resolvedColumns, rows)?.name ?? resolvedColumns[0]?.name ?? "",
    [resolvedColumns, rows],
  );

  const [chartType, setChartType] = useState<ChartType>("bar");
  const [selectedX, setSelectedX] = useState(defaultXColumnName);
  const [selectedY, setSelectedY] = useState<string[]>(() => (numericColumns[0] ? [numericColumns[0].name] : []));

  const selectedXColumn = useMemo(
    () => resolvedColumns.find((column) => column.name === selectedX) ?? resolvedColumns[0],
    [resolvedColumns, selectedX],
  );
  const isTemporalX = isTemporalColumn(selectedXColumn);
  const availableChartTypes = useMemo(() => {
    const relevantTypes = new Set(selectRelevantChartTypes(isTemporalX, numericColumns.length));
    return CHART_TYPES.filter((meta) => relevantTypes.has(meta.type));
  }, [isTemporalX, numericColumns.length]);

  const chartMeta = useMemo(
    () => availableChartTypes.find((meta) => meta.type === chartType) ?? availableChartTypes[0],
    [availableChartTypes, chartType],
  );
  const isSingleValueChart = Boolean(chartMeta.singleValue);
  const xAxisColumns = chartType === "scatter" ? numericColumns : resolvedColumns;
  const hasMultipleXAxisChoices = xAxisColumns.length > 1;
  const hasMultipleNumericChoices = numericColumns.length > 1;

  useEffect(() => {
    setSelectedX((current) =>
      resolvedColumns.some((column) => column.name === current) ? current : defaultXColumnName
    );
  }, [defaultXColumnName, resolvedColumns]);

  useEffect(() => {
    setSelectedX((current) =>
      xAxisColumns.some((column) => column.name === current)
        ? current
        : xAxisColumns[0]?.name ?? current
    );
  }, [xAxisColumns]);

  useEffect(() => {
    setSelectedY((current) => {
      const next = current.filter((columnName) =>
        numericColumns.some((column) => column.name === columnName)
      );
      if (next.length > 0) return next;
      return numericColumns[0] ? [numericColumns[0].name] : [];
    });
  }, [numericColumns]);

  useEffect(() => {
    if (chartMeta.type !== chartType) {
      setChartType(chartMeta.type);
    }
  }, [chartMeta.type, chartType]);

  const handleYToggle = useCallback((columnName: string) => {
    setSelectedY((current) => {
      if (!current.includes(columnName)) return [...current, columnName];
      return current.length > 1 ? current.filter((value) => value !== columnName) : current;
    });
  }, []);

  const handleChartTypeChange = useCallback((nextType: ChartType) => {
    setChartType(nextType);
    if (nextType === "scatter") {
      const nextX = numericColumns.find((column) => column.name !== selectedY[0]) ?? numericColumns[0];
      if (nextX) setSelectedX(nextX.name);
    }
  }, [numericColumns, selectedY]);

  const xIndex = selectedXColumn ? resolvedColumns.findIndex((column) => column.name === selectedXColumn.name) : -1;
  const xKey = selectedXColumn?.name ?? "__label";
  const columnIndexByName = useMemo(
    () => new Map(resolvedColumns.map((column, index) => [column.name, index])),
    [resolvedColumns],
  );

  const selectedYColumns = useMemo(
    () => numericColumns.filter((column) => selectedY.includes(column.name)),
    [numericColumns, selectedY],
  );

  const chartData = useMemo(() => {
    if (!selectedXColumn) return [];

    return sampleChartRows(rows).map((row, rowIndex) => {
      const entry: Record<string, unknown> = {
        __rowIndex: rowIndex + 1,
      };

      entry[xKey] = xIndex >= 0 ? row[xIndex] ?? formatCategoryValue(null, rowIndex) : formatCategoryValue(null, rowIndex);

      selectedYColumns.forEach((column) => {
        const columnIndex = columnIndexByName.get(column.name) ?? -1;
        entry[column.name] = columnIndex >= 0 ? tryParseNumeric(row[columnIndex]) : null;
      });

      return entry;
    });
  }, [columnIndexByName, rows, selectedXColumn, selectedYColumns, xIndex, xKey]);

  const cleanYKeys = useMemo(
    () => cleanSeries(selectedYColumns.map((column) => column.name), chartData),
    [chartData, selectedYColumns],
  );

  const seriesData = useMemo(
    () => (!isTemporalX && chartType !== "scatter"
      ? aggregateChartRows(chartData, xKey, cleanYKeys)
      : chartData),
    [chartData, chartType, cleanYKeys, isTemporalX, xKey],
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

  const radarData = useMemo(() => {
    if (!selectedXColumn || cleanYKeys.length === 0) return [];
    return chartData.map((row, rowIndex) => {
      const entry: Record<string, unknown> = {
        __axis: formatCategoryValue(row[selectedXColumn.name], rowIndex),
      };
      cleanYKeys.forEach((key) => {
        entry[key] = tryParseNumeric(row[key]) ?? 0;
      });
      return entry;
    });
  }, [chartData, cleanYKeys, selectedXColumn]);

  const scatterBaseXKey = useMemo(() => {
    if (!selectedXColumn) return "__rowIndex";
    return isNumericColumn(selectedXColumn, rows, xIndex) ? selectedXColumn.name : "__rowIndex";
  }, [rows, selectedXColumn, xIndex]);

  const scatterUsesRowIndex = scatterBaseXKey === "__rowIndex";

  const scatterSeries = useMemo<ScatterSeries[]>(() => {
    if (selectedYColumns.length === 0) return [];

    return selectedYColumns
      .map((column) => {
        const points = chartData
          .map((row, rowIndex) => {
            const xValue = tryParseNumeric(row[scatterBaseXKey]);
            const yValue = tryParseNumeric(row[column.name]);
            if (xValue === null || yValue === null) return null;

            return {
              x: xValue,
              y: yValue,
              label: selectedXColumn
                ? formatCategoryValue(row[selectedXColumn.name], rowIndex)
                : `Row ${rowIndex + 1}`,
            };
          })
          .filter((point): point is { x: number; y: number; label: string } => point !== null);

        return {
          name: column.name,
          data: points,
        };
      })
      .filter((series) => series.data.length > 0);
  }, [chartData, scatterBaseXKey, selectedXColumn, selectedYColumns]);

  if (rows.length === 0) {
    return <EmptyState icon="table" title="No data to visualize." />;
  }

  if (numericColumns.length === 0) {
    return (
      <EmptyState
        icon="chart"
        title="No numeric columns detected for charting."
        detail="Run a query that returns at least one numeric metric column."
      />
    );
  }

  if (selectedYColumns.length === 0) {
    return <EmptyState icon="chart" title="Select at least one Y-axis column above." />;
  }

  return (
    <div className="datachart-container">
      <div className="datachart-toolbar">
        <div className="datachart-group datachart-group--types">
          <label className="datachart-label">Chart</label>
          <div className="datachart-toggle-group">
            {availableChartTypes.map(({ type, label, icon: Icon }) => (
              <button
                key={type}
                type="button"
                className={`datachart-toggle-btn${chartType === type ? " active" : ""}`}
                onClick={() => handleChartTypeChange(type)}
                title={label}
              >
                <Icon className="w-3.5 h-3.5" />
                <span className="datachart-toggle-text">{label}</span>
              </button>
            ))}
          </div>
        </div>

        {hasMultipleXAxisChoices && (
          <div className="datachart-group datachart-group--select-right">
            <label className="datachart-label" htmlFor="datachart-x-select">
              {isSingleValueChart ? "Category" : "X-Axis"}
            </label>
            <select
              id="datachart-x-select"
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
        )}

        {!isSingleValueChart && numericColumns.length > 0 && (
          <div className="datachart-group">
            <label className="datachart-label">{chartType === "radar" ? "Series" : "Y-Axis"}</label>
            <div className="datachart-y-pills">
              {numericColumns.map((column) => (
                <button
                  key={column.name}
                  type="button"
                  className={`datachart-y-pill${selectedY.includes(column.name) ? " active" : ""}`}
                  onClick={() => handleYToggle(column.name)}
                  title={`Type: ${column.data_type || column.column_type || "unknown"}. Select multiple metrics to compare them.`}
                  aria-pressed={selectedY.includes(column.name)}
                >
                  {column.name}
                </button>
              ))}
            </div>
          </div>
        )}

        {isSingleValueChart && hasMultipleNumericChoices && (
          <div className="datachart-group datachart-group--single-value">
            <label className="datachart-label" htmlFor="datachart-value-select">Value</label>
            <select
              id="datachart-value-select"
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
        )}
      </div>

      <div className="datachart-body">
        <ChartCanvas
          chartType={chartType}
          chartData={seriesData}
          xKey={xKey}
          cleanYKeys={cleanYKeys}
          categoryData={categoryData}
          radarData={radarData}
          scatterSeries={scatterSeries}
          scatterUsesRowIndex={scatterUsesRowIndex}
          selectedXName={selectedXColumn?.name ?? "X"}
        />
      </div>
    </div>
  );
}
