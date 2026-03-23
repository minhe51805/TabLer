import type { SchemaObjectInfo, TableInfo } from "../../types";

export function getQualifiedTableName(table: Pick<TableInfo, "name" | "schema">) {
  return table.schema ? `${table.schema}.${table.name}` : table.name;
}

export function quoteIdentifier(identifier: string, dbType?: string) {
  const quote = dbType === "mysql" || dbType === "mariadb" ? "`" : `"`;
  const escaped = identifier.split(quote).join(`${quote}${quote}`);
  return `${quote}${escaped}${quote}`;
}

export function getQuotedQualifiedTableName(table: Pick<TableInfo, "name" | "schema">, dbType?: string) {
  if (!table.schema) return quoteIdentifier(table.name, dbType);
  return `${quoteIdentifier(table.schema, dbType)}.${quoteIdentifier(table.name, dbType)}`;
}

export function normalizeObjectSql(object: SchemaObjectInfo) {
  const qualifiedName = object.schema ? `${object.schema}.${object.name}` : object.name;
  const rawDefinition = object.definition?.trim();

  if (!rawDefinition) {
    return `-- ${object.object_type} ${qualifiedName}`;
  }

  const normalizedHead = rawDefinition.slice(0, 24).toUpperCase();
  if (normalizedHead.startsWith("CREATE ")) {
    return rawDefinition.endsWith(";") ? rawDefinition : `${rawDefinition};`;
  }

  if (object.object_type === "VIEW") {
    return `CREATE VIEW ${qualifiedName} AS\n${rawDefinition.replace(/;+\s*$/, "")};`;
  }

  return `-- ${object.object_type} ${qualifiedName}\n${rawDefinition}`;
}

export async function copyToClipboard(value: string) {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}
