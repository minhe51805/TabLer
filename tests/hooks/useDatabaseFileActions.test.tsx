import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

const invokeMutationMock = vi.fn();
const assertStatementsAllowedMock = vi.fn();
const requestAppConfirmationMock = vi.fn();
const requestAppExportEncryptionMock = vi.fn();

vi.mock("@/utils/tauri-utils", () => ({
  invokeMutation: (...args: unknown[]) => invokeMutationMock(...args),
  invokeWithTimeout: (...args: unknown[]) => invokeMutationMock(...args),
}));

vi.mock("@/utils/safe-mode-query-guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/safe-mode-query-guard")>();
  return {
    ...actual,
    assertStatementsAllowed: (...args: unknown[]) => assertStatementsAllowedMock(...args),
  };
});

vi.mock("@/stores/confirmStore", () => ({
  requestAppConfirmation: (...args: unknown[]) => requestAppConfirmationMock(...args),
  requestAppExportEncryption: (...args: unknown[]) => requestAppExportEncryptionMock(...args),
}));

import { useDatabaseFileActions } from "@/hooks/useDatabaseFileActions";
import { useConnectionStore } from "@/stores/connectionStore";
import { useGlobalErrorStore } from "@/stores/globalErrorStore";
import { useUIStore } from "@/stores/uiStore";
import { SafeModeCancelledError } from "@/utils/safe-mode-query-guard";
import {
  clearQueryResultCache,
  getCachedQueryResult,
  setCachedQueryResult,
} from "@/utils/query-result-cache";
import { APP_TOAST_EVENT, type AppToastPayload } from "@/utils/app-toast";
import type { ConnectionConfig } from "@/types";

const connection = (overrides: Partial<ConnectionConfig> = {}): ConnectionConfig => ({
  id: "conn-1",
  name: "My DB",
  db_type: "postgresql",
  use_ssl: false,
  ...overrides,
});

function collectToasts() {
  const toasts: AppToastPayload[] = [];
  const listener = (e: Event) => toasts.push((e as CustomEvent<AppToastPayload>).detail);
  window.addEventListener(APP_TOAST_EVENT, listener);
  return {
    toasts,
    stop: () => window.removeEventListener(APP_TOAST_EVENT, listener),
  };
}

function seedWorkspace(overrides: Partial<ConnectionConfig> = {}) {
  const conn = connection(overrides);
  useConnectionStore.setState({
    connections: [conn],
    activeConnectionId: conn.id,
    connectedIds: new Set([conn.id]),
    currentDatabase: "app",
  });
  return conn;
}

beforeEach(() => {
  invokeMutationMock.mockReset();
  assertStatementsAllowedMock.mockReset().mockResolvedValue(undefined);
  requestAppConfirmationMock.mockReset().mockResolvedValue(true);
  requestAppExportEncryptionMock.mockReset();
  clearQueryResultCache();
  useGlobalErrorStore.getState().clearError();
  useUIStore.setState({ tabs: [], activeTabId: null });
  useConnectionStore.setState({
    connections: [],
    activeConnectionId: null,
    connectedIds: new Set(),
    databases: [],
    currentDatabase: null,
    tables: [],
    schemaObjects: [],
    isLoadingDatabases: false,
    isLoadingTables: false,
    isLoadingSchemaObjects: false,
  });
});

describe("useDatabaseFileActions.importSqlIntoCurrentDatabase", () => {
  it("refuses non-SQL engines with an info toast and no backend calls", async () => {
    seedWorkspace({ db_type: "redis" });
    const { toasts, stop } = collectToasts();
    const { result } = renderHook(() => useDatabaseFileActions("en"));

    await result.current.importSqlIntoCurrentDatabase();
    stop();

    expect(toasts).toHaveLength(1);
    expect(toasts[0].tone).toBe("info");
    expect(toasts[0].title).toBe("SQL import is not available here");
    expect(invokeMutationMock).not.toHaveBeenCalled();
    expect(assertStatementsAllowedMock).not.toHaveBeenCalled();
    expect(useGlobalErrorStore.getState().error).toBeNull();
  });

  it("surfaces a declined Safe Mode review as a neutral cancel toast, not an error", async () => {
    seedWorkspace();
    invokeMutationMock.mockImplementation((command: string) =>
      command === "read_sql_file"
        ? Promise.resolve({ file_name: "restore.sql", content: "DELETE FROM t" })
        : Promise.resolve(undefined),
    );
    assertStatementsAllowedMock.mockRejectedValue(new SafeModeCancelledError());
    const { toasts, stop } = collectToasts();
    const { result } = renderHook(() => useDatabaseFileActions("en"));

    await result.current.importSqlIntoCurrentDatabase();
    stop();

    expect(toasts).toEqual([expect.objectContaining({ tone: "info", title: "Restore cancelled" })]);
    expect(useGlobalErrorStore.getState().error).toBeNull();
    // The review aborted before any restore/preview command ran.
    expect(invokeMutationMock.mock.calls.map(([command]) => command)).toEqual(["read_sql_file"]);
  });

  it("runs the restore and invalidates the read cache after approval", async () => {
    seedWorkspace();
    // A cached read on this connection must not survive the import.
    setCachedQueryResult("conn-1", "SELECT 1", "app", {
      columns: [],
      rows: [[1]],
      affected_rows: 0,
      execution_time_ms: 1,
      query: "SELECT 1",
      sandboxed: false,
      truncated: false,
    });
    invokeMutationMock.mockImplementation((command: string) => {
      if (command === "read_sql_file")
        return Promise.resolve({ file_name: "restore.sql", content: "INSERT INTO t VALUES (1)" });
      if (command === "preview_database_restore")
        return Promise.resolve({
          statement_count: 1,
          schema_change_count: 0,
          data_change_count: 1,
          destructive_statement_count: 0,
          transactional: true,
        });
      return Promise.resolve(command === "list_databases" ? [] : []);
    });
    const { toasts, stop } = collectToasts();
    const { result } = renderHook(() => useDatabaseFileActions("en"));

    await result.current.importSqlIntoCurrentDatabase();
    stop();

    const commands = invokeMutationMock.mock.calls.map(([command]) => command);
    expect(commands).toContain("preview_database_restore");
    expect(commands).toContain("restore_database_sql");
    expect(invokeMutationMock).toHaveBeenCalledWith("restore_database_sql", {
      connectionId: "conn-1",
      sql: "INSERT INTO t VALUES (1)",
      dbType: "postgresql",
    });
    // The cached read was invalidated by the committed write.
    expect(getCachedQueryResult("conn-1", "SELECT 1", "app")).toBeNull();
    expect(toasts.some((toast) => toast.tone === "success")).toBe(true);
    expect(useGlobalErrorStore.getState().error).toBeNull();
  });

  it("stops at the preview confirmation when the user declines", async () => {
    seedWorkspace();
    requestAppConfirmationMock.mockResolvedValue(false);
    invokeMutationMock.mockImplementation((command: string) => {
      if (command === "read_sql_file")
        return Promise.resolve({ file_name: "restore.sql", content: "INSERT INTO t VALUES (1)" });
      if (command === "preview_database_restore")
        return Promise.resolve({
          statement_count: 1,
          schema_change_count: 0,
          data_change_count: 1,
          destructive_statement_count: 0,
          transactional: true,
        });
      return Promise.resolve([]);
    });
    const { toasts, stop } = collectToasts();
    const { result } = renderHook(() => useDatabaseFileActions("en"));

    await result.current.importSqlIntoCurrentDatabase();
    stop();

    const commands = invokeMutationMock.mock.calls.map(([command]) => command);
    expect(commands).not.toContain("restore_database_sql");
    expect(toasts).toEqual([expect.objectContaining({ tone: "info", title: "Restore cancelled" })]);
  });
});

describe("useDatabaseFileActions.importSqlFile", () => {
  it("refuses a command-surface engine with an info toast and no file read", async () => {
    seedWorkspace({ db_type: "redis" });
    const { toasts, stop } = collectToasts();
    const { result } = renderHook(() => useDatabaseFileActions("en"));

    await result.current.importSqlFile();
    stop();

    expect(toasts).toEqual([
      expect.objectContaining({ tone: "info", title: "SQL files are not used here" }),
    ]);
    expect(invokeMutationMock).not.toHaveBeenCalled();
  });

  it("opens the picked file as a query tab bound to the workspace", async () => {
    seedWorkspace();
    invokeMutationMock.mockImplementation((command: string) =>
      command === "read_sql_file"
        ? Promise.resolve({ file_name: "seed.sql", content: "SELECT 1" })
        : Promise.resolve([]),
    );
    const { toasts, stop } = collectToasts();
    const { result } = renderHook(() => useDatabaseFileActions("en"));

    await result.current.importSqlFile();
    stop();

    const tabs = useUIStore.getState().tabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({
      type: "query",
      title: "seed.sql",
      connectionId: "conn-1",
      database: "app",
      content: "SELECT 1",
    });
    expect(toasts.some((toast) => toast.tone === "success")).toBe(true);
  });
});
