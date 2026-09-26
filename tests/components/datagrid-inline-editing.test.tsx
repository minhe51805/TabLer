import { act, renderHook } from "@testing-library/react";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { useDataGridInlineEditing } from "@/components/DataGrid/hooks/useDataGridInlineEditing";
import type { ResolvedColumn } from "@/components/DataGrid/hooks/useDataGrid";
import type { QueryResult } from "@/types";

const COLUMNS: ResolvedColumn[] = [
  { name: "id", data_type: "INT", is_nullable: false, is_primary_key: true },
  { name: "name", data_type: "TEXT", is_nullable: true, is_primary_key: false },
  { name: "secret", data_type: "TEXT", is_nullable: true, is_primary_key: false },
];

const PK_COLUMNS = COLUMNS.filter((c) => c.is_primary_key);

function makeData(): QueryResult {
  return {
    columns: COLUMNS,
    rows: [
      [1, "alice", "s1"],
      [2, null, "s2"], // null cell — the untouched-blur contract target
      [null, "no-pk", "s3"], // incomplete PK — must refuse editing
    ],
    affected_rows: 0,
    execution_time_ms: 1,
    query: "SELECT fixture",
    sandboxed: false,
    truncated: false,
  } as QueryResult;
}

interface HarnessOptions {
  maskedColumnNames?: ReadonlySet<string>;
  canAttemptInlineEdit?: boolean;
  structureStatus?: "idle" | "loading" | "ready" | "failed";
}

function makeHarness(options: HarnessOptions = {}) {
  const spies = {
    setSelectedCell: vi.fn(),
    setError: vi.fn(),
    stageChange: vi.fn(),
    patchLoadedTableCell: vi.fn(),
    ensureStructureLoaded: vi.fn(async () => COLUMNS),
  };
  const hook = renderHook(() => {
    const [data, setData] = useState<QueryResult | null>(makeData());
    const [editingCell, setEditingCell] = useState<{ row: number; col: number } | null>(null);
    const [seed, setSeed] = useState("");
    const [stagedRows, setStagedRows] = useState<Set<number>>(new Set());
    const draftRef = useRef("");
    const touchedRef = useRef(false);
    const api = useDataGridInlineEditing({
      canAttemptInlineEdit: options.canAttemptInlineEdit ?? true,
      connectionId: "conn-1",
      data,
      tableName: "users",
      database: "app",
      resolvedColumns: COLUMNS,
      primaryKeyColumns: PK_COLUMNS,
      structureStatus: options.structureStatus ?? "ready",
      editingCell,
      setEditingCell,
      setEditingSeedValue: setSeed,
      setSavingCell: vi.fn(),
      setStagedRowIndices: setStagedRows,
      setData,
      setSelectedCell: spies.setSelectedCell,
      setError: spies.setError,
      stageChange: spies.stageChange,
      patchLoadedTableCell: spies.patchLoadedTableCell,
      ensureStructureLoaded: spies.ensureStructureLoaded,
      maskedColumnNames: options.maskedColumnNames,
      editingDraftRef: draftRef,
      editingTouchedRef: touchedRef,
    });
    return { api, data, editingCell, seed, stagedRows, draftRef, touchedRef };
  });
  return { hook, spies };
}

/** Drives the full open → type → commit flow the cell editor performs. */
async function typeAndCommit(
  hook: ReturnType<typeof makeHarness>["hook"],
  row: number,
  col: number,
  typed: string,
) {
  await act(async () => {
    await hook.result.current.api.startEditingCell(row, col);
  });
  // Simulate the editor's onChange then blur-commit.
  act(() => {
    hook.result.current.draftRef.current = typed;
    hook.result.current.touchedRef.current = true;
  });
  await act(async () => {
    await hook.result.current.api.commitEditingCell();
  });
}

describe("startEditingCell gates", () => {
  it("opens the editor seeded with the cell's display text", async () => {
    const { hook } = makeHarness();
    await act(async () => {
      await hook.result.current.api.startEditingCell(0, 1);
    });
    expect(hook.result.current.editingCell).toEqual({ row: 0, col: 1 });
    expect(hook.result.current.seed).toBe("alice");
    expect(hook.result.current.draftRef.current).toBe("alice");
    expect(hook.result.current.touchedRef.current).toBe(false);
  });

  it("seeds the literal text 'NULL' for a null cell", async () => {
    const { hook } = makeHarness();
    await act(async () => {
      await hook.result.current.api.startEditingCell(1, 1);
    });
    expect(hook.result.current.seed).toBe("NULL");
  });

  it("refuses to edit a primary-key column", async () => {
    const { hook, spies } = makeHarness();
    await act(async () => {
      await hook.result.current.api.startEditingCell(0, 0);
    });
    expect(hook.result.current.editingCell).toBeNull();
    expect(spies.setError).toHaveBeenCalledWith(expect.stringContaining("read-only"));
  });

  it("refuses to edit a masked column", async () => {
    const { hook, spies } = makeHarness({ maskedColumnNames: new Set(["secret"]) });
    await act(async () => {
      await hook.result.current.api.startEditingCell(0, 2);
    });
    expect(hook.result.current.editingCell).toBeNull();
    expect(spies.setError).toHaveBeenCalledWith(expect.stringContaining("masked"));
  });

  it("refuses rows whose primary key is incomplete", async () => {
    const { hook, spies } = makeHarness();
    await act(async () => {
      await hook.result.current.api.startEditingCell(2, 1);
    });
    expect(hook.result.current.editingCell).toBeNull();
    expect(spies.setError).toHaveBeenCalledWith(expect.stringContaining("incomplete primary key"));
  });

  it("does nothing when inline editing is disabled", async () => {
    const { hook } = makeHarness({ canAttemptInlineEdit: false });
    await act(async () => {
      await hook.result.current.api.startEditingCell(0, 1);
    });
    expect(hook.result.current.editingCell).toBeNull();
  });
});

describe("commitEditingCell — the touched-flag contract", () => {
  it("an untouched blur on a NULL cell stages nothing (the 'NULL' seed is not data)", async () => {
    const { hook, spies } = makeHarness();
    await act(async () => {
      await hook.result.current.api.startEditingCell(1, 1);
    });
    expect(hook.result.current.seed).toBe("NULL");
    // User blurs without typing — draft still equals the seed.
    await act(async () => {
      await hook.result.current.api.commitEditingCell();
    });
    expect(spies.stageChange).not.toHaveBeenCalled();
    expect(hook.result.current.editingCell).toBeNull();
  });

  it("deliberately typing 'NULL' into a null cell stages the literal string", async () => {
    const { hook, spies } = makeHarness();
    await typeAndCommit(hook, 1, 1, "NULL");
    expect(spies.stageChange).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "update",
        columns: { 1: { old: null, new: "NULL" } },
      }),
    );
    expect(hook.result.current.data?.rows[1][1]).toBe("NULL");
  });
});

describe("commitEditingCell — staging", () => {
  it("stages an update keyed by rowKey with old/new and patches grid + cache", async () => {
    const { hook, spies } = makeHarness();
    await typeAndCommit(hook, 0, 1, "alicia");

    expect(spies.stageChange).toHaveBeenCalledTimes(1);
    const staged = spies.stageChange.mock.calls[0][0] as {
      type: string;
      connectionId: string;
      tableName: string;
      rowIndex: number;
      rowKey: Record<string, unknown>;
      columns: Record<string, { old: unknown; new: unknown }>;
      originalRow: unknown[];
    };
    expect(staged.type).toBe("update");
    expect(staged.connectionId).toBe("conn-1");
    expect(staged.tableName).toBe("users");
    expect(staged.rowIndex).toBe(0);
    expect(staged.rowKey).toEqual({ id: 1 });
    expect(staged.columns).toEqual({ 1: { old: "alice", new: "alicia" } });
    expect(staged.originalRow).toEqual([1, "alice", "s1"]);

    // Optimistic apply: rendered row + chunk cache carry the new value.
    expect(hook.result.current.data?.rows[0][1]).toBe("alicia");
    expect(spies.patchLoadedTableCell).toHaveBeenCalledWith(0, 1, "alicia");
    expect(hook.result.current.stagedRows.has(0)).toBe(true);
    expect(hook.result.current.editingCell).toBeNull();
  });

  it("an explicit null commit stages real NULL (the dedicated NULL gesture)", async () => {
    const { hook, spies } = makeHarness();
    await act(async () => {
      await hook.result.current.api.startEditingCell(0, 1);
    });
    await act(async () => {
      await hook.result.current.api.commitEditingCell(null);
    });
    expect(spies.stageChange).toHaveBeenCalledWith(
      expect.objectContaining({ columns: { 1: { old: "alice", new: null } } }),
    );
    expect(hook.result.current.data?.rows[0][1]).toBeNull();
  });

  it("stages nothing when the committed value equals the current one", async () => {
    const { hook, spies } = makeHarness();
    await typeAndCommit(hook, 0, 1, "alice");
    expect(spies.stageChange).not.toHaveBeenCalled();
  });

  it("surfaces a staging failure as an error without losing the edit", async () => {
    const { hook, spies } = makeHarness();
    await act(async () => {
      await hook.result.current.api.startEditingCell(0, 1);
    });
    spies.stageChange.mockImplementation(() => {
      throw new Error("column map missing");
    });
    act(() => {
      hook.result.current.draftRef.current = "x";
      hook.result.current.touchedRef.current = true;
    });
    await act(async () => {
      await hook.result.current.api.commitEditingCell();
    });
    expect(spies.setError).toHaveBeenCalledWith(expect.stringContaining("column map missing"));
  });
});
