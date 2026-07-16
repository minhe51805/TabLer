import { beforeAll, describe, expect, it } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { DataGrid } from "@/components/DataGrid/DataGrid";
import type { QueryResult } from "@/types";

beforeAll(() => {
  class TestResizeObserver {
    constructor(private readonly callback: (entries: ResizeObserverEntry[], observer: unknown) => void) {}

    observe(target: Element) {
      this.callback(
        [{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      );
    }
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      width: 960,
      height: 480,
      top: 0,
      left: 0,
      right: 960,
      bottom: 480,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get: () => 960,
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get: () => 480,
  });
});

function createResult(rowCount: number, columnCount: number): QueryResult {
  return {
    columns: Array.from({ length: columnCount }, (_, index) => ({
      name: `column_${index}`,
      data_type: "TEXT",
      is_nullable: true,
      is_primary_key: false,
    })),
    rows: Array.from({ length: rowCount }, (_, rowIndex) => (
      Array.from({ length: columnCount }, (_, columnIndex) => `${rowIndex}:${columnIndex}`)
    )),
    affected_rows: 0,
    execution_time_ms: 1,
    query: "SELECT fixture",
    sandboxed: false,
    truncated: false,
  };
}

describe("DataGrid virtualization", () => {
  it("renders a bounded set of rows and columns for a wide 10k result fixture", async () => {
    const { container } = render(
      <DataGrid connectionId="fixture" queryResult={createResult(10_000, 160)} />,
    );

    await waitFor(() => {
      expect(container.querySelectorAll("tr.datagrid-row").length).toBeGreaterThan(0);
      expect(container.querySelectorAll("th.datagrid-th").length).toBeGreaterThan(1);
    });
    const table = container.querySelector(".datagrid-table") as HTMLTableElement;
    expect(table.style.tableLayout).toBe("fixed");
    const virtualSpacer = container.querySelector(".datagrid-virtual-column-spacer") as HTMLElement;
    expect(virtualSpacer.style.width).toBe(virtualSpacer.style.minWidth);
    expect(virtualSpacer.style.width).toBe(virtualSpacer.style.maxWidth);
    expect(container.querySelectorAll("tr.datagrid-row").length).toBeLessThan(100);
    expect(container.querySelectorAll("th.datagrid-th").length).toBeLessThan(40);
  });

  it("keeps a 100k result bounded in the DOM", async () => {
    const { container } = render(
      <DataGrid connectionId="fixture" queryResult={createResult(100_000, 2)} />,
    );

    await waitFor(() => {
      expect(container.querySelectorAll("tr.datagrid-row").length).toBeGreaterThan(0);
    });
    expect(container.querySelectorAll("tr.datagrid-row").length).toBeLessThan(100);
  });

});
