import { useEffect, useState } from "react";
import { ChevronRight, LoaderCircle, Pencil, Trash2 } from "lucide-react";
import type { ConnectionPingResult, ConnectionRowProps } from "./types";

interface Props extends ConnectionRowProps {
  tagName?: string;
  tagColor?: string;
  envBadge?: { label: string; color: string } | null;
  /** Latest "ping all" probe result for this card, if any. */
  ping?: ConnectionPingResult;
  pingOkLabel?: string;
  pingFailLabel?: string;
  onDelete: () => void;
  deleteLabel: string;
  onRename: (name: string) => void;
  renameLabel: string;
  /** Right-click on the card opens the launcher context menu. */
  onContextMenu?: (event: React.MouseEvent<HTMLDivElement>) => void;
  /** Bumping this nonce puts the card into rename mode (context-menu Rename). */
  renameNonce?: number;
}

export function ConnectionRow({
  data,
  onClick,
  onDelete,
  deleteLabel,
  onRename,
  renameLabel,
  onMouseEnter,
  onMouseLeave,
  onContextMenu,
  renameNonce,
  tagName,
  tagColor,
  envBadge,
  ping,
  pingOkLabel,
  pingFailLabel,
}: Props) {
  const {
    connection,
    isSelected,
    isConnected,
    isActive,
    isBusy,
    isGridLayout,
    statusLabel,
    dbInfo,
    endpointLabel,
    databaseLabel,
    secondaryBadgeLabel,
  } = data;

  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(connection.name);

  // Context-menu "Rename" bumps renameNonce; enter rename mode on change.
  useEffect(() => {
    if (renameNonce) {
      setRenameValue(connection.name);
      setIsRenaming(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- nonce is the trigger
  }, [renameNonce]);

  const commitRename = () => {
    const next = renameValue.trim();
    setIsRenaming(false);
    if (next && next !== connection.name) onRename(next);
  };

  return (
    <div
      className={`startup-connection-row ${isSelected ? "active" : ""}`}
      data-conn-id={connection.id}
      data-testid={`connection-${connection.id}`}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onContextMenu={onContextMenu}
    >
      {/* Stretched real button: covers the card so the whole row opens the
          connection and keyboard users get a genuine focusable control.
          Rename/delete sit above it via z-index. A plain role=button div
          would nest interactive descendants and fail axe. */}
      <button
        type="button"
        className="startup-connection-open"
        aria-label={connection.name || "Untitled"}
        disabled={isBusy}
        onClick={() => {
          if (isBusy) return;
          onClick();
        }}
      />

      {connection.color ? (
        <span
          className="startup-connection-accent"
          style={{ backgroundColor: connection.color }}
          aria-hidden="true"
        />
      ) : null}

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
          {isRenaming ? (
            <input
              type="text"
              className="startup-connection-rename-input"
              autoFocus
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
              onBlur={commitRename}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Enter") commitRename();
                if (event.key === "Escape") {
                  setRenameValue(connection.name);
                  setIsRenaming(false);
                }
              }}
            />
          ) : (
            <strong className="startup-connection-title">{connection.name || "Untitled"}</strong>
          )}

          <div className="startup-connection-title-actions">
            {envBadge ? (
              <span
                className="startup-connection-env-badge"
                style={{ color: envBadge.color, borderColor: envBadge.color }}
                title={`Environment: ${envBadge.label}`}
              >
                {envBadge.label}
              </span>
            ) : null}

            {tagName ? (
              <span
                className="startup-connection-tag-pill"
                style={{
                  color: tagColor || "var(--text-secondary)",
                  borderColor: tagColor || "var(--text-muted)",
                }}
                title={`Tag: ${tagName}`}
              >
                {tagName}
              </span>
            ) : null}
          </div>
        </div>

        <span
          className="startup-connection-meta"
          title={
            isGridLayout
              ? `${endpointLabel}\n${databaseLabel}`
              : `${endpointLabel} - ${databaseLabel}`
          }
        >
          {isGridLayout ? endpointLabel : `${endpointLabel} - ${databaseLabel}`}
        </span>

        {isGridLayout ? (
          <span className="startup-connection-meta secondary" title={databaseLabel}>
            {databaseLabel}
          </span>
        ) : null}
      </div>

      <div className="startup-connection-trailing">
        {isBusy ? (
          <LoaderCircle className="startup-connection-loading w-3.5 h-3.5" />
        ) : isActive || isConnected ? (
          <span
            className={`startup-connection-status ${
              isActive ? "active" : isConnected ? "connected" : ""
            }`}
          >
            {statusLabel}
          </span>
        ) : null}

        {ping ? (
          <span
            className={`startup-connection-ping ${ping.ok ? "ok" : "fail"}`}
            title={
              ping.ok
                ? `${pingOkLabel ?? "Reachable"} — ${ping.latencyMs ?? 0} ms`
                : (pingFailLabel ?? "Unreachable")
            }
          >
            {ping.ok ? `${ping.latencyMs ?? 0} ms` : (pingFailLabel ?? "Fail")}
          </span>
        ) : null}

        <button
          type="button"
          className="startup-connection-rename"
          onClick={(event) => {
            event.stopPropagation();
            setRenameValue(connection.name);
            setIsRenaming(true);
          }}
          onKeyDown={(event) => event.stopPropagation()}
          title={renameLabel}
          aria-label={renameLabel}
        >
          <Pencil className="w-3.5 h-3.5" />
        </button>

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

        <ChevronRight className="startup-connection-open-icon w-4 h-4" />
      </div>
    </div>
  );
}
