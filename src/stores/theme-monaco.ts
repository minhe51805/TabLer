import { ThemeEngine } from "./theme-engine";

// ---------------------------------------------------------------------------
// NOTE: `(monaco as any)` is required here because `registerMonacoTheme` receives
// `unknown` — `monaco-editor` types are not available at the module level.
// This is safe because the caller (use-sql-editor) always passes a real
// Monaco instance. The `(monaco as any)` avoids a @monaco-editor/react type mismatch.

export function registerMonacoTheme(monaco: unknown): void {
  const theme = ThemeEngine.loadActive();
  const { editor } = theme.colors;


  const m = monaco as any;

  // MiniMax uses a light editor surface (#FFFFFF). The theme id is kept as
  // "tabler-dark" for backward compatibility with callers, but the Monaco base
  // is "vs" (light) so the editor chrome matches the MiniMax white canvas.
  m.editor.defineTheme("tabler-dark", {
    base: "vs",
    inherit: true,
    rules: [
      { token: "keyword", foreground: editor.syntax.keyword, fontStyle: "bold" },
      { token: "string", foreground: editor.syntax.string },
      { token: "number", foreground: editor.syntax.number },
      { token: "comment", foreground: editor.syntax.comment, fontStyle: "italic" },
      { token: "operator", foreground: editor.syntax.operator },
      { token: "delimiter", foreground: editor.text },
      { token: "identifier", foreground: editor.text },
      { token: "type", foreground: editor.syntax.type },
    ],
    colors: {
      "editor.background": editor.background,
      "editor.foreground": editor.text,
      "editor.selectionBackground": editor.selection,
      "editor.lineHighlightBackground": editor.currentLineHighlight,
      "editorCursor.foreground": editor.cursor,
      "editorLineNumber.foreground": editor.lineNumber,
      "editorLineNumber.activeForeground": editor.text,
    },
  });
}
