/**
 * Schema → code generation for the sidebar "Copy as code" menu.
 *
 * Pure functions: ColumnDetail[] in, source text out. One opinionated type
 * mapping per target — no options dialog (see plans/260922-1730).
 */

import type { ColumnDetail } from "../types/database";

export type CodegenTarget = "typescript" | "zod" | "rust" | "go" | "jsonschema";

export interface CodegenResult {
  code: string;
  /** PascalCase identifier derived from the table name, e.g. "OrderItems". */
  typeName: string;
  fieldCount: number;
}

type TypeClass =
  | "int"
  | "bigint"
  | "decimal"
  | "float"
  | "bool"
  | "date"
  | "time"
  | "datetime"
  | "uuid"
  | "json"
  | "binary"
  | "text";

const TYPE_CLASS_BY_SQL: Record<string, TypeClass> = {
  int: "int",
  integer: "int",
  smallint: "int",
  tinyint: "int",
  mediumint: "int",
  serial: "int",
  smallserial: "int",
  int2: "int",
  int4: "int",
  bigint: "bigint",
  bigserial: "bigint",
  int8: "bigint",
  decimal: "decimal",
  numeric: "decimal",
  money: "decimal",
  float: "float",
  real: "float",
  double: "float",
  "double precision": "float",
  float4: "float",
  float8: "float",
  bool: "bool",
  boolean: "bool",
  date: "date",
  time: "time",
  timetz: "time",
  timestamp: "datetime",
  timestamptz: "datetime",
  datetime: "datetime",
  "timestamp with time zone": "datetime",
  "timestamp without time zone": "datetime",
  uuid: "uuid",
  uniqueidentifier: "uuid",
  json: "json",
  jsonb: "json",
  blob: "binary",
  bytea: "binary",
  binary: "binary",
  varbinary: "binary",
  image: "binary",
};

/** Normalizes a SQL data_type (+ optional column_type) to a TypeClass. */
export function normalizeType(dataType: string, _columnType?: string | null): TypeClass {
  const base = dataType
    .toLowerCase()
    .replace(/\(.*\)/, "")
    .trim();
  return TYPE_CLASS_BY_SQL[base] ?? "text";
}

export function toPascalCase(name: string): string {
  const parts = name.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  const joined = parts.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("");
  return joined || "Generated";
}

function toSnakeCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .toLowerCase()
    .replace(/^_+|_+$/g, "");
}

const RUST_KEYWORDS: Record<string, true> = {
  type: true,
  match: true,
  ref: true,
  box: true,
  crate: true,
  self: true,
  mod: true,
  fn: true,
  let: true,
  pub: true,
  struct: true,
  enum: true,
  impl: true,
  where: true,
  loop: true,
  move: true,
  mut: true,
  dyn: true,
};

const GO_KEYWORDS: Record<string, true> = {
  type: true,
  func: true,
  map: true,
  range: true,
  chan: true,
  var: true,
  string: true,
  int: true,
  package: true,
  import: true,
  interface: true,
};

function isValidTsIdent(name: string): boolean {
  return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name);
}

/** Deduplicates sanitized identifiers with _2, _3 suffixes. */
function dedupe(names: string[]): string[] {
  const counts: Record<string, number> = {};
  return names.map((name) => {
    const seen = counts[name] ?? 0;
    counts[name] = seen + 1;
    return seen === 0 ? name : `${name}_${seen + 1}`;
  });
}

function tsType(cls: TypeClass, nullable: boolean): string {
  const base: Record<TypeClass, string> = {
    int: "number",
    bigint: "bigint",
    decimal: "string",
    float: "number",
    bool: "boolean",
    date: "string",
    time: "string",
    datetime: "string",
    uuid: "string",
    json: "unknown",
    binary: "Uint8Array",
    text: "string",
  };
  return nullable ? `${base[cls]} | null` : base[cls];
}

function zodType(cls: TypeClass, nullable: boolean): string {
  const base: Record<TypeClass, string> = {
    int: "z.number().int()",
    bigint: "z.bigint()",
    decimal: "z.string()",
    float: "z.number()",
    bool: "z.boolean()",
    date: "z.string().date()",
    time: "z.string().time()",
    datetime: "z.string().datetime()",
    uuid: "z.string().uuid()",
    json: "z.unknown()",
    binary: "z.instanceof(Uint8Array)",
    text: "z.string()",
  };
  return nullable ? `${base[cls]}.nullable()` : base[cls];
}

function rustType(cls: TypeClass, nullable: boolean): string {
  const base: Record<TypeClass, string> = {
    int: "i32",
    bigint: "i64",
    decimal: "String",
    float: "f64",
    bool: "bool",
    date: "String",
    time: "String",
    datetime: "String",
    uuid: "String",
    json: "serde_json::Value",
    binary: "Vec<u8>",
    text: "String",
  };
  return nullable ? `Option<${base[cls]}>` : base[cls];
}

function goType(cls: TypeClass, nullable: boolean): string {
  const base: Record<TypeClass, string> = {
    int: "int64",
    bigint: "int64",
    decimal: "string",
    float: "float64",
    bool: "bool",
    date: "time.Time",
    time: "time.Time",
    datetime: "time.Time",
    uuid: "string",
    json: "json.RawMessage",
    binary: "[]byte",
    text: "string",
  };
  const t = base[cls];
  // Pointer only for nullable scalars; slices stay bare.
  if (!nullable || t === "[]byte" || t === "json.RawMessage") return t;
  return `*${t}`;
}

/** Go import paths the generated struct needs. */
export function goImports(columns: ColumnDetail[]): string[] {
  const classes = columns.map((c) => normalizeType(c.data_type, c.column_type));
  const imports: string[] = [];
  if (classes.some((c) => c === "date" || c === "time" || c === "datetime")) {
    imports.push("time");
  }
  if (classes.some((c) => c === "json")) {
    imports.push("encoding/json");
  }
  return imports;
}

function jsonSchemaType(cls: TypeClass, nullable: boolean): Record<string, unknown> {
  switch (cls) {
    case "int":
    case "bigint":
      return { type: nullable ? ["integer", "null"] : "integer" };
    case "float":
      return { type: nullable ? ["number", "null"] : "number" };
    case "bool":
      return { type: nullable ? ["boolean", "null"] : "boolean" };
    case "date":
      return { type: nullable ? ["string", "null"] : "string", format: "date" };
    case "time":
      return { type: nullable ? ["string", "null"] : "string", format: "time" };
    case "datetime":
      return {
        type: nullable ? ["string", "null"] : "string",
        format: "date-time",
      };
    case "uuid":
      return { type: nullable ? ["string", "null"] : "string", format: "uuid" };
    case "json":
      return {};
    case "binary":
      return {
        type: nullable ? ["string", "null"] : "string",
        contentEncoding: "base64",
      };
    default:
      return { type: nullable ? ["string", "null"] : "string" };
  }
}

function emitTypeScript(columns: ColumnDetail[], typeName: string): string {
  const names = dedupe(columns.map((c) => c.name));
  const lines = columns.map((col, i) => {
    const cls = normalizeType(col.data_type, col.column_type);
    const key = isValidTsIdent(names[i]) ? names[i] : JSON.stringify(names[i]);
    const comment = col.comment ? `  /** ${col.comment} */\n` : "";
    const pk = col.is_primary_key ? " // primary key" : "";
    return `${comment}  ${key}: ${tsType(cls, col.is_nullable)};${pk}`;
  });
  return `export interface ${typeName} {\n${lines.join("\n")}\n}\n`;
}

function emitZod(columns: ColumnDetail[], typeName: string): string {
  const names = dedupe(columns.map((c) => c.name));
  const varName = typeName.charAt(0).toLowerCase() + typeName.slice(1);
  const lines = columns.map((col, i) => {
    const cls = normalizeType(col.data_type, col.column_type);
    const key = isValidTsIdent(names[i]) ? names[i] : JSON.stringify(names[i]);
    const comment = col.comment ? `  /** ${col.comment} */\n` : "";
    const pk = col.is_primary_key ? " // primary key" : "";
    return `${comment}  ${key}: ${zodType(cls, col.is_nullable)},${pk}`;
  });
  return (
    `export const ${varName}Schema = z.object({\n${lines.join("\n")}\n});\n\n` +
    `export type ${typeName} = z.infer<typeof ${varName}Schema>;\n`
  );
}

function emitRust(columns: ColumnDetail[], typeName: string): string {
  const names = dedupe(columns.map((c) => toSnakeCase(c.name) || "field"));
  const lines = columns.map((col, i) => {
    const cls = normalizeType(col.data_type, col.column_type);
    let ident = names[i];
    if (RUST_KEYWORDS[ident]) ident = `r#${ident}`;
    const comment = col.comment ? `    /// ${col.comment}\n` : "";
    const pk = col.is_primary_key ? "    // primary key\n" : "";
    const rename =
      ident.replace(/^r#/, "") !== col.name
        ? `    #[serde(rename = ${JSON.stringify(col.name)})]\n`
        : "";
    return `${comment}${pk}${rename}    pub ${ident}: ${rustType(cls, col.is_nullable)},`;
  });
  return (
    `#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]\n` +
    `pub struct ${typeName} {\n${lines.join("\n")}\n}\n`
  );
}

function emitGo(columns: ColumnDetail[], typeName: string): string {
  const names = dedupe(columns.map((c) => toPascalCase(c.name)));
  const imports = goImports(columns);
  const importBlock =
    imports.length > 0 ? `import (\n${imports.map((i) => `\t"${i}"`).join("\n")}\n)\n\n` : "";
  const lines = columns.map((col, i) => {
    const cls = normalizeType(col.data_type, col.column_type);
    let ident = names[i];
    if (GO_KEYWORDS[ident.toLowerCase()]) ident = `${ident}Field`;
    const comment = col.comment ? `\t// ${col.comment}\n` : "";
    const pk = col.is_primary_key ? " // primary key" : "";
    return `${comment}\t${ident} ${goType(cls, col.is_nullable)} \`json:"${col.name}"\`${pk}`;
  });
  return `${importBlock}type ${typeName} struct {\n${lines.join("\n")}\n}\n`;
}

function emitJsonSchema(columns: ColumnDetail[], typeName: string): string {
  const names = dedupe(columns.map((c) => c.name));
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  columns.forEach((col, i) => {
    const cls = normalizeType(col.data_type, col.column_type);
    const schema: Record<string, unknown> = jsonSchemaType(cls, col.is_nullable);
    if (col.comment) schema.description = col.comment;
    if (col.is_primary_key) schema["x-primary-key"] = true;
    properties[names[i]] = schema;
    if (!col.is_nullable) required.push(names[i]);
  });
  return (
    JSON.stringify(
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        title: typeName,
        type: "object",
        properties,
        required,
      },
      null,
      2,
    ) + "\n"
  );
}

export function generateCode(
  columns: ColumnDetail[],
  tableName: string,
  target: CodegenTarget,
): CodegenResult {
  const typeName = toPascalCase(tableName);
  const emitters: Record<CodegenTarget, (c: ColumnDetail[], n: string) => string> = {
    typescript: emitTypeScript,
    zod: emitZod,
    rust: emitRust,
    go: emitGo,
    jsonschema: emitJsonSchema,
  };
  return {
    code: emitters[target](columns, typeName),
    typeName,
    fieldCount: columns.length,
  };
}
