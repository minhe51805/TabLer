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
  AXIS_TICK,
  GRID_STROKE,
  colorAt,
  formatAxisTick,
  formatNumberTick,
  type ChartType,
  type ScatterSeries,
} from "./chart-utils";
import { BaseTooltip, EmptyState } from "./chart-primitives";

/** Self-contained recharts views, one per supported chart family. */


export function ChartCanvas({
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

export function ChartGradients({ yKeys }: { yKeys: string[] }) {
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

export function BarSeriesChart({
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
            isAnimationActive={false}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

export function LineSeriesChart({
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
            dot={data.length <= 120 ? { r: 2.5, strokeWidth: 0, fill: colorAt(index) } : false}
            activeDot={{ r: 5 }}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

export function AreaSeriesChart({
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
            isAnimationActive={false}
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function ComposedSeriesChart({
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
              isAnimationActive={false}
            />
          ) : (
            <Line
              key={key}
              type="monotone"
              dataKey={key}
              stroke={colorAt(index)}
              strokeWidth={2.4}
              dot={data.length <= 120 ? { r: 2.5, strokeWidth: 0, fill: colorAt(index) } : false}
              activeDot={{ r: 5 }}
              isAnimationActive={false}
            />
          )
        )}
      </ComposedChart>
    </ResponsiveContainer>
  );
}

export function ScatterChartView({
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
            isAnimationActive={false}
          />
        ))}
      </ScatterChart>
    </ResponsiveContainer>
  );
}

export function RadarChartView({
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
            isAnimationActive={false}
          />
        ))}
      </RadarChart>
    </ResponsiveContainer>
  );
}

export function RadialChartView({ data }: { data: Array<{ name: string; value: number }> }) {
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
        <RadialBar background dataKey="value" cornerRadius={6} isAnimationActive={false} />
        <Legend iconSize={10} layout="vertical" verticalAlign="middle" align="right" />
        <Tooltip content={<BaseTooltip />} />
      </RadialBarChart>
    </ResponsiveContainer>
  );
}

export function PieChartView({ data, donut }: { data: Array<{ name: string; value: number }>; donut: boolean }) {
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
          isAnimationActive={false}
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
