import type * as Monaco from "monaco-editor";
import type { TableStructure } from "../../types";
import {
  analyzeSqlContext,
  getCteScopes,
  getTablesInScope,
  type SQLTableScope,
} from "./SQLContextAnalyzer";
import { buildJoinConditionSuggestions, normalizeTableKey } from "./sql-join-suggestions";
import { getCompletionSet } from "../../utils/sql-completions";
import type { DatabaseType } from "../../types/database";

export { defineTableRTheme } from "./SQLEditorTheme";

// Type for column objects from the table structure API
type TableColumn = TableStructure["columns"][number];
type CompletionColumn = Pick<TableColumn, "name" | "data_type" | "is_primary_key"> &
  Partial<Pick<TableColumn, "is_nullable" | "default_value" | "comment">>;

// Shape of a Monaco completion item we build internally
type CompletionItem = {
  label: string;
  kind: Monaco.languages.CompletionItemKind;
  insertText: string;
  insertTextRules?: Monaco.languages.CompletionItemInsertTextRule;
  detail?: string;
  documentation?: string;
  sortText?: string;
  range: Monaco.IRange;
};

export interface CompletionProviderDeps {
  /** All available tables */
  getTables: () => Array<{ name: string; schema?: string }>;
  /** Fetch column structure for a given table */
  getTableStructure: (tableName: string) => Promise<TableStructure>;
  /** Database type for dialect-aware completions */
  dbType: DatabaseType | undefined;
}

/** Max parallel `get_table_structure` calls for schema completions; keeps a
 *  first-use burst from hammering a remote database (or the IPC bridge). */
const STRUCTURE_FETCH_CONCURRENCY = 4;

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

export function registerSchemaCompletionProvider(
  monaco: any,
  deps: CompletionProviderDeps,
  _onDispose?: () => void,
): { dispose: () => void; prefetchStructures?: () => Promise<void> } {
  const { getTables, getTableStructure, dbType } = deps;

  async function fetchStructure(tableName: string): Promise<TableStructure> {
    // QueryStore owns the versioned cache, including in-flight deduplication.
    // Keeping a Monaco-local cache would allow stale completions after DDL.
    return getTableStructure(tableName);
  }

  async function fetchScopeColumns(scope: SQLTableScope): Promise<CompletionColumn[]> {
    if (scope.kind === "cte") {
      return (scope.columns ?? []).map((name) => ({
        name,
        data_type: "CTE result",
        is_primary_key: false,
      }));
    }
    return (await fetchStructure(scope.table)).columns;
  }

  function makeRange(range: Monaco.IRange): Monaco.IRange {
    return {
      startLineNumber: range.startLineNumber,
      endLineNumber: range.endLineNumber,
      startColumn: range.startColumn,
      endColumn: range.endColumn,
    };
  }

  function colDetail(col: CompletionColumn, suffix: string): string {
    const pk = col.is_primary_key ? " (PK)" : "";
    const nullable = col.is_nullable === undefined ? "" : col.is_nullable ? " NULL" : " NOT NULL";
    return col.data_type + pk + nullable + suffix;
  }

  function colDoc(col: CompletionColumn): string | undefined {
    const parts: string[] = [];
    if (col.default_value !== undefined) parts.push(`Default: ${col.default_value}`);
    if (col.comment) parts.push(col.comment);
    return parts.length > 0 ? parts.join("\n") : undefined;
  }

  async function provideCompletionItems(
    model: Monaco.editor.ITextModel,
    position: Monaco.Position,
    _context: Monaco.languages.CompletionContext,
    token?: Monaco.CancellationToken,
  ): Promise<Monaco.languages.CompletionList> {
    const analysis = analyzeSqlContext(model, position);
    const word = model.getWordUntilPosition(position);
    const range = makeRange({
      startLineNumber: position.lineNumber,
      endLineNumber: position.lineNumber,
      startColumn: word.startColumn,
      endColumn: word.endColumn,
    });

    const suggestions: CompletionItem[] = [];
    const completionSet = getCompletionSet(dbType);
    const cancelled = () => !!token?.isCancellationRequested;
    const qualifier = analysis.qualifier?.toLowerCase() ?? null;

    const matchesQualifier = (scope: SQLTableScope) =>
      scope.alias.toLowerCase() === qualifier ||
      scope.table.toLowerCase() === qualifier ||
      scope.table.toLowerCase().split(".").pop() === qualifier;

    // A typed `alias.`/`table.` qualifier narrows column suggestions to that
    // one scope; no qualifier means every scope contributes.
    const columnScopes = (scopes: SQLTableScope[]) =>
      qualifier ? scopes.filter(matchesQualifier) : scopes;

    /** Pushes columns for the given scopes. With a qualifier typed the
     *  insertText stays bare — `alias.col` would double the qualifier. */
    async function pushScopeColumns(scopes: SQLTableScope[]) {
      await Promise.all(
        scopes.map(async (scope) => {
          const prefix = qualifier ? "" : scope.alias !== scope.table ? scope.alias + "." : "";
          const suffix = scope.alias !== scope.table ? " [" + scope.alias + "]" : "";
          try {
            const columns = await fetchScopeColumns(scope);
            for (const col of columns) {
              suggestions.push({
                label: col.name,
                kind: monaco.languages.CompletionItemKind.Field,
                insertText: prefix + col.name,
                detail: colDetail(col, suffix),
                documentation: colDoc(col),
                range,
              });
            }
          } catch {
            // Structure unavailable — skip this scope's columns.
          }
        }),
      );
    }

    /** `qualifier.` matched no alias — treat it as a bare table name. */
    async function pushQualifierTableColumns() {
      if (!analysis.qualifier) return;
      try {
        const structure = await fetchStructure(analysis.qualifier);
        for (const col of structure.columns) {
          suggestions.push({
            label: col.name,
            kind: monaco.languages.CompletionItemKind.Field,
            insertText: col.name,
            detail: colDetail(col, ` (${analysis.qualifier})`),
            documentation: colDoc(col),
            range,
          });
        }
      } catch {
        // Not a fetchable table — nothing to add.
      }
    }

    /** Fallback when no FROM/JOIN scope exists: qualified columns of every
     *  known table, fetched under the concurrency cap. */
    async function pushAllTableColumns() {
      const tables = getTables();
      await mapWithConcurrency(tables, STRUCTURE_FETCH_CONCURRENCY, async (t) => {
        try {
          const structure = await fetchStructure(t.name);
          for (const col of structure.columns) {
            suggestions.push({
              label: t.name + "." + col.name,
              kind: monaco.languages.CompletionItemKind.Field,
              insertText: t.name + "." + col.name,
              detail: colDetail(col, " (" + t.name + ")"),
              documentation: colDoc(col),
              range,
            });
          }
        } catch {
          // Skip tables we can't fetch structure for
        }
      });
    }

    const pushTableSuggestions = (detail: string) => {
      // `schema.` filters to that schema; the qualifier is already typed so
      // the insertText stays the bare table name.
      const tables = qualifier
        ? getTables().filter((t) => t.schema?.toLowerCase() === qualifier)
        : getTables();
      for (const table of tables) {
        suggestions.push({
          label: table.name,
          kind: monaco.languages.CompletionItemKind.Class,
          insertText: table.name,
          detail: table.schema ? "schema: " + table.schema : detail,
          documentation: table.schema ? "Schema: " + table.schema : undefined,
          range,
        });
        if (table.schema && !qualifier) {
          suggestions.push({
            label: table.schema + "." + table.name,
            kind: monaco.languages.CompletionItemKind.Class,
            insertText: table.schema + "." + table.name,
            detail: "Table (schema-qualified)",
            range,
          });
        }
      }
    };

    // ── Context-specific completions ──────────────────────────────────────────

    switch (analysis.context) {
      case "FROM":
      case "JOIN": {
        if (!qualifier) {
          for (const cte of getCteScopes(model)) {
            suggestions.push({
              label: cte.table,
              kind: monaco.languages.CompletionItemKind.Class,
              insertText: cte.table,
              detail: "CTE result",
              documentation: cte.columns?.length ? `Columns: ${cte.columns.join(", ")}` : undefined,
              range,
            });
          }
        }
        pushTableSuggestions("Table");

        if (analysis.context === "JOIN" && !analysis.isOnContext) {
          suggestions.push({
            label: "ON",
            kind: monaco.languages.CompletionItemKind.Keyword,
            insertText: "ON ",
            detail: "Join condition",
            range,
          });
          const joinTypes = [
            "LEFT JOIN",
            "RIGHT JOIN",
            "INNER JOIN",
            "FULL JOIN",
            "CROSS JOIN",
            "NATURAL JOIN",
            "LEFT OUTER JOIN",
          ];
          for (const jt of joinTypes) {
            suggestions.push({
              label: jt,
              kind: monaco.languages.CompletionItemKind.Keyword,
              insertText: jt + " ",
              detail: "Join type",
              range,
            });
          }
        }
        break;
      }

      case "ON": {
        const tablesInScope = getTablesInScope(model, position);
        const scoped = columnScopes(tablesInScope);
        const foreignKeysByTable = new Map<string, TableStructure["foreign_keys"]>();
        // FK metadata is collected for every scope (join conditions span both
        // sides); column suggestions respect the qualifier.
        await Promise.all(
          tablesInScope.map(async (scope) => {
            if (scope.kind === "table") {
              try {
                const structure = await fetchStructure(scope.table);
                foreignKeysByTable.set(normalizeTableKey(scope.table), structure.foreign_keys);
                if (!scoped.includes(scope)) return;
                const prefix = qualifier
                  ? ""
                  : scope.alias !== scope.table
                    ? `${scope.alias}.`
                    : "";
                for (const col of structure.columns) {
                  suggestions.push({
                    label: col.name,
                    kind: monaco.languages.CompletionItemKind.Field,
                    insertText: prefix + col.name,
                    detail: colDetail(col, ""),
                    documentation: colDoc(col),
                    range,
                  });
                }
              } catch {
                // Structure unavailable — skip this table's columns and FKs.
              }
              return;
            }
            if (!scoped.includes(scope)) return;
            for (const name of scope.columns ?? []) {
              suggestions.push({
                label: name,
                kind: monaco.languages.CompletionItemKind.Field,
                insertText: name,
                detail: "CTE result",
                range,
              });
            }
          }),
        );
        if (cancelled()) return { suggestions: [], incomplete: false };
        if (qualifier && scoped.length === 0) await pushQualifierTableColumns();
        if (cancelled()) return { suggestions: [], incomplete: false };

        // FK-derived join conditions rank above plain columns via sortText.
        for (const join of buildJoinConditionSuggestions(tablesInScope, foreignKeysByTable)) {
          suggestions.push({
            label: join.label,
            kind: monaco.languages.CompletionItemKind.Snippet,
            insertText: join.insertText,
            detail: join.detail,
            sortText: join.sortText,
            range,
          });
        }

        for (const kw of ["AND", "OR"]) {
          suggestions.push({
            label: kw,
            kind: monaco.languages.CompletionItemKind.Operator,
            insertText: kw + " ",
            detail: "Combine conditions",
            range,
          });
        }
        break;
      }

      case "SELECT": {
        const tablesInScope = getTablesInScope(model, position);

        suggestions.push({
          label: "*",
          kind: monaco.languages.CompletionItemKind.Variable,
          insertText: "*",
          detail: "All columns",
          range,
        });

        const scoped = columnScopes(tablesInScope);
        if (scoped.length > 0) {
          await pushScopeColumns(scoped);
        } else if (qualifier) {
          await pushQualifierTableColumns();
        } else {
          await pushAllTableColumns();
        }
        if (cancelled()) return { suggestions: [], incomplete: false };

        if (!qualifier) {
          for (const kw of ["DISTINCT", "ALL", "AS"]) {
            suggestions.push({
              label: kw,
              kind: monaco.languages.CompletionItemKind.Keyword,
              insertText: kw + " ",
              detail: "SELECT modifier",
              range,
            });
          }
        }
        break;
      }

      case "WHERE": {
        const scoped = columnScopes(getTablesInScope(model, position));
        if (scoped.length > 0) {
          await pushScopeColumns(scoped);
        } else if (qualifier) {
          await pushQualifierTableColumns();
        } else {
          await pushAllTableColumns();
        }
        if (cancelled()) return { suggestions: [], incomplete: false };

        if (!qualifier) {
          const whereOps = [
            "=",
            "!=",
            "<>",
            "<",
            ">",
            "<=",
            ">=",
            "IN",
            "NOT IN",
            "LIKE",
            "NOT LIKE",
            "ILIKE",
            "NOT ILIKE",
            "IS NULL",
            "IS NOT NULL",
            "BETWEEN",
            "NOT BETWEEN",
            "EXISTS",
            "NOT EXISTS",
          ];
          for (const op of whereOps) {
            suggestions.push({
              label: op,
              kind: monaco.languages.CompletionItemKind.Operator,
              insertText: op + " ",
              detail: "Comparison operator",
              range,
            });
          }
          for (const kw of ["AND", "OR", "NOT"]) {
            suggestions.push({
              label: kw,
              kind: monaco.languages.CompletionItemKind.Keyword,
              insertText: kw + " ",
              detail: "Combine conditions",
              range,
            });
          }
        }
        break;
      }

      case "ORDER BY":
      case "GROUP BY":
      case "HAVING": {
        const scoped = columnScopes(getTablesInScope(model, position));
        if (scoped.length > 0) {
          await pushScopeColumns(scoped);
        } else if (qualifier) {
          await pushQualifierTableColumns();
        } else {
          await pushAllTableColumns();
        }
        if (cancelled()) return { suggestions: [], incomplete: false };

        if (analysis.context === "HAVING" && !qualifier) {
          for (const fn of ["COUNT", "SUM", "AVG", "MIN", "MAX"]) {
            const sig = completionSet.functionSignatures[fn.toLowerCase()];
            suggestions.push({
              label: fn,
              kind: monaco.languages.CompletionItemKind.Function,
              insertText: fn + "($1)",
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              detail: sig ? sig.signature : "Aggregate function",
              documentation: sig?.doc,
              range,
            });
          }
        }

        if (analysis.context === "ORDER BY" && !qualifier) {
          for (const dir of ["ASC", "DESC"]) {
            suggestions.push({
              label: dir,
              kind: monaco.languages.CompletionItemKind.Keyword,
              insertText: dir,
              detail: dir === "ASC" ? "Ascending order" : "Descending order",
              range,
            });
          }
        }
        break;
      }

      case "SET": {
        // UPDATE <t> SET — the DML clause names the target table directly,
        // which stays correct even when the editor holds several statements.
        const tableName = analysis.targetTable ?? getTables()[0]?.name;
        if (tableName) {
          try {
            const structure = await fetchStructure(tableName);
            if (cancelled()) return { suggestions: [], incomplete: false };
            for (const col of structure.columns) {
              suggestions.push({
                label: col.name,
                kind: monaco.languages.CompletionItemKind.Field,
                insertText: col.name + " = ",
                detail: colDetail(col, " = value"),
                documentation: colDoc(col),
                range,
              });
            }
          } catch {
            // Skip
          }
        }
        break;
      }

      case "VALUES": {
        suggestions.push({
          label: "NULL",
          kind: monaco.languages.CompletionItemKind.Keyword,
          insertText: "NULL",
          detail: "Null value",
          range,
        });
        suggestions.push({
          label: "DEFAULT",
          kind: monaco.languages.CompletionItemKind.Keyword,
          insertText: "DEFAULT",
          detail: "Default value",
          range,
        });
        break;
      }

      case "UPDATE": {
        pushTableSuggestions("Table to update");
        if (analysis.targetTable && !qualifier) {
          suggestions.push({
            label: "SET",
            kind: monaco.languages.CompletionItemKind.Keyword,
            insertText: "SET ",
            detail: "Assign updated values",
            range,
          });
        }
        break;
      }

      case "INSERT INTO": {
        if (analysis.insertColumnList) {
          // Inside `INSERT INTO t (…)` — offer the columns not yet listed.
          const tableName = analysis.targetTable;
          if (tableName) {
            try {
              const structure = await fetchStructure(tableName);
              if (cancelled()) return { suggestions: [], incomplete: false };
              const used = new Set(analysis.insertColumnList.map((c) => c.toLowerCase()));
              for (const col of structure.columns) {
                if (used.has(col.name.toLowerCase())) continue;
                suggestions.push({
                  label: col.name,
                  kind: monaco.languages.CompletionItemKind.Field,
                  insertText: col.name,
                  detail: colDetail(col, ""),
                  documentation: colDoc(col),
                  range,
                });
              }
            } catch {
              // Skip
            }
          }
          break;
        }

        pushTableSuggestions("Table to insert into");

        // `INSERT INTO t ` (cursor right after the table name) — offer the
        // full column list as a snippet.
        const textBefore = model.getValue().substring(0, model.getOffsetAt(position));
        if (/\bINSERT\s+INTO\s+[^\s,()]+\s*$/i.test(textBefore) && analysis.targetTable) {
          try {
            const structure = await fetchStructure(analysis.targetTable);
            if (cancelled()) return { suggestions: [], incomplete: false };
            const cols = structure.columns.map((c) => c.name).join(", ");
            suggestions.push({
              label: "(column names)",
              kind: monaco.languages.CompletionItemKind.Snippet,
              insertText: "(" + cols + ") VALUES ($1)",
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              detail: "Insert column list",
              range,
            });
          } catch {
            // Skip
          }
        }
        break;
      }

      case "DELETE FROM": {
        pushTableSuggestions("Table to delete from");
        if (analysis.targetTable && !qualifier) {
          suggestions.push({
            label: "WHERE",
            kind: monaco.languages.CompletionItemKind.Keyword,
            insertText: "WHERE ",
            detail: "Filter rows to delete",
            range,
          });
          try {
            const structure = await fetchStructure(analysis.targetTable);
            if (cancelled()) return { suggestions: [], incomplete: false };
            for (const col of structure.columns) {
              suggestions.push({
                label: col.name,
                kind: monaco.languages.CompletionItemKind.Field,
                insertText: col.name,
                detail: colDetail(col, ""),
                documentation: colDoc(col),
                range,
              });
            }
          } catch {
            // Skip
          }
        }
        break;
      }

      default: {
        pushTableSuggestions("Table");
        break;
      }
    }

    // ── Always include: keywords, functions, operators ───────────────────────
    const hasActiveWord = analysis.word.length > 0;

    if (hasActiveWord) {
      for (const kw of completionSet.keywords) {
        if (!suggestions.some((s) => s.label === kw)) {
          suggestions.push({
            label: kw,
            kind: monaco.languages.CompletionItemKind.Keyword,
            insertText: kw,
            detail: "Keyword",
            range,
          });
        }
      }

      for (const fn of completionSet.functions) {
        const sig = completionSet.functionSignatures[fn.toLowerCase()];
        suggestions.push({
          label: fn,
          kind: monaco.languages.CompletionItemKind.Function,
          insertText: fn,
          detail: sig ? sig.signature : "Function",
          documentation: sig?.doc,
          range,
        });
      }

      for (const op of completionSet.operators) {
        suggestions.push({
          label: op,
          kind: monaco.languages.CompletionItemKind.Operator,
          insertText: op,
          detail: "Operator",
          range,
        });
      }
    }

    return { suggestions, incomplete: hasActiveWord };
  }

  const disposable = monaco.languages.registerCompletionItemProvider("sql", {
    provideCompletionItems,
    triggerCharacters: [" ", ".", "(", ",", "*"],
  });

  return {
    dispose: () => disposable.dispose(),
    /** Warms the versioned structure cache so the first completion burst
     *  never fires dozens of parallel metadata queries. */
    prefetchStructures: () =>
      mapWithConcurrency(getTables(), 3, (t) => fetchStructure(t.name).catch(() => undefined)).then(
        () => undefined,
      ),
  };
}

/** Legacy completion provider providing only table names + basic SQL keywords. */
export function registerStandardCompletionProvider(
  monaco: any,
  getTables: () => Array<{ name: string }>,
  _onDispose?: () => void,
): { dispose: () => void } {
  return monaco.languages.registerCompletionItemProvider("sql", {
    provideCompletionItems: (model: any, position: any) => {
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };

      const currentTables = getTables();
      const tableSuggestions = currentTables.map((t) => ({
        label: t.name,
        kind: monaco.languages.CompletionItemKind.Class,
        insertText: t.name,
        detail: "Table",
        range,
      }));

      const keywordSuggestions = [
        "SELECT",
        "FROM",
        "WHERE",
        "AND",
        "OR",
        "ORDER BY",
        "GROUP BY",
        "LIMIT",
        "JOIN",
        "LEFT JOIN",
        "INNER JOIN",
        "ON",
        "AS",
        "INSERT INTO",
        "VALUES",
        "UPDATE",
        "SET",
        "DELETE FROM",
        "CREATE TABLE",
        "DROP TABLE",
        "ALTER TABLE",
      ].map((k) => ({
        label: k,
        kind: monaco.languages.CompletionItemKind.Keyword,
        insertText: k,
        detail: "Keyword",
        range,
      }));

      return { suggestions: [...tableSuggestions, ...keywordSuggestions] };
    },
  });
}
