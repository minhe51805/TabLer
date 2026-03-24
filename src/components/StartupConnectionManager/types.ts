import type { ReactNode } from "react";
import type { ConnectionConfig } from "../../types";
export type { ConnectionConfig } from "../../types";
export { type ConnectionGroup } from "../../stores/connection-group-store";
export { type ConnectionTag } from "../../stores/connection-tag-store";

// ─── Layout ──────────────────────────────────────────────────────────────────

export type ConnectionLayoutMode = "stacked" | "grid";

export const STARTUP_CONNECTION_LAYOUT_STORAGE_KEY =
  "tabler.startup-connection-layout";

// ─── App Info ─────────────────────────────────────────────────────────────────

export const APP_VERSION = "0.1.0";
export const APP_DEVELOPER = "TabLer Team";

// ─── Environment Badge ───────────────────────────────────────────────────────

export type ConnectionEnvironment = "prod" | "staging" | "local" | "ssh" | null;

export interface EnvironmentBadge {
  label: string;
  variant: "prod" | "staging" | "local" | "ssh";
  color: string;
}

const ENV_PATTERNS: Array<{ pattern: RegExp; env: ConnectionEnvironment }> = [
  { pattern: /\b(prod|production)\b/i, env: "prod" },
  { pattern: /\bstaging\b/i, env: "staging" },
  { pattern: /\bssh\b/i, env: "ssh" },
];

export function detectEnvironment(host?: string | null, name?: string | null): ConnectionEnvironment {
  const text = [name, host].filter(Boolean).join(" ");
  if (!text) return null;

  for (const { pattern, env } of ENV_PATTERNS) {
    if (pattern.test(text)) return env;
  }

  const localhosts = ["localhost", "127.0.0.1", "0.0.0.0"];
  if (localhosts.some((l) => text.includes(l))) return "local";

  return null;
}

export function getEnvironmentBadge(env: ConnectionEnvironment, labels: { prod: string; staging: string; local: string; ssh: string }): EnvironmentBadge | null {
  if (!env) return null;
  const badgeColors: Record<string, string> = {
    prod: "var(--danger, #e74c3c)",
    staging: "var(--warning, #f39c12)",
    local: "var(--success, #2ecc71)",
    ssh: "var(--info, #3498db)",
  };
  return { label: labels[env], variant: env, color: badgeColors[env] ?? "#888" };
}

// ─── DB Type Labels ───────────────────────────────────────────────────────────

export interface DbLabel {
  abbr: string;
  color: string;
}

export const DB_LABELS: Record<string, DbLabel> = {
  mysql: { abbr: "Ms", color: "#c0392b" },
  mariadb: { abbr: "Mr", color: "#6c7a89" },
  sqlite: { abbr: "Sl", color: "#3498db" },
  duckdb: { abbr: "Du", color: "#2c3e50" },
  cassandra: { abbr: "Cs", color: "#27ae60" },
  cockroachdb: { abbr: "Cr", color: "#3ddc84" },
  snowflake: { abbr: "Nf", color: "#29b5e8" },
  postgresql: { abbr: "Pg", color: "#336791" },
  greenplum: { abbr: "Gp", color: "#2ecc71" },
  redshift: { abbr: "Rs", color: "#16a085" },
  mssql: { abbr: "Ss", color: "#7f8c8d" },
  redis: { abbr: "Re", color: "#e74c3c" },
  mongodb: { abbr: "Mg", color: "#27ae60" },
  vertica: { abbr: "Ve", color: "#95a5a6" },
  clickhouse: { abbr: "Ch", color: "#5b9bd5" },
  bigquery: { abbr: "Bq", color: "#8e44ad" },
  libsql: { abbr: "Ls", color: "#2ecc71" },
  cloudflared1: { abbr: "D1", color: "#f39c12" },
};

// ─── Hover Preview ─────────────────────────────────────────────────────────────

export interface HoverPreviewState {
  connectionId: string;
  top: number;
  left: number;
  right: number;
}

// ─── Connection Row Props ─────────────────────────────────────────────────────

export interface ConnectionRowData {
  connection: ConnectionConfig;
  isSelected: boolean;
  isConnected: boolean;
  isActive: boolean;
  isGridLayout: boolean;
  statusLabel: string;
  dbInfo: DbLabel;
  endpointLabel: string;
  databaseLabel: string;
  engineLabel: string;
  secondaryBadgeLabel: string | null;
}

// ─── Hover Popover Data ────────────────────────────────────────────────────────

export interface HoverPopoverData {
  connection: ConnectionConfig;
  statusLabel: string;
  endpointLabel: string;
  databaseLabel: string;
  isActive: boolean;
  isConnected: boolean;
  style: { top: number; left: number };
}

// ─── Component Props ───────────────────────────────────────────────────────────

export interface StartupBrandingPanelProps {
  windowControls?: ReactNode;
}

export interface ConnectionListViewProps {
  connections: ConnectionConfig[];
  filteredConnections: ConnectionConfig[];
  selectedConnectionId: string | null;
  layoutMode: ConnectionLayoutMode;
  onSelectConnection: (id: string) => void;
  onConnect: (connection: ConnectionConfig) => void;
  onHover: (event: React.MouseEvent<HTMLButtonElement>, id: string) => void;
  onLeaveHover: () => void;
  listRef: React.RefObject<HTMLDivElement | null>;
}

export interface ConnectionRowProps {
  data: ConnectionRowData;
  onClick: () => void;
  onDoubleClick: () => void;
  onMouseEnter: (e: React.MouseEvent<HTMLButtonElement>) => void;
  onMouseLeave: () => void;
}

export interface ConnectionGroupHeaderProps {
  name: string;
  color: string;
  count: number;
  isCollapsed: boolean;
  onToggle: () => void;
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

export function getLastPathSegment(value?: string | null): string {
  if (!value) return "";
  const normalized = value.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] || value;
}

export function getDbInfo(dbType: string): DbLabel {
  return (
    DB_LABELS[dbType] || { abbr: "??", color: "var(--text-muted)" }
  );
}

export function buildEndpointLabel(
  dbType: string,
  host?: string | null,
  port?: number | null,
  filePath?: string | null,
): string {
  if (dbType === "sqlite") {
    return getLastPathSegment(filePath);
  }
  return `${host || "localhost"}${port ? `:${port}` : ""}`;
}

export function buildDatabaseLabel(
  dbType: string,
  database?: string | null,
  username?: string | null,
): string {
  if (dbType === "sqlite") {
    return "Local File Access";
  }
  return database || username || "Credentials Saved";
}

export function buildSecondaryBadgeLabel(dbType: string, useSsl: boolean): string | null {
  if (dbType === "sqlite") return "Local";
  if (useSsl) return "SSL";
  return null;
}
