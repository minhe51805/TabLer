/**
 * Light SQL theme matching the MiniMax palette (see stores/theme-presets).
 * The id is kept as "tabler-dark" for backward compatibility with callers,
 * but the Monaco base is "vs" (light) so the editor chrome matches the white canvas.
 */

// Theme definition matching Monaco's IStandaloneThemeData shape
// Light SQL theme matching the MiniMax palette
// (editor.syntax in MINIMAX_THEME). The id is kept as "tabler-dark" for
// backward compatibility with callers, but the base is "vs" (light) so the
// editor chrome matches the white #FFFFFF canvas.
const TABLER_DARK_THEME = {
  base: "vs",
  inherit: true,
  rules: [
    { token: "keyword", foreground: "0A49A5", fontStyle: "bold" },
    { token: "string", foreground: "C41A16" },
    { token: "number", foreground: "6C36A9" },
    { token: "comment", foreground: "007400", fontStyle: "italic" },
    { token: "operator", foreground: "000000" },
    { token: "delimiter", foreground: "000000" },
    { token: "identifier", foreground: "000000" },
    { token: "type", foreground: "3F6E74" },
  ],
  colors: {
    "editor.background": "#FFFFFF",
    "editor.foreground": "#000000",
    "editor.selectionBackground": "#B4D8FD",
    "editor.lineHighlightBackground": "#007AFF14",
    "editorCursor.foreground": "#007AFF",
    "editorLineNumber.foreground": "#8E8E93",
    "editorLineNumber.activeForeground": "#000000",
  },
};

 
export function defineTableRTheme(monaco: any) {
  monaco.editor.defineTheme("tabler-dark", TABLER_DARK_THEME);
}

