import { describe, expect, it, vi } from "vitest";
import { loadColumnStats } from "@/components/DataGrid/column-stats-runner";
import type { ResolvedColumn } from "@/components/DataGrid/hooks/useDataGrid";
import type { QueryResult } from "@/types";

const countResult: QueryResult = {
  columns: [],
  rows: [[10, 4, 1]],
  affected_rows: 0,
  execution_time_ms: 1,
  query: "counts",
  sandboxed: true,
  truncated: false,
};

const aggregateResult: QueryResult = {
  ...countResult,
  rows: [[1, 9, 4.5]],
  query: "aggregates",
};

const numericColumn: ResolvedColumn = {
  name: "value",
  data_type: "INT",
  is_nullable: true,
  is_primary_key: false,
};

const textColumn: ResolvedColumn = {
  name: "note",
  data_type: "TEXT",
  is_nullable: true,
  is_primary_key: false,
};

function params(
  column: ResolvedColumn,
  executeQuery: (connectionId: string, sql: string) => Promise<QueryResult>,
  isCurrent: () => boolean,
) {
  return {
    connectionId: "conn-1",
    tableName: "users",
    column,
    columnIndex: 1,
    dataRows: [
      [1, "a"],
      [2, "b"],
    ] as QueryResult["rows"],
    databaseType: "postgresql" as const,
    executeQuery,
    isCurrent,
  };
}

describe("loadColumnStats request freshness", () => {
  it("lets the newest request win when an older response arrives later", async () => {
    const pending: Array<(result: QueryResult) => void> = [];
    const executeQuery = vi.fn(
      () =>
        new Promise<QueryResult>((resolve) => {
          pending.push(resolve);
        }),
    );
    let active = 1;
    const first = loadColumnStats(params(textColumn, executeQuery, () => active === 1));
    const second = loadColumnStats(params(textColumn, executeQuery, () => active === 2));
    active = 2;

    pending[1](countResult);
    await expect(second).resolves.toMatchObject({ total: 10, distinct: 4, nulls: 1 });
    pending[0](countResult);
    await expect(first).resolves.toBeNull();
  });

  it("does not start the numeric aggregate after the request becomes stale", async () => {
    let resolveCount: (result: QueryResult) => void = () => {};
    const executeQuery = vi.fn(
      () =>
        new Promise<QueryResult>((resolve) => {
          resolveCount = resolve;
        }),
    );
    let current = true;
    const promise = loadColumnStats(params(numericColumn, executeQuery, () => current));
    current = false;
    resolveCount(countResult);

    await expect(promise).resolves.toBeNull();
    expect(executeQuery).toHaveBeenCalledTimes(1);
  });

  it("keeps counts when the numeric aggregate is unsupported", async () => {
    const executeQuery = vi
      .fn()
      .mockResolvedValueOnce(countResult)
      .mockRejectedValueOnce(new Error("AVG is unsupported"));
    const stats = await loadColumnStats(params(numericColumn, executeQuery, () => true));
    expect(stats).toMatchObject({ total: 10, distinct: 4, nulls: 1 });
    expect(executeQuery).toHaveBeenCalledTimes(2);
  });

  it("returns numeric aggregates only while the request is current", async () => {
    const executeQuery = vi
      .fn()
      .mockResolvedValueOnce(countResult)
      .mockResolvedValueOnce(aggregateResult);
    const stats = await loadColumnStats(params(numericColumn, executeQuery, () => true));
    expect(stats).toMatchObject({ total: 10, min: 1, max: 9, avg: 4.5 });
  });
});
