import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { AlertCircle, BarChart3, List } from "lucide-react";
import type { ResolvedColumn } from "./hooks/useDataGrid";
import type { QueryResult } from "../../types";

export type ChartType = "bar" | "line" | "area" | "scatter" | "pie";

interface DataChartProps {
  resolvedColumns: ResolvedColumn[];
  queryResult: QueryResult | null;
}

interface ScatterSeries {
  name: string;
  data: Array<{ x: number; y: number; label: string }>;
}

const CHART_LABELS: Record<ChartType, string> = {
  bar: "Bar",
  line: "Line",
  area: "Area",
  scatter: "Scatter",
  pie: "Pie",
};

const SERIES_COLORS = [
  "var(--accent)",
  "var(--fintech-green)",
  "var(--fintech-cyan)",
  "#f59e0b",
  "#8b5cf6",
  "#10b981",
  "#ef4444",
  "#06b6d4",
  "#84cc16",
  "#f97316",
];

function isNumericByType(column: ResolvedColumn) {
  const type = (column.column_type || column.data_type || "").toLowerCase();
  return (
    /^(smallint|bigint|tinyint|integer|int2|int4|int8|oid)$/.test(type) ||
    /^(real|double|double precision|serial|bigserial)$/.test(type) ||
    /\b(int|real|double|numeric|decimal|float|money|currency)\b/.test(type) ||
    type.startsWith("int")
  );
}

function tryParseNumeric(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.replace(/,/g, "").trim();
    if (!normalized) return null;
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function hasNumericValues(rows: unknown[][], columnIndex: number) {
  return rows.some((row) => tryParseNumeric(row[columnIndex]) !== null);
}

function isNumericColumn(column: ResolvedColumn, rows: unknown[][], columnIndex: number) {
  return isNumericByType(column) || hasNumericValues(rows, columnIndex);
}

function detectXAxis(columns: ResolvedColumn[], rows: unknown[][]) {
  const priorities = [
    /^(label|name|title|category|type|status|region|country|city|month|day|date)$/i,
    /(^created|^updated|^modified|_at$|time|timestamp)/i,
  ];

  for (const matcher of priorities) {
    const match = columns.find((column) => matcher.test(column.name));
    if (match) return match;
  }

  const firstCategorical = columns.find((column, index) => !isNumericColumn(column, rows, index));
  return firstCategorical || columns[0];
}

function formatCategoryValue(value: unknown, rowIndex: number) {
  if (value === null || value === undefined || value === "") {
    return `Row ${rowIndex + 1}`;
  }
  return String(value);
}

function formatAxisTick(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  return text.length > 18 ? `${text.slice(0, 15)}...` : text;
}

function cleanSeries(keys: string[], data: Record<string, unknown>[]) {
  return keys.filter((key) =>
    data.some((row) => typeof row[key] === "number" && Number.isFinite(row[key] as number))
  );
}

function BaseTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ name?: string; value?: unknown; color?: string }>;
  label?: unknown;
}) {
  if (!active || !payload?.length) return null;

  return (
    <div className="datachart-tooltip">
      {label !== undefined && label !== null && (
        <p className="datachart-tooltip-label">{String(label)}</p>
      )}
      {payload.map((item, index) => (
        <p key={`${item.name || "value"}-${index}`} style={{ color: item.color || "var(--text-primary)" }}>
          {item.name || "Value"}: {item.value === null || item.value === undefined ? "NULL" : String(item.value)}
        </p>
      ))}
    </div>
  );
}

function EmptyState({
  icon,
  title,
  detail,
}: {
  icon: "chart" | "table" | "warning";
  title: string;
  detail?: string;
}) {
  const Icon = icon === "table" ? List : icon === "warning" ? AlertCircle : BarChart3;

  return (
    <div className="datachart-empty">
      <Icon className="w-10 h-10 opacity-30 mb-3" />
      <p>{title}</p>
      {detail ? <p className="text-xs mt-1">{detail}</p> : null}
    </div>
  );
}

export function DataChart({ resolvedColumns, queryResult }: DataChartProps) {
  const rows = queryResult?.rows ?? [];

  const numericColumns = useMemo(
    () =>
      resolvedColumns.filter((column, index) => isNumericColumn(column, rows, index)),
    [resolvedColumns, rows],
  );

  const defaultXColumnName = useMemo(
    () => detectXAxis(resolvedColumns, rows)?.name ?? resolvedColumns[0]?.name ?? "",
    [resolvedColumns, rows],
  );

  const [chartType, setChartType] = useState<ChartType>("bar");
  const [selectedX, setSelectedX] = useState(defaultXColumnName);
  const [selectedY, setSelectedY] = useState<string[]>(() => (numericColumns[0] ? [numericColumns[0].name] : []));

  useEffect(() => {
    setSelectedX((current) =>
      resolvedColumns.some((column) => column.name === current) ? current : defaultXColumnName
    );
  }, [defaultXColumnName, resolvedColumns]);

  useEffect(() => {
    setSelectedY((current) => {
      const next = current.filter((columnName) =>
        numericColumns.some((column) => column.name === columnName)
      );
      if (next.length > 0) return next;
      return numericColumns[0] ? [numericColumns[0].name] : [];
    });
  }, [numericColumns]);

  const handleYToggle = useCallback((columnName: string) => {
    setSelectedY((current) =>
      current.includes(columnName)
        ? current.filter((value) => value !== columnName)
        : [...current, columnName]
    );
  }, []);

  const selectedXColumn = useMemo(
    () => resolvedColumns.find((column) => column.name === selectedX) ?? resolvedColumns[0],
    [resolvedColumns, selectedX],
  );

  const xIndex = selectedXColumn ? resolvedColumns.findIndex((column) => column.name === selectedXColumn.name) : -1;
  const xKey = selectedXColumn?.name ?? "__label";

  const selectedYColumns = useMemo(
    () => numericColumns.filter((column) => selectedY.includes(column.name)),
    [numericColumns, selectedY],
  );

  const chartData = useMemo(() => {
    if (!selectedXColumn) return [];

    return rows.map((row, rowIndex) => {
      const entry: Record<string, unknown> = {
        __rowIndex: rowIndex + 1,
      };

      entry[xKey] = xIndex >= 0 ? row[xIndex] ?? formatCategoryValue(null, rowIndex) : formatCategoryValue(null, rowIndex);

      selectedYColumns.forEach((column) => {
        const columnIndex = resolvedColumns.findIndex((candidate) => candidate.name === column.name);
        entry[column.name] = columnIndex >= 0 ? tryParseNumeric(row[columnIndex]) : null;
      });

      return entry;
    });
  }, [resolvedColumns, rows, selectedXColumn, selectedYColumns, xIndex, xKey]);

  const cleanYKeys = useMemo(
    () => cleanSeries(selectedYColumns.map((column) => column.name), chartData),
    [chartData, selectedYColumns],
  );

  const pieData = useMemo(() => {
    if (!selectedXColumn || selectedYColumns.length === 0) return [];

    const labelKey = selectedXColumn.name;
    const valueKey = selectedYColumns[0].name;
    const totals = new Map<string, number>();

    chartData.forEach((row, rowIndex) => {
      const label = formatCategoryValue(row[labelKey], rowIndex);
      const value = tryParseNumeric(row[valueKey]);
      if (value === null) return;
      totals.set(label, (totals.get(label) ?? 0) + value);
    });

    return [...totals.entries()]
      .map(([name, value]) => ({ name, value }))
      .filter((item) => item.value !== 0);
  }, [chartData, selectedXColumn, selectedYColumns]);

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
        <div className="datachart-group">
          <label className="datachart-label">Chart</label>
          <div className="datachart-toggle-group">
            {(Object.keys(CHART_LABELS) as ChartType[]).map((type) => (
              <button
                key={type}
                type="button"
                className={`datachart-toggle-btn${chartType === type ? " active" : ""}`}
                onClick={() => setChartType(type)}
              >
                {CHART_LABELS[type]}
              </button>
            ))}
          </div>
        </div>

        {chartType !== "pie" && (
          <div className="datachart-group">
            <label className="datachart-label" htmlFor="datachart-x-select">X-Axis</label>
            <select
              id="datachart-x-select"
              className="datachart-select"
              value={selectedX}
              onChange={(event) => setSelectedX(event.target.value)}
            >
              {resolvedColumns.map((column) => (
                <option key={column.name} value={column.name}>
                  {column.name}
                </option>
              ))}
            </select>
            {chartType === "scatter" && scatterUsesRowIndex && (
              <span className="datachart-inline-note">
                Scatter needs a numeric X-axis, so it is using row order right now.
              </span>
            )}
          </div>
        )}

        {chartType !== "pie" && (
          <div className="datachart-group">
            <label className="datachart-label">Y-Axis</label>
            <div className="datachart-y-pills">
              {numericColumns.map((column) => (
                <button
                  key={column.name}
                  type="button"
                  className={`datachart-y-pill${selectedY.includes(column.name) ? " active" : ""}`}
                  onClick={() => handleYToggle(column.name)}
                  title={`Type: ${column.data_type || column.column_type || "unknown"}`}
                >
                  {column.name}
                </button>
              ))}
            </div>
          </div>
        )}

        {chartType === "pie" && (
          <div className="datachart-group">
            <label className="datachart-label" htmlFor="datachart-pie-select">Value</label>
            <select
              id="datachart-pie-select"
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
        {chartType === "pie" ? (
          pieData.length > 0 ? (
            <PieChartView data={pieData} />
          ) : (
            <EmptyState
              icon="chart"
              title="Pie chart needs one label column and one numeric value column."
            />
          )
        ) : chartType === "scatter" ? (
          scatterSeries.length > 0 ? (
            <ScatterChartView
              series={scatterSeries}
              xLabel={scatterUsesRowIndex ? "Row" : (selectedXColumn?.name ?? "X")}
            />
          ) : (
            <EmptyState
              icon="chart"
              title="Scatter chart needs numeric values on both axes."
              detail="Pick a numeric X-axis column or keep the row-order fallback and at least one numeric Y-axis."
            />
          )
        ) : cleanYKeys.length === 0 ? (
          <EmptyState
            icon="chart"
            title="The selected series does not contain numeric values to render."
          />
        ) : chartType === "bar" ? (
          <CartesianSeriesChart type="bar" data={chartData} xKey={xKey} yKeys={cleanYKeys} />
        ) : chartType === "line" ? (
          <CartesianSeriesChart type="line" data={chartData} xKey={xKey} yKeys={cleanYKeys} />
        ) : (
          <CartesianSeriesChart type="area" data={chartData} xKey={xKey} yKeys={cleanYKeys} />
        )}
      </div>
    </div>
  );
}

function CartesianSeriesChart({
  type,
  data,
  xKey,
  yKeys,
}: {
  type: "bar" | "line" | "area";
  data: Record<string, unknown>[];
  xKey: string;
  yKeys: string[];
}) {
  const chartMargin = { top: 8, right: 24, bottom: 8, left: 8 };

  if (type === "bar") {
    return (
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={chartMargin}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
          <XAxis dataKey={xKey} tick={{ fill: "var(--text-secondary)", fontSize: 11 }} tickFormatter={formatAxisTick} minTickGap={24} />
          <YAxis tick={{ fill: "var(--text-secondary)", fontSize: 11 }} />
          <Tooltip content={<BaseTooltip />} />
          <Legend />
          {yKeys.map((key, index) => (
            <Bar
              key={key}
              dataKey={key}
              fill={SERIES_COLORS[index % SERIES_COLORS.length]}
              isAnimationActive
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    );
  }

  if (type === "line") {
    return (
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={chartMargin}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
          <XAxis dataKey={xKey} tick={{ fill: "var(--text-secondary)", fontSize: 11 }} tickFormatter={formatAxisTick} minTickGap={24} />
          <YAxis tick={{ fill: "var(--text-secondary)", fontSize: 11 }} />
          <Tooltip content={<BaseTooltip />} />
          <Legend />
          {yKeys.map((key, index) => (
            <Line
              key={key}
              type="monotone"
              dataKey={key}
              stroke={SERIES_COLORS[index % SERIES_COLORS.length]}
              dot={false}
              isAnimationActive
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    );
  }

  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={chartMargin}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
        <XAxis dataKey={xKey} tick={{ fill: "var(--text-secondary)", fontSize: 11 }} tickFormatter={formatAxisTick} minTickGap={24} />
        <YAxis tick={{ fill: "var(--text-secondary)", fontSize: 11 }} />
        <Tooltip content={<BaseTooltip />} />
        <Legend />
        {yKeys.map((key, index) => (
          <Area
            key={key}
            type="monotone"
            dataKey={key}
            fill={SERIES_COLORS[index % SERIES_COLORS.length]}
            fillOpacity={0.2}
            stroke={SERIES_COLORS[index % SERIES_COLORS.length]}
            isAnimationActive
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}

function ScatterChartView({
  series,
  xLabel,
}: {
  series: ScatterSeries[];
  xLabel: string;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <ScatterChart margin={{ top: 8, right: 24, bottom: 8, left: 8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
        <XAxis
          type="number"
          dataKey="x"
          name={xLabel}
          tick={{ fill: "var(--text-secondary)", fontSize: 11 }}
        />
        <YAxis
          type="number"
          dataKey="y"
          name="Value"
          tick={{ fill: "var(--text-secondary)", fontSize: 11 }}
        />
        <Tooltip
          cursor={{ strokeDasharray: "3 3" }}
          content={<BaseTooltip />}
          labelFormatter={(value) => `X: ${value}`}
        />
        <Legend />
        {series.map((item, index) => (
          <Scatter
            key={item.name}
            name={item.name}
            data={item.data}
            fill={SERIES_COLORS[index % SERIES_COLORS.length]}
            isAnimationActive
          />
        ))}
      </ScatterChart>
    </ResponsiveContainer>
  );
}

function PieChartView({ data }: { data: Array<{ name: string; value: number }> }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <PieChart>
        <Pie
          data={data}
          dataKey="value"
          nameKey="name"
          cx="50%"
          cy="50%"
          outerRadius="60%"
          label={({ name, percent }) => `${name} (${((percent ?? 0) * 100).toFixed(0)}%)`}
          isAnimationActive
        >
          {data.map((item, index) => (
            <Cell
              key={`${item.name}-${index}`}
              fill={SERIES_COLORS[index % SERIES_COLORS.length]}
            />
          ))}
        </Pie>
        <Tooltip formatter={(value) => (value === null || value === undefined ? "NULL" : String(value))} />
        <Legend />
      </PieChart>
    </ResponsiveContainer>
  );
}
