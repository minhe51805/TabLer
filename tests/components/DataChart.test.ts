import { describe, expect, it } from "vitest";
import { selectRelevantChartTypes } from "../../src/components/DataGrid/DataChart";

describe("selectRelevantChartTypes", () => {
  it("offers time-series charts for temporal X axes", () => {
    expect(selectRelevantChartTypes(true, 1)).toEqual(["line", "area", "bar"]);
  });

  it("keeps category charts focused when there is one metric", () => {
    expect(selectRelevantChartTypes(false, 1)).toEqual(["bar", "donut"]);
  });

  it("offers scatter only when two numeric metrics are available", () => {
    expect(selectRelevantChartTypes(false, 2)).toEqual(["bar", "donut", "scatter"]);
  });
});
