// Chart rendering components for MetricsBoard widgets.

export function ChartBars({ series }: { series: { label: string; value: number }[] }) {
  const max = Math.max(...series.map((item) => item.value), 1);

  return (
    <div className="metrics-widget-bars">
      {series.map((item) => (
        <div key={item.label} className="metrics-widget-bars-item">
          <div
            className="metrics-widget-bars-bar"
            style={{ height: `${Math.max((item.value / max) * 100, 8)}%` }}
          />
          <span className="metrics-widget-bars-label">{item.label}</span>
        </div>
      ))}
    </div>
  );
}

export function ChartLine({ series }: { series: { label: string; value: number }[] }) {
  const width = 240;
  const height = 120;
  const max = Math.max(...series.map((item) => item.value), 1);
  const points = series
    .map((item, index) => {
      const x = series.length === 1 ? width / 2 : (index / (series.length - 1)) * (width - 16) + 8;
      const y = height - (item.value / max) * (height - 24) - 12;
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="metrics-widget-line-chart" preserveAspectRatio="none">
      <polyline
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinejoin="round"
        strokeLinecap="round"
        points={points}
      />
      {series.map((item, index) => {
        const x = series.length === 1 ? width / 2 : (index / (series.length - 1)) * (width - 16) + 8;
        const y = height - (item.value / max) * (height - 24) - 12;
        return <circle key={item.label} cx={x} cy={y} r="4" fill="currentColor" />;
      })}
    </svg>
  );
}

export function ChartPie({ series }: { series: { label: string; value: number }[] }) {
  const total = Math.max(series.reduce((sum, item) => sum + item.value, 0), 1);
  const colors = ["#7aa2ff", "#7fe0c2", "#ffc56b", "#f08aa2", "#b9a3ff", "#7dc9d8"];
  let angle = 0;
  const gradient = series
    .map((item, index) => {
      const start = angle;
      angle += (item.value / total) * 360;
      return `${colors[index % colors.length]} ${start}deg ${angle}deg`;
    })
    .join(", ");

  return (
    <div className="metrics-widget-pie-shell">
      <div className="metrics-widget-pie" style={{ background: `conic-gradient(${gradient})` }} />
      <div className="metrics-widget-pie-legend">
        {series.map((item, index) => (
          <div key={item.label} className="metrics-widget-pie-legend-item">
            <span
              className="metrics-widget-pie-swatch"
              style={{ backgroundColor: colors[index % colors.length] }}
            />
            <span className="metrics-widget-pie-legend-label">{item.label}</span>
            <span className="metrics-widget-pie-legend-value">{item.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
