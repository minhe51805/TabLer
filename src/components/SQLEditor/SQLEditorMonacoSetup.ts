import type * as Monaco from "monaco-editor";
import type { TableStructure } from "../../types";
import { analyzeSqlContext, getCteScopes, getTablesInScope, type SQLTableScope } from "./SQLContextAnalyzer";
import { getCompletionSet } from "../../utils/sql-completions";
import type { DatabaseType } from "../../types/database";

export { defineTableRTheme } from "./SQLEditorTheme";

// Type for column objects from the table structure API
type TableColumn = TableStructure["columns"][number];
type CompletionColumn = Pick<TableColumn, "name" | "data_type" | "is_primary_key">;

// Shape of a Monaco completion item we build internally
type CompletionItem = {
  label: string;
  kind: Monaco.languages.CompletionItemKind;
  insertText: string;
  insertTextRules?: Monaco.languages.CompletionItemInsertTextRule;
  detail?: string;
  documentation?: string;
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
  _onDispose?: () => void
): { dispose: () => void; prefetchStructures?: () => Promise<void> } {
  const { getTables, getTableStructure, dbType } = deps;

  async function fetchStructure(tableName: string): Promise<TableStructure> {
    // QueryStore owns the versioned cache, including in-flight deduplication.
    // Keeping a Monaco-local cache would allow stale completions after DDL.
    return getTableStructure(tableName);
  }

  async function fetchScopeColumns(scope: SQLTableScope): Promise<CompletionColumn[]> {
    if (scope.kind === "cte") {
      return (scope.columns ?? []).map((name) => ({ name, data_type: "CTE result", is_primary_key: false }));
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

  function colDetail(col: CompletionColumn, prefix: string): string {
    const pk = col.is_primary_key ? " (PK)" : "";
    return col.data_type + pk + prefix;
  }

   
  async function provideCompletionItems(model: any, position: any): Promise<any> {
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

    // ── Context-specific completions ──────────────────────────────────────────

    switch (analysis.context) {
      case "FROM":
      case "JOIN": {
        const tables = getTables();
        const ctes = getCteScopes(model);
        for (const cte of ctes) {
          suggestions.push({
            label: cte.table,
            kind: monaco.languages.CompletionItemKind.Class,
            insertText: cte.table,
            detail: "CTE result",
            documentation: cte.columns?.length ? `Columns: ${cte.columns.join(", ")}` : undefined,
            range,
          });
        }
        for (const table of tables) {
          const schemaDetail = table.schema ? "schema: " + table.schema : "Table";
          const schemaLabel = table.schema ? table.schema + "." + table.name : table.name;

          suggestions.push({
            label: table.name,
            kind: monaco.languages.CompletionItemKind.Class,
            insertText: table.name,
            detail: schemaDetail,
            documentation: table.schema ? "Schema: " + table.schema : undefined,
            range,
          });
          if (table.schema) {
            suggestions.push({
              label: schemaLabel,
              kind: monaco.languages.CompletionItemKind.Class,
              insertText: schemaLabel,
              detail: "Table (schema-qualified)",
              range,
            });
          }
        }

        if (analysis.context === "JOIN" && !analysis.isOnContext) {
          suggestions.push({
            label: "ON",
            kind: monaco.languages.CompletionItemKind.Keyword,
            insertText: "ON ",
            detail: "Join condition",
            range,
          });
          const joinTypes = [
            "LEFT JOIN", "RIGHT JOIN", "INNER JOIN", "FULL JOIN",
            "CROSS JOIN", "NATURAL JOIN", "LEFT OUTER JOIN",
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
        await Promise.all(
          tablesInScope.map(async (scope) => {
            const columns = await fetchScopeColumns(scope);
            const prefix = scope.alias !== scope.table ? `${scope.alias}.` : "";
            for (const col of columns) {
              suggestions.push({
                label: col.name,
                kind: monaco.languages.CompletionItemKind.Field,
                insertText: prefix + col.name,
                detail: colDetail(col, ""),
                range,
              });
            }
          })
        );
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

        if (tablesInScope.length > 0) {
          await Promise.all(
            tablesInScope.map(async (scope) => {
              const columns = await fetchScopeColumns(scope);
              const prefix = scope.alias !== scope.table ? scope.alias + "." : "";
              for (const col of columns) {
                suggestions.push({
                  label: col.name,
                  kind: monaco.languages.CompletionItemKind.Field,
                  insertText: prefix + col.name,
                  detail: colDetail(col, scope.alias !== scope.table ? " [" + scope.alias + "]" : ""),
                  range,
                });
              }
            })
          );
        } else {
          const tables = getTables();
          await mapWithConcurrency(
            tables,
            STRUCTURE_FETCH_CONCURRENCY,
            async (t) => {
              try {
                const structure = await fetchStructure(t.name);
                for (const col of structure.columns) {
                  suggestions.push({
                    label: t.name + "." + col.name,
                    kind: monaco.languages.CompletionItemKind.Field,
                    insertText: t.name + "." + col.name,
                    detail: col.data_type + " (" + t.name + ")",
                    range,
                  });
                }
              } catch {
                // Skip tables we can't fetch structure for
              }
            }
          );
        }

        for (const kw of ["DISTINCT", "ALL", "AS"]) {
          suggestions.push({
            label: kw,
            kind: monaco.languages.CompletionItemKind.Keyword,
            insertText: kw + " ",
            detail: "SELECT modifier",
            range,
          });
        }
        break;
      }

      case "WHERE": {
        const tablesInScope = getTablesInScope(model, position);
        if (tablesInScope.length > 0) {
          await Promise.all(
            tablesInScope.map(async (scope) => {
              const columns = await fetchScopeColumns(scope);
              const prefix = scope.alias !== scope.table ? `${scope.alias}.` : "";
              for (const col of columns) {
              suggestions.push({
                label: col.name,
                kind: monaco.languages.CompletionItemKind.Field,
                insertText: prefix + col.name,
                  detail: col.data_type,
                  range,
                });
              }
            })
          );
        } else {
          const tables = getTables();
          await mapWithConcurrency(
            tables,
            STRUCTURE_FETCH_CONCURRENCY,
            async (t) => {
              try {
                const structure = await fetchStructure(t.name);
                for (const col of structure.columns) {
                  suggestions.push({
                    label: t.name + "." + col.name,
                    kind: monaco.languages.CompletionItemKind.Field,
                    insertText: t.name + "." + col.name,
                    detail: col.data_type + " (" + t.name + ")",
                    range,
                  });
                }
              } catch {
                // Skip
              }
            }
          );
        }

        const whereOps = [
          "=", "!=", "<>", "<", ">", "<=", ">=",
          "IN", "NOT IN",
          "LIKE", "NOT LIKE", "ILIKE", "NOT ILIKE",
          "IS NULL", "IS NOT NULL",
          "BETWEEN", "NOT BETWEEN",
          "EXISTS", "NOT EXISTS",
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
        break;
      }

      case "ORDER BY":
      case "GROUP BY":
      case "HAVING": {
        const tablesInScope = getTablesInScope(model, position);
        if (tablesInScope.length > 0) {
          await Promise.all(
            tablesInScope.map(async (scope) => {
              const columns = await fetchScopeColumns(scope);
              const prefix = scope.alias !== scope.table ? scope.alias + "." : "";
              for (const col of columns) {
                suggestions.push({
                  label: col.name,
                  kind: monaco.languages.CompletionItemKind.Field,
                  insertText: prefix + col.name,
                  detail: colDetail(col, ""),
                  range,
                });
              }
            })
          );
        } else {
          const tables = getTables();
          await mapWithConcurrency(
            tables,
            STRUCTURE_FETCH_CONCURRENCY,
            async (t) => {
              try {
                const structure = await fetchStructure(t.name);
                for (const col of structure.columns) {
                  suggestions.push({
                    label: t.name + "." + col.name,
                    kind: monaco.languages.CompletionItemKind.Field,
                    insertText: t.name + "." + col.name,
                    detail: colDetail(col, " (" + t.name + ")"),
                    range,
                  });
                }
              } catch {
                // Skip
              }
            }
          );
        }

        if (analysis.context === "HAVING") {
          for (const fn of ["COUNT", "SUM", "AVG", "MIN", "MAX"]) {
            suggestions.push({
              label: fn,
              kind: monaco.languages.CompletionItemKind.Function,
              insertText: fn + "()",
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              detail: "Aggregate function",
              range,
            });
          }
        }

        if (analysis.context === "ORDER BY") {
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
        const tables = getTables();
        if (tables.length > 0) {
          const textBefore = model.getValue().substring(0, model.getOffsetAt(position));
          const updateMatch = textBefore.match(/\bUPDATE\s+([\w]+)/i);
          const tableName = updateMatch ? updateMatch[1] : tables[0].name;

          if (tableName) {
            try {
              const structure = await fetchStructure(tableName);
              for (const col of structure.columns) {
                suggestions.push({
                  label: col.name,
                  kind: monaco.languages.CompletionItemKind.Field,
                  insertText: col.name + " = ",
                  insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                  detail: col.data_type + " = value",
                  range,
                });
              }
            } catch {
              // Skip
            }
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
        const tables = getTables();
        for (const table of tables) {
          suggestions.push({
            label: table.name,
            kind: monaco.languages.CompletionItemKind.Class,
            insertText: table.name,
            detail: "Table to update",
            range,
          });
        }
        break;
      }

      case "INSERT INTO": {
        const tables = getTables();
        for (const table of tables) {
          suggestions.push({
            label: table.name,
            kind: monaco.languages.CompletionItemKind.Class,
            insertText: table.name,
            detail: "Table to insert into",
            range,
          });
        }

        const textBefore = model.getValue().substring(0, model.getOffsetAt(position));
        const insertMatch = textBefore.match(/\bINSERT\s+INTO\s+([\w]+)\s*$/i);
        if (insertMatch) {
          const tableName = insertMatch[1];
          try {
            const structure = await fetchStructure(tableName);
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
        const tables = getTables();
        for (const table of tables) {
          suggestions.push({
            label: table.name,
            kind: monaco.languages.CompletionItemKind.Class,
            insertText: table.name,
            detail: "Table to delete from",
            range,
          });
        }
        break;
      }

      default: {
        const tables = getTables();
        for (const table of tables) {
          const schemaDetail = table.schema ? "schema: " + table.schema : "Table";
          suggestions.push({
            label: table.name,
            kind: monaco.languages.CompletionItemKind.Class,
            insertText: table.name,
            detail: schemaDetail,
            range,
          });
        }
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
        suggestions.push({
          label: fn,
          kind: monaco.languages.CompletionItemKind.Function,
          insertText: fn,
          detail: "Function",
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
      mapWithConcurrency(
        getTables(),
        3,
        (t) => fetchStructure(t.name).catch(() => undefined),
      ).then(() => undefined),
  };
}

/** Legacy completion provider providing only table names + basic SQL keywords. */
export function registerStandardCompletionProvider(
   
  monaco: any,
  getTables: () => Array<{ name: string }>,
  _onDispose?: () => void
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
        "SELECT", "FROM", "WHERE", "AND", "OR", "ORDER BY", "GROUP BY", "LIMIT",
        "JOIN", "LEFT JOIN", "INNER JOIN", "ON", "AS", "INSERT INTO", "VALUES",
        "UPDATE", "SET", "DELETE FROM", "CREATE TABLE", "DROP TABLE", "ALTER TABLE",
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
