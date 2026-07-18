import { describe, expect, it } from "vitest";

import { buildDiagramGridPositions } from "@/components/ERDiagram/layout";

describe("ERD large-schema layout", () => {
  it("produces finite, unique positions for the 500-table release fixture", () => {
    const startedAt = performance.now();
    const positions = buildDiagramGridPositions(500, 254);
    const elapsedMs = performance.now() - startedAt;

    expect(positions).toHaveLength(500);
    expect(new Set(positions.map(({ x, y }) => `${x}:${y}`)).size).toBe(500);
    expect(positions.every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y))).toBe(true);
    expect(elapsedMs).toBeLessThan(50);
  });

  it("handles an empty schema without producing a phantom node", () => {
    expect(buildDiagramGridPositions(0, 254)).toEqual([]);
  });
});
