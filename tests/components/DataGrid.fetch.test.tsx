import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor, fireEvent } from "@testing-library/react";
import { DataGrid } from "@/components/DataGrid/DataGrid";

/**
 * Characterization test for the table (fetch/pagination) path of DataGrid.
 * Mocks the Tauri invoke bridge so fetchData / countRows run for real through
 * the query store while the backend is stubbed.
 */

const PAGE_SIZE = 100;

type InvokePayload = Record<string, unknown>;

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

function makePage(offset: number, rowCount: number): Record<string, unknown> {
  return {
    columns: [
      { name: "id", data_type: "INT", is_nullable: false, is_primary_key: true },
      { name: "name", data_type: "TEXT", is_nullable: true, is_primary_key: false },
    ],
    rows: Array.from({ length: rowCount }, (_, i) => [offset + i, `row-${offset + i}`]),
    affected_rows: 0,
    execution_time_ms: 1,
    query: "SELECT fixture",
    sandboxed: false,
    truncated: false,
  };
}

beforeAll(() => {
  // Mirror the ResizeObserver/rect mocks from DataGrid.virtualization.test.tsx:
  // the row virtualizer needs real measurements to compute visible rows.
  class TestResizeObserver {
    constructor(private readonly callback: (entries: ResizeObserverEntry[]) => void) {}
    observe(target: Element) {
      this.callback([{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry]);
    }
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ width: 960, height: 480, top: 0, left: 0, right: 960, bottom: 480, x: 0, y: 0, toJSON: () => ({}) }),
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 960 });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 480 });
});

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string, payload?: InvokePayload) => {
    if (command === "get_table_data") {
      const offset = Number(payload?.offset ?? 0);
      // Two pages of data then stop.
      if (offset >= 200) return makePage(offset, 0);
      return makePage(offset, PAGE_SIZE);
    }
    if (command === "count_table_rows") return { count: 250 };
    if (command === "get_table_structure") {
      return {
        columns: [
          { name: "id", data_type: "INT", is_nullable: false, is_primary_key: true },
          { name: "name", data_type: "TEXT", is_nullable: true, is_primary_key: false },
        ],
        indexes: [],
        foreign_keys: [],
      };
    }
    // Plugin / settings commands touched while the workspace mounts.
    if (command === "list_installed_plugins") return [];
    if (command === "get_plugin_registry") return { schemaVersion: 1, packages: [] };
    if (command === "check_plugin_updates") return [];
    return null;
  });
});

describe("DataGrid table fetch path", () => {
  it("loads page 0 via get_table_data and renders rows with total pill", async () => {
    const { container, getByTestId } = render(
      <DataGrid connectionId="conn-1" tableName="public.users" database="appdb" isActive />,
    );

    await waitFor(() => {
      expect(getByTestId("data-grid")).toBeTruthy();
      expect(container.querySelectorAll("tr.datagrid-row").length).toBeGreaterThan(0);
    });

    const firstCall = invokeMock.mock.calls.find(([cmd]) => cmd === "get_table_data") as
      | [string, InvokePayload]
      | undefined;
    expect(firstCall).toBeTruthy();
    expect(firstCall![1].table).toContain("users");
    expect(Number(firstCall![1].limit)).toBe(PAGE_SIZE);
  });

  it("reports a friendly empty state when the table has no rows", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_table_data") return makePage(0, 0);
      if (command === "count_table_rows") return { count: 0 };
      if (command === "get_table_structure") return { columns: [], indexes: [], foreign_keys: [] };
      return null;
    });

    const { container, getByTestId } = render(
      <DataGrid connectionId="conn-1" tableName="public.empty" database="appdb" isActive />,
    );

    await waitFor(() => {
      expect(getByTestId("data-grid")).toBeTruthy();
      expect(container.textContent).not.toContain("row-0");
    });
  });

  it("surfaces backend failures as an error message instead of crashing", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_table_data") throw new Error("boom");
      if (command === "count_table_rows") throw new Error("boom");
      if (command === "get_table_structure") throw new Error("boom");
      return null;
    });

    const { container, getByTestId } = render(
      <DataGrid connectionId="conn-1" tableName="public.broken" database="appdb" isActive />,
    );

    await waitFor(() => {
      expect(getByTestId("data-grid")).toBeTruthy();
      // Backend failed: grid must stay mounted with an empty body rather than crash.
      expect(container.querySelectorAll("tr.datagrid-row").length).toBe(0);
    });
  });

  it("filters loaded rows locally as the user types in the filter box", async () => {
    const { container, getByRole } = render(
      <DataGrid connectionId="conn-1" tableName="public.users" database="appdb" isActive />
    );
    await waitFor(() => {
      expect(container.querySelectorAll("tr.datagrid-row").length).toBeGreaterThan(0);
    });

    const input = getByRole("textbox", { name: "Filter loaded rows" });
    fireEvent.change(input, { target: { value: "row-11" } });

    // Filtering happens locally over the already-loaded chunks.
    await waitFor(() => {
      const rows = container.querySelectorAll("tr.datagrid-row");
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.length).toBeLessThan(100);
      expect(container.textContent).toContain("row-11");
      expect(container.textContent).not.toContain("row-15");
    });
  });
});
