import { useCallback, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { useConnectionStore } from "../stores/connectionStore";
import { useGlobalErrorStore } from "../stores/globalErrorStore";
import { useUIStore } from "../stores/uiStore";
import {
  buildDatabaseFileConnection,
  normalizeDatabaseFilePath,
  type DatabaseFileSelection,
} from "../utils/database-file";
import { emitAppToast } from "../utils/app-toast";
import { getQueryProfile } from "../utils/query-profile";
import { splitSqlStatements } from "../utils/sqlStatements";
import { assertStatementsAllowed } from "../utils/safe-mode-query-guard";
import { invokeMutation } from "../utils/tauri-utils";

interface RestorePreview {
  statement_count: number;
  schema_change_count: number;
  data_change_count: number;
  destructive_statement_count: number;
  transactional: boolean;
  warning?: string | null;
}

export function useDatabaseFileActions(language: string) {
  const [isExportingDatabase, setIsExportingDatabase] = useState(false);
  const {
    activeConnectionId,
    connectedIds,
    connections,
    currentDatabase,
    fetchDatabases,
    fetchTables,
    fetchSchemaObjects,
    loadSavedConnections,
  } = useConnectionStore(
    useShallow((state) => ({
      activeConnectionId: state.activeConnectionId,
      connectedIds: state.connectedIds,
      connections: state.connections,
      currentDatabase: state.currentDatabase,
      fetchDatabases: state.fetchDatabases,
      fetchTables: state.fetchTables,
      fetchSchemaObjects: state.fetchSchemaObjects,
      loadSavedConnections: state.loadSavedConnections,
    })),
  );
  const addTab = useUIStore((state) => state.addTab);
  const setError = useGlobalErrorStore((state) => state.setError);
  const activeConnection = connections.find((item) => item.id === activeConnectionId);

  const refreshWorkspace = useCallback(async () => {
    if (!activeConnectionId) return;
    await fetchDatabases(activeConnectionId);
    if (currentDatabase) {
      await Promise.all([
        fetchTables(activeConnectionId, currentDatabase),
        fetchSchemaObjects(activeConnectionId, currentDatabase),
      ]);
    }
  }, [activeConnectionId, currentDatabase, fetchDatabases, fetchSchemaObjects, fetchTables]);

  const importSqlFile = useCallback(async () => {
    if (!activeConnectionId || !activeConnection) {
      emitAppToast({
        tone: "info",
        title: language === "vi" ? "Chua mo workspace" : "Open a workspace first",
        description:
          language === "vi"
            ? "Hay mo mot ket noi SQL truoc khi nap tep .sql."
            : "Open a SQL workspace before loading a .sql file.",
      });
      return;
    }
    if (getQueryProfile(activeConnection.db_type).surface !== "sql") {
      emitAppToast({
        tone: "info",
        title: language === "vi" ? "Engine hien tai khong dung tep .sql" : "SQL files are not used here",
        description:
          language === "vi"
            ? "Engine hien tai dung command surface, khong mo tep .sql theo kieu query."
            : "The current engine uses a command surface, so .sql files are not opened as SQL tabs.",
      });
      return;
    }

    try {
      const result = await invokeMutation<{ file_name: string; content: string }>(
        "read_sql_file",
        {},
      );
      const fileName =
        result?.file_name || (result as { fileName?: string } | null)?.fileName || "query.sql";
      if (!result?.content) return;
      addTab({
        id: `query-${crypto.randomUUID()}`,
        type: "query",
        title: fileName,
        connectionId: activeConnectionId,
        database: currentDatabase || undefined,
        content: result.content,
      });
      emitAppToast({
        tone: "success",
        title: language === "vi" ? "Da mo tep SQL" : "SQL file opened",
        description:
          language === "vi"
            ? `${fileName} da duoc mo thanh mot query tab moi.`
            : `${fileName} was opened in a new query tab.`,
      });
    } catch (error) {
      if (error instanceof Error && error.message !== "No file selected.") {
        console.error("Failed to import SQL file:", error);
      }
    }
  }, [activeConnection, activeConnectionId, addTab, currentDatabase, language]);

  const importSqlIntoCurrentDatabase = useCallback(async () => {
    if (!activeConnectionId || !activeConnection) {
      emitAppToast({
        tone: "info",
        title: language === "vi" ? "Chua mo workspace" : "Open a workspace first",
        description:
          language === "vi"
            ? "Hay mo mot ket noi SQL truoc khi import tep .sql."
            : "Open a SQL workspace before importing a .sql file.",
      });
      return;
    }
    if (getQueryProfile(activeConnection.db_type).surface !== "sql") {
      emitAppToast({
        tone: "info",
        title: language === "vi" ? "Engine hien tai khong ho tro import SQL" : "SQL import is not available here",
        description:
          language === "vi"
            ? "Engine hien tai dung command surface, khong import tep .sql theo kieu SQL database."
            : "The current engine uses a command surface, so .sql import is not available here.",
      });
      return;
    }

    const startedAt = performance.now();
    try {
      const result = await invokeMutation<{ file_name: string; content: string }>(
        "read_sql_file",
        {},
      );
      const fileName =
        result?.file_name || (result as { fileName?: string } | null)?.fileName || "import.sql";
      const sql = result?.content || "";
      const statements = splitSqlStatements(sql);
      if (!statements.length) {
        emitAppToast({
          tone: "info",
          title: language === "vi" ? "Tep SQL khong co cau lenh" : "The SQL file is empty",
          description:
            language === "vi"
              ? "Khong tim thay cau lenh nao de import."
              : "No SQL statements were found to import.",
        });
        return;
      }

      await assertStatementsAllowed(statements, activeConnectionId);

      const preview = await invokeMutation<RestorePreview>("preview_database_restore", {
        sql,
        dbType: activeConnection.db_type,
      });
      const approved = window.confirm(
        `Restore preview\n\nFile: ${fileName}\nStatements: ${preview.statement_count}\nSchema changes: ${preview.schema_change_count}\nData changes: ${preview.data_change_count}\nDestructive statements: ${preview.destructive_statement_count}\nMode: ${preview.transactional ? "transactional" : "best effort"}${preview.warning ? `\n\nWarning: ${preview.warning}` : ""}\n\nThe restore will run against ${activeConnection.name || currentDatabase || activeConnection.db_type}. Continue?`,
      );
      if (!approved) {
        emitAppToast({ tone: "info", title: language === "vi" ? "Da huy restore" : "Restore cancelled", description: language === "vi" ? "Khong co cau lenh nao duoc chay." : "No restore statements were executed." });
        return;
      }

      await invokeMutation("restore_database_sql", {
        connectionId: activeConnectionId,
        sql,
        dbType: activeConnection.db_type,
      });
      await refreshWorkspace();
      window.dispatchEvent(
        new CustomEvent("workspace-activity", {
          detail: {
            connectionId: activeConnectionId,
            label: "Import SQL",
            durationMs: Math.max(1, Math.round(performance.now() - startedAt)),
          },
        }),
      );
      emitAppToast({
        tone: "success",
        title: language === "vi" ? "Da import tep SQL" : "SQL import complete",
        description:
          language === "vi"
            ? `${fileName} da duoc ap dung vao ${activeConnection.name || currentDatabase || activeConnection.db_type}. ${statements.length} cau lenh da chay.`
            : `${fileName} was applied to ${activeConnection.name || currentDatabase || activeConnection.db_type}. ${statements.length} statements ran.`,
      });
    } catch (error) {
      if (error instanceof Error && error.message === "No file selected.") return;
      const message = error instanceof Error ? error.message : String(error);
      setError(
        language === "vi"
          ? `Khong the import tep SQL: ${message}`
          : `Could not import the SQL file: ${message}`,
      );
      emitAppToast({
        tone: "error",
        title: language === "vi" ? "Import SQL that bai" : "SQL import failed",
        description: message,
      });
    }
  }, [activeConnection, activeConnectionId, currentDatabase, language, refreshWorkspace, setError]);

  const openDatabaseFile = useCallback(async () => {
    try {
      const selection = await invokeMutation<DatabaseFileSelection>("pick_database_file", {});
      const fileName =
        selection?.file_name || (selection as { fileName?: string } | null)?.fileName || "database";
      const filePath =
        selection?.file_path || (selection as { filePath?: string } | null)?.filePath || "";
      if (!filePath) return;

      const normalizedPath = normalizeDatabaseFilePath(filePath);
      const existingConnection = connections.find(
        (connection) =>
          normalizeDatabaseFilePath(connection.file_path || "") === normalizedPath,
      );
      if (existingConnection) {
        window.dispatchEvent(
          new CustomEvent("launcher-focus-connection", {
            detail: { connectionId: existingConnection.id },
          }),
        );
        if (connectedIds.has(existingConnection.id)) {
          const targetDatabase = existingConnection.database ?? null;
          useConnectionStore.setState({
            activeConnectionId: existingConnection.id,
            currentDatabase: targetDatabase,
            schemaObjects: [],
            ...(targetDatabase ? {} : { tables: [] }),
          });
          void fetchDatabases(existingConnection.id);
          if (targetDatabase) void fetchTables(existingConnection.id, targetDatabase);
        } else {
          await useConnectionStore.getState().connectSavedConnection(existingConnection.id);
        }
        await loadSavedConnections();
        emitAppToast({
          tone: "success",
          title: language === "vi" ? "Da dung lai card da luu" : "Reused the saved connection card",
          description:
            language === "vi"
              ? `${fileName} da ton tai trong launcher duoi ten ${existingConnection.name || fileName}.`
              : `${fileName} already exists in the launcher as ${existingConnection.name || fileName}.`,
        });
        return;
      }

      const nextConfig = buildDatabaseFileConnection(
        { file_name: fileName, file_path: filePath },
        `file-${crypto.randomUUID()}`,
      );
      if (!nextConfig) {
        emitAppToast({
          tone: "error",
          title: language === "vi" ? "Khong nhan dien duoc tep database" : "Database file type not recognized",
          description:
            language === "vi"
              ? "TableR hien chi mo truc tiep tep SQLite va DuckDB o launcher."
              : "TableR currently opens SQLite and DuckDB files directly from the launcher.",
        });
        return;
      }

      await useConnectionStore.getState().connectToDatabase(nextConfig);
      await loadSavedConnections();
      window.dispatchEvent(
        new CustomEvent("launcher-focus-connection", { detail: { connectionId: nextConfig.id } }),
      );
      emitAppToast({
        tone: "success",
        title: language === "vi" ? "Da mo tep database" : "Database file opened",
        description:
          language === "vi"
            ? `${fileName} da duoc mo thanh workspace moi.`
            : `${fileName} was opened as a workspace.`,
      });
    } catch (error) {
      if (error instanceof Error && error.message === "No file selected.") return;
      const message = error instanceof Error ? error.message : String(error);
      setError(
        language === "vi"
          ? `Khong the mo tep database: ${message}`
          : `Could not open the database file: ${message}`,
      );
      emitAppToast({
        tone: "error",
        title: language === "vi" ? "Mo tep database that bai" : "Opening the database file failed",
        description: message,
      });
    }
  }, [
    connectedIds,
    connections,
    fetchDatabases,
    fetchTables,
    language,
    loadSavedConnections,
    setError,
  ]);

  const exportDatabase = useCallback(async () => {
    if (!activeConnectionId || !activeConnection || isExportingDatabase) return;
    const startedAt = performance.now();
    setIsExportingDatabase(true);
    try {
      await invokeMutation("export_database", {
        connectionId: activeConnectionId,
        database: currentDatabase || null,
        dbType: activeConnection.db_type,
        connectionName:
          activeConnection.name ||
          activeConnection.host ||
          activeConnection.file_path ||
          activeConnection.db_type,
      });
      emitAppToast({
        tone: "success",
        title: language === "vi" ? "Da xuat database" : "Database exported",
        description:
          language === "vi"
            ? `${activeConnection.name || activeConnection.db_type} da duoc xuat thanh cong.`
            : `${activeConnection.name || activeConnection.db_type} was exported successfully.`,
      });
      window.dispatchEvent(
        new CustomEvent("workspace-activity", {
          detail: {
            connectionId: activeConnectionId,
            label: "Export",
            durationMs: Math.max(1, Math.round(performance.now() - startedAt)),
          },
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== "No file selected.") {
        setError(
          language === "vi"
            ? `Khong the xuat database: ${message}`
            : `Could not export database: ${message}`,
        );
      }
    } finally {
      setIsExportingDatabase(false);
    }
  }, [
    activeConnection,
    activeConnectionId,
    currentDatabase,
    isExportingDatabase,
    language,
    setError,
  ]);

  return {
    importSqlFile,
    importSqlIntoCurrentDatabase,
    openDatabaseFile,
    exportDatabase,
    isExportingDatabase,
  };
}
