import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The `@` favorites provider must lazy-load: an empty store that isn't
 * loading yet triggers loadFavorites() — a regression here silently kills
 * `@` completion for every user.
 */

const { favoritesState } = vi.hoisted(() => ({
  favoritesState: {
    favorites: [] as Array<{ name: string; sql: string; description?: string }>,
    isLoading: false,
    loadFavorites: vi.fn(async () => undefined),
  },
}));

vi.mock("@/stores/sql-favorites-store", () => ({
  useSqlFavoritesStore: Object.assign(
    (selector: (state: typeof favoritesState) => unknown) => selector(favoritesState),
    { getState: () => favoritesState },
  ),
}));

import { registerSqlFavoriteSnippetsProvider } from "@/components/SQLEditor/sql-snippets";

function createMonaco() {
  let provider: {
    provideCompletionItems: (
      model: unknown,
      position: unknown,
    ) => Promise<{ suggestions: Array<{ insertText: string; label: string }> }>;
  } | null = null;
  const monaco = {
    languages: {
      CompletionItemKind: { Snippet: 7, Keyword: 3 },
      registerCompletionItemProvider: vi.fn((_lang: string, next: typeof provider) => {
        provider = next;
        return { dispose: vi.fn() };
      }),
    },
  };
  return { monaco, getProvider: () => provider! };
}

function createModel(lineText: string) {
  return {
    getLineContent: () => lineText,
    getWordUntilPosition: ({ column }: { column: number }) => {
      const before = lineText.slice(0, column - 1);
      const match = /[\w$]+$/.exec(before);
      return {
        word: match?.[0] ?? "",
        startColumn: match ? before.length - match[0].length + 1 : column,
        endColumn: column,
      };
    },
  } as never;
}

const position = { lineNumber: 1, column: 2 }; // right after "@"

beforeEach(() => {
  favoritesState.favorites = [];
  favoritesState.isLoading = false;
  favoritesState.loadFavorites.mockReset().mockResolvedValue(undefined);
});

describe("@ favorites provider", () => {
  it("lazy-loads favorites on first use, then serves them", async () => {
    favoritesState.loadFavorites.mockImplementation(async () => {
      favoritesState.favorites = [{ name: "recent", sql: "SELECT * FROM t" }];
    });
    const { monaco, getProvider } = createMonaco();
    registerSqlFavoriteSnippetsProvider(monaco as never);

    const result = await getProvider().provideCompletionItems(createModel("@"), position);

    expect(favoritesState.loadFavorites).toHaveBeenCalledTimes(1);
    expect(result.suggestions.map((s) => s.insertText)).toContain("SELECT * FROM t");
  });

  it("does not refetch when favorites are already loaded", async () => {
    favoritesState.favorites = [{ name: "recent", sql: "SELECT 1" }];
    const { monaco, getProvider } = createMonaco();
    registerSqlFavoriteSnippetsProvider(monaco as never);

    const result = await getProvider().provideCompletionItems(createModel("@"), position);

    expect(favoritesState.loadFavorites).not.toHaveBeenCalled();
    expect(result.suggestions.map((s) => s.label)).toEqual(["recent"]);
  });

  it("suggests nothing when no @ trigger precedes the cursor", async () => {
    favoritesState.favorites = [{ name: "recent", sql: "SELECT 1" }];
    const { monaco, getProvider } = createMonaco();
    registerSqlFavoriteSnippetsProvider(monaco as never);

    const result = await getProvider().provideCompletionItems(createModel("SELECT 1"), {
      lineNumber: 1,
      column: 8,
    });
    expect(result.suggestions).toEqual([]);
  });
});
