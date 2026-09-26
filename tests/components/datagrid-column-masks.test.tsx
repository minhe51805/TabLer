import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useDataGridColumnMasks } from "@/components/DataGrid/hooks/useDataGridColumnMasks";
import type { GridCellValue, ResolvedColumn } from "@/components/DataGrid/hooks/useDataGrid";
import { columnMaskScopeKey, useColumnMaskStore } from "@/stores/columnMaskStore";

const CONNECTION = "conn-1";
const DATABASE = "app";
const TABLE = "users";
const SCOPE = columnMaskScopeKey(CONNECTION, DATABASE, TABLE);

const COLUMNS: ResolvedColumn[] = [
  { name: "id", data_type: "INT", is_nullable: false, is_primary_key: true },
  { name: "email", data_type: "TEXT", is_nullable: true, is_primary_key: false },
  { name: "name", data_type: "TEXT", is_nullable: true, is_primary_key: false },
];

const ROWS: GridCellValue[][] = [
  [1, "a@corp.example", "alice"],
  [2, "b@corp.example", "bob"],
];

const OTHER_ROWS: GridCellValue[][] = [[3, "c@corp.example", "carol"]];

function renderMasks(displayedRows: GridCellValue[][] = ROWS) {
  return renderHook(
    (props: { rows: GridCellValue[][] }) =>
      useDataGridColumnMasks(CONNECTION, DATABASE, TABLE, COLUMNS, props.rows),
    { initialProps: { rows: displayedRows } },
  );
}

beforeEach(() => {
  localStorage.clear();
  useColumnMaskStore.setState({ masks: {}, salts: {}, revealed: {} });
});

describe("useDataGridColumnMasks — masked matrix", () => {
  it("exposes a masked copy of the displayed rows once the async matrix lands", async () => {
    useColumnMaskStore.getState().setColumnMask(SCOPE, "email", "redact");
    const { result } = renderMasks();

    // Cells render raw until the masked matrix resolves.
    expect(result.current.hasActiveMasks).toBe(true);
    expect(result.current.maskedRows).toBeNull();

    await act(async () => {});
    expect(result.current.maskedRows).toEqual([
      [1, "***", "alice"],
      [2, "***", "bob"],
    ]);
    expect(result.current.activeMaskedNames).toEqual(new Set(["email"]));
  });

  it("never exposes a matrix computed for a previous row set", async () => {
    useColumnMaskStore.getState().setColumnMask(SCOPE, "email", "redact");
    const { result, rerender } = renderMasks();
    await act(async () => {});
    expect(result.current.maskedRows?.[0][0]).toBe(1);

    // A new row array identity arrives (filter/sort changed the window): the
    // stale masked rows for the OLD set must not be shown.
    rerender({ rows: OTHER_ROWS });
    expect(result.current.maskedRows).toBeNull();

    await act(async () => {});
    expect(result.current.maskedRows).toEqual([[3, "***", "carol"]]);
  });

  it("a restored mask without a salt lazily creates one (ensureSalt path)", async () => {
    // Simulate a partial persisted write: mask rule exists, salt missing.
    useColumnMaskStore.setState({
      masks: { [SCOPE]: { email: "hash" } },
      salts: {},
      revealed: {},
    });
    const { result } = renderMasks();
    await act(async () => {});

    // Salt creation re-triggers the effect; the SHA-256 digest needs one
    // more async hop than a single act() flush on slower runners.
    const salt = useColumnMaskStore.getState().salts[SCOPE];
    expect(salt).toBeTruthy();
    await waitFor(() => {
      expect(result.current.maskedRows?.[0][1]).toMatch(/^hashed_[0-9a-f]+$/);
    });
  });

  it("maskRows masks only strategy columns and never mutates its input", async () => {
    useColumnMaskStore.getState().setColumnMask(SCOPE, "email", "redact");
    const { result } = renderMasks();
    await act(async () => {});

    const input: GridCellValue[][] = [[9, "x@corp.example", "zed"]];
    const masked = await result.current.maskRows(input);
    expect(masked).toEqual([[9, "***", "zed"]]);
    expect(input[0][1]).toBe("x@corp.example"); // caller's matrix untouched
  });

  it("maskValue returns the raw value for unmasked or revealed columns", async () => {
    useColumnMaskStore.getState().setColumnMask(SCOPE, "email", "hash");
    const { result } = renderMasks();
    await act(async () => {});

    // Unmasked column passes through.
    expect(await result.current.maskValue("name", "alice")).toBe("alice");
    // Masked column returns the anonymized form (deterministic, non-raw).
    const masked = await result.current.maskValue("email", "a@corp.example");
    expect(masked).toMatch(/^hashed_/);
    expect(masked).not.toContain("corp.example");

    // Reveal flips it back to raw.
    act(() => {
      result.current.toggleRevealed("email");
    });
    expect(await result.current.maskValue("email", "a@corp.example")).toBe("a@corp.example");
    expect(result.current.hasActiveMasks).toBe(false);
    expect(result.current.activeMaskedNames.size).toBe(0);
  });
});
