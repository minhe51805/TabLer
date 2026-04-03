import { Trash2 } from "lucide-react";
import type { ConnectionRowProps } from "./types";

interface Props extends ConnectionRowProps {
  tagName?: string;
  tagColor?: string;
  envBadge?: { label: string; color: string } | null;
  onDelete: () => void;
  deleteLabel: string;
}

export function ConnectionRow({
  data,
  onClick,
  onDelete,
  deleteLabel,
  onMouseEnter,
  onMouseLeave,
  tagName,
  tagColor,
  envBadge,
}: Props) {
  const { connection, isSelected, isConnected, isActive, isBusy, isGridLayout, statusLabel, dbInfo, endpointLabel, databaseLabel, secondaryBadgeLabel } = data;

  return (
    <div
      role="button"
      tabIndex={isBusy ? -1 : 0}
      aria-disabled={Boolean(isBusy)}
      className={`startup-connection-row ${isSelected ? "active" : ""}`}
      data-conn-id={connection.id}
      onClick={() => {
        if (isBusy) return;
        onClick();
      }}
      onKeyDown={(event) => {
        if (isBusy) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onClick();
      }}
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

          <div className="startup-connection-title-actions">
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

            <button
              type="button"
              className="startup-connection-delete"
              onClick={(event) => {
                event.stopPropagation();
                onDelete();
              }}
              title={deleteLabel}
              aria-label={deleteLabel}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
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
      </div>
    </div>
  );
}
