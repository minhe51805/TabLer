import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { RowInspector } from "@/components/RowInspector/RowInspector";
import { buildRowInspectorPrimaryKeyValues } from "@/components/DataGrid/row-inspector-utils";
import type { ResolvedColumn } from "@/components/DataGrid/hooks/useDataGrid";

const copyToClipboardMock = vi.hoisted(() => vi.fn());
vi.mock("@/utils/sql-generator", () => ({ copyToClipboard: copyToClipboardMock }));

const columns: ResolvedColumn[] = [
  { name: "id", data_type: "INT", is_nullable: false, is_primary_key: true },
  { name: "email", data_type: "TEXT", is_nullable: false, is_primary_key: false },
  { name: "secret", data_type: "TEXT", is_nullable: true, is_primary_key: false },
];

beforeEach(() => copyToClipboardMock.mockReset());
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

describe("RowInspector filtered columns", () => {
  it("keeps values and copies aligned with the original column index", () => {
    render(
      <RowInspector
        isOpen
        data={{
          rowIndex: 1,
          row: [7, "alice@example.com", "classified"],
          columns,
          primaryKeyValues: {},
          tableName: "users",
        }}
        onClose={vi.fn()}
        onEditCell={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText("Search fields..."), {
      target: { value: "email" },
    });
    expect(screen.getByText("alice@example.com")).toBeInTheDocument();
    expect(screen.queryByText("7")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTitle("Copy value"));
    expect(copyToClipboardMock).toHaveBeenCalledWith("alice@example.com");
  });

  it("uses original indices instead of duplicate column names", () => {
    const duplicateColumns: ResolvedColumn[] = [
      { name: "value", data_type: "FIRST", is_nullable: true, is_primary_key: false },
      { name: "value", data_type: "SECOND", is_nullable: true, is_primary_key: false },
    ];
    render(
      <RowInspector
        isOpen
        data={{
          rowIndex: 1,
          row: ["first-value", "second-value"],
          columns: duplicateColumns,
          primaryKeyValues: {},
        }}
        onClose={vi.fn()}
        onEditCell={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText("Search fields..."), {
      target: { value: "second" },
    });
    expect(screen.getByText("second-value")).toBeInTheDocument();
    expect(screen.queryByText("first-value")).not.toBeInTheDocument();
  });
});
