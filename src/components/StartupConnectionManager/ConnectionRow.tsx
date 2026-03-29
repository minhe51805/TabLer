import type { ConnectionRowProps } from "./types";

interface Props extends ConnectionRowProps {
  tagName?: string;
  tagColor?: string;
  envBadge?: { label: string; color: string } | null;
}

export function ConnectionRow({
  data,
  onClick,
  onMouseEnter,
  onMouseLeave,
  tagName,
  tagColor,
  envBadge,
}: Props) {
  const { connection, isSelected, isConnected, isActive, isBusy, isGridLayout, statusLabel, dbInfo, endpointLabel, databaseLabel, engineLabel, secondaryBadgeLabel } = data;

  return (
    <button
      type="button"
      className={`startup-connection-row ${isSelected ? "active" : ""}`}
      data-conn-id={connection.id}
      disabled={Boolean(isBusy)}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="startup-connection-side">
        <div
          className="startup-connection-avatar"
          style={{ backgroundColor: connection.color || dbInfo.color }}
        >
          {dbInfo.abbr}
        </div>

        {isGridLayout && secondaryBadgeLabel ? (
          <div className="startup-connection-side-badges">
            <span className="startup-connection-badge accent startup-connection-side-badge">
              {secondaryBadgeLabel}
            </span>
          </div>
        ) : null}
      </div>

      <div className="startup-connection-copy">
        <div className="startup-connection-title-row">
          <strong className="startup-connection-title">
            {connection.name || "Untitled"}
          </strong>

          {envBadge ? (
            <span
              className="startup-connection-env-badge"
              style={{ color: envBadge.color, borderColor: envBadge.color }}
              title={`Environment: ${envBadge.label}`}
            >
              ({envBadge.label})
            </span>
          ) : null}

          {tagName ? (
            <span
              className="startup-connection-tag-pill"
              style={{ color: tagColor || "var(--text-secondary)", borderColor: tagColor || "var(--text-muted)" }}
              title={`Tag: ${tagName}`}
            >
              {tagName}
            </span>
          ) : null}

          <span
            className={`startup-connection-status ${
              isActive ? "active" : isConnected ? "connected" : ""
            }`}
          >
            {statusLabel}
          </span>
        </div>

        <span
          className="startup-connection-meta"
          title={
            isGridLayout
              ? `${endpointLabel}\n${databaseLabel}`
              : `${endpointLabel} • ${databaseLabel}`
          }
        >
          {isGridLayout ? endpointLabel : `${endpointLabel} • ${databaseLabel}`}
        </span>

        {isGridLayout ? (
          <span className="startup-connection-meta secondary" title={databaseLabel}>
            {databaseLabel}
          </span>
        ) : null}

        {isGridLayout ? (
          <div className="startup-connection-footer">
            <span className="startup-connection-badge engine">{engineLabel}</span>
          </div>
        ) : null}
      </div>
    </button>
  );
}
