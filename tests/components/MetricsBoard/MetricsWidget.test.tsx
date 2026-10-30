import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MetricsWidgetDefinition, QueryResult } from "@/types";

const mocks = vi.hoisted(() => ({ executeMetricsQuery: vi.fn() }));

vi.mock("@/components/MetricsBoard/utils/query-builder", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/MetricsBoard/utils/query-builder")>();
  return {
    ...actual,
    executeMetricsQuery: (...args: unknown[]) => mocks.executeMetricsQuery(...args),
  };
});

import { MetricsWidgetCard } from "@/components/MetricsBoard/components/MetricsWidget";

const queryResult: QueryResult = {
  columns: [
    { name: "label", data_type: "text", is_nullable: false, is_primary_key: false },
    { name: "value", data_type: "integer", is_nullable: false, is_primary_key: false },
  ],
  rows: [["orders", 2]],
  affected_rows: 0,
  execution_time_ms: 1,
  query: "SELECT 2 AS value, 'orders' AS label",
  sandboxed: true,
  truncated: false,
};

function makeWidget(id: string): MetricsWidgetDefinition {
  return {
    id,
    type: "table",
    title: "Orders",
    query: "SELECT 2 AS value, 'orders' AS label",
    refresh_seconds: 5,
    col_span: 4,
    row_span: 4,
    grid_x: 0,
    grid_y: 0,
  };
}

function renderWidget(id: string) {
  return render(
    <MetricsWidgetCard
      widget={makeWidget(id)}
      connectionId="connection-1"
      onOpenResult={vi.fn()}
      onOpenQuery={vi.fn()}
      selected={false}
      onSelect={vi.fn()}
      layoutStyle={{}}
      dragging={false}
      resizing={false}
      onDragStart={vi.fn()}
      onResizeStart={vi.fn()}
      onContextMenu={vi.fn()}
      refreshToken={0}
      onFullscreen={vi.fn()}
      onDrillDown={vi.fn()}
      onWidgetRefreshed={vi.fn()}
    />,
  );
}

async function flushQuery() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function advance(milliseconds: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("MetricsWidget auto-refresh failure backoff", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.executeMetricsQuery.mockReset();
    mocks.executeMetricsQuery.mockRejectedValue(
      new Error("Sandbox execution throttled: circuit breaker is open"),
    );
  });

  afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("backs off three widget failures to five, ten, and twenty seconds", async () => {
    const invocationTimes: number[] = [];
    const startedAt = Date.now();
    mocks.executeMetricsQuery.mockImplementation(() => {
      invocationTimes.push(Date.now());
      return Promise.reject(new Error("query failed"));
    });
    renderWidget("backoff-intervals");
    await flushQuery();

    await advance(5_000);
    await advance(10_000);
    await advance(20_000);

    expect(invocationTimes.map((time) => time - startedAt)).toEqual([0, 5_000, 15_000, 35_000]);
  });

  it("stops invoking for thirty seconds after repeated breaker failures pause the widget", async () => {
    renderWidget("breaker-pause");
    await flushQuery();
    await advance(5_000);
    await advance(10_000);
    await advance(20_000);
    await advance(40_000);
    expect(mocks.executeMetricsQuery).toHaveBeenCalledTimes(5);
    expect(screen.getByText("paused — run again")).toBeInTheDocument();

    mocks.executeMetricsQuery.mockClear();
    await advance(30_000);
    expect(mocks.executeMetricsQuery).not.toHaveBeenCalled();
  });

  it("pauses after five failures and a manual retry runs exactly once", async () => {
    renderWidget("manual-resume");
    await flushQuery();
    await advance(5_000);
    await advance(10_000);
    await advance(20_000);
    await advance(40_000);
    expect(mocks.executeMetricsQuery).toHaveBeenCalledTimes(5);
    expect(screen.getByText("paused — run again")).toBeInTheDocument();

    mocks.executeMetricsQuery.mockClear();
    await advance(60_000);
    expect(mocks.executeMetricsQuery).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await flushQuery();
    expect(mocks.executeMetricsQuery).toHaveBeenCalledTimes(1);
  });

  it("resets the effective interval to refresh_seconds after one success", async () => {
    renderWidget("success-reset");
    await flushQuery();
    mocks.executeMetricsQuery.mockResolvedValue(queryResult);

    await advance(5_000);
    expect(mocks.executeMetricsQuery).toHaveBeenCalledTimes(2);
    await advance(5_000);
    expect(mocks.executeMetricsQuery).toHaveBeenCalledTimes(3);
    expect(screen.queryByText("paused — run again")).not.toBeInTheDocument();
  });
});
