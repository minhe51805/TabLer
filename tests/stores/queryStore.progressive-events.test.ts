import { waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryResult } from "@/types";

const mocks = vi.hoisted(() => ({
  invokeMutation: vi.fn(),
  invokeWithTimeout: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("@/utils/tauri-utils", () => ({
  invokeMutation: (...args: unknown[]) => mocks.invokeMutation(...args),
  invokeWithTimeout: (...args: unknown[]) => mocks.invokeWithTimeout(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => mocks.listen(...args),
}));
vi.mock("@/utils/query-notify", () => ({ notifyQueryDone: vi.fn() }));

import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { useSafeModeStore } from "@/stores/safeModeStore";
import { clearQueryResultCache } from "@/utils/query-result-cache";

const queryResult: QueryResult = {
  columns: [],
  rows: [[1]],
  affected_rows: 0,
  execution_time_ms: 1,
  query: "SELECT 1",
  sandboxed: true,
  truncated: false,
};

type BatchHandler = (event: {
  payload: {
    connectionId: string;
    requestId: string;
    rows: unknown[][];
    offset: number;
    totalRows: number;
  };
}) => void;

const handlers: BatchHandler[] = [];
const progressiveCalls: Array<{
  resolve: (result: QueryResult) => void;
  args: { requestId: string };
}> = [];

function readOnlyDecision(sql: string) {
  return {
    statements: [{ sql, kind: "read", readOnly: true }],
    readOnly: true,
    hasSchemaMutation: false,
    parseError: null,
  };
}

describe("progressive query event correlation", () => {
  beforeEach(() => {
    handlers.length = 0;
    progressiveCalls.length = 0;
    mocks.invokeMutation.mockReset();
    mocks.invokeWithTimeout.mockReset();
    mocks.listen.mockReset();
    mocks.listen.mockImplementation(async (_eventName: string, handler: BatchHandler) => {
      handlers.push(handler);
      return () => {};
    });
    mocks.invokeWithTimeout.mockImplementation((command: string, args: { sql?: string }) => {
      if (command === "classify_sql_safety") {
        return Promise.resolve(readOnlyDecision(args.sql ?? ""));
      }
      return Promise.resolve(queryResult);
    });
    mocks.invokeMutation.mockImplementation((command: string, args: { requestId: string }) => {
      if (command === "execute_query_progressive") {
        return new Promise<QueryResult>((resolve) => {
          progressiveCalls.push({ resolve, args });
        });
      }
      return Promise.resolve(queryResult);
    });
    useSafeModeStore.getState().setGlobalLevel(1);
    useSafeModeStore.getState().clearConnectionOverrides();
    useConnectionStore.setState({
      currentDatabase: "app",
      connectedIds: new Set(["conn-1"]),
      connections: [{ id: "conn-1", name: "Fixture", db_type: "sqlite", use_ssl: false }],
    });
    useQueryStore.setState({
      isExecutingQuery: false,
      activeQueryRequestId: null,
      activeQueryConnectionId: null,
      progressiveDeliveryEnabled: true,
      progressiveRowCount: null,
    });
    clearQueryResultCache();
  });

  it("counts delivered rows and ignores a foreign request id", async () => {
    const promise = useQueryStore.getState().executeQuery("conn-1", "SELECT * FROM users");
    await waitFor(() => expect(progressiveCalls).toHaveLength(1));
    const requestId = progressiveCalls[0].args.requestId;

    handlers[0]({
      payload: {
        connectionId: "conn-1",
        requestId: "other",
        rows: [],
        offset: 0,
        totalRows: 10_000,
      },
    });
    expect(useQueryStore.getState().progressiveRowCount).toBeNull();

    handlers[0]({
      payload: {
        connectionId: "conn-1",
        requestId,
        rows: Array.from({ length: 250 }, () => []),
        offset: 500,
        totalRows: 10_000,
      },
    });
    expect(useQueryStore.getState().progressiveRowCount).toBe(750);

    progressiveCalls[0].resolve(queryResult);
    await promise;
    expect(useQueryStore.getState().progressiveRowCount).toBeNull();
  });

  it("does not let the older query overwrite the newer active query", async () => {
    const first = useQueryStore.getState().executeQuery("conn-1", "SELECT * FROM first_table");
    const second = useQueryStore.getState().executeQuery("conn-1", "SELECT * FROM second_table");
    await waitFor(() => expect(progressiveCalls).toHaveLength(2));
    const firstRequestId = progressiveCalls[0].args.requestId;
    const secondRequestId = progressiveCalls[1].args.requestId;
    expect(useQueryStore.getState().activeQueryRequestId).toBe(secondRequestId);

    handlers[0]({
      payload: {
        connectionId: "conn-1",
        requestId: firstRequestId,
        rows: Array.from({ length: 100 }, () => []),
        offset: 0,
        totalRows: 1_000,
      },
    });
    expect(useQueryStore.getState().progressiveRowCount).toBeNull();

    handlers[1]({
      payload: {
        connectionId: "conn-1",
        requestId: secondRequestId,
        rows: Array.from({ length: 50 }, () => []),
        offset: 50,
        totalRows: 1_000,
      },
    });
    expect(useQueryStore.getState().progressiveRowCount).toBe(100);

    progressiveCalls[0].resolve(queryResult);
    progressiveCalls[1].resolve(queryResult);
    await Promise.all([first, second]);
  });
});
