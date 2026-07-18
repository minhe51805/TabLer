import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DataGridToolbar } from "../../src/components/DataGrid/DataGridToolbar";

vi.mock("../../src/stores/pluginStore", () => ({
  usePluginStore: (selector: (state: unknown) => unknown) => selector({
    plugins: [],
    hasLoaded: true,
    loadPlugins: vi.fn(),
  }),
}));

const noop = vi.fn();

describe("DataGridToolbar capability enforcement", () => {
  it("does not expose unsupported import and disables unsupported export", () => {
    render(<DataGridToolbar
      tableName="public.users"
      columnCount={1}
      visibleRowCount={1}
      sortColumn={null}
      sortDir="ASC"
      selectedRowCount={0}
      isDeletingRows={false}
      handleDeleteSelectedRows={noop}
      handleInsertRow={noop}
      handleCopyAsInsert={noop}
      handleCopyAsUpdate={noop}
      handleCopyAsInsertParam={noop}
      handleCopyAsUpdateParam={noop}
      handleCopyAsDeleteParam={noop}
      isTableEditable
      structureStatus="ready"
      resolvedColumns={[{
        name: "id",
        data_type: "integer",
        is_nullable: false,
        is_primary_key: true,
      }]}
      dataRows={[[1]]}
      canImportCsv={false}
      canExportData={false}
    />);

    expect(screen.queryByRole("button", { name: /import csv/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /paste rows/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /export/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /insert row/i })).toBeEnabled();
  });
});
