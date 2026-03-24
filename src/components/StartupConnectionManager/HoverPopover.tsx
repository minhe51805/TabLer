import type { HoverPopoverData } from "./types";
import { useI18n } from "../../i18n";

interface Props {
  data: HoverPopoverData | null;
}

export function HoverPopover({ data }: Props) {
  const { t } = useI18n();

  if (!data) return null;

  const { connection, statusLabel, endpointLabel, databaseLabel, isActive, isConnected, style } = data;

  return (
    <div
      className="startup-connection-floating-popover"
      style={{
        top: `${style.top}px`,
        left: `${style.left}px`,
      }}
    >
      <div className="startup-connection-hover-head">
        <strong>{connection.name || t("connections.untitled")}</strong>
        <span
          className={`startup-connection-status ${
            isActive ? "active" : isConnected ? "connected" : ""
          }`}
        >
          {statusLabel}
        </span>
      </div>

      <div className="startup-connection-hover-grid">
        <div className="startup-connection-hover-item">
          <span>{t("common.endpoint")}</span>
          <strong>{endpointLabel}</strong>
        </div>
        <div className="startup-connection-hover-item">
          <span>{t("common.database")}</span>
          <strong>{databaseLabel}</strong>
        </div>
        {connection.username ? (
          <div className="startup-connection-hover-item">
            <span>{t("common.user")}</span>
            <strong>{connection.username}</strong>
          </div>
        ) : null}
      </div>

      <div className="startup-connection-hover-badges">
        <span className="startup-connection-badge">
          {connection.db_type.toUpperCase()}
        </span>
        {connection.use_ssl ? (
          <span className="startup-connection-badge accent">SSL</span>
        ) : null}
        {connection.db_type === "sqlite" ? (
          <span className="startup-connection-badge accent">
            {t("connections.localFileAccess")}
          </span>
        ) : null}
      </div>
    </div>
  );
}
