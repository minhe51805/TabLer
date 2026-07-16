import type {
  ERRelationship,
  ConnectionConfig,
  MetricsBoardDefinition,
  MetricsWidgetDefinition,
  Tab,
} from "../types";
import { splitSqlStatements } from "./sqlStatements";

export const WORKSPACE_BUNDLE_FORMAT = "tabler-workspace";
export const WORKSPACE_BUNDLE_VERSION = 2;

export interface WorkspaceEntityMetadata {
  id: string;
  revision: string;
  updatedAt: string;
}

export interface WorkspaceBundleLayout {
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  leftPanel: "database" | "metrics";
}

export interface WorkspaceBundleConnection extends WorkspaceEntityMetadata {
  name: string;
  databaseType: string;
  host?: string;
  port?: number;
  database?: string;
}

export interface WorkspaceBundleQuery extends WorkspaceEntityMetadata {
  title: string;
  database?: string;
  sql: string;
}

export interface WorkspaceBundleDashboard extends WorkspaceEntityMetadata {
  name: string;
  database?: string;
  widgets: MetricsWidgetDefinition[];
}

export interface WorkspaceBundleERView extends WorkspaceEntityMetadata {
  database?: string;
  relationships: ERRelationship[];
}

export interface WorkspaceBundle {
  format: typeof WORKSPACE_BUNDLE_FORMAT;
  version: typeof WORKSPACE_BUNDLE_VERSION;
  exportedAt: string;
  target: {
    databaseType: string;
    database?: string;
  };
  layout: WorkspaceBundleLayout;
  connections: WorkspaceBundleConnection[];
  queries: WorkspaceBundleQuery[];
  dashboards: WorkspaceBundleDashboard[];
  erViews: WorkspaceBundleERView[];
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

export function createWorkspaceEntityRevision(value: unknown) {
  const source = stableStringify(value);
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}

function entityMetadata(id: string, value: unknown, updatedAt?: string): WorkspaceEntityMetadata {
  return {
    id,
    revision: createWorkspaceEntityRevision(value),
    updatedAt: updatedAt || new Date().toISOString(),
  };
}

function stripLeadingSqlNoise(statement: string) {
  let remaining = statement.trimStart();
  while (remaining.startsWith("--") || remaining.startsWith("/*")) {
    if (remaining.startsWith("--")) {
      const nextLine = remaining.indexOf("\n");
      if (nextLine < 0) return "";
      remaining = remaining.slice(nextLine + 1).trimStart();
      continue;
    }
    const blockEnd = remaining.indexOf("*/");
    if (blockEnd < 0) return "";
    remaining = remaining.slice(blockEnd + 2).trimStart();
  }
  return remaining;
}

/** A portable bundle only carries one read-only SQL statement per query. */
export function isSafeWorkspaceQuery(sql: string) {
  const statements = splitSqlStatements(sql)
    .map((statement) => statement.trim())
    .filter(Boolean);
  if (statements.length !== 1) return false;

  const normalized = stripLeadingSqlNoise(statements[0])
    .replace(/\s+/g, " ")
    .toUpperCase();
  if (!normalized) return false;
  if (normalized.startsWith("PRAGMA")) return !normalized.includes("=");
  if (normalized.startsWith("WITH")) {
    return !/\b(INSERT|UPDATE|DELETE|MERGE|ALTER|CREATE|DROP|TRUNCATE)\b/.test(
      normalized,
    );
  }
  return ["SELECT", "SHOW", "DESCRIBE", "EXPLAIN"].some((prefix) =>
    normalized.startsWith(prefix),
  );
}

function cloneSafeWidgets(widgets: MetricsWidgetDefinition[]) {
  return widgets
    .filter((widget) => isSafeWorkspaceQuery(widget.query))
    .map((widget) => ({ ...widget }));
}

export function createWorkspaceBundle(input: {
  connection?: ConnectionConfig;
  databaseType: string;
  database?: string;
  tabs: Tab[];
  dashboards: MetricsBoardDefinition[];
  erRelationships: ERRelationship[];
  layout: WorkspaceBundleLayout;
}): WorkspaceBundle {
  const exportedAt = new Date().toISOString();
  const connectionValue = input.connection
    ? {
        name: input.connection.name,
        databaseType: input.connection.db_type,
        host: input.connection.host,
        port: input.connection.port,
        database: input.connection.database,
      }
    : null;
  return {
    format: WORKSPACE_BUNDLE_FORMAT,
    version: WORKSPACE_BUNDLE_VERSION,
    exportedAt,
    target: { databaseType: input.databaseType, database: input.database },
    layout: input.layout,
    connections: input.connection && connectionValue
      ? [{
          ...entityMetadata(input.connection.id, connectionValue, exportedAt),
          ...connectionValue,
        }]
      : [],
    queries: input.tabs
      .filter(
        (tab) =>
          tab.type === "query" &&
          typeof tab.content === "string" &&
          isSafeWorkspaceQuery(tab.content),
      )
      .map((tab) => ({
        ...entityMetadata(
          tab.workspaceEntityId || tab.id,
          { title: tab.title, database: tab.database, sql: tab.content },
          tab.workspaceEntityUpdatedAt || exportedAt,
        ),
        title: tab.title,
        database: tab.database,
        sql: tab.content as string,
      })),
    dashboards: input.dashboards.map((board) => {
      const value = {
        name: board.name,
        database: board.database,
        widgets: cloneSafeWidgets(board.widgets),
      };
      return {
        ...entityMetadata(board.id, value, new Date(board.updated_at).toISOString()),
        ...value,
      };
    }),
    erViews: input.erRelationships.length
      ? [
          {
            ...entityMetadata(
              input.database || "default",
              input.erRelationships,
              exportedAt,
            ),
            database: input.database,
            relationships: input.erRelationships.map((relationship) => ({
              ...relationship,
            })),
          },
        ]
      : [],
  };
}

function isDashboard(value: unknown): value is WorkspaceBundleDashboard {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.name === "string" && Array.isArray(record.widgets);
}

function parsedEntityMetadata(
  value: Record<string, unknown>,
  fallbackId: string,
  revisionValue: unknown,
  fallbackUpdatedAt: string,
): WorkspaceEntityMetadata {
  return {
    id:
      typeof value.id === "string" && value.id.trim()
        ? value.id
        : `legacy-${fallbackId}-${createWorkspaceEntityRevision(revisionValue)}`,
    revision:
      typeof value.revision === "string" && value.revision.trim()
        ? value.revision
        : createWorkspaceEntityRevision(revisionValue),
    updatedAt:
      typeof value.updatedAt === "string" && !Number.isNaN(Date.parse(value.updatedAt))
        ? value.updatedAt
        : fallbackUpdatedAt,
  };
}

/** Parses an untrusted bundle and strips any unsafe SQL before import. */
export function parseWorkspaceBundle(raw: string): WorkspaceBundle {
  const parsed = JSON.parse(raw) as Partial<WorkspaceBundle>;
  const sourceVersion = (parsed as { version?: number }).version;
  if (
    parsed.format !== WORKSPACE_BUNDLE_FORMAT ||
    (sourceVersion !== 1 && sourceVersion !== WORKSPACE_BUNDLE_VERSION)
  ) {
    throw new Error("This file is not a supported TableR workspace bundle.");
  }

  const target = parsed.target;
  if (!target || typeof target.databaseType !== "string") {
    throw new Error("Workspace bundle target metadata is missing.");
  }

  const layout = parsed.layout;
  const exportedAt =
    typeof parsed.exportedAt === "string" && !Number.isNaN(Date.parse(parsed.exportedAt))
      ? parsed.exportedAt
      : new Date(0).toISOString();
  const safeLayout: WorkspaceBundleLayout = {
    sidebarCollapsed: Boolean(layout?.sidebarCollapsed),
    sidebarWidth:
      typeof layout?.sidebarWidth === "number" &&
      Number.isFinite(layout.sidebarWidth)
        ? Math.min(560, Math.max(220, Math.round(layout.sidebarWidth)))
        : 320,
    leftPanel: layout?.leftPanel === "metrics" ? "metrics" : "database",
  };

  const connections = Array.isArray(parsed.connections)
    ? parsed.connections
        .filter(
          (connection): connection is WorkspaceBundleConnection =>
            !!connection &&
            typeof connection === "object" &&
            typeof connection.name === "string" &&
            typeof connection.databaseType === "string",
        )
        .map((connection, index) => {
          const value = {
            name: connection.name,
            databaseType: connection.databaseType,
            host: typeof connection.host === "string" ? connection.host : undefined,
            port: typeof connection.port === "number" ? connection.port : undefined,
            database: typeof connection.database === "string" ? connection.database : undefined,
          };
          return {
            ...parsedEntityMetadata(
              connection as unknown as Record<string, unknown>,
              `connection-${index}`,
              value,
              exportedAt,
            ),
            ...value,
          };
        })
    : [];

  const queries = Array.isArray(parsed.queries)
    ? parsed.queries
        .filter(
          (query) =>
            !!query &&
            typeof query.title === "string" &&
            typeof query.sql === "string" &&
            isSafeWorkspaceQuery(query.sql),
        )
        .map((query, index) => {
          const value = {
            title: query.title,
            database: typeof query.database === "string" ? query.database : undefined,
            sql: query.sql,
          };
          return {
            ...parsedEntityMetadata(
              query as unknown as Record<string, unknown>,
              `query-${index}`,
              value,
              exportedAt,
            ),
            ...value,
          };
        })
    : [];

  const dashboards = Array.isArray(parsed.dashboards)
    ? parsed.dashboards.filter(isDashboard).map((board, index) => {
        const value = {
          name: board.name,
          database: typeof board.database === "string" ? board.database : undefined,
          widgets: cloneSafeWidgets(board.widgets as MetricsWidgetDefinition[]),
        };
        return {
          ...parsedEntityMetadata(
            board as unknown as Record<string, unknown>,
            `dashboard-${index}`,
            value,
            exportedAt,
          ),
          ...value,
        };
      })
    : [];

  const erViews = Array.isArray(parsed.erViews)
    ? parsed.erViews
        .filter(
          (view): view is WorkspaceBundleERView =>
            !!view &&
            typeof view === "object" &&
            Array.isArray((view as WorkspaceBundleERView).relationships),
        )
        .map((view, index) => {
          const value = {
            database: typeof view.database === "string" ? view.database : undefined,
            relationships: view.relationships.filter(
            (relationship) =>
              typeof relationship?.fromTable === "string" &&
              typeof relationship?.fromColumn === "string" &&
              typeof relationship?.toTable === "string" &&
              typeof relationship?.toColumn === "string",
            ),
          };
          return {
            ...parsedEntityMetadata(
              view as unknown as Record<string, unknown>,
              `er-view-${index}`,
              value,
              exportedAt,
            ),
            ...value,
          };
        })
    : [];

  return {
    format: WORKSPACE_BUNDLE_FORMAT,
    version: WORKSPACE_BUNDLE_VERSION,
    exportedAt,
    target: {
      databaseType: target.databaseType,
      database:
        typeof target.database === "string" ? target.database : undefined,
    },
    layout: safeLayout,
    connections,
    queries,
    dashboards,
    erViews,
  };
}
