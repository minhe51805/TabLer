import { describe, expect, it } from "vitest";

import { buildDiagramGridPositions } from "@/components/ERDiagram/layout";
import type { ExplorerSchemaSection } from "@/components/Sidebar/hooks/useTreeState";
import {
  estimateExplorerItemSize,
  explorerFolderKey,
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
    systemViews: [],
    triggers: [{ name: "trg_audit", schema: "dbo", object_type: "trigger", related_table: "taikhoan", definition: undefined }],
    procedures: [],
    systemProcedures: [],
    systemFunctions: [],
    tableFunctions: [],
    scalarFunctions: [],
    aggregateFunctions: [],
    databaseTriggers: [],
    assemblies: [],
    rules: [],
    defaults: [],
    systemTypes: [],
    userDefinedTypes: [],
    userTableTypes: [],
    clrTypes: [],
    xmlSchemaCollections: [],
    synonyms: [],
    sequences: [],
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

describe("explorer virtualization (freeze-audit P1, SSMS folder tree)", () => {
  it("flattens sections into the folder-tree order with unique stable keys", () => {
    const items = flattenExplorerSections([section()]);

    expect(items.map((item) => item.kind)).toEqual([
      "schema-head",
      "folder", "table", "table",      // Tables
      "folder", "view",                // Views
      "folder", "empty-folder",        //   System Views (empty)
      "folder", "empty-folder",        // Synonyms (empty placeholder)
      "folder",                        // Programmability
      "folder",                        //   Stored Procedures (empty)
      "folder", "empty-folder",        //   System Stored Procedures (empty)
      "folder",                        //   Functions (container)
      "folder", "empty-folder",        //     Table-valued Functions (empty)
      "folder", "empty-folder",        //     Scalar-valued Functions (empty)
      "folder", "empty-folder",        //     Aggregate Functions (empty)
      "folder", "empty-folder",        //     System Functions (empty)
      "folder", "object",              //   Triggers (trg_audit)
      "folder", "object",              //   Routines (sp_calc catch-all)
      "folder", "empty-folder",        //   Database Triggers (empty)
      "folder", "empty-folder",        //   Assemblies (empty)
      "folder",                        //   Types (container)
      "folder",                        //     System Data Types (container)
      "folder", "empty-folder",        //       Exact Numerics
      "folder", "empty-folder",        //       Approximate Numerics
      "folder", "empty-folder",        //       Date and Time
      "folder", "empty-folder",        //       Character Strings
      "folder", "empty-folder",        //       Unicode Character Strings
      "folder", "empty-folder",        //       Binary Strings
      "folder", "empty-folder",        //       CLR Data Types
      "folder", "empty-folder",        //       Spatial Data Types
      "folder", "empty-folder",        //       Other Data Types
      "folder", "empty-folder",        //     User-Defined Data Types
      "folder", "empty-folder",        //     User-Defined Table Types
      "folder", "empty-folder",        //     User-Defined Types (CLR)
      "folder", "empty-folder",        //     XML Schema Collections
      "folder", "empty-folder",        //   Rules (empty)
      "folder", "empty-folder",        //   Defaults (empty)
      "folder", "empty-folder",        // Sequences (empty placeholder)
    ]);
    const keys = new Set(items.map((item) => item.key));
    expect(keys.size).toBe(items.length);
    expect(items[0]).toMatchObject({ kind: "schema-head", schemaName: "dbo", count: 5 });
    const folders = items.filter((item) => item.kind === "folder");
    expect(folders.every((folder) => folder.expanded)).toBe(true);
  });

  it("collapses every folder when an explicit empty expansion set is given", () => {
    const items = flattenExplorerSections([section()], { expandedFolders: new Set() });
    expect(items.map((item) => item.kind)).toEqual([
      "schema-head",
      "folder",
      "folder",
      "folder",
      "folder",
      "folder",
    ]);
  });

  it("hides empty engine-specific folders when system folders are off", () => {
    const items = flattenExplorerSections([section()], {
      expandedFolders: new Set(),
      showSystemFolders: false,
    });
    const folders = items.filter((item) => item.kind === "folder");
    // Tables, Views, Programmability only — Synonyms/Sequences are empty and
    // therefore hidden.
    expect(folders.map((folder) => folder.folder)).toEqual(["tables", "views", "programmability"]);
  });

  it("expands only the folders present in the expansion set", () => {
    const items = flattenExplorerSections([section()], {
      expandedFolders: new Set([explorerFolderKey("dbo", "tables")]),
    });
    const kinds = items.map((item) => item.kind);
    expect(kinds).toContain("table");
    expect(kinds).toContain("folder");
    expect(kinds).not.toContain("view");
    expect(kinds).not.toContain("empty-folder");
  });

  it("estimates heads and folders smaller than rows", () => {
    const items = flattenExplorerSections([section()]);
    const head = items.find((item) => item.kind === "schema-head");
    const folder = items.find((item) => item.kind === "folder");
    const row = items.find((item) => item.kind === "table");
    expect(estimateExplorerItemSize(head!)).toBeLessThan(estimateExplorerItemSize(row!));
    expect(estimateExplorerItemSize(folder!)).toBeLessThan(estimateExplorerItemSize(row!));
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

    // schema head + tables folder + 1000 tables + views/system-views folders
    // + view + synonyms folder + empty + programmability folder + procedures/
    // system-procedures + functions (4 subfolders incl. system) with
    // placeholders + triggers/routines folders with one object each +
    // database-triggers/assemblies folders (empty) + types container
    // (system-data-types + 9 categories + 4 user type folders, all empty) +
    // rules/defaults folders (empty) + sequences folder + empty.
    expect(items).toHaveLength(1_063);
    expect(elapsedMs).toBeLessThan(50);
  });
});

import { findAgentSchemaMatches } from "@/components/AISlidePanel/ai-agent-schema-search";
import {
  createEmptyGridSelection,
  moveGridSelection,
  selectGridCell,
} from "@/components/DataGrid/grid-selection";
