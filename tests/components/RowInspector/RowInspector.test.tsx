import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RowInspector } from "@/components/RowInspector/RowInspector";
import { buildRowInspectorPrimaryKeyValues } from "@/components/DataGrid/row-inspector-utils";
import type { ResolvedColumn } from "@/components/DataGrid/hooks/useDataGrid";

const columns: ResolvedColumn[] = [
  { name: "id", data_type: "INT", is_nullable: false, is_primary_key: true },
  { name: "email", data_type: "TEXT", is_nullable: false, is_primary_key: false },
  { name: "secret", data_type: "TEXT", is_nullable: true, is_primary_key: false },
];

afterEach(() => cleanup());

describe("RowInspector masked primary keys", () => {
  it("builds displayed primary keys from the masked row, including composite keys", () => {
    const compositeColumns: ResolvedColumn[] = [
      { ...columns[0], name: "tenant_id" },
      { ...columns[0], name: "user_id" },
      columns[1],
    ];
    const primaryKeys = compositeColumns.filter((column) => column.is_primary_key);
    const values = buildRowInspectorPrimaryKeyValues(
      ["***", 7, "alice@example.com"],
      compositeColumns,
      primaryKeys,
    );
    expect(values).toEqual({ tenant_id: "***", user_id: 7 });
    expect(JSON.stringify(values)).not.toContain("tenant-secret");
  });

  it("does not render the raw primary key in the footer", () => {
    const primaryKeyValues = buildRowInspectorPrimaryKeyValues(
      ["***", "alice@example.com", "classified"],
      columns,
      [columns[0]],
    );
    render(
      <RowInspector
        isOpen
        data={{
          rowIndex: 1,
          row: ["***", "alice@example.com", "classified"],
          columns,
          primaryKeyValues,
          tableName: "users",
        }}
        onClose={vi.fn()}
        onEditCell={vi.fn()}
      />,
    );
    const footer = document.querySelector(".ri-panel-footer");
    expect(footer).toHaveTextContent("id = ***");
    expect(footer).not.toHaveTextContent("id = 7");
  });
});
