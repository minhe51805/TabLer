/**
 * Pure helpers for the ER editor: relationship draft persistence wrappers,
 * column option formatting and filename sanitizing.
 */

import type { ColumnDetail, ERRelationship, TableSchema } from "../../types/database";
import { readCustomERDRelationships, writeCustomERDRelationships } from "../../utils/erd-custom-relationships";
import { getRelationshipSignature } from "./erd-graph";
import type { ERDSelectOption } from "./ERDCompactSelect";
import type { PendingRelationshipDraft } from "./ERDiagram";

export function readCustomRelationships(
  connectionId: string,
  database?: string,
): ERRelationship[] {
  return readCustomERDRelationships(connectionId, database);
}

export function persistCustomRelationships(
  connectionId: string,
  database: string | undefined,
  relationships: ERRelationship[],
) {
  writeCustomERDRelationships(connectionId, database, relationships);
}

export function dedupeRelationships(relationships: ERRelationship[]) {
  const unique = new Map<string, ERRelationship>();

  relationships.forEach((relationship) => {
    unique.set(getRelationshipSignature(relationship), relationship);
  });

  return [...unique.values()];
}

export function getPreferredRelationshipDraft(
  sourceTable: TableSchema,
  targetTable: TableSchema,
): Pick<PendingRelationshipDraft, "sourceColumn" | "targetColumn"> {
  const preferredSource =
    sourceTable.columns.find((column) => column.is_primary_key) ||
    sourceTable.columns[0];
  const preferredNames = new Set(
    [
      preferredSource?.name,
      `${sourceTable.name}_id`,
      `${sourceTable.name.replace(/\s+/g, "_")}_id`,
    ]
      .filter(Boolean)
      .map((value) => value.toLowerCase()),
  );

  const preferredTarget =
    targetTable.columns.find((column) =>
      preferredNames.has(column.name.toLowerCase()),
    ) ||
    targetTable.columns.find((column) => !column.is_primary_key) ||
    targetTable.columns[0];

  return {
    sourceColumn: preferredSource?.name || "",
    targetColumn: preferredTarget?.name || "",
  };
}

export function getColumnOptionLabel(column: ColumnDetail) {
  const parts = [column.data_type];

  if (column.is_primary_key) parts.push("PK");
  if (!column.is_nullable) parts.push("NOT NULL");

  return parts.join(" / ");
}

export function getColumnSelectOption(column: ColumnDetail): ERDSelectOption {
  return {
    value: column.name,
    label: column.name,
    meta: getColumnOptionLabel(column),
  };
}

export function sanitizeFileName(value: string) {
  return value
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function getQualifiedTableName(table: Pick<TableSchema, "name" | "schema">) {
  return table.schema ? `${table.schema}.${table.name}` : table.name;
}
