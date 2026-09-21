import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ResultDiffControls } from "../../src/components/ResultDiff/ResultDiffControls";
import { ResultDiffModal } from "../../src/components/ResultDiff/ResultDiffModal";
import { useResultDiffStore } from "../../src/components/ResultDiff/result-diff-store";
import type { QueryResult } from "../../src/types";

const col = (name: string, pk = false) => ({
  name,
  data_type: "text",
  is_nullable: true,
  is_primary_key: pk,
});
const res = (columns: any[], rows: any[][], query = "select 1"): QueryResult => ({
  columns,
  rows,
  affected_rows: 0,
  execution_time_ms: 1,
  query,
  sandboxed: false,
  truncated: false,
});

describe("ResultDiff pin→compare flow", () => {
  it("pins result A, compares result B, renders grouped diff", () => {
    const a = res(
      [col("id", true), col("v")],
      [
        [1, "x"],
        [2, "y"],
      ],
      "select * from t",
    );
    const b = res(
      [col("id", true), col("v")],
      [
        [2, "y2"],
        [3, "z"],
      ],
      "select * from t2",
    );

    useResultDiffStore.setState({ pinned: null, compare: null });
    const view = render(
      <>
        <ResultDiffControls result={a} label="select * from t" />
        <ResultDiffModal />
      </>,
    );

    // Pin A
    fireEvent.click(screen.getByRole("button", { name: /pin/i }));
    expect(useResultDiffStore.getState().pinned?.result.rows).toHaveLength(2);

    // Now grid shows B — rerender controls with B
    view.rerender(
      <>
        <ResultDiffControls result={b} label="select * from t2" />
        <ResultDiffModal />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: /compare/i }));

    // Modal renders: summary + groups
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(/\+1 added/)).toBeInTheDocument();
    expect(screen.getByText(/-1 removed/)).toBeInTheDocument();
    expect(screen.getByText(/~1 changed/)).toBeInTheDocument();
    expect(screen.getByText(/Only in current \(1\)/)).toBeInTheDocument();
    expect(screen.getByText(/Only in pinned \(1\)/)).toBeInTheDocument();
    expect(screen.getByText(/Changed rows \(1\)/)).toBeInTheDocument();
    // Changed cell shows before → after
    expect(screen.getByText("y")).toBeInTheDocument();
    expect(screen.getByText("y2")).toBeInTheDocument();
    // PK match note
    expect(screen.getByText(/primary key: id/)).toBeInTheDocument();
  });
});
