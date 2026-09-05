import type { SchemaObjectInfo } from "../../../types";
import type { ExplorerSchemaSection, SystemTypeCategory } from "../hooks/useTreeState";
import { explorerSectionObjectCount, systemTypeCategory } from "../hooks/useTreeState";

/**
 * Freeze-audit P1: the Explorer previously rendered every schema group and
 * object row of the expanded database into the DOM at once. This module
 * flattens the grouped sections into a single ordered row list so the tree can
 * be windowed with @tanstack/react-virtual while keeping the exact visual
 * order (schema head → group head → rows).
 */

/**
 * SSMS-style folder hierarchy rendered inside an expanded database:
 * schema → Tables / Views / Synonyms / Programmability → (Stored Procedures /
 * Functions → (Table-valued / Scalar / Aggregate / System) / Database
 * Triggers / Assemblies / Types → (System Data Types → 9 categories /
 * User-Defined / Table Types / CLR / XML Schema Collections) / Rules /
 * Defaults) / Sequences.
 */
export type ExplorerFolderId =
  | "tables"
  | "views"
  | "system-views"
  | "synonyms"
  | "programmability"
  | "procedures"
  | "system-procedures"
  | "functions"
  | "functions-table-valued"
  | "functions-scalar"
  | "functions-aggregate"
  | "functions-system"
  | "triggers"
  | "database-triggers"
  | "assemblies"
  | "types"
  | "system-data-types"
  | "system-types-exact"
  | "system-types-approximate"
  | "system-types-date"
  | "system-types-char"
  | "system-types-unicode"
  | "system-types-binary"
  | "system-types-clr"
  | "system-types-spatial"
  | "system-types-other"
  | "user-defined-types"
  | "user-table-types"
  | "clr-types"
  | "xml-schema-collections"
  | "rules"
  | "defaults"
  | "routines"
  | "sequences";

export const EXPLORER_FOLDER_LABEL_KEYS: Record<ExplorerFolderId, string> = {
  tables: "explorer.tablesGroup",
  views: "explorer.viewsGroup",
  "system-views": "explorer.systemViewsGroup",
  synonyms: "explorer.synonymsGroup",
  programmability: "explorer.progGroup",
  procedures: "explorer.proceduresGroup",
  "system-procedures": "explorer.systemProceduresGroup",
  functions: "explorer.functionsGroup",
  "functions-table-valued": "explorer.functionsTableValuedGroup",
  "functions-scalar": "explorer.functionsScalarGroup",
  "functions-aggregate": "explorer.functionsAggregateGroup",
  "functions-system": "explorer.functionsSystemGroup",
  triggers: "explorer.triggersGroup",
  "database-triggers": "explorer.databaseTriggersGroup",
  assemblies: "explorer.assembliesGroup",
  types: "explorer.typesGroup",
  "system-data-types": "explorer.systemDataTypesGroup",
  "system-types-exact": "explorer.typeExactNumericGroup",
  "system-types-approximate": "explorer.typeApproximateNumericGroup",
  "system-types-date": "explorer.typeDateTimeGroup",
  "system-types-char": "explorer.typeCharGroup",
  "system-types-unicode": "explorer.typeUnicodeGroup",
  "system-types-binary": "explorer.typeBinaryGroup",
  "system-types-clr": "explorer.typeClrGroup",
  "system-types-spatial": "explorer.typeSpatialGroup",
  "system-types-other": "explorer.typeOtherGroup",
  "user-defined-types": "explorer.userDefinedTypesGroup",
  "user-table-types": "explorer.userTableTypesGroup",
  "clr-types": "explorer.clrTypesGroup",
  "xml-schema-collections": "explorer.xmlSchemaGroup",
  rules: "explorer.rulesGroup",
  defaults: "explorer.defaultsGroup",
  routines: "explorer.routinesGroup",
  sequences: "explorer.sequencesGroup",
};

/** SSMS System Data Types categories, in the order SSMS renders them. */
const SYSTEM_TYPE_CATEGORY_FOLDERS: Array<{
  folder: ExplorerFolderId;
  category: SystemTypeCategory;
}> = [
  { folder: "system-types-exact", category: "exact-numeric" },
  { folder: "system-types-approximate", category: "approximate-numeric" },
  { folder: "system-types-date", category: "date-time" },
  { folder: "system-types-char", category: "character-string" },
  { folder: "system-types-unicode", category: "unicode-character-string" },
  { folder: "system-types-binary", category: "binary-string" },
  { folder: "system-types-clr", category: "clr" },
  { folder: "system-types-spatial", category: "spatial" },
  { folder: "system-types-other", category: "other" },
];

/** Bucket a rendered object row belongs to (drives meta text + icon). */
export type ExplorerObjectGroup =
  | "procedures"
  | "system-procedures"
  | "triggers"
  | "routines"
  | "table-functions"
  | "scalar-functions"
  | "aggregate-functions"
  | "system-functions"
  | "system-views"
  | "database-triggers"
  | "assemblies"
  | "rules"
  | "defaults"
  | "system-types"
  | "user-defined-types"
  | "user-table-types"
  | "clr-types"
  | "xml-schema-collections";

/** Stable key used for folder expansion state and flat-row identity. */
export function explorerFolderKey(schemaName: string, folder: ExplorerFolderId): string {
  return `${schemaName}::${folder}`;
}

export type ExplorerFlatItem =
  | {
      kind: "schema-head";
      key: string;
      schemaName: string;
      count: number;
      tables: ExplorerSchemaSection["tables"];
    }
  | {
      kind: "folder";
      key: string;
      schemaName: string;
      folder: ExplorerFolderId;
      depth: number;
      count: number;
      expanded: boolean;
    }
  | { kind: "empty-folder"; key: string; schemaName: string; folder: ExplorerFolderId; depth: number }
  | { kind: "table"; key: string; schemaName: string; table: ExplorerSchemaSection["tables"][number]; depth: number }
  | { kind: "view"; key: string; schemaName: string; view: ExplorerSchemaSection["views"][number]; depth: number }
  | {
      kind: "object";
      key: string;
      schemaName: string;
      object: SchemaObjectInfo;
      group: ExplorerObjectGroup;
      depth: number;
    };

export type ExplorerFolderExpansion = ReadonlySet<string>;

interface FlattenOptions {
  /**
   * Keys (see {@link explorerFolderKey}) of folders that are expanded.
   * Omitted / null means "expand everything" (legacy callers and search mode).
   */
  expandedFolders?: ExplorerFolderExpansion | null;
  /**
   * When false, engine-specific folders that are usually empty (Synonyms,
   * Sequences) are hidden instead of rendered with a "No items" placeholder.
   * Defaults to true (SSMS parity, e.g. SQL Server).
   */
  showSystemFolders?: boolean;
}

/** Flattens grouped sections into the visual row order used by the virtual list. */
export function flattenExplorerSections(
  sections: ExplorerSchemaSection[],
  options: FlattenOptions = {},
): ExplorerFlatItem[] {
  const expanded = options.expandedFolders ?? null;
  const isOpen = (key: string) => expanded === null || expanded.has(key);
  const showSystemFolders = options.showSystemFolders ?? true;

  const items: ExplorerFlatItem[] = [];
  for (const section of sections) {
    const { schemaName } = section;
    const totalCount = section.tables.length + explorerSectionObjectCount(section);
    items.push({
      kind: "schema-head",
      key: `schema-head-${schemaName}`,
      schemaName,
      count: totalCount,
      tables: section.tables,
    });

    const pushFolder = (
      folder: ExplorerFolderId,
      depth: number,
      count: number,
      childrenFn: () => ExplorerFlatItem[],
      showWhenEmpty = true,
    ) => {
      const folderKey = explorerFolderKey(schemaName, folder);
      const open = isOpen(folderKey);
      items.push({ kind: "folder", key: folderKey, schemaName, folder, depth, count, expanded: open });
      if (!open) return;
      const children = childrenFn();
      if (children.length > 0) {
        for (const entry of children) items.push(entry);
      } else if (showWhenEmpty) {
        items.push({ kind: "empty-folder", key: `${folderKey}::empty`, schemaName, folder, depth: depth + 1 });
      }
    };

    const pushObjects = (
      folder: ExplorerFolderId,
      group: ExplorerObjectGroup,
      depth: number,
      entries: SchemaObjectInfo[],
    ): ExplorerFlatItem[] =>
      entries.map((object) => ({
        kind: "object" as const,
        key: `${folder}-${schemaName}-${object.name}`,
        schemaName,
        object,
        group,
        depth,
      }));

    // SSMS "System …" subfolder (System Views / System Stored Procedures /
    // System Functions): rendered on SQL Server even when empty, with the
    // merged `sys`-schema objects inside.
    const pushSystemSubfolder = (
      folder: ExplorerFolderId,
      group: ExplorerObjectGroup,
      depth: number,
      entries: SchemaObjectInfo[],
    ): ExplorerFlatItem[] => {
      if (!showSystemFolders) return [];
      const rows: ExplorerFlatItem[] = [
        buildFolderRow(schemaName, folder, depth, entries.length, isOpen),
      ];
      if (isOpen(explorerFolderKey(schemaName, folder))) {
        if (entries.length > 0) rows.push(...pushObjects(folder, group, depth + 1, entries));
        else {
          rows.push({
            kind: "empty-folder",
            key: `${explorerFolderKey(schemaName, folder)}::empty`,
            schemaName,
            folder,
            depth: depth + 1,
          });
        }
      }
      return rows;
    };

    pushFolder("tables", 1, section.tables.length, () =>
      section.tables.map((table) => ({
        kind: "table" as const,
        key: `table-${schemaName}-${table.name}`,
        schemaName,
        table,
        depth: 2,
      })),
    );

    pushFolder(
      "views",
      1,
      section.views.length + section.systemViews.length,
      () => [
        ...section.views.map((view) => ({
          kind: "view" as const,
          key: `view-${schemaName}-${view.name}`,
          schemaName,
          view,
          depth: 2,
        })),
        ...pushSystemSubfolder("system-views", "system-views", 2, section.systemViews),
      ],
    );

    // SSMS always lists Synonyms (with a "No items" placeholder when empty);
    // other engines hide the folder entirely when it has no content.
    if (section.synonyms.length > 0 || showSystemFolders) {
      pushFolder(
        "synonyms",
        1,
        section.synonyms.length,
        () => pushObjects("synonyms", "routines", 2, section.synonyms),
        showSystemFolders,
      );
    }

    // Programmability is a pure container: it always renders its non-empty
    // subfolders and never gets its own "no items" placeholder. SSMS order:
    // Stored Procedures → Functions → Database Triggers → Assemblies → Types
    // → Rules → Defaults.
    const functionCount =
      section.tableFunctions.length +
      section.scalarFunctions.length +
      section.aggregateFunctions.length +
      section.systemFunctions.length;
    const typesCount =
      section.systemTypes.length +
      section.userDefinedTypes.length +
      section.userTableTypes.length +
      section.clrTypes.length +
      section.xmlSchemaCollections.length;
    const progKey = explorerFolderKey(schemaName, "programmability");
    const progOpen = isOpen(progKey);
    items.push({
      kind: "folder",
      key: progKey,
      schemaName,
      folder: "programmability",
      depth: 1,
      count:
        section.procedures.length +
        section.systemProcedures.length +
        functionCount +
        section.triggers.length +
        section.routines.length +
        section.databaseTriggers.length +
        section.assemblies.length +
        typesCount +
        section.rules.length +
        section.defaults.length,
      expanded: progOpen,
    });
    if (progOpen) {
      pushFolder(
        "procedures",
        2,
        section.procedures.length + section.systemProcedures.length,
        () => [
          ...pushObjects("procedures", "procedures", 3, section.procedures),
          ...pushSystemSubfolder("system-procedures", "system-procedures", 3, section.systemProcedures),
        ],
      );
      pushFolder("functions", 2, functionCount, () =>
        buildFunctionsItems(section, showSystemFolders, isOpen),
      );
      pushFolder("triggers", 2, section.triggers.length, () =>
        pushObjects("triggers", "triggers", 3, section.triggers),
      );
      if (section.routines.length > 0) {
        pushFolder("routines", 2, section.routines.length, () =>
          pushObjects("routines", "routines", 3, section.routines),
        );
      }
      if (section.databaseTriggers.length > 0 || showSystemFolders) {
        pushFolder("database-triggers", 2, section.databaseTriggers.length, () =>
          pushObjects("database-triggers", "database-triggers", 3, section.databaseTriggers),
        );
      }
      if (section.assemblies.length > 0 || showSystemFolders) {
        pushFolder("assemblies", 2, section.assemblies.length, () =>
          pushObjects("assemblies", "assemblies", 3, section.assemblies),
        );
      }
      if (typesCount > 0 || showSystemFolders) {
        pushFolder("types", 2, typesCount, () =>
          buildTypesItems(section, showSystemFolders, isOpen),
        );
      }
      if (section.rules.length > 0 || showSystemFolders) {
        pushFolder("rules", 2, section.rules.length, () =>
          pushObjects("rules", "rules", 3, section.rules),
        );
      }
      if (section.defaults.length > 0 || showSystemFolders) {
        pushFolder("defaults", 2, section.defaults.length, () =>
          pushObjects("defaults", "defaults", 3, section.defaults),
        );
      }
    }

    // Same engine-gated visibility as Synonyms (SQL Server sys.sequences).
    if (section.sequences.length > 0 || showSystemFolders) {
      pushFolder(
        "sequences",
        1,
        section.sequences.length,
        () => pushObjects("sequences", "routines", 2, section.sequences),
        showSystemFolders,
      );
    }
  }
  return items;
}

type IsOpenFn = (key: string) => void | boolean;

/** Pure helper: folder row for `folder` with its expansion state resolved. */
function buildFolderRow(
  schemaName: string,
  folder: ExplorerFolderId,
  depth: number,
  count: number,
  isOpen: IsOpenFn,
): ExplorerFlatItem {
  const folderKey = explorerFolderKey(schemaName, folder);
  return { kind: "folder", key: folderKey, schemaName, folder, depth, count, expanded: Boolean(isOpen(folderKey)) };
}

/**
 * Children of the Functions container: Table-valued / Scalar-valued /
 * Aggregate / System subfolders (always visible on SQL Server). The System
 * bucket holds `sys`-schema functions folded in by useSchemaSections when
 * SSMS-parity merging is on. Non-MSSQL engines keep the legacy flat behaviour
 * (object rows directly underneath). Pure: returns the rows without touching
 * the outer list.
 */
function buildFunctionsItems(
  section: ExplorerSchemaSection,
  showSystemFolders: boolean,
  isOpen: IsOpenFn,
): ExplorerFlatItem[] {
  const schemaName = section.schemaName;
  const pushObjects = (folder: ExplorerFolderId, group: ExplorerObjectGroup, depth: number, entries: SchemaObjectInfo[]) =>
    entries.map((object) => ({
      kind: "object" as const,
      key: `${folder}-${schemaName}-${object.name}`,
      schemaName,
      object,
      group,
      depth,
    }));

  if (!showSystemFolders) {
    return [
      ...pushObjects("functions-table-valued", "table-functions", 3, section.tableFunctions),
      ...pushObjects("functions-scalar", "scalar-functions", 3, section.scalarFunctions),
      ...pushObjects("functions-aggregate", "aggregate-functions", 3, section.aggregateFunctions),
    ];
  }

  const subfolders: Array<{
    folder: ExplorerFolderId;
    group: ExplorerObjectGroup;
    entries: SchemaObjectInfo[];
  }> = [
    { folder: "functions-table-valued", group: "table-functions", entries: section.tableFunctions },
    { folder: "functions-scalar", group: "scalar-functions", entries: section.scalarFunctions },
    { folder: "functions-aggregate", group: "aggregate-functions", entries: section.aggregateFunctions },
    { folder: "functions-system", group: "system-functions", entries: section.systemFunctions },
  ];
  const items: ExplorerFlatItem[] = [];
  for (const { folder, group, entries } of subfolders) {
    items.push(buildFolderRow(schemaName, folder, 3, entries.length, isOpen));
    if (isOpen(explorerFolderKey(schemaName, folder))) {
      if (entries.length > 0) items.push(...pushObjects(folder, group, 4, entries));
      else items.push({ kind: "empty-folder", key: `${explorerFolderKey(schemaName, folder)}::empty`, schemaName, folder, depth: 4 });
    }
  }
  return items;
}

/**
 * Children of the Types container (SSMS): System Data Types → 9 categories,
 * then User-Defined Data Types / User-Defined Table Types / User-Defined
 * Types (CLR) / XML Schema Collections. Types is a pure container — no own
 * "No items" placeholder. Pure: returns the rows without touching the list.
 */
function buildTypesItems(
  section: ExplorerSchemaSection,
  showSystemFolders: boolean,
  isOpen: IsOpenFn,
): ExplorerFlatItem[] {
  const schemaName = section.schemaName;
  const pushObjects = (folder: ExplorerFolderId, group: ExplorerObjectGroup, depth: number, entries: SchemaObjectInfo[]) =>
    entries.map((object) => ({
      kind: "object" as const,
      key: `${folder}-${schemaName}-${object.name}`,
      schemaName,
      object,
      group,
      depth,
    }));
  const pushFolderRows = (
    folder: ExplorerFolderId,
    depth: number,
    entries: SchemaObjectInfo[],
    group: ExplorerObjectGroup,
  ): ExplorerFlatItem[] => {
    const rows: ExplorerFlatItem[] = [buildFolderRow(schemaName, folder, depth, entries.length, isOpen)];
    if (isOpen(explorerFolderKey(schemaName, folder))) {
      if (entries.length > 0) rows.push(...pushObjects(folder, group, depth + 1, entries));
      else rows.push({ kind: "empty-folder", key: `${explorerFolderKey(schemaName, folder)}::empty`, schemaName, folder, depth: depth + 1 });
    }
    return rows;
  };

  const items: ExplorerFlatItem[] = [];
  const sdtKey = explorerFolderKey(schemaName, "system-data-types");
  items.push(buildFolderRow(schemaName, "system-data-types", 3, section.systemTypes.length, isOpen));
  if (isOpen(sdtKey)) {
    for (const { folder, category } of SYSTEM_TYPE_CATEGORY_FOLDERS) {
      const entries = section.systemTypes.filter(
        (typeObject) => systemTypeCategory(typeObject.object_type) === category,
      );
      items.push(...pushFolderRows(folder, 4, entries, "system-types"));
    }
  }
  if (section.userDefinedTypes.length > 0 || showSystemFolders) {
    items.push(...pushFolderRows("user-defined-types", 3, section.userDefinedTypes, "user-defined-types"));
  }
  if (section.userTableTypes.length > 0 || showSystemFolders) {
    items.push(...pushFolderRows("user-table-types", 3, section.userTableTypes, "user-table-types"));
  }
  if (section.clrTypes.length > 0 || showSystemFolders) {
    items.push(...pushFolderRows("clr-types", 3, section.clrTypes, "clr-types"));
  }
  if (section.xmlSchemaCollections.length > 0 || showSystemFolders) {
    items.push(...pushFolderRows("xml-schema-collections", 3, section.xmlSchemaCollections, "xml-schema-collections"));
  }
  return items;
}

/** Rough per-row height estimates (px); real heights are measured at runtime. */
export function estimateExplorerItemSize(item: ExplorerFlatItem): number {
  switch (item.kind) {
    case "schema-head":
      return 26;
    case "folder":
      return 26;
    case "empty-folder":
      return 22;
    default:
      return 32;
  }
}
