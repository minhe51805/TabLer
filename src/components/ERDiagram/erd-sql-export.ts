import type { DatabaseType, ERRelationship } from "../../types/database";

function quoteIdentifier(dbType: DatabaseType, value: string) {
  if (dbType === "mysql" || dbType === "mariadb") return "`" + value.replace(/`/g, "``") + "`";
  return '"' + value.replace(/"/g, '""') + '"';
}

function qualifyTable(dbType: DatabaseType, table: string, database?: string) {
  const parts = table.split(".").filter(Boolean);
  if ((dbType === "mysql" || dbType === "mariadb") && database && parts.length === 1) parts.unshift(database);
  return parts.map((part) => quoteIdentifier(dbType, part)).join(".");
}

function constraintName(relationship: ERRelationship) {
  return `fk_${relationship.fromTable}_${relationship.fromColumn}_${relationship.toTable}_${relationship.toColumn}`
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .slice(0, 60);
}

/** Builds review-only DDL for relationships drawn manually in the ER diagram. */
export function buildERDiagramSqlExport(
  dbType: DatabaseType,
  relationships: ERRelationship[],
  database?: string,
) {
  const customRelationships = relationships.filter((relationship) => relationship.isCustom);
  const existingRelationships = relationships.filter((relationship) => !relationship.isCustom);
  const statements = customRelationships.map((relationship) => {
    const source = qualifyTable(dbType, relationship.fromTable, database);
    const target = qualifyTable(dbType, relationship.toTable, database);
    return `ALTER TABLE ${source} ADD CONSTRAINT ${quoteIdentifier(dbType, constraintName(relationship))} FOREIGN KEY (${quoteIdentifier(dbType, relationship.fromColumn)}) REFERENCES ${target} (${quoteIdentifier(dbType, relationship.toColumn)})`;
  });
  const notes = existingRelationships.map((relationship) => `-- Existing relationship retained: ${relationship.fromTable}.${relationship.fromColumn} -> ${relationship.toTable}.${relationship.toColumn}`);

  return [
    "-- Review this migration before executing it. This export does not apply any database changes.",
    ...notes,
    ...statements.map((statement) => `${statement};`),
  ].join("\n");
}
