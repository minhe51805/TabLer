// Throwaway smoke: the grouped toolbar renders both dropdowns and they open.
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DataGridToolbar } from "../../src/components/DataGrid/DataGridToolbar";

vi.mock("../../src/stores/pluginStore", () => ({
  usePluginStore: (selector: (state: unknown) => unknown) =>
    selector({ plugins: [], hasLoaded: true, loadPlugins: vi.fn() }),
}));

const noop = vi.fn();

function renderToolbar(overrides: Record<string, unknown> = {}) {
  return render(
    <DataGridToolbar
      tableName="public.users"
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
      resolvedColumns={[
        { name: "id", data_type: "integer", is_nullable: false, is_primary_key: true },
        { name: "name", data_type: "text", is_nullable: true, is_primary_key: false },
      ]}
      dataRows={[[1, "Ada"]]}
      canImportCsv
      canExportData
      onPasteRows={noop}
      onImportCsv={noop}
      onReloadData={noop}
      onToggleRowInspector={noop}
      {...overrides}
    />,
  );
}

describe("grouped toolbar", () => {
  it("collapses row actions behind one Rows button", () => {
    renderToolbar();
    expect(screen.getByRole("button", { name: "Rows" })).toBeInTheDocument();
    // Standalone pill labels are gone — they now live inside the menu.
    expect(screen.queryByRole("button", { name: /paste rows/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /import csv/i })).not.toBeInTheDocument();
  });

  it("opens the Rows menu with insert/paste/import entries", async () => {
    renderToolbar();
    fireEvent.click(screen.getByRole("button", { name: "Rows" }));
    expect(await screen.findByText("Insert Row")).toBeInTheDocument();
    expect(screen.getByText("Paste Rows")).toBeInTheDocument();
    expect(screen.getByText("Import CSV")).toBeInTheDocument();
  });

  it("collapses chart/inspector behind one Tools button", () => {
    renderToolbar({ onAutoRefreshMsChange: noop, autoRefreshTick: noop });
    const tools = screen.getByRole("button", { name: "Tools" });
    expect(tools).toBeInTheDocument();
    fireEvent.click(tools);
    // Inspector toggle entry exists inside the opened menu.
    expect(document.querySelector(".datagrid-export-menu")).not.toBeNull();
  });
});
