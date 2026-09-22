/**
 * `{{param}}` placeholders inside saved SQL favorites.
 *
 * Grammar: `{{name}}`, `{{name:type}}`, `{{name=default}}`,
 * `{{name:type=default}}`. Types: string (default), int, float, bool, date.
 * The type hint comes before `=` so a default may itself contain `:`.
 *
 * Substitution is textual — the resolved SQL is always shown to the user in
 * the fill dialog before it runs. `{{}}` inside quotes/comments still
 * substitutes (documented v1 limitation; no SQL-aware lexer).
 */

export type SqlParamType = "string" | "int" | "float" | "bool" | "date";

export interface SqlParam {
  name: string;
  type: SqlParamType;
  default?: string;
  /** Number of `{{name…}}` occurrences in the SQL. */
  occurrences: number;
}

export interface ParamIssue {
  name: string;
  message: string;
}

/** Blocking validation failure — the run must not proceed. */
export class ParamError extends Error {
  /** The param that failed validation. */
  readonly paramName: string;

  constructor(paramName: string, message: string) {
    super(message);
    this.name = "ParamError";
    this.paramName = paramName;
  }
}

export interface SubstituteResult {
  sql: string;
  /** Non-blocking issues, e.g. an int param got non-numeric input. */
  warnings: ParamIssue[];
}

const PARAM_PATTERN =
  /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*(?::\s*(int|float|bool|date|string)\s*)?(?:=\s*([^}]*?)\s*)?\}\}/g;

const NUMERIC_PATTERN = /^-?\d+(\.\d+)?$/;

const BOOL_TRUE: Record<string, true> = { true: true, "1": true, yes: true };
const BOOL_FALSE: Record<string, true> = { false: true, "0": true, no: true };

function escapeSqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
/** A default wrapped in single quotes means the literal value inside. */
function unwrapDefault(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")
    ? trimmed.slice(1, -1)
    : trimmed;
}

/** Extracts deduplicated params in order of first appearance. */
export function extractParams(sql: string): SqlParam[] {
  const params: SqlParam[] = [];
  const byName: Record<string, SqlParam> = {};
  for (const match of sql.matchAll(PARAM_PATTERN)) {
    const [, name, type, rawDefault] = match;
    const existing = byName[name];
    if (existing) {
      existing.occurrences += 1;
      continue;
    }
    const param: SqlParam = {
      name,
      type: (type as SqlParamType | undefined) ?? "string",
      default: rawDefault !== undefined ? unwrapDefault(rawDefault) : undefined,
      occurrences: 1,
    };
    byName[name] = param;
    params.push(param);
  }
  return params;
}

function renderValue(param: SqlParam, raw: string, warnings: ParamIssue[]): string {
  const value = raw.trim();
  switch (param.type) {
    case "int":
    case "float":
      if (NUMERIC_PATTERN.test(value)) return value;
      warnings.push({
        name: param.name,
        message: `${param.name} expected a number; quoted as string`,
      });
      return escapeSqlString(value);
    case "bool": {
      const lowered = value.toLowerCase();
      if (BOOL_TRUE[lowered]) return "TRUE";
      if (BOOL_FALSE[lowered]) return "FALSE";
      throw new ParamError(
        param.name,
        `${param.name} expects true/false/1/0/yes/no, got "${value}"`,
      );
    }
    case "date":
    case "string":
    default:
      return escapeSqlString(value);
  }
}

/**
 * Replaces every `{{param}}` with its resolved literal.
 * Throws ParamError on a missing value or an invalid bool.
 */
export function substituteParams(sql: string, values: Record<string, string>): SubstituteResult {
  const params = extractParams(sql);
  const warnings: ParamIssue[] = [];
  const rendered: Record<string, string> = {};

  for (const param of params) {
    const raw = values[param.name];
    const effective = raw !== undefined && raw !== "" ? raw : param.default;
    if (effective === undefined || effective === "") {
      throw new ParamError(param.name, `${param.name} has no value`);
    }
    rendered[param.name] = renderValue(param, effective, warnings);
  }

  const resolved = sql.replace(PARAM_PATTERN, (whole, name: string) => {
    return rendered[name] ?? whole;
  });

  return { sql: resolved, warnings };
}
