import { beforeEach, describe, expect, it } from "vitest";

import {
  PINNED_RESULT_ROW_LIMIT,
  useResultDiffStore,
} from "@/components/ResultDiff/result-diff-store";
import type { QueryResult } from "@/types";

const makeResult = (rowCount = 2): QueryResult => ({
  columns: [
    { name: "id", data_type: "int", is_nullable: false, is_primary_key: true },
    { name: "name", data_type: "text", is_nullable: true, is_primary_key: false },
  ],
  rows: Array.from({ length: rowCount }, (_, i) => [i + 1, `row-${i + 1}`]),
  affected_rows: 0,
  execution_time_ms: 1,
  query: "SELECT * FROM users",
  sandboxed: false,
  truncated: false,
});

beforeEach(() => {
  useResultDiffStore.setState({ pinned: null, compare: null });
});

describe("useResultDiffStore.pin", () => {
  it("snapshots a deep copy so in-place grid edits never corrupt the diff baseline", () => {
    const result = makeResult();
    useResultDiffStore.getState().pin(result, "users");

    // Mutate the live result the way an in-place grid edit does.
    result.rows[0][1] = "EDITED";
    result.columns[0].name = "renamed";
    result.rows.push([99, "new"]);

    const pinned = useResultDiffStore.getState().pinned;
    expect(pinned?.result.rows[0][1]).toBe("row-1");
    expect(pinned?.result.columns[0].name).toBe("id");
    expect(pinned?.result.rows).toHaveLength(2);
    // Identity marker for "this grid is the pinned one".
    expect(pinned?.source).toBe(result);
    expect(pinned?.label).toBe("users");
    expect(pinned?.truncatedForDiff).toBe(false);
  });

  it("caps the snapshot at the row limit and flags truncation", () => {
    const result = makeResult(PINNED_RESULT_ROW_LIMIT + 10);

    useResultDiffStore.getState().pin(result, "huge");

    const pinned = useResultDiffStore.getState().pinned;
    expect(pinned?.result.rows).toHaveLength(PINNED_RESULT_ROW_LIMIT);
    expect(pinned?.truncatedForDiff).toBe(true);
    expect(pinned?.source.rows).toHaveLength(PINNED_RESULT_ROW_LIMIT + 10);
  });
});

describe("useResultDiffStore.openCompare", () => {
  it("no-ops when nothing is pinned", () => {
    useResultDiffStore.getState().openCompare(makeResult(), "current");

    expect(useResultDiffStore.getState().compare).toBeNull();
  });

  it("pairs the pinned snapshot with the current result", () => {
    const baseline = makeResult();
    useResultDiffStore.getState().pin(baseline, "before");
    const current = makeResult();

    useResultDiffStore.getState().openCompare(current, "after");

    const compare = useResultDiffStore.getState().compare;
    expect(compare?.a.result.rows[0][1]).toBe("row-1");
    expect(compare?.b).toBe(current);
    expect(compare?.bLabel).toBe("after");
  });
});
