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
  systemViews: SchemaObjectInfo[];
  triggers: SchemaObjectInfo[];
  procedures: SchemaObjectInfo[];
  systemProcedures: SchemaObjectInfo[];
  systemFunctions: SchemaObjectInfo[];
  tableFunctions: SchemaObjectInfo[];
  scalarFunctions: SchemaObjectInfo[];
  aggregateFunctions: SchemaObjectInfo[];
  databaseTriggers: SchemaObjectInfo[];
  assemblies: SchemaObjectInfo[];
  rules: SchemaObjectInfo[];
  defaults: SchemaObjectInfo[];
  systemTypes: SchemaObjectInfo[];
  userDefinedTypes: SchemaObjectInfo[];
  userTableTypes: SchemaObjectInfo[];
  clrTypes: SchemaObjectInfo[];
  xmlSchemaCollections: SchemaObjectInfo[];
  synonyms: SchemaObjectInfo[];
  sequences: SchemaObjectInfo[];
  routines: SchemaObjectInfo[];
}

/** Total object count of a section (everything except tables). */
export function explorerSectionObjectCount(section: ExplorerSchemaSection): number {
  return (
    section.views.length +
    section.systemViews.length +
    section.triggers.length +
    section.procedures.length +
    section.systemProcedures.length +
    section.systemFunctions.length +
    section.tableFunctions.length +
    section.scalarFunctions.length +
    section.aggregateFunctions.length +
    section.databaseTriggers.length +
    section.assemblies.length +
    section.rules.length +
    section.defaults.length +
    section.systemTypes.length +
    section.userDefinedTypes.length +
    section.userTableTypes.length +
    section.clrTypes.length +
    section.xmlSchemaCollections.length +
    section.synonyms.length +
    section.sequences.length +
    section.routines.length
  );
}

/**
 * SSMS-parity system schemas. On SQL Server these hold the "System …" objects
 * SSMS shows under the database node (System Stored Procedures, System Views,
 * System Functions, …). When merging is on they are folded into the `dbo`
 * section instead of rendering as their own schema section.
 */
const SYSTEM_SCHEMA_NAMES = new Set(["SYS", "INFORMATION_SCHEMA"]);
const SYSTEM_SCHEMA_TARGET = "dbo";

/**
 * SSMS System Data Types subfolders, derived from the MSSQL driver's
 * `SYSTEM_*` object_type labels (see mssql.rs list_schema_objects).
 */
export type SystemTypeCategory =
  | "exact-numeric"
  | "approximate-numeric"
  | "date-time"
  | "character-string"
  | "unicode-character-string"
  | "binary-string"
  | "clr"
  | "spatial"
  | "other";

const SYSTEM_TYPE_CATEGORIES: Record<string, SystemTypeCategory> = {
  SYSTEM_EXACT_NUMERIC: "exact-numeric",
  SYSTEM_APPROXIMATE_NUMERIC: "approximate-numeric",
  SYSTEM_DATE_TIME: "date-time",
  SYSTEM_CHARACTER_STRING: "character-string",
  SYSTEM_UNICODE_CHARACTER_STRING: "unicode-character-string",
  SYSTEM_BINARY_STRING: "binary-string",
  SYSTEM_CLR_DATA_TYPE: "clr",
  SYSTEM_SPATIAL_DATA_TYPE: "spatial",
  SYSTEM_OTHER_DATA_TYPE: "other",
};

export function systemTypeCategory(
  rawObjectType: string | undefined | null,
): SystemTypeCategory {
  return SYSTEM_TYPE_CATEGORIES[(rawObjectType || "").trim().toUpperCase()] ?? "other";
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

/**
 * Classifies a raw driver `object_type` value into an explorer group.
 *
 * Drivers name types differently (MSSQL uses type_desc values like
 * "SQL_TRIGGER" / "SQL_STORED_PROCEDURE" / "CLR_SCALAR_FUNCTION" plus the
 * synthetic SSMS-parity labels emitted by mssql.rs — "DATABASE_TRIGGER",
 * "ASSEMBLY", "SYSTEM_*_..." / "USER_*_TYPE" / "XML_SCHEMA_COLLECTION" —,
 * MySQL uses "PROCEDURE"/"FUNCTION", SQLite/LibSQL use "trigger"/"view"), so
 * matching is done by substring on the uppercased, trimmed value. Unknown
 * values fall into the "routine" catch-all.
 */
export function classifySchemaObject(
  rawObjectType: string | undefined | null,
): "view" | "sequence" | "synonym" | "trigger" | "database-trigger" | "procedure"
  | "table-function" | "scalar-function" | "aggregate-function"
  | "assembly" | "rule" | "default"
  | "system-type" | "user-type" | "table-type" | "clr-type" | "xml-schema"
  | "routine" {
  const objectType = (rawObjectType || "").trim().toUpperCase();
  if (objectType === "VIEW") return "view";
  if (objectType === "SEQUENCE") return "sequence";
  if (objectType === "SYNONYM") return "synonym";
  if (objectType === "DATABASE_TRIGGER") return "database-trigger";
  if (objectType === "ASSEMBLY") return "assembly";
  if (objectType === "RULE") return "rule";
  if (objectType === "DEFAULT") return "default";
  if (objectType === "XML_SCHEMA_COLLECTION") return "xml-schema";
  if (objectType === "USER_DEFINED_TYPE") return "user-type";
  if (objectType === "USER_TABLE_TYPE") return "table-type";
  if (objectType === "USER_CLR_TYPE") return "clr-type";
  if (objectType.startsWith("SYSTEM_")) return "system-type";
  if (objectType.includes("TRIGGER")) return "trigger";
  if (objectType.includes("PROC")) return "procedure";
  if (objectType.includes("AGGREGATE")) return "aggregate-function";
  if (objectType.includes("TABLE_VALUED")) return "table-function";
  if (objectType.includes("SCALAR")) return "scalar-function";
  if (objectType.includes("FUNC")) return "scalar-function";
  return "routine";
}

export function useSchemaSections(
  actualTables: TableInfo[],
  filteredSchemaObjects: SchemaObjectInfo[],
  pinnedTableSet: Set<string>,
  /** MSSQL SSMS-parity: fold `sys`/`INFORMATION_SCHEMA` objects into `dbo`. */
  mergeSystemSchema = false,
) {
  return useMemo<ExplorerSchemaSection[]>(() => {
    const groups = new Map<string, ExplorerSchemaSection>();

    const ensureGroup = (schemaName: string) => {
      if (!groups.has(schemaName)) {
        groups.set(schemaName, {
          schemaName,
          tables: [],
          views: [],
          systemViews: [],
          triggers: [],
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
      const tableSchema = table.schema || "public";
      // System schemas never render as table rows on MSSQL (SSMS shows their
      // views under Views → System Views instead).
      if (mergeSystemSchema && SYSTEM_SCHEMA_NAMES.has(tableSchema.toUpperCase())) continue;
      ensureGroup(tableSchema).tables.push(table);
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
      const objectSchema = object.schema || "public";
      const groupType = classifySchemaObject(object.object_type);

      // SSMS-parity merge (MSSQL): system-schema objects fold into the `dbo`
      // section so the "System …" folders render like SSMS's database node
      // instead of appearing as a separate `sys` schema section.
      if (mergeSystemSchema && SYSTEM_SCHEMA_NAMES.has(objectSchema.toUpperCase())) {
        const systemGroup = ensureGroup(SYSTEM_SCHEMA_TARGET);
        switch (groupType) {
          case "view":
            systemGroup.systemViews.push(object);
            break;
          case "procedure":
            systemGroup.systemProcedures.push(object);
            break;
          case "table-function":
          case "scalar-function":
          case "aggregate-function":
            systemGroup.systemFunctions.push(object);
            break;
          case "trigger":
            systemGroup.triggers.push(object);
            break;
          case "database-trigger":
            systemGroup.databaseTriggers.push(object);
            break;
          case "assembly":
            systemGroup.assemblies.push(object);
            break;
          case "rule":
            systemGroup.rules.push(object);
            break;
          case "default":
            systemGroup.defaults.push(object);
            break;
          case "system-type":
            systemGroup.systemTypes.push(object);
            break;
          case "user-type":
            systemGroup.userDefinedTypes.push(object);
            break;
          case "table-type":
            systemGroup.userTableTypes.push(object);
            break;
          case "clr-type":
            systemGroup.clrTypes.push(object);
            break;
          case "xml-schema":
            systemGroup.xmlSchemaCollections.push(object);
            break;
          case "synonym":
            systemGroup.synonyms.push(object);
            break;
          case "sequence":
            systemGroup.sequences.push(object);
            break;
          default:
            systemGroup.routines.push(object);
        }
        continue;
      }

      const group = ensureGroup(objectSchema);
      switch (groupType) {
        case "view":
          group.views.push(object);
          break;
        case "sequence":
          group.sequences.push(object);
          break;
        case "synonym":
          group.synonyms.push(object);
          break;
        case "trigger":
          group.triggers.push(object);
          break;
        case "database-trigger":
          group.databaseTriggers.push(object);
          break;
        case "procedure":
          group.procedures.push(object);
          break;
        case "table-function":
          group.tableFunctions.push(object);
          break;
        case "scalar-function":
          group.scalarFunctions.push(object);
          break;
        case "aggregate-function":
          group.aggregateFunctions.push(object);
          break;
        case "assembly":
          group.assemblies.push(object);
          break;
        case "rule":
          group.rules.push(object);
          break;
        case "default":
          group.defaults.push(object);
          break;
        case "system-type":
          group.systemTypes.push(object);
          break;
        case "user-type":
          group.userDefinedTypes.push(object);
          break;
        case "table-type":
          group.userTableTypes.push(object);
          break;
        case "clr-type":
          group.clrTypes.push(object);
          break;
        case "xml-schema":
          group.xmlSchemaCollections.push(object);
          break;
        default:
          group.routines.push(object);
      }
    }

    return Array.from(groups.values()).sort((left, right) =>
      left.schemaName.localeCompare(right.schemaName)
    );
  }, [actualTables, filteredSchemaObjects, pinnedTableSet, mergeSystemSchema]);
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
      (total, section) => total + explorerSectionObjectCount(section), 0
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
