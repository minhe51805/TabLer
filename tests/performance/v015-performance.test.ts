import { describe, expect, it } from "vitest";

import { buildDiagramGridPositions } from "@/components/ERDiagram/layout";
import type { ExplorerSchemaSection } from "@/components/Sidebar/hooks/useTreeState";
import {
  estimateExplorerItemSize,
  flattenExplorerSections,
} from "@/components/Sidebar/components/explorer-virtualization";

function section(overrides: Partial<ExplorerSchemaSection> = {}): ExplorerSchemaSection {
  return {
    schemaName: "dbo",
    tables: [
      { name: "taikhoan", schema: "dbo", table_type: "BASE TABLE", row_count: 3 },
      { name: "donhang", schema: "dbo", table_type: "BASE TABLE", row_count: 10 },
    ],
    views: [{ name: "v_orders", schema: "dbo", object_type: "view", related_table: "donhang", definition: undefined }],
    triggers: [{ name: "trg_audit", schema: "dbo", object_type: "trigger", related_table: "taikhoan", definition: undefined }],
    routines: [{ name: "sp_calc", schema: "dbo", object_type: "routine", related_table: undefined, definition: undefined }],
    ...overrides,
  };
}

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

describe("explorer virtualization (freeze-audit P1)", () => {
  it("flattens sections into the visual order with unique stable keys", () => {
    const items = flattenExplorerSections([section()]);

    expect(items.map((item) => item.kind)).toEqual([
      "schema-head",
      "group-head",
      "table",
      "table",
      "group-head",
      "view",
      "group-head",
      "object",
      "group-head",
      "object",
    ]);
    const keys = new Set(items.map((item) => item.key));
    expect(keys.size).toBe(items.length);
    expect(items[0]).toMatchObject({ kind: "schema-head", schemaName: "dbo", count: 5 });
  });

  it("skips empty groups entirely", () => {
    const items = flattenExplorerSections([
      section({ tables: [], views: [], triggers: [], routines: [{ name: "sp_only", schema: "dbo", object_type: "routine", related_table: undefined, definition: undefined }] }),
    ]);
    expect(items.map((item) => item.kind)).toEqual(["schema-head", "group-head", "object"]);
    expect(items.find((item) => item.kind === "group-head")).toMatchObject({ group: "routines" });
  });

  it("estimates heads smaller than rows", () => {
    const items = flattenExplorerSections([section()]);
    const head = items.find((item) => item.kind === "schema-head");
    const row = items.find((item) => item.kind === "table");
    expect(estimateExplorerItemSize(head!)).toBeLessThan(estimateExplorerItemSize(row!));
  });

  it("flattens a 1000-table catalog well under the interaction budget", () => {
    const big = section({
      tables: Array.from({ length: 1_000 }, (_, index) => ({
        name: `table_${index}`,
        schema: "dbo",
        table_type: "BASE TABLE",
        row_count: index,
      })),
    });
    const startedAt = performance.now();
    const items = flattenExplorerSections([big]);
    const elapsedMs = performance.now() - startedAt;

    expect(items).toHaveLength(1_008); // schema head + group head + 1000 tables + view/trigger/routine groups
    expect(elapsedMs).toBeLessThan(50);
  });
});

import { findAgentSchemaMatches } from "@/components/AISlidePanel/ai-agent-schema-search";
import {
  createEmptyGridSelection,
  moveGridSelection,
  selectGridCell,
} from "@/components/DataGrid/grid-selection";
