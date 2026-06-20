import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  RadialBar,
  RadialBarChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Activity,
  AlertCircle,
  BarChart3,
  ChartArea,
  ChartColumnStacked,
  ChartLine,
  ChartScatter,
  Donut,
  Gauge,
  Layers,
  List,
  PieChart as PieIcon,
  Radar as RadarIcon,
  Spline,
  type LucideIcon,
} from "lucide-react";
import type { ResolvedColumn } from "./hooks/useDataGrid";
import type { QueryResult } from "../../types";

export type ChartType =
  | "bar"
  | "bar-horizontal"
  | "bar-stacked"
  | "line"
  | "line-smooth"
  | "area"
  | "area-stacked"
  | "composed"
  | "scatter"
  | "pie"
  | "donut"
  | "radar"
  | "radial";

interface DataChartProps {
  resolvedColumns: ResolvedColumn[];
  queryResult: QueryResult | null;
}

interface ScatterSeries {
  name: string;
  data: Array<{ x: number; y: number; label: string }>;
}

interface ChartTypeMeta {
  type: ChartType;
  label: string;
  icon: LucideIcon;
  /** Charts that compare categories against a single aggregated value. */
  singleValue?: boolean;
}

const CHART_TYPES: ChartTypeMeta[] = [
  { type: "bar", label: "Bar", icon: BarChart3 },
  { type: "bar-horizontal", label: "Horizontal", icon: ChartColumnStacked },
  { type: "bar-stacked", label: "Stacked", icon: Layers },
  { type: "line", label: "Line", icon: ChartLine },
  { type: "line-smooth", label: "Smooth", icon: Spline },
  { type: "area", label: "Area", icon: ChartArea },
  { type: "area-stacked", label: "Stacked area", icon: Activity },
  { type: "composed", label: "Bar + line", icon: Activity },
  { type: "scatter", label: "Scatter", icon: ChartScatter },
  { type: "pie", label: "Pie", icon: PieIcon, singleValue: true },
  { type: "donut", label: "Donut", icon: Donut, singleValue: true },
  { type: "radar", label: "Radar", icon: RadarIcon },
  { type: "radial", label: "Radial", icon: Gauge, singleValue: true },
];

const SERIES_COLORS = [
  "var(--accent)",
  "#22c55e",
  "#06b6d4",
  "#f59e0b",
  "#8b5cf6",
  "#10b981",
  "#ef4444",
  "#3b82f6",
  "#84cc16",
  "#f97316",
  "#ec4899",
  "#14b8a6",
];

function colorAt(index: number) {
  return SERIES_COLORS[index % SERIES_COLORS.length];
}

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

function formatNumberTick(value: unknown) {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return String(value ?? "");
  const abs = Math.abs(num);
  if (abs >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
  return String(num);
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
        <p key={`${item.name || "value"}-${index}`} className="datachart-tooltip-row">
          <span className="datachart-tooltip-dot" style={{ background: item.color || "var(--text-primary)" }} />
          <span className="datachart-tooltip-name">{item.name || "Value"}</span>
          <span className="datachart-tooltip-value">
            {item.value === null || item.value === undefined ? "NULL" : String(item.value)}
          </span>
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

const AXIS_TICK = { fill: "var(--text-secondary)", fontSize: 11 };
const GRID_STROKE = "var(--border-subtle)";

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

  const chartMeta = useMemo(
    () => CHART_TYPES.find((meta) => meta.type === chartType) ?? CHART_TYPES[0],
    [chartType],
  );
  const isSingleValueChart = Boolean(chartMeta.singleValue);
  const hasMultipleXAxisChoices = resolvedColumns.length > 1;
  const hasMultipleNumericChoices = numericColumns.length > 1;

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

  const categoryData = useMemo(() => {
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
            {CHART_TYPES.map(({ type, label, icon: Icon }) => (
              <button
                key={type}
                type="button"
                className={`datachart-toggle-btn${chartType === type ? " active" : ""}`}
                onClick={() => setChartType(type)}
                title={label}
              >
                <Icon className="w-3.5 h-3.5" />
                <span className="datachart-toggle-text">{label}</span>
              </button>
            ))}
          </div>
        </div>

        {chartType !== "pie" &&
          chartType !== "donut" &&
          chartType !== "radial" &&
          hasMultipleXAxisChoices && (
          <div className="datachart-group datachart-group--select-right">
            <label className="datachart-label" htmlFor="datachart-x-select">
              {chartType === "radar" ? "Axis" : "X-Axis"}
            </label>
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

        {!isSingleValueChart && hasMultipleNumericChoices && (
          <div className="datachart-group">
            <label className="datachart-label">{chartType === "radar" ? "Series" : "Y-Axis"}</label>
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
          chartData={chartData}
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

function ChartCanvas({
  chartType,
  chartData,
  xKey,
  cleanYKeys,
  categoryData,
  radarData,
  scatterSeries,
  scatterUsesRowIndex,
  selectedXName,
}: {
  chartType: ChartType;
  chartData: Record<string, unknown>[];
  xKey: string;
  cleanYKeys: string[];
  categoryData: Array<{ name: string; value: number }>;
  radarData: Record<string, unknown>[];
  scatterSeries: ScatterSeries[];
  scatterUsesRowIndex: boolean;
  selectedXName: string;
}) {
  if (chartType === "pie" || chartType === "donut") {
    return categoryData.length > 0 ? (
      <PieChartView data={categoryData} donut={chartType === "donut"} />
    ) : (
      <EmptyState icon="chart" title="This chart needs one label column and one numeric value column." />
    );
  }

  if (chartType === "radial") {
    return categoryData.length > 0 ? (
      <RadialChartView data={categoryData} />
    ) : (
      <EmptyState icon="chart" title="Radial chart needs one label column and one numeric value column." />
    );
  }

  if (chartType === "radar") {
    return cleanYKeys.length > 0 && radarData.length > 0 ? (
      <RadarChartView data={radarData} yKeys={cleanYKeys} />
    ) : (
      <EmptyState icon="chart" title="Radar chart needs a category axis and at least one numeric series." />
    );
  }

  if (chartType === "scatter") {
    return scatterSeries.length > 0 ? (
      <ScatterChartView series={scatterSeries} xLabel={scatterUsesRowIndex ? "Row" : selectedXName} />
    ) : (
      <EmptyState
        icon="chart"
        title="Scatter chart needs numeric values on both axes."
        detail="Pick a numeric X-axis column or keep the row-order fallback and at least one numeric Y-axis."
      />
    );
  }

  if (cleanYKeys.length === 0) {
    return <EmptyState icon="chart" title="The selected series does not contain numeric values to render." />;
  }

  if (chartType === "composed") {
    return <ComposedSeriesChart data={chartData} xKey={xKey} yKeys={cleanYKeys} />;
  }

  if (chartType === "bar" || chartType === "bar-horizontal" || chartType === "bar-stacked") {
    return (
      <BarSeriesChart
        data={chartData}
        xKey={xKey}
        yKeys={cleanYKeys}
        horizontal={chartType === "bar-horizontal"}
        stacked={chartType === "bar-stacked"}
      />
    );
  }

  if (chartType === "line" || chartType === "line-smooth") {
    return <LineSeriesChart data={chartData} xKey={xKey} yKeys={cleanYKeys} smooth={chartType === "line-smooth"} />;
  }

  return (
    <AreaSeriesChart data={chartData} xKey={xKey} yKeys={cleanYKeys} stacked={chartType === "area-stacked"} />
  );
}

function ChartGradients({ yKeys }: { yKeys: string[] }) {
  return (
    <defs>
      {yKeys.map((key, index) => (
        <linearGradient key={key} id={`datachart-grad-${index}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={colorAt(index)} stopOpacity={0.85} />
          <stop offset="100%" stopColor={colorAt(index)} stopOpacity={0.12} />
        </linearGradient>
      ))}
    </defs>
  );
}

function BarSeriesChart({
  data,
  xKey,
  yKeys,
  horizontal,
  stacked,
}: {
  data: Record<string, unknown>[];
  xKey: string;
  yKeys: string[];
  horizontal: boolean;
  stacked: boolean;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart
        data={data}
        layout={horizontal ? "vertical" : "horizontal"}
        margin={{ top: 8, right: 24, bottom: 8, left: horizontal ? 24 : 8 }}
        barCategoryGap={stacked ? "20%" : "12%"}
      >
        <ChartGradients yKeys={yKeys} />
        <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
        {horizontal ? (
          <>
            <XAxis type="number" tick={AXIS_TICK} tickFormatter={formatNumberTick} />
            <YAxis type="category" dataKey={xKey} tick={AXIS_TICK} tickFormatter={formatAxisTick} width={110} />
          </>
        ) : (
          <>
            <XAxis dataKey={xKey} tick={AXIS_TICK} tickFormatter={formatAxisTick} minTickGap={24} />
            <YAxis tick={AXIS_TICK} tickFormatter={formatNumberTick} />
          </>
        )}
        <Tooltip content={<BaseTooltip />} cursor={{ fill: "var(--bg-hover)", opacity: 0.4 }} />
        <Legend />
        {yKeys.map((key, index) => (
          <Bar
            key={key}
            dataKey={key}
            stackId={stacked ? "stack" : undefined}
            fill={`url(#datachart-grad-${index})`}
            stroke={colorAt(index)}
            strokeWidth={1}
            radius={stacked ? [0, 0, 0, 0] : horizontal ? [0, 6, 6, 0] : [6, 6, 0, 0]}
            isAnimationActive
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

function LineSeriesChart({
  data,
  xKey,
  yKeys,
  smooth,
}: {
  data: Record<string, unknown>[];
  xKey: string;
  yKeys: string[];
  smooth: boolean;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 8, right: 24, bottom: 8, left: 8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
        <XAxis dataKey={xKey} tick={AXIS_TICK} tickFormatter={formatAxisTick} minTickGap={24} />
        <YAxis tick={AXIS_TICK} tickFormatter={formatNumberTick} />
        <Tooltip content={<BaseTooltip />} />
        <Legend />
        {yKeys.map((key, index) => (
          <Line
            key={key}
            type={smooth ? "monotone" : "linear"}
            dataKey={key}
            stroke={colorAt(index)}
            strokeWidth={2.4}
            dot={{ r: 2.5, strokeWidth: 0, fill: colorAt(index) }}
            activeDot={{ r: 5 }}
            isAnimationActive
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

function AreaSeriesChart({
  data,
  xKey,
  yKeys,
  stacked,
}: {
  data: Record<string, unknown>[];
  xKey: string;
  yKeys: string[];
  stacked: boolean;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 8, right: 24, bottom: 8, left: 8 }}>
        <ChartGradients yKeys={yKeys} />
        <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
        <XAxis dataKey={xKey} tick={AXIS_TICK} tickFormatter={formatAxisTick} minTickGap={24} />
        <YAxis tick={AXIS_TICK} tickFormatter={formatNumberTick} />
        <Tooltip content={<BaseTooltip />} />
        <Legend />
        {yKeys.map((key, index) => (
          <Area
            key={key}
            type="monotone"
            dataKey={key}
            stackId={stacked ? "stack" : undefined}
            stroke={colorAt(index)}
            strokeWidth={2}
            fill={`url(#datachart-grad-${index})`}
            fillOpacity={1}
            isAnimationActive
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}

function ComposedSeriesChart({
  data,
  xKey,
  yKeys,
}: {
  data: Record<string, unknown>[];
  xKey: string;
  yKeys: string[];
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart data={data} margin={{ top: 8, right: 24, bottom: 8, left: 8 }}>
        <ChartGradients yKeys={yKeys} />
        <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
        <XAxis dataKey={xKey} tick={AXIS_TICK} tickFormatter={formatAxisTick} minTickGap={24} />
        <YAxis tick={AXIS_TICK} tickFormatter={formatNumberTick} />
        <Tooltip content={<BaseTooltip />} cursor={{ fill: "var(--bg-hover)", opacity: 0.4 }} />
        <Legend />
        {yKeys.map((key, index) =>
          index === 0 ? (
            <Bar
              key={key}
              dataKey={key}
              fill={`url(#datachart-grad-${index})`}
              stroke={colorAt(index)}
              strokeWidth={1}
              radius={[6, 6, 0, 0]}
              isAnimationActive
            />
          ) : (
            <Line
              key={key}
              type="monotone"
              dataKey={key}
              stroke={colorAt(index)}
              strokeWidth={2.4}
              dot={{ r: 2.5, strokeWidth: 0, fill: colorAt(index) }}
              activeDot={{ r: 5 }}
              isAnimationActive
            />
          )
        )}
      </ComposedChart>
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
        <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
        <XAxis type="number" dataKey="x" name={xLabel} tick={AXIS_TICK} tickFormatter={formatNumberTick} />
        <YAxis type="number" dataKey="y" name="Value" tick={AXIS_TICK} tickFormatter={formatNumberTick} />
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
            fill={colorAt(index)}
            fillOpacity={0.75}
            isAnimationActive
          />
        ))}
      </ScatterChart>
    </ResponsiveContainer>
  );
}

function RadarChartView({
  data,
  yKeys,
}: {
  data: Record<string, unknown>[];
  yKeys: string[];
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <RadarChart data={data} outerRadius="72%">
        <PolarGrid stroke={GRID_STROKE} />
        <PolarAngleAxis dataKey="__axis" tick={AXIS_TICK} />
        <PolarRadiusAxis tick={AXIS_TICK} tickFormatter={formatNumberTick} />
        <Tooltip content={<BaseTooltip />} />
        <Legend />
        {yKeys.map((key, index) => (
          <Radar
            key={key}
            name={key}
            dataKey={key}
            stroke={colorAt(index)}
            fill={colorAt(index)}
            fillOpacity={0.18}
            isAnimationActive
          />
        ))}
      </RadarChart>
    </ResponsiveContainer>
  );
}

function RadialChartView({ data }: { data: Array<{ name: string; value: number }> }) {
  const enriched = data.map((item, index) => ({ ...item, fill: colorAt(index) }));
  return (
    <ResponsiveContainer width="100%" height="100%">
      <RadialBarChart
        data={enriched}
        innerRadius="20%"
        outerRadius="100%"
        startAngle={90}
        endAngle={-270}
      >
        <RadialBar background dataKey="value" cornerRadius={6} isAnimationActive />
        <Legend iconSize={10} layout="vertical" verticalAlign="middle" align="right" />
        <Tooltip content={<BaseTooltip />} />
      </RadialBarChart>
    </ResponsiveContainer>
  );
}

function PieChartView({ data, donut }: { data: Array<{ name: string; value: number }>; donut: boolean }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <PieChart margin={{ top: 22, right: 12, bottom: 16, left: 48 }}>
        <Pie
          data={data}
          dataKey="value"
          nameKey="name"
          cx="38%"
          cy="46%"
          innerRadius={donut ? "45%" : 0}
          outerRadius="58%"
          paddingAngle={donut ? 2 : 0}
          label={({ name, percent }) => `${name} (${((percent ?? 0) * 100).toFixed(0)}%)`}
          isAnimationActive
        >
          {data.map((item, index) => (
            <Cell key={`${item.name}-${index}`} fill={colorAt(index)} stroke="var(--bg-secondary)" strokeWidth={2} />
          ))}
        </Pie>
        <Tooltip formatter={(value) => (value === null || value === undefined ? "NULL" : String(value))} />
        <Legend
          layout="vertical"
          verticalAlign="top"
          align="right"
          iconType="square"
          iconSize={10}
          wrapperStyle={{
            top: 12,
            right: 12,
            width: "26%",
            lineHeight: "22px",
          }}
        />
      </PieChart>
    </ResponsiveContainer>
  );
}
