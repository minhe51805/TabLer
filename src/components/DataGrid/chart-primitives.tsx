import { AlertCircle, BarChart3, List } from "lucide-react";

/** Shared minimal presentational pieces for the chart view. */

export function BaseTooltip({
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

export function EmptyState({
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
