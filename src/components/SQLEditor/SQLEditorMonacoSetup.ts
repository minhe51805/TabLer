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

const SQL_KEYWORDS = [
  "SELECT", "FROM", "WHERE", "AND", "OR", "ORDER BY", "GROUP BY", "LIMIT",
  "JOIN", "LEFT JOIN", "INNER JOIN", "ON", "AS", "INSERT INTO", "VALUES",
  "UPDATE", "SET", "DELETE FROM", "CREATE TABLE", "DROP TABLE", "ALTER TABLE",
];

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

      const keywordSuggestions = SQL_KEYWORDS.map((k) => ({
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
