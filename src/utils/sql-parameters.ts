import type { QueryParameter, QueryParameterType } from "../types";

export interface SqlParameterDraft {
  value: string;
  dataType: QueryParameterType;
}

type ScanState = "normal" | "lineComment" | "blockComment" | "singleQuote" | "doubleQuote" | "backtick";

export function extractNamedSqlParameters(sql: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  let state: ScanState = "normal";
  let dollarDelimiter: string | null = null;

  for (let index = 0; index < sql.length;) {
    if (dollarDelimiter) {
      if (sql.startsWith(dollarDelimiter, index)) {
        index += dollarDelimiter.length;
        dollarDelimiter = null;
      } else {
        index += 1;
      }
      continue;
    }

    const current = sql[index];
    const next = sql[index + 1];
    if (state === "normal") {
      if (current === "-" && next === "-") { state = "lineComment"; index += 2; continue; }
      if (current === "/" && next === "*") { state = "blockComment"; index += 2; continue; }
      if (current === "'") { state = "singleQuote"; index += 1; continue; }
      if (current === '"') { state = "doubleQuote"; index += 1; continue; }
      if (current === "`") { state = "backtick"; index += 1; continue; }
      if (current === ":" && next === ":") { index += 2; continue; }
      if (current === "$") {
        const delimiterMatch = sql.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
        if (delimiterMatch) { dollarDelimiter = delimiterMatch[0]; index += delimiterMatch[0].length; continue; }
      }
      if ((current === ":" || current === "$" || current === "@") && /[A-Za-z_]/.test(next ?? "")) {
        const match = sql.slice(index + 1).match(/^[A-Za-z_][A-Za-z0-9_]*/);
        if (match) {
          const name = match[0];
          if (!seen.has(name)) { seen.add(name); found.push(name); }
          index += name.length + 1;
          continue;
        }
      }
      index += 1;
      continue;
    }
    if (state === "lineComment") { state = current === "\n" ? "normal" : state; index += 1; continue; }
    if (state === "blockComment") { if (current === "*" && next === "/") { state = "normal"; index += 2; } else { index += 1; } continue; }
    if (state === "singleQuote") { if (current === "'" && next === "'") { index += 2; } else { if (current === "'") state = "normal"; index += 1; } continue; }
    if (state === "doubleQuote") { if (current === '"' && next === '"') { index += 2; } else { if (current === '"') state = "normal"; index += 1; } continue; }
    if (state === "backtick") { if (current === "`") state = "normal"; index += 1; }
  }
  return found;
}

export function toQueryParameters(names: string[], drafts: Record<string, SqlParameterDraft>): QueryParameter[] {
  return names.map((name) => {
    const draft = drafts[name] ?? { value: "", dataType: "text" as const };
    return {
      name,
      dataType: draft.dataType,
      value: coerceParameterValue(draft),
    };
  });
}

function coerceParameterValue(draft: SqlParameterDraft): unknown {
  if (draft.dataType === "null") return null;
  if (draft.dataType === "integer") return Number.parseInt(draft.value, 10);
  if (draft.dataType === "decimal") return Number.parseFloat(draft.value);
  if (draft.dataType === "boolean") return draft.value === "true";
  if (draft.dataType === "json") return JSON.parse(draft.value || "null");
  return draft.value;
}
