import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DataGridToolbar } from "../../src/components/DataGrid/DataGridToolbar";

vi.mock("../../src/stores/pluginStore", () => ({
  usePluginStore: (selector: (state: unknown) => unknown) =>
    selector({
      plugins: [],
      hasLoaded: true,
      loadPlugins: vi.fn(),
    }),
}));

const noop = vi.fn();

const baseProps = {
  selectedRowCount: 0,
  isDeletingRows: false,
  handleDeleteSelectedRows: noop,
  handleInsertRow: noop,
  handleCopyAsInsert: noop,
  handleCopyAsUpdate: noop,
  handleCopyAsInsertParam: noop,
  handleCopyAsUpdateParam: noop,
  handleCopyAsDeleteParam: noop,
  isTableEditable: false,
  structureStatus: "ready" as const,
};

const numericColumns = [
  { name: "city", data_type: "text", is_nullable: true, is_primary_key: false },
  { name: "total", data_type: "integer", is_nullable: true, is_primary_key: false },
];
const numericRows: (string | number | boolean | null)[][] = [
  ["Hanoi", 10],
  ["Hue", 20],
];
const textOnlyColumns = [
  { name: "city", data_type: "text", is_nullable: true, is_primary_key: false },
];

describe("DataGridToolbar chart button", () => {
  it("shows the Chart entry inside the Tools menu only when a numeric column exists", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <DataGridToolbar {...baseProps} resolvedColumns={textOnlyColumns} dataRows={[["Hanoi"]]} />,
    );
    // No numeric column and no inspector/refresh props -> no Tools button at all.
    expect(screen.queryByRole("button", { name: "Tools" })).not.toBeInTheDocument();

    rerender(
      <DataGridToolbar {...baseProps} resolvedColumns={numericColumns} dataRows={numericRows} />,
    );
    await user.click(screen.getByRole("button", { name: "Tools" }));
    expect(screen.getByText("Chart this result")).toBeInTheDocument();
  });

  it("opens the chart modal with type picker and axis controls", async () => {
    const user = userEvent.setup();
    render(
      <DataGridToolbar {...baseProps} resolvedColumns={numericColumns} dataRows={numericRows} />,
    );

    await user.click(screen.getByRole("button", { name: "Tools" }));
    await user.click(screen.getByText("Chart this result"));

    const dialog = screen.getByRole("dialog", { name: "Chart" });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText("Chart type")).toBeInTheDocument();
    expect(screen.getByText("X axis")).toBeInTheDocument();
    expect(screen.getByText("Y axis")).toBeInTheDocument();
    // X defaults to the first text column, Y to the numeric column.
    expect(screen.getByLabelText("X axis")).toHaveValue("city");
    expect(screen.getByRole("button", { name: "total" })).toHaveAttribute("aria-pressed", "true");
  });
});

describe("DataGridToolbar auto-refresh", () => {
  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
  });

  it("hides the control without auto-refresh props and ticks on the interval", async () => {
    vi.useFakeTimers();
    const { rerender } = render(
      <DataGridToolbar {...baseProps} resolvedColumns={numericColumns} dataRows={numericRows} />,
    );
    // Chart is still available for numeric columns — the auto-refresh picker
    // alone is what stays hidden until the props arrive.
    expect(screen.queryByText("Every 5 seconds")).not.toBeInTheDocument();

    const tick = vi.fn();
    const onChange = vi.fn();
    rerender(
      <DataGridToolbar
        {...baseProps}
        resolvedColumns={numericColumns}
        dataRows={numericRows}
        autoRefreshMs={5000}
        onAutoRefreshMsChange={onChange}
        autoRefreshTick={tick}
      />,
    );

    act(() => void vi.advanceTimersByTime(5000));
    expect(tick).toHaveBeenCalledTimes(1);
    act(() => void vi.advanceTimersByTime(5000));
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it("pauses the tick while the page is hidden", () => {
    vi.useFakeTimers();
    const tick = vi.fn();
    render(
      <DataGridToolbar
        {...baseProps}
        resolvedColumns={numericColumns}
        dataRows={numericRows}
        autoRefreshMs={5000}
        onAutoRefreshMsChange={noop}
        autoRefreshTick={tick}
      />,
    );

    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    act(() => void vi.advanceTimersByTime(10000));
    expect(tick).not.toHaveBeenCalled();

    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    act(() => void vi.advanceTimersByTime(5000));
    expect(tick).toHaveBeenCalledTimes(1);
  });
});
