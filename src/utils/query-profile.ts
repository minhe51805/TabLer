import type { DatabaseType } from "../types/database";

export type QuerySurface = "sql" | "command";
export type QueryEditorLanguage = "sql" | "javascript" | "shell";
export type QueryExecutionPath = "sandbox" | "direct";

export interface QueryProfile {
  surface: QuerySurface;
  editorLanguage: QueryEditorLanguage;
  executionPath: QueryExecutionPath;
  supportsFormatting: boolean;
  defaultTabTitle: string;
  defaultContent: string;
  surfaceLabel: string;
}

const DEFAULT_SQL_PROFILE: QueryProfile = {
  surface: "sql",
  editorLanguage: "sql",
  executionPath: "sandbox",
  supportsFormatting: true,
  defaultTabTitle: "Query",
  defaultContent: "",
  surfaceLabel: "SQL",
};

const COMMAND_PROFILES: Partial<Record<DatabaseType, QueryProfile>> = {
  mongodb: {
    surface: "command",
    editorLanguage: "javascript",
    executionPath: "direct",
    supportsFormatting: false,
    defaultTabTitle: "Mongo Shell",
    defaultContent: 'db.runCommand({"ping": 1})',
    surfaceLabel: "Mongo Shell",
  },
  redis: {
    surface: "command",
    editorLanguage: "shell",
    executionPath: "direct",
    supportsFormatting: false,
    defaultTabTitle: "Redis CLI",
    defaultContent: "SCAN 0 MATCH * COUNT 100",
    surfaceLabel: "Redis CLI",
  },
};

export function getQueryProfile(dbType?: DatabaseType): QueryProfile {
  return dbType ? COMMAND_PROFILES[dbType] ?? DEFAULT_SQL_PROFILE : DEFAULT_SQL_PROFILE;
}

export function getNewQueryTabTitle(dbType: DatabaseType | undefined, tabCountForConnection: number) {
  const baseTitle = getQueryProfile(dbType).defaultTabTitle;
  return tabCountForConnection <= 1 ? baseTitle : `${baseTitle} ${tabCountForConnection}`;
}

export function isCommandQuerySurface(dbType?: DatabaseType) {
  return getQueryProfile(dbType).surface === "command";
}
