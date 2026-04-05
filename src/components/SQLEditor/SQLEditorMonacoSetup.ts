import type * as Monaco from "monaco-editor";
import type { TableStructure } from "../../types";
import { analyzeSqlContext, getTablesInScope } from "./SQLContextAnalyzer";
import { getCompletionSet } from "../../utils/sql-completions";
import type { DatabaseType } from "../../types/database";

// Theme definition matching Monaco's IStandaloneThemeData shape
const TABLER_DARK_THEME = {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "keyword", foreground: "22D3EE", fontStyle: "bold" },
    { token: "string", foreground: "7FE0C2" },
    { token: "number", foreground: "7DC9D8" },
    { token: "comment", foreground: "65789A", fontStyle: "italic" },
    { token: "operator", foreground: "22D3EE" },
  ],
  colors: {
    "editor.background": "#101826",
    "editor.foreground": "#e7ecf8",
    "editor.selectionBackground": "#22d3ee2a",
    "editor.lineHighlightBackground": "#0b2f3c66",
    "editorCursor.foreground": "#22d3ee",
    "editorLineNumber.foreground": "#62779d",
    "editorLineNumber.activeForeground": "#e7ecf8",
  },
};

export function defineTableRTheme(monaco: any) {
  monaco.editor.defineTheme("tabler-dark", TABLER_DARK_THEME);
}

export interface CompletionProviderDeps {
  /** All available tables */
  getTables: () => Array<{ name: string; schema?: string }>;
  /** Fetch column structure for a given table */
  getTableStructure: (tableName: string) => Promise<TableStructure>;
  /** Database type for dialect-aware completions */
  dbType: DatabaseType | undefined;
}

interface TableStructureCacheEntry {
  structure: TableStructure;
  timestamp: number;
}

const CACHE_TTL_MS = 30_000; // 30 seconds

/**
 * Schema-aware SQL completion provider.
 *
 * Detects the SQL context (SELECT/FROM/WHERE/JOIN/ON/etc.) at the cursor and
 * provides appropriate completions: table names, column names with types,
 * SQL keywords, functions, and operators.
 */
export function registerSchemaCompletionProvider(
  monaco: any,
  deps: CompletionProviderDeps,
  _onDispose?: () => void
): { dispose: () => void } {
  const { getTables, getTableStructure, dbType } = deps;

  // Per-instance cache to avoid repeated backend calls for the same table
  const structureCache = new Map<string, TableStructureCacheEntry>();
  // Deduplicate in-flight fetches
  const fetchInFlight = new Map<string, Promise<TableStructure>>();

  function getCachedStructure(tableName: string): TableStructure | null {
    const cached = structureCache.get(tableName);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return cached.structure;
    }
    return null;
  }

  async function fetchStructure(tableName: string): Promise<TableStructure> {
    const cached = getCachedStructure(tableName);
    if (cached) return cached;

    const inFlight = fetchInFlight.get(tableName);
    if (inFlight) return inFlight;

    const promise = getTableStructure(tableName).finally(() => {
      fetchInFlight.delete(tableName);
    });
    fetchInFlight.set(tableName, promise);

    const structure = await promise;
    structureCache.set(tableName, { structure, timestamp: Date.now() });
    return structure;
  }

  function makeRange(range: Monaco.IRange): Monaco.IRange {
    return {
      startLineNumber: range.startLineNumber,
      endLineNumber: range.endLineNumber,
      startColumn: range.startColumn,
      endColumn: range.endColumn,
    };
  }

  function colDetail(col: any, prefix: string): string {
    const pk = col.is_primary_key ? " (PK)" : "";
    return col.data_type + pk + prefix;
  }

  async function provideCompletionItems(
    model: any,
    position: any
  ): Promise<any> {
    const analysis = analyzeSqlContext(model, position);
    const word = model.getWordUntilPosition(position);
    const range = makeRange({
      startLineNumber: position.lineNumber,
      endLineNumber: position.lineNumber,
      startColumn: word.startColumn,
      endColumn: word.endColumn,
    });

    const suggestions: any[] = [];
    const completionSet = getCompletionSet(dbType);

    // ── Context-specific completions ──────────────────────────────────────────

    switch (analysis.context) {
      case "FROM":
      case "JOIN": {
        const tables = getTables();
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
          tablesInScope.map(async ({ table }) => {
            const structure = await fetchStructure(table);
            for (const col of structure.columns) {
              suggestions.push({
                label: col.name,
                kind: monaco.languages.CompletionItemKind.Field,
                insertText: col.name,
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
            tablesInScope.map(async ({ table, alias }) => {
              const structure = await fetchStructure(table);
              const prefix = alias !== table ? alias + "." : "";
              for (const col of structure.columns) {
                suggestions.push({
                  label: col.name,
                  kind: monaco.languages.CompletionItemKind.Field,
                  insertText: prefix + col.name,
                  detail: colDetail(col, alias !== table ? " [" + alias + "]" : ""),
                  range,
                });
              }
            })
          );
        } else {
          const tables = getTables();
          await Promise.all(
            tables.map(async (t) => {
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
            })
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
            tablesInScope.map(async ({ table }) => {
              const structure = await fetchStructure(table);
              for (const col of structure.columns) {
                suggestions.push({
                  label: col.name,
                  kind: monaco.languages.CompletionItemKind.Field,
                  insertText: col.name,
                  detail: col.data_type,
                  range,
                });
              }
            })
          );
        } else {
          const tables = getTables();
          await Promise.all(
            tables.map(async (t) => {
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
            })
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
            tablesInScope.map(async ({ table, alias }) => {
              const structure = await fetchStructure(table);
              const prefix = alias !== table ? alias + "." : "";
              for (const col of structure.columns) {
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
          await Promise.all(
            tables.map(async (t) => {
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
            })
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

  return monaco.languages.registerCompletionItemProvider("sql", {
    provideCompletionItems,
    triggerCharacters: [" ", ".", "(", ",", "*"],
  });
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
