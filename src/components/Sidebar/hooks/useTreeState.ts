import { useCallback, useMemo, useState } from "react";
import type { SchemaObjectInfo, TableInfo } from "../../../types";
import { formatCountLabel, type AppLanguage } from "../../../i18n";
import { getQualifiedTableName } from "../SidebarUtils";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const EXPLORER_PINNED_TABLES_STORAGE_KEY = "tabler.explorerPinnedTables";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExplorerSchemaSection {
  schemaName: string;
  tables: TableInfo[];
  views: SchemaObjectInfo[];
  triggers: SchemaObjectInfo[];
  routines: SchemaObjectInfo[];
}

// ---------------------------------------------------------------------------
// Pinned tables
// ---------------------------------------------------------------------------

export function loadPinnedTablesByWorkspace() {
  if (typeof window === "undefined") return {} as Record<string, string[]>;

  try {
    const raw = window.localStorage.getItem(EXPLORER_PINNED_TABLES_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, string[]>;
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string[]] => Array.isArray(entry[1]))
    );
  } catch {
    return {};
  }
}

export function usePinnedTables(tableWorkspaceKey: string) {
  const [pinnedTablesByWorkspace, setPinnedTablesByWorkspace] = useState<Record<string, string[]>>(
    () => loadPinnedTablesByWorkspace()
  );

  const pinnedTableSet = useMemo(
    () => new Set(pinnedTablesByWorkspace[tableWorkspaceKey] ?? []),
    [pinnedTablesByWorkspace, tableWorkspaceKey]
  );

  const togglePinnedTable = useCallback(
    (table: Pick<TableInfo, "name" | "schema">) => {
      if (!tableWorkspaceKey) return;
      const qualifiedName = getQualifiedTableName(table);
      setPinnedTablesByWorkspace((previous) => {
        const current = previous[tableWorkspaceKey] ?? [];
        const next = current.includes(qualifiedName)
          ? current.filter((entry) => entry !== qualifiedName)
          : [qualifiedName, ...current];
        return {
          ...previous,
          [tableWorkspaceKey]: next,
        };
      });
    },
    [tableWorkspaceKey]
  );

  return { pinnedTableSet, pinnedTablesByWorkspace, togglePinnedTable };
}

// ---------------------------------------------------------------------------
// Schema sections
// ---------------------------------------------------------------------------

export function useSchemaSections(
  actualTables: TableInfo[],
  filteredSchemaObjects: SchemaObjectInfo[],
  pinnedTableSet: Set<string>,
) {
  return useMemo<ExplorerSchemaSection[]>(() => {
    const groups = new Map<string, ExplorerSchemaSection>();

    const ensureGroup = (schemaName: string) => {
      if (!groups.has(schemaName)) {
        groups.set(schemaName, {
          schemaName,
          tables: [],
          views: [],
          triggers: [],
          routines: [],
        });
      }
      return groups.get(schemaName)!;
    };

    const sortedTables = [...actualTables].sort((left, right) => {
      const leftQualified = getQualifiedTableName(left);
      const rightQualified = getQualifiedTableName(right);
      const leftPinned = pinnedTableSet.has(leftQualified);
      const rightPinned = pinnedTableSet.has(rightQualified);

      if (leftPinned !== rightPinned) {
        return leftPinned ? -1 : 1;
      }

      const leftSchema = left.schema || "public";
      const rightSchema = right.schema || "public";
      if (leftSchema !== rightSchema) {
        return leftSchema.localeCompare(rightSchema);
      }
      return left.name.localeCompare(right.name);
    });

    for (const table of sortedTables) {
      ensureGroup(table.schema || "public").tables.push(table);
    }

    const sortedObjects = [...filteredSchemaObjects].sort((left, right) => {
      const leftSchema = left.schema || "public";
      const rightSchema = right.schema || "public";
      if (leftSchema !== rightSchema) {
        return leftSchema.localeCompare(rightSchema);
      }
      if (left.object_type !== right.object_type) {
        return left.object_type.localeCompare(right.object_type);
      }
      return left.name.localeCompare(right.name);
    });

    for (const object of sortedObjects) {
      const group = ensureGroup(object.schema || "public");
      if (object.object_type === "VIEW") {
        group.views.push(object);
      } else if (object.object_type === "TRIGGER") {
        group.triggers.push(object);
      } else {
        group.routines.push(object);
      }
    }

    return Array.from(groups.values()).sort((left, right) =>
      left.schemaName.localeCompare(right.schemaName)
    );
  }, [actualTables, filteredSchemaObjects, pinnedTableSet]);
}

// ---------------------------------------------------------------------------
// Summary counts
// ---------------------------------------------------------------------------

export function useExplorerSummary(
  filteredSchemaSections: ExplorerSchemaSection[],
  language: AppLanguage,
) {
  return useMemo(() => {
    const visibleTableCount = filteredSchemaSections.reduce(
      (total, section) => total + section.tables.length, 0
    );
    const visibleObjectCount = filteredSchemaSections.reduce(
      (total, section) => total + section.views.length + section.triggers.length + section.routines.length, 0
    );
    const visibleSchemaCount = filteredSchemaSections.length;

    const summaryLabel = `${formatCountLabel(language, visibleTableCount, {
      one: "table",
      other: "tables",
      vi: "bảng",
    })} | ${formatCountLabel(language, visibleObjectCount, {
      one: "object",
      other: "objects",
      vi: "đối tượng",
    })} | ${formatCountLabel(language, visibleSchemaCount, {
      one: "schema",
      other: "schemas",
      vi: "schema",
    })}`;

    return { visibleTableCount, visibleObjectCount, visibleSchemaCount, summaryLabel };
  }, [filteredSchemaSections, language]);
}
