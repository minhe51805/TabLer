import type * as Monaco from "monaco-editor";

export interface SQLTableScope {
  table: string;
  alias: string;
  kind: "table" | "cte";
  columns?: string[];
}

export interface SQLAnalysisContext {
  context:
    | "SELECT"
    | "FROM"
    | "WHERE"
    | "JOIN"
    | "ON"
    | "ORDER BY"
    | "GROUP BY"
    | "HAVING"
    | "SET"
    | "VALUES"
    | "INSERT INTO"
    | "UPDATE"
    | "DELETE FROM"
    | "UNKNOWN";
  table: string | null;
  alias: string | null;
  word: string;
  range: Monaco.IRange;
  isJoinContext: boolean;
  isOnContext: boolean;
  isAliasDefinition: boolean;
}

const CLAUSE_PATTERNS: Array<[SQLAnalysisContext["context"], RegExp]> = [
  ["INSERT INTO", /\bINSERT\s+INTO\b/gi],
  ["DELETE FROM", /\bDELETE\s+FROM\b/gi],
  ["ORDER BY", /\bORDER\s+BY\b/gi],
  ["GROUP BY", /\bGROUP\s+BY\b/gi],
  ["JOIN", /\b(?:LEFT\s+|RIGHT\s+|INNER\s+|OUTER\s+|CROSS\s+|FULL\s+)?JOIN\b/gi],
  ["SELECT", /\bSELECT\b/gi],
  ["FROM", /\bFROM\b/gi],
  ["WHERE", /\bWHERE\b/gi],
  ["ON", /\bON\b/gi],
  ["HAVING", /\bHAVING\b/gi],
  ["SET", /\bSET\b/gi],
  ["VALUES", /\bVALUES\b/gi],
  ["UPDATE", /\bUPDATE\b/gi],
];

const NON_ALIAS_WORDS = new Set([
  "WHERE", "ON", "JOIN", "LEFT", "RIGHT", "INNER", "OUTER", "CROSS", "FULL",
  "ORDER", "GROUP", "HAVING", "LIMIT", "OFFSET", "UNION", "SET", "VALUES",
]);

function lastMatchIndex(text: string, pattern: RegExp) {
  let index = -1;
  for (const match of text.matchAll(pattern)) index = match.index ?? index;
  return index;
}

function normalizeIdentifier(value: string) {
  return value
    .trim()
    .split(".")
    .map((part) => part.replace(/^[`"\x5B]|[`"\x5D]$/g, ""))
    .join(".");
}

function splitTopLevel(text: string) {
  const values: string[] = [];
  let start = 0;
  let depth = 0;
  let quote = "";

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === quote && text[index + 1] === quote) {
        index += 1;
      } else if (char === quote) {
        quote = "";
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth = Math.max(0, depth - 1);
    } else if (char === "," && depth === 0) {
      values.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }

  const last = text.slice(start).trim();
  if (last) values.push(last);
  return values;
}

function readBalanced(text: string, openIndex: number) {
  let depth = 0;
  let quote = "";
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === quote && text[index + 1] === quote) index += 1;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === '"' || char === "`") quote = char;
    else if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return { body: text.slice(openIndex + 1, index), end: index + 1 };
    }
  }
  return null;
}

function deriveSelectColumns(query: string) {
  const selectMatch = /\bSELECT\b/i.exec(query);
  if (!selectMatch) return [];
  const selectBody = query.slice(selectMatch.index + selectMatch[0].length);
  const fromIndex = lastMatchIndex(selectBody, /\bFROM\b/gi);
  const projection = fromIndex >= 0 ? selectBody.slice(0, fromIndex) : selectBody;

  return splitTopLevel(projection)
    .map((value) => {
      const alias = /\bAS\s+([`"\x5B]?[\w$]+[`"\x5D]?)\s*$/i.exec(value)?.[1];
      if (alias) return normalizeIdentifier(alias);
      const trailingIdentifier = /(?:[.`"\x5B])?([\w$]+)[`"\x5D]?\s*$/.exec(value)?.[1];
      return trailingIdentifier && !value.includes("*") ? trailingIdentifier : "";
    })
    .filter(Boolean);
}

function extractCtes(text: string) {
  const ctes = new Map<string, string[]>();
  const prefix = /^\s*WITH(?:\s+RECURSIVE)?\s+/i.exec(text);
  if (!prefix) return ctes;

  let cursor = prefix[0].length;
  while (cursor < text.length) {
    const nameMatch = /^([`"\x5B]?[\w$]+[`"\x5D]?)/.exec(text.slice(cursor));
    if (!nameMatch) break;
    const name = normalizeIdentifier(nameMatch[1]);
    cursor += nameMatch[0].length;
    while (/\s/.test(text[cursor] || "")) cursor += 1;

    let explicitColumns: string[] = [];
    if (text[cursor] === "(") {
      const names = readBalanced(text, cursor);
      if (!names) break;
      explicitColumns = splitTopLevel(names.body).map(normalizeIdentifier).filter(Boolean);
      cursor = names.end;
      while (/\s/.test(text[cursor] || "")) cursor += 1;
    }

    const asMatch = /^AS\s*\(/i.exec(text.slice(cursor));
    if (!asMatch) break;
    const openIndex = cursor + asMatch[0].lastIndexOf("(");
    const body = readBalanced(text, openIndex);
    if (!body) break;
    ctes.set(name.toLowerCase(), explicitColumns.length > 0 ? explicitColumns : deriveSelectColumns(body.body));
    cursor = body.end;
    while (/\s/.test(text[cursor] || "")) cursor += 1;
    if (text[cursor] !== ",") break;
    cursor += 1;
    while (/\s/.test(text[cursor] || "")) cursor += 1;
  }
  return ctes;
}

export function getCteScopes(model: Monaco.editor.ITextModel): SQLTableScope[] {
  return [...extractCtes(model.getValue()).entries()].map(([table, columns]) => ({
    table,
    alias: table,
    kind: "cte",
    columns,
  }));
}

/** Extracts table and CTE aliases currently visible to SQL completion. */
export function extractTableAliases(model: Monaco.editor.ITextModel): Map<string, SQLTableScope> {
  const text = model.getValue();
  const ctes = extractCtes(text);
  const scopes = new Map<string, SQLTableScope>();
  const tablePattern = /\b(?:FROM|JOIN|UPDATE|INTO)\s+((?:[`"\x5B]?[\w$]+[`"\x5D]?)(?:\s*\.\s*(?:[`"\x5B]?[\w$]+[`"\x5D]?))?)(?:\s+(?:AS\s+)?([`"\x5B]?[\w$]+[`"\x5D]?))?/gi;

  for (const match of text.matchAll(tablePattern)) {
    const table = normalizeIdentifier(match[1]);
    const candidateAlias = match[2] ? normalizeIdentifier(match[2]) : "";
    const alias = candidateAlias && !NON_ALIAS_WORDS.has(candidateAlias.toUpperCase())
      ? candidateAlias
      : table.split(".").slice(-1)[0] || table;
    const cteColumns = ctes.get(table.toLowerCase());
    scopes.set(alias.toLowerCase(), {
      table,
      alias,
      kind: cteColumns ? "cte" : "table",
      columns: cteColumns,
    });
  }

  return scopes;
}

export function getTablesInScope(
  model: Monaco.editor.ITextModel,
  _position: Monaco.Position,
): SQLTableScope[] {
  return [...extractTableAliases(model).values()];
}

export function analyzeSqlContext(
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
): SQLAnalysisContext {
  const word = model.getWordUntilPosition(position);
  const range: Monaco.IRange = {
    startLineNumber: position.lineNumber,
    endLineNumber: position.lineNumber,
    startColumn: word.startColumn,
    endColumn: word.endColumn,
  };
  const textBefore = model.getValue().slice(0, model.getOffsetAt(position));

  let context: SQLAnalysisContext["context"] = "UNKNOWN";
  let latestIndex = -1;
  for (const [candidate, pattern] of CLAUSE_PATTERNS) {
    const index = lastMatchIndex(textBefore, pattern);
    if (index > latestIndex) {
      latestIndex = index;
      context = candidate;
    }
  }

  const scopes = getTablesInScope(model, position);
  const activeScope = scopes.length > 0 ? scopes[scopes.length - 1] : null;
  const isAliasDefinition = /\b(?:FROM|JOIN|UPDATE|INTO)\s+[^\s,()]+\s+(?:AS\s+)?[\w$]*$/i.test(textBefore);

  return {
    context,
    table: activeScope?.table ?? null,
    alias: activeScope?.alias ?? null,
    word: word.word,
    range,
    isJoinContext: context === "JOIN",
    isOnContext: context === "ON",
    isAliasDefinition,
  };
}
