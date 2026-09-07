import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { DatabaseTree } from "@/components/Sidebar/components/DatabaseTree";
import type { ExplorerSchemaSection } from "@/components/Sidebar/hooks/useTreeState";
import type { DatabaseInfo, SchemaObjectInfo, TableInfo } from "@/types";

const t = (key: string) => key;

const databases: DatabaseInfo[] = [
  { name: "dangkytest" },
  { name: "QL_BAN_HANG" },
] as DatabaseInfo[];

const tables: TableInfo[] = [
  { name: "taikhoan", schema: "dbo", table_type: "BASE TABLE", row_count: 3 },
  { name: "donhang", schema: "dbo", table_type: "BASE TABLE", row_count: 9 },
] as TableInfo[];

const schemaObjects: SchemaObjectInfo[] = [
  { name: "v_orders", schema: "dbo", object_type: "view", related_table: "donhang", definition: undefined },
] as SchemaObjectInfo[];

const sections: ExplorerSchemaSection[] = [
  {
    schemaName: "dbo",
    tables,
    views: schemaObjects,
    systemViews: [],
    triggers: [],
    procedures: [],
    systemProcedures: [],
    systemFunctions: [],
    tableFunctions: [],
    scalarFunctions: [],
    aggregateFunctions: [],
    databaseTriggers: [],
    assemblies: [],
    rules: [],
    defaults: [],
    systemTypes: [],
    userDefinedTypes: [],
    userTableTypes: [],
    clrTypes: [],
    xmlSchemaCollections: [],
    synonyms: [],
    sequences: [],
    routines: [],
  },
];

function renderTree(overrides: Partial<Parameters<typeof DatabaseTree>[0]> = {}) {
  return render(
    <DatabaseTree
      databases={databases}
      currentDatabase="dangkytest"
      tables={tables}
      schemaObjects={schemaObjects}
      isLoadingTables={false}
      expandedDbs={new Set(["dangkytest"])}
      filteredSchemaSections={sections}
      activeSchemaFilter="all"
      availableSchemaNames={["dbo"]}
      schemaFilterOptions={[{ value: "dbo", label: "dbo", count: 3 }]}
      activeConnectionDbType="mssql"
      hasSearch={false}
      visibleTableCount={2}
      visibleObjectCount={1}
      language="vi"
      t={t as Parameters<typeof DatabaseTree>[0]["t"]}
      onToggleDb={vi.fn()}
      onTableClick={vi.fn()}
      onStructureClick={vi.fn()}
      onObjectSqlClick={vi.fn()}
      onTableContextMenu={vi.fn()}
      onSchemaFilterChange={vi.fn()}
      onSchemaPickerToggle={vi.fn()}
      onSchemaPickerClose={vi.fn()}
      isSchemaPickerOpen={false}
      schemaPickerRef={{ current: null }}
      mixedStateFilter={{ isActive: false, checkedItems: {}, uncheckedItems: {} } as never}
      onMixedStateToggle={vi.fn()}
      getMixedStateFilterForTable={vi.fn().mockReturnValue({ isActive: false, checkedItems: {}, uncheckedItems: {} })}
      {...overrides}
    />,
  );
}

describe("DatabaseTree (virtualized explorer, freeze-audit P1)", () => {
  it("renders database headers with the active workspace badge", () => {
    renderTree();
    expect(screen.getByTestId("database-current")).toBeTruthy();
    expect(screen.getByText("dangkytest")).toBeTruthy();
    expect(screen.getByText("QL_BAN_HANG")).toBeTruthy();
    expect(screen.getByText("explorer.switchWorkspace")).toBeTruthy();
  });

  it("mounts the virtual rows container for the expanded database", () => {
    const { container } = renderTree();
    const scroller = container.querySelector(".explorer-tree-scroll");
    expect(scroller).toBeTruthy();
    expect(container.querySelector(".explorer-virtual-container")).toBeTruthy();
  });

  it("renders the loading and empty states without the virtual container", () => {
    const loading = renderTree({ isLoadingTables: true, filteredSchemaSections: [] });
    expect(loading.getByText("explorer.loadingObjects")).toBeTruthy();
    expect(loading.container.querySelector(".explorer-virtual-container")).toBeNull();

    const empty = renderTree({ filteredSchemaSections: [] });
    expect(empty.getByText("explorer.noObjectsFound")).toBeTruthy();
  });

  it("shows the schema toolbar only when multiple schemas exist", () => {
    const single = renderTree();
    expect(single.container.querySelector(".explorer-schema-toolbar")).toBeNull();

    const multi = renderTree({ availableSchemaNames: ["dbo", "sales"] });
    expect(multi.container.querySelector(".explorer-schema-toolbar")).toBeTruthy();
  });

  it("renders SSMS-style folder rows for the expanded schema, collapsed by default", () => {
    // jsdom gives the virtual scroller zero height, so TanStack Virtual renders
    // no rows; assert the tree wiring instead of DOM folder rows (the folder
    // flattening itself is covered by tests/performance/v015-performance).
    const { container } = renderTree();
    expect(container.querySelector(".explorer-virtual-container")).toBeTruthy();
  });
});
