import type { SchemaObjectInfo } from "../../../types";
import type { ExplorerSchemaSection } from "../hooks/useTreeState";

/**
 * Freeze-audit P1: the Explorer previously rendered every schema group and
 * object row of the expanded database into the DOM at once. This module
 * flattens the grouped sections into a single ordered row list so the tree can
 * be windowed with @tanstack/react-virtual while keeping the exact visual
 * order (schema head → group head → rows).
 */

export type ExplorerGroupKind = "tables" | "views" | "triggers" | "routines";

export type ExplorerFlatItem =
  | {
      kind: "schema-head";
      key: string;
      schemaName: string;
      count: number;
      tables: ExplorerSchemaSection["tables"];
    }
  | { kind: "group-head"; key: string; schemaName: string; group: ExplorerGroupKind }
  | { kind: "table"; key: string; schemaName: string; table: ExplorerSchemaSection["tables"][number] }
  | { kind: "view"; key: string; schemaName: string; view: ExplorerSchemaSection["views"][number] }
  | {
      kind: "object";
      key: string;
      schemaName: string;
      object: SchemaObjectInfo;
      group: "triggers" | "routines";
    };

export const EXPLORER_GROUP_LABEL_KEYS: Record<ExplorerGroupKind, string> = {
  tables: "explorer.tablesGroup",
  views: "explorer.viewsGroup",
  triggers: "explorer.triggersGroup",
  routines: "explorer.routinesGroup",
};

/** Flattens grouped sections into the visual row order used by the virtual list. */
export function flattenExplorerSections(sections: ExplorerSchemaSection[]): ExplorerFlatItem[] {
  const items: ExplorerFlatItem[] = [];
  for (const section of sections) {
    const { schemaName } = section;
    items.push({
      kind: "schema-head",
      key: `schema-head-${schemaName}`,
      schemaName,
      count: section.tables.length + section.views.length + section.triggers.length + section.routines.length,
      tables: section.tables,
    });
    if (section.tables.length > 0) {
      items.push({ kind: "group-head", key: `group-head-${schemaName}-tables`, schemaName, group: "tables" });
      for (const table of section.tables) {
        items.push({ kind: "table", key: `table-${schemaName}-${table.name}`, schemaName, table });
      }
    }
    if (section.views.length > 0) {
      items.push({ kind: "group-head", key: `group-head-${schemaName}-views`, schemaName, group: "views" });
      for (const view of section.views) {
        items.push({ kind: "view", key: `view-${schemaName}-${view.name}`, schemaName, view });
      }
    }
    if (section.triggers.length > 0) {
      items.push({ kind: "group-head", key: `group-head-${schemaName}-triggers`, schemaName, group: "triggers" });
      for (const trigger of section.triggers) {
        items.push({ kind: "object", key: `trigger-${schemaName}-${trigger.name}`, schemaName, object: trigger, group: "triggers" });
      }
    }
    if (section.routines.length > 0) {
      items.push({ kind: "group-head", key: `group-head-${schemaName}-routines`, schemaName, group: "routines" });
      for (const routine of section.routines) {
        items.push({ kind: "object", key: `routine-${schemaName}-${routine.name}`, schemaName, object: routine, group: "routines" });
      }
    }
  }
  return items;
}

/** Rough per-row height estimates (px); real heights are measured at runtime. */
export function estimateExplorerItemSize(item: ExplorerFlatItem): number {
  switch (item.kind) {
    case "schema-head":
      return 28;
    case "group-head":
      return 24;
    default:
      return 34;
  }
}
