/**
 * SQL favorites "@" completion provider.
 *
 * Typing `@` in the SQL editor opens a completion list of saved SQL favorites
 * (get_sql_favorites via the zustand store). Picking one replaces the
 * `@<filter>` text with the favorite's SQL at the cursor.
 */

import type * as Monaco from "monaco-editor";
import { useSqlFavoritesStore } from "../../stores/sql-favorites-store";

/**
 * Registers a Monaco completion provider triggered by `@`.
 * Returns a disposable; call `dispose()` on editor unmount.
 */
export function registerSqlFavoriteSnippetsProvider(monaco: typeof Monaco): {
  dispose: () => void;
} {
  return monaco.languages.registerCompletionItemProvider("sql", {
    triggerCharacters: ["@"],

    async provideCompletionItems(model: Monaco.editor.ITextModel, position: Monaco.Position) {
      const word = model.getWordUntilPosition(position);
      const line = model.getLineContent(position.lineNumber);

      // The "@" must immediately precede the word being completed (or the
      // cursor itself when nothing has been typed after it yet).
      const atColumn = word.startColumn - 1;
      if (atColumn < 1 || line.charAt(atColumn - 1) !== "@") {
        return { suggestions: [] };
      }

      // First use may race the favorites panel's own load — fetch on demand.
      let favorites = useSqlFavoritesStore.getState().favorites;
      if (favorites.length === 0 && !useSqlFavoritesStore.getState().isLoading) {
        await useSqlFavoritesStore.getState().loadFavorites();
        favorites = useSqlFavoritesStore.getState().favorites;
      }
      if (favorites.length === 0) {
        return { suggestions: [] };
      }

      // Range covers "@<typed>" so picking an item replaces the trigger text.
      const range: Monaco.IRange = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: atColumn,
        endColumn: word.endColumn,
      };

      const suggestions: Monaco.languages.CompletionItem[] = favorites.map((fav, index) => ({
        label: fav.name,
        // "@name" lets Monaco's fuzzy filter match what the user typed after @.
        filterText: `@${fav.name}`,
        sortText: index.toString().padStart(4, "0"),
        kind: monaco.languages.CompletionItemKind.Snippet,
        insertText: fav.sql,
        detail: "SQL favorite",
        documentation: fav.description || fav.sql,
        range,
      }));

      return { suggestions };
    },
  });
}
