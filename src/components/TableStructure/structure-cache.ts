import type { ColumnDetail, TableStructure } from "../../types";

/**
 * Module-level structure caches shared by every TableStructure instance.
 * Keyed by `${connectionId}|${database}|${tableName}`.
 */

export const columnCache = new Map<string, ColumnDetail[]>();
export const fullStructureCache = new Map<string, TableStructure>();

/** localStorage prefix for persisted schema snapshots. */
export const schemaSnapshotPrefix = "tabler.schema-snapshot.v1";
