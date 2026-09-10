/**
 * Database-doc collector (Group-2 Feature 9): walks the tables of the active
 * database, pulls each structure through the cached query-store loaders, and
 * funnels the Markdown/HTML book through the native save dialog.
 */

import type { DocDatabase, DocTable } from "./schema-doc-generator";
import { generateHtmlDocs, generateMarkdownDocs } from "./schema-doc-generator";
import { saveExportFile } from "./tauri-utils";
import { useConnectionStore } from "../stores/connectionStore";
import { useQueryStore } from "../stores/queryStore";

async function collectTableDocs(
  connectionId: string,
  tableName: string,
  database?: string,
): Promise<DocTable> {
  const { getTableStructure } = useQueryStore.getState();
  const structure = await getTableStructure(connectionId, tableName, database);
  return {
    name: tableName,
    columns: structure.columns.map((column) => ({
      name: column.name,
      data_type: column.column_type || column.data_type,
      is_nullable: column.is_nullable,
      is_primary_key: Boolean(column.is_primary_key),
      default_value: column.default_value,
      comment: column.comment,
    })),
    indexes: structure.indexes.map((index) => ({
      name: index.name,
      columns: [...index.columns],
      is_unique: Boolean(index.is_unique),
    })),
    foreignKeys: structure.foreign_keys.map((fk) => ({
      name: fk.name,
      column: fk.column,
      referenced_table: fk.referenced_table,
      referenced_column: fk.referenced_column,
      on_delete: fk.on_delete,
      on_update: fk.on_update,
    })),
  };
}

/** Walk every table of the database and assemble the doc payload. */
export async function collectDatabaseDocs(
  connectionId: string,
  databaseName: string,
  tableNames?: readonly string[],
): Promise<DocDatabase> {
  const connectionState = useConnectionStore.getState();
  // Only real tables go into the book — views carry no indexes/FKs and
  // would inflate the doc with near-duplicate sections.
  const names = tableNames
    ?? connectionState.tables
      .filter((table) => !table.table_type || /table/i.test(table.table_type))
      .map((table) => table.name);
  if (names.length === 0) {
    throw new Error("No tables found for this database.");
  }

  const collected: DocTable[] = [];
  for (const tableName of names) {
    collected.push(await collectTableDocs(connectionId, tableName, databaseName));
  }
  return { name: databaseName, tables: collected };
}

/** Collect + open the native save dialog with the chosen format. */
export async function saveDatabaseDocs(
  connectionId: string,
  databaseName: string,
  format: "markdown" | "html",
  tableNames?: readonly string[],
): Promise<string | null> {
  const docs = await collectDatabaseDocs(connectionId, databaseName, tableNames);
  const baseName = databaseName.replace(/[^\w.-]+/g, "_") || "schema";
  if (format === "html") {
    return saveExportFile({
      fileName: `${baseName}-docs.html`,
      content: generateHtmlDocs(docs),
      filters: [{ name: "HTML", extensions: ["html"] }],
    });
  }
  return saveExportFile({
    fileName: `${baseName}-docs.md`,
    content: generateMarkdownDocs(docs),
    filters: [{ name: "Markdown", extensions: ["md"] }],
  });
}
