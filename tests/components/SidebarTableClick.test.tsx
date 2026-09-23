import { describe, expect, it, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { useSidebar } from "../../src/components/Sidebar/hooks/use-sidebar";
import { useConnectionStore } from "../../src/stores/connectionStore";
import { useUIStore } from "../../src/stores/uiStore";

// Regression: the multi-select refactor once dropped `tableName` from the
// preview tab payload, so every sidebar table click mounted a DataGrid with
// tableName=undefined and showed the blank state instead of rows.
describe("sidebar table click -> preview tab", () => {
  beforeEach(() => {
    useUIStore.setState({ tabs: [], activeTabId: null });
    useConnectionStore.setState({
      activeConnectionId: "conn-1",
      currentDatabase: "appdb",
      connections: [],
      tables: [],
      schemaObjects: [],
      databases: [],
      connectedIds: new Set<string>(),
      isLoadingTables: false,
      isLoadingSchemaObjects: false,
    } as never);
  });

  it("opens a preview tab carrying the qualified table name", () => {
    const { result } = renderHook(() => useSidebar());

    act(() => {
      result.current.handleTableClick(undefined, { name: "orders", schema: "dbo" });
    });

    const tabs = useUIStore.getState().tabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({
      type: "table",
      title: "orders",
      connectionId: "conn-1",
      tableName: "dbo.orders",
      database: "appdb",
      isPreview: true,
    });
  });

  it("uses the bare table name when the table has no schema", () => {
    const { result } = renderHook(() => useSidebar());

    act(() => {
      result.current.handleTableClick(undefined, { name: "customers" });
    });

    expect(useUIStore.getState().tabs[0]?.tableName).toBe("customers");
  });
});
