import { describe, expect, it } from "vitest";

import { buildDiagramGridPositions } from "@/components/ERDiagram/layout";
import { findAgentSchemaMatches } from "@/components/AISlidePanel/ai-agent-schema-search";
import {
  createEmptyGridSelection,
  moveGridSelection,
  selectGridCell,
} from "@/components/DataGrid/grid-selection";

describe("v0.1.5 binding microbenchmarks", () => {
  it("updates 10,000 virtualized-grid selections within the local budget", () => {
    const bounds = { rowCount: 1_000_000, columnCount: 200 };
    let selection = selectGridCell(createEmptyGridSelection(), { row: 0, col: 0 }, bounds);
    const startedAt = performance.now();
    for (let index = 0; index < 10_000; index += 1) {
      selection = moveGridSelection(selection, { row: 1, col: index % 3 === 0 ? 1 : 0 }, bounds);
    }
    const elapsedMs = performance.now() - startedAt;

    expect(selection.activeCell?.row).toBe(10_000);
    expect(elapsedMs).toBeLessThan(1_500);
  });

  it("searches a 500-table schema and lays it out within the local budget", () => {
    const candidates = Array.from({ length: 500 }, (_, index) => ({
      identifier: `public.table_${index}`,
      columns: Array.from({ length: 24 }, (_value, columnIndex) => ({
        name: columnIndex === 17 ? `customer_email_${index}` : `column_${columnIndex}`,
        data_type: "text",
        is_nullable: true,
        is_primary_key: false,
      })),
    }));
    const startedAt = performance.now();
    const matches = findAgentSchemaMatches("customer email", candidates);
    const positions = buildDiagramGridPositions(candidates.length, 254);
    const elapsedMs = performance.now() - startedAt;

    expect(matches).toHaveLength(12);
    expect(positions).toHaveLength(500);
    expect(elapsedMs).toBeLessThan(500);
  });
});
