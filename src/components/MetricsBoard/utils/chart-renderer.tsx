// Chart rendering components for MetricsBoard widgets (recharts-powered).
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  Cell,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  PolarAngleAxis,
  RadialBar,
  RadialBarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export interface MetricsSeriesPoint {
  label: string;
  value: number;
}

const SERIES_COLORS = [
  "var(--accent)",
  "#22d3ee",
  "#00d4aa",
  "#6366f1",
  "#a78bfa",
  "#f08aa2",
  "#a3e635",
  "#f59e0b",
];

function colorAt(index: number) {
  return SERIES_COLORS[index % SERIES_COLORS.length];
}

function formatCompact(value: number) {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

function shortLabel(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  return text.length > 14 ? `${text.slice(0, 11)}...` : text;
}

const AXIS_TICK = { fill: "var(--text-secondary)", fontSize: 10 };
const GRID_STROKE = "var(--border-subtle)";

function MetricsTooltip({
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
    <div className="metrics-chart-tooltip">
      {label !== undefined && label !== null && String(label) !== "" && (
        <p className="metrics-chart-tooltip-label">{String(label)}</p>
      )}
      {payload.map((item, index) => (
        <p key={index} className="metrics-chart-tooltip-row">
          <span className="metrics-chart-tooltip-dot" style={{ background: item.color || "var(--accent)" }} />
          <span className="metrics-chart-tooltip-value">
            {item.value === null || item.value === undefined ? "NULL" : String(item.value)}
          </span>
        </p>
      ))}
    </div>
  );
}

export function ChartBars({ series, horizontal = false }: { series: MetricsSeriesPoint[]; horizontal?: boolean }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart
        data={series}
        layout={horizontal ? "vertical" : "horizontal"}
        margin={{ top: 6, right: 10, bottom: 2, left: horizontal ? 8 : 0 }}
        barCategoryGap="18%"
      >
        <defs>
          <linearGradient id="metrics-bar-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.9} />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity={0.25} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} vertical={horizontal} horizontal={!horizontal} />
        {horizontal ? (
          <>
            <XAxis type="number" tick={AXIS_TICK} tickFormatter={formatCompact} />
            <YAxis type="category" dataKey="label" tick={AXIS_TICK} tickFormatter={shortLabel} width={72} />
          </>
        ) : (
          <>
            <XAxis dataKey="label" tick={AXIS_TICK} tickFormatter={shortLabel} interval={0} />
            <YAxis tick={AXIS_TICK} tickFormatter={formatCompact} width={34} />
          </>
        )}
        <Tooltip content={<MetricsTooltip />} cursor={{ fill: "var(--bg-hover)", opacity: 0.35 }} />
        <Bar dataKey="value" radius={horizontal ? [0, 5, 5, 0] : [5, 5, 0, 0]} isAnimationActive>
          {series.map((entry, index) => (
            <Cell key={entry.label} fill={series.length > 1 ? colorAt(index) : "url(#metrics-bar-grad)"} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export function ChartLine({ series, area = false }: { series: MetricsSeriesPoint[]; area?: boolean }) {
  if (area) {
    return (
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={series} margin={{ top: 6, right: 10, bottom: 2, left: 0 }}>
          <defs>
            <linearGradient id="metrics-area-grad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.55} />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity={0.04} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
          <XAxis dataKey="label" tick={AXIS_TICK} tickFormatter={shortLabel} interval={0} />
          <YAxis tick={AXIS_TICK} tickFormatter={formatCompact} width={34} />
          <Tooltip content={<MetricsTooltip />} />
          <Area type="monotone" dataKey="value" stroke="var(--accent)" strokeWidth={2} fill="url(#metrics-area-grad)" isAnimationActive />
        </AreaChart>
      </ResponsiveContainer>
    );
  }
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={series} margin={{ top: 6, right: 10, bottom: 2, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
        <XAxis dataKey="label" tick={AXIS_TICK} tickFormatter={shortLabel} interval={0} />
        <YAxis tick={AXIS_TICK} tickFormatter={formatCompact} width={34} />
        <Tooltip content={<MetricsTooltip />} />
        <Line type="monotone" dataKey="value" stroke="var(--accent)" strokeWidth={2.4} dot={{ r: 2.5, fill: "var(--accent)", strokeWidth: 0 }} activeDot={{ r: 4 }} isAnimationActive />
      </LineChart>
    </ResponsiveContainer>
  );
}

export function ChartPie({ series, donut = false }: { series: MetricsSeriesPoint[]; donut?: boolean }) {
  return (
    <div className="metrics-widget-pie-shell">
      <div className="metrics-widget-pie-chart">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={series}
              dataKey="value"
              nameKey="label"
              cx="50%"
              cy="50%"
              innerRadius={donut ? "55%" : 0}
              outerRadius="92%"
              paddingAngle={donut ? 2 : 0}
              isAnimationActive
            >
              {series.map((entry, index) => (
                <Cell key={entry.label} fill={colorAt(index)} stroke="var(--bg-secondary)" strokeWidth={1.5} />
              ))}
            </Pie>
            <Tooltip content={<MetricsTooltip />} />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <div className="metrics-widget-pie-legend">
        {series.map((item, index) => (
          <div key={item.label} className="metrics-widget-pie-legend-item">
            <span className="metrics-widget-pie-swatch" style={{ backgroundColor: colorAt(index) }} />
            <span className="metrics-widget-pie-legend-label">{item.label}</span>
            <span className="metrics-widget-pie-legend-value">{formatCompact(item.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ChartRadial({ series }: { series: MetricsSeriesPoint[] }) {
  const data = series.map((item, index) => ({ ...item, fill: colorAt(index) }));
  return (
    <ResponsiveContainer width="100%" height="100%">
      <RadialBarChart data={data} innerRadius="25%" outerRadius="100%" startAngle={90} endAngle={-270}>
        <PolarAngleAxis type="number" domain={[0, Math.max(...series.map((s) => s.value), 1)]} tick={false} />
        <RadialBar dataKey="value" background cornerRadius={6} isAnimationActive />
        <Legend iconSize={9} layout="vertical" verticalAlign="middle" align="right" wrapperStyle={{ fontSize: 10 }} />
        <Tooltip content={<MetricsTooltip />} />
      </RadialBarChart>
    </ResponsiveContainer>
  );
}
