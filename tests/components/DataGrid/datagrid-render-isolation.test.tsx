import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { AppKeyboardHandler } from "@/components/AppKeyboardHandler";
import { DataGrid } from "@/components/DataGrid/DataGrid";
import { DataGridToolbar } from "@/components/DataGrid/DataGridToolbar";
import { createDataGridStore } from "@/components/DataGrid/store/dataGridStore";
import { createEmptyGridSelection } from "@/components/DataGrid/grid-selection";
import { invalidateConnectionCapabilities } from "@/hooks/useConnectionCapabilities";
import { changeScopeKey, useChangeTrackingStore } from "@/stores/change-tracking-store";
import { useConnectionStore } from "@/stores/connectionStore";
import type { ConnectionConfig, DriverCapabilityProfile } from "@/types";

type InvokePayload = Record<string, unknown>;

const invokeMock = vi.hoisted(() => vi.fn());

const renderCounters = vi.hoisted(() => ({
  toolbar: 0,
  cells: new Map<string, number>(),
  reset() {
    this.toolbar = 0;
    this.cells.clear();
  },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@/stores/pluginStore", () => ({
  usePluginStore: (selector: (state: unknown) => unknown) =>
    selector({
      plugins: [],
      hasLoaded: true,
      loadPlugins: vi.fn(),
    }),
}));

vi.mock("@/components/DataGrid/DataGridToolbar", async (importOriginal) => {
  const React = await import("react");
  const actual = await importOriginal<typeof import("@/components/DataGrid/DataGridToolbar")>();
  const InnerToolbar = (
    actual.DataGridToolbar as unknown as { type: (props: unknown) => React.ReactNode }
  ).type;
  const CountingToolbar = React.memo(function CountingToolbar(props: Record<string, unknown>) {
    renderCounters.toolbar += 1;
    return InnerToolbar(props);
  });
  return {
    ...actual,
    DataGridToolbar: CountingToolbar,
  };
});

vi.mock("@/components/DataGrid/components/DataGridCell", async (importOriginal) => {
  const React = await import("react");
  const actual =
    await importOriginal<typeof import("@/components/DataGrid/components/DataGridCell")>();
  const InnerBodyCell = (
    actual.DataGridBodyCell as unknown as { type: (props: unknown) => React.ReactNode }
  ).type;
  const CountingBodyCell = React.memo(function CountingBodyCell(props: {
    rowIndex: number;
    colIndex: number;
  }) {
    const key = `${props.rowIndex}:${props.colIndex}`;
    renderCounters.cells.set(key, (renderCounters.cells.get(key) ?? 0) + 1);
    return InnerBodyCell(props);
  });
  return {
    ...actual,
    DataGridBodyCell: CountingBodyCell,
  };
});

const SUPPORTED_CAPABILITIES: DriverCapabilityProfile = {
  key: "sqlite",
  label: "SQLite",
  tier: "core",
  queryModel: "sql",
  distribution: "builtin",
  capabilities: {
    connect: "supported",
    query: "supported",
    preparedParameters: "supported",
    queryCancellation: "supported",
    pagination: "supported",
    inlineEdit: "supported",
    atomicEditQueue: "supported",
    atomicCsvImport: "supported",
    dataExport: "supported",
    explain: "supported",
    schemaEdit: "supported",
    backupRestore: "supported",
    administration: "supported",
  },
  limitations: [],
};

const FIXTURE_COLUMNS = [
  { name: "id", data_type: "INT", is_nullable: false, is_primary_key: true },
  { name: "name", data_type: "TEXT", is_nullable: true, is_primary_key: false },
  { name: "code", data_type: "TEXT", is_nullable: true, is_primary_key: false },
  { name: "score", data_type: "INT", is_nullable: true, is_primary_key: false },
];

function makeTableData(table: string) {
  const prefix = table.includes("orders") ? "ord" : "usr";
  return {
    columns: FIXTURE_COLUMNS,
    rows: [
      [1, `${prefix}-alpha`, "A1", 10],
      [2, `${prefix}-beta`, "B2", 20],
      [3, `${prefix}-gamma`, "C3", 30],
      [4, `${prefix}-delta`, "D4", 40],
      [5, `${prefix}-epsilon`, "E5", 50],
    ],
    affected_rows: 0,
    execution_time_ms: 1,
    query: `SELECT * FROM ${table}`,
    sandboxed: false,
    truncated: false,
  };
}

const noop = vi.fn();

const TOOLBAR_BASE_PROPS = {
  selectedRowCount: 0,
  isDeletingRows: false,
  handleDeleteSelectedRows: noop,
  handleInsertRow: noop,
  handleCopyAsInsert: noop,
  handleCopyAsUpdate: noop,
  handleCopyAsInsertParam: noop,
  handleCopyAsUpdateParam: noop,
  handleCopyAsDeleteParam: noop,
  isTableEditable: true,
  structureStatus: "ready" as const,
};

function getGridCell(container: HTMLElement, rowIndex: number, colName: string): HTMLElement {
  const row = container.querySelector(`tr.datagrid-row[data-index="${rowIndex}"]`);
  if (!row) throw new Error(`Missing row data-index=${rowIndex}`);
  const cell = row.querySelector(`td[data-col-id="${colName}"] .datagrid-cell`);
  if (!(cell instanceof HTMLElement)) {
    throw new Error(`Missing cell row=${rowIndex} col=${colName}`);
  }
  return cell;
}

describe("DataGrid render isolation & regression suite", () => {
  const initialConnections = useConnectionStore.getState().connections;

  beforeAll(() => {
    class TestResizeObserver {
      constructor(private readonly callback: (entries: ResizeObserverEntry[]) => void) {}
      observe(target: Element) {
        this.callback([
          { target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry,
        ]);
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

  beforeEach(() => {
    renderCounters.reset();
    invalidateConnectionCapabilities();
    useConnectionStore.setState({
      connections: [
        {
          id: "conn-1",
          name: "Local SQLite",
          db_type: "sqlite",
          host: "",
          port: 0,
          database: "appdb",
          username: "",
        } as ConnectionConfig,
      ],
    });
    useChangeTrackingStore.setState({
      stagedChanges: [],
      history: {},
      future: {},
      isPreviewOpen: false,
      previewScopeKey: null,
      selectedChangeId: null,
      _columnNameMap: {},
      _dbTypeMap: {},
    });

    invokeMock.mockReset();
    invokeMock.mockImplementation(async (command: string, payload?: InvokePayload) => {
      if (command === "get_connection_capabilities") return SUPPORTED_CAPABILITIES;
      if (command === "get_table_data") return makeTableData(String(payload?.table ?? "users"));
      if (command === "count_table_rows") return { count: 5 };
      if (command === "get_table_structure") {
        return {
          columns: FIXTURE_COLUMNS,
          indexes: [],
          foreign_keys: [],
        };
      }
      if (command === "list_installed_plugins") return [];
      if (command === "get_plugin_registry") return { schemaVersion: 1, packages: [] };
      if (command === "check_plugin_updates") return [];
      return null;
    });
  });

  afterEach(() => {
    useConnectionStore.setState({ connections: initialConnections });
  });

  it("isolates cell selection and arrow navigation from DataGridToolbar and unaffected cells", async () => {
    const { container } = render(
      <DataGrid connectionId="conn-1" tableName="users" database="appdb" isActive />,
    );

    await waitFor(() => {
      expect(container.querySelectorAll(".datagrid-cell.editable").length).toBeGreaterThan(0);
    });

    renderCounters.reset();

    const cell00 = getGridCell(container, 0, "id");
    fireEvent.click(cell00);

    await waitFor(() => {
      expect(getGridCell(container, 0, "id").classList.contains("selected")).toBe(true);
    });
    expect(renderCounters.toolbar).toBe(0);
    expect(renderCounters.cells.get("0:0")).toBe(1);
    expect(renderCounters.cells.get("2:2") ?? 0).toBe(0);
    expect(renderCounters.cells.get("3:3") ?? 0).toBe(0);
    expect(renderCounters.cells.get("4:1") ?? 0).toBe(0);

    renderCounters.reset();

    const wrap = container.querySelector(".datagrid-table-wrap") as HTMLElement;
    fireEvent.keyDown(wrap, { key: "ArrowRight", bubbles: true, cancelable: true });

    await waitFor(() => {
      expect(getGridCell(container, 0, "name").classList.contains("selected")).toBe(true);
      expect(getGridCell(container, 0, "id").classList.contains("selected")).toBe(false);
    });
    expect(renderCounters.toolbar).toBe(0);
    expect(renderCounters.cells.get("0:0")).toBe(1);
    expect(renderCounters.cells.get("0:1")).toBe(1);
    expect(renderCounters.cells.get("2:2") ?? 0).toBe(0);
    expect(renderCounters.cells.get("3:3") ?? 0).toBe(0);
    expect(renderCounters.cells.get("4:2") ?? 0).toBe(0);
  });

  it("keeps two mounted DataGrid instances isolated and mounts one scoped ChangeTrackingPreviewModal", async () => {
    render(
      <div>
        <div data-testid="grid-users">
          <DataGrid connectionId="conn-1" tableName="users" database="appdb" isActive />
        </div>
        <div data-testid="grid-orders">
          <DataGrid connectionId="conn-1" tableName="orders" database="appdb" isActive />
        </div>
      </div>,
    );

    const gridUsers = screen.getByTestId("grid-users");
    const gridOrders = screen.getByTestId("grid-orders");

    await waitFor(() => {
      expect(within(gridUsers).getByText("usr-alpha")).toBeInTheDocument();
      expect(within(gridOrders).getByText("ord-alpha")).toBeInTheDocument();
    });

    fireEvent.click(getGridCell(gridUsers, 0, "name"));

    await waitFor(() => {
      expect(getGridCell(gridUsers, 0, "name").classList.contains("selected")).toBe(true);
    });
    expect(gridOrders.querySelectorAll(".datagrid-cell.selected").length).toBe(0);

    const store = useChangeTrackingStore.getState();
    act(() => {
      store.stageChange({
        connectionId: "conn-1",
        database: "appdb",
        tableName: "users",
        type: "update",
        rowIndex: 0,
        rowKey: { id: 1 },
        columns: {
          name: { old: "usr-alpha", new: "edited-user" },
        },
      });
      store.stageChange({
        connectionId: "conn-1",
        database: "appdb",
        tableName: "orders",
        type: "update",
        rowIndex: 0,
        rowKey: { id: 1 },
        columns: {
          name: { old: "ord-alpha", new: "edited-order" },
        },
      });
      store.openPreview(changeScopeKey("conn-1", "appdb", "users"));
    });

    const dialogs = await screen.findAllByRole("dialog");
    expect(dialogs).toHaveLength(1);
    expect(
      within(dialogs[0]).getAllByText(/UPDATE users SET name = 'edited-user'/).length,
    ).toBeGreaterThan(0);
    expect(
      within(dialogs[0]).queryByText(/UPDATE orders SET name = 'edited-order'/),
    ).not.toBeInTheDocument();
  });

  it("closes previously opened DataGridToolbar menu when another menu opens (DG-1)", () => {
    render(
      <DataGridToolbar
        {...TOOLBAR_BASE_PROPS}
        tableName="users"
        canImportCsv
        canExportData
        resolvedColumns={FIXTURE_COLUMNS}
        dataRows={[[1, "alpha", "A1", 10]]}
        onToggleRowInspector={noop}
        rowInspectorOpen={false}
      />,
    );

    const rowsBtn = screen.getByRole("button", { name: "Rows" });
    const exportBtn = screen.getByRole("button", { name: "Export" });
    const toolsBtn = screen.getByRole("button", { name: "Tools" });
    const settingsBtn = screen.getByTitle("Data grid settings");

    fireEvent.click(rowsBtn);
    expect(rowsBtn).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(exportBtn);
    expect(rowsBtn).toHaveAttribute("aria-expanded", "false");
    expect(exportBtn).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(toolsBtn);
    expect(exportBtn).toHaveAttribute("aria-expanded", "false");
    expect(toolsBtn).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(settingsBtn);
    expect(toolsBtn).toHaveAttribute("aria-expanded", "false");
    expect(settingsBtn).toHaveAttribute("aria-expanded", "true");
  });

  it("shows disabled Undo and clickable Redo when only redoableChanges > 0 (DG-2)", () => {
    const onUndo = vi.fn();
    const onRedo = vi.fn();
    render(
      <DataGridToolbar
        {...TOOLBAR_BASE_PROPS}
        tableName="users"
        undoableChanges={0}
        redoableChanges={1}
        onUndo={onUndo}
        onRedo={onRedo}
      />,
    );

    const undoBtn = screen.getByRole("button", { name: "Undo" });
    const redoBtn = screen.getByRole("button", { name: "Redo" });

    expect(undoBtn).toBeDisabled();
    expect(redoBtn).toBeEnabled();

    fireEvent.click(redoBtn);
    expect(onRedo).toHaveBeenCalledTimes(1);
    expect(onUndo).not.toHaveBeenCalled();
  });

  it("fills down a multi-cell range on Ctrl+D instead of opening Duplicate Row, and falls back to Duplicate Row for single-cell selection (DG-3)", async () => {
    const { container } = render(
      <div>
        <AppKeyboardHandler
          activeTab={{
            id: "tab-1",
            type: "table",
            title: "dg3_items",
            connectionId: "conn-1",
            tableName: "dg3_items",
          }}
          onNewQuery={noop}
          onRunActiveQuery={noop}
          onToggleTerminalPanel={noop}
          onToggleSidebar={noop}
          onToggleQueryHistory={noop}
          onToggleSQLFavorites={noop}
          onToggleVimMode={noop}
          onOpenCommandPalette={noop}
          onOpenQuickSwitcher={noop}
          onOpenGlobalSearch={noop}
          setUiFontScale={noop}
          setShowAISlidePanel={noop}
        />
        <DataGrid connectionId="conn-1" tableName="dg3_items" database="appdb" isActive />
      </div>,
    );

    await waitFor(
      () => {
        expect(invokeMock).toHaveBeenCalledWith(
          "get_table_structure",
          expect.objectContaining({ table: "dg3_items" }),
        );
        expect(container.querySelectorAll(".datagrid-cell.editable").length).toBeGreaterThan(0);
      },
      { timeout: 2500 },
    );

    // Select row 0 so handleDuplicateRow has an active target if fill-down does not intercept Ctrl+D.
    const row0Btn = container.querySelector(
      'tr.datagrid-row[data-index="0"] button.datagrid-index-selectable',
    ) as HTMLElement;
    expect(row0Btn).toBeTruthy();
    fireEvent.click(row0Btn);

    const cell01 = getGridCell(container, 0, "name");
    const cell11 = getGridCell(container, 1, "name");
    fireEvent.click(cell01);
    fireEvent.click(cell11, { shiftKey: true });

    await waitFor(() => {
      expect(getGridCell(container, 0, "name").classList.contains("selected")).toBe(true);
      expect(getGridCell(container, 1, "name").classList.contains("selected")).toBe(true);
    });

    const wrap = container.querySelector(".datagrid-table-wrap") as HTMLElement;
    fireEvent.keyDown(wrap, { key: "d", ctrlKey: true, bubbles: true, cancelable: true });

    await waitFor(() => {
      expect(useChangeTrackingStore.getState().stagedChanges).toHaveLength(1);
    });
    const staged = useChangeTrackingStore.getState().stagedChanges[0];
    expect(staged.columns.name).toEqual({
      old: "usr-beta",
      new: "usr-alpha",
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    // Clear staged edit and reduce selection to a single live cell -> Ctrl+D opens Duplicate Row dialog.
    act(() => {
      useChangeTrackingStore.setState({ stagedChanges: [], history: {}, future: {} });
    });
    fireEvent.click(getGridCell(container, 0, "code"));
    await waitFor(() => {
      expect(container.querySelectorAll(".datagrid-cell.selected").length).toBe(1);
    });

    fireEvent.keyDown(wrap, { key: "d", ctrlKey: true, bubbles: true, cancelable: true });

    const duplicateDialog = await screen.findByRole("dialog");
    expect(duplicateDialog).toBeInTheDocument();
  });

  it("maintains per-instance dataGridStore invariants and syncRowSelection bailouts", () => {
    const store = createDataGridStore();
    const initial = store.getState();
    expect(initial.gridSelection).toEqual(createEmptyGridSelection());
    expect(initial.editingCell).toBeNull();
    expect(initial.selectedRows.size).toBe(0);
    expect(initial.allVisibleRowsSelected).toBe(false);

    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });

    const rowSet = new Set([0, 2]);
    store.getState().syncRowSelection(rowSet, false);
    expect(notifications).toBe(1);

    // Identical Set contents should bail out cleanly with zero subscriber notifications.
    store.getState().syncRowSelection(new Set([0, 2]), false);
    expect(notifications).toBe(1);

    store.getState().setGridSelection((prev) => ({
      ...prev,
      activeCell: { row: 1, col: 1 },
    }));
    expect(notifications).toBe(2);
    expect(store.getState().gridSelection.activeCell).toEqual({ row: 1, col: 1 });
    unsubscribe();
  });
});
