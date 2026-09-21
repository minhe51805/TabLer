// Throwaway verification for ShellMisc slice: shortcuts overlay trigger,
// ping badge rendering, and "@" favorite-snippet completion provider.
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { AppKeyboardHandler } from "../../src/components/AppKeyboardHandler";
import { ConnectionRow } from "../../src/components/StartupConnectionManager/ConnectionRow";
import { registerSqlFavoriteSnippetsProvider } from "../../src/components/SQLEditor/sql-snippets";
import { useSqlFavoritesStore } from "../../src/stores/sql-favorites-store";

const handlerProps = {
  activeTab: null,
  onNewQuery: vi.fn(),
  onRunActiveQuery: vi.fn(),
  onToggleTerminalPanel: vi.fn(),
  onToggleSidebar: vi.fn(),
  onToggleQueryHistory: vi.fn(),
  onToggleSQLFavorites: vi.fn(),
  onToggleVimMode: vi.fn(),
  onOpenCommandPalette: vi.fn(),
  onOpenQuickSwitcher: vi.fn(),
  onOpenGlobalSearch: vi.fn(),
  setUiFontScale: vi.fn(),
  setShowAISlidePanel: vi.fn(),
};

function dispatchKey(
  target: EventTarget,
  init: { key?: string; code?: string; ctrlKey?: boolean; shiftKey?: boolean },
) {
  target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
}

describe("shortcuts overlay trigger", () => {
  it("F1 dispatches open-keyboard-shortcuts-palette", () => {
    render(<AppKeyboardHandler {...handlerProps} />);
    const spy = vi.fn();
    window.addEventListener("open-keyboard-shortcuts-palette", spy);
    dispatchKey(window.document.body, { key: "F1" });
    expect(spy).toHaveBeenCalledTimes(1);
    window.removeEventListener("open-keyboard-shortcuts-palette", spy);
  });

  it("Ctrl+/ outside Monaco dispatches the event", () => {
    render(<AppKeyboardHandler {...handlerProps} />);
    const spy = vi.fn();
    window.addEventListener("open-keyboard-shortcuts-palette", spy);
    dispatchKey(window.document.body, { key: "/", code: "Slash", ctrlKey: true });
    expect(spy).toHaveBeenCalledTimes(1);
    window.removeEventListener("open-keyboard-shortcuts-palette", spy);
  });

  it("Ctrl+/ inside Monaco does NOT dispatch (editor keeps line-comment)", () => {
    render(<AppKeyboardHandler {...handlerProps} />);
    const monacoHost = document.createElement("div");
    monacoHost.className = "monaco-editor";
    const inner = document.createElement("div");
    monacoHost.appendChild(inner);
    document.body.appendChild(monacoHost);
    const spy = vi.fn();
    window.addEventListener("open-keyboard-shortcuts-palette", spy);
    dispatchKey(inner, { key: "/", code: "Slash", ctrlKey: true });
    expect(spy).not.toHaveBeenCalled();
    window.removeEventListener("open-keyboard-shortcuts-palette", spy);
    monacoHost.remove();
  });
});

describe("ping badge", () => {
  const baseData = {
    connection: { id: "c1", name: "prod db", db_type: "postgres" } as never,
    isSelected: false,
    isConnected: false,
    isActive: false,
    isGridLayout: false,
    statusLabel: "Saved",
    dbInfo: { abbr: "PG", color: "#336791" },
    endpointLabel: "localhost:5432",
    databaseLabel: "postgres",
    engineLabel: "POSTGRES",
    secondaryBadgeLabel: null,
  };
  const rowProps = {
    onClick: vi.fn(),
    onDelete: vi.fn(),
    deleteLabel: "Delete",
    onRename: vi.fn(),
    renameLabel: "Rename",
    onMouseEnter: vi.fn(),
    onMouseLeave: vi.fn(),
  };

  it("renders green latency badge on success", () => {
    const { container } = render(
      <ConnectionRow
        data={baseData}
        {...rowProps}
        ping={{ ok: true, latencyMs: 42 }}
        pingOkLabel="Reachable"
        pingFailLabel="Unreachable"
      />,
    );
    const badge = container.querySelector(".startup-connection-ping.ok");
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe("42 ms");
  });

  it("renders red badge on failure", () => {
    const { container } = render(
      <ConnectionRow
        data={baseData}
        {...rowProps}
        ping={{ ok: false, latencyMs: null }}
        pingOkLabel="Reachable"
        pingFailLabel="Unreachable"
      />,
    );
    const badge = container.querySelector(".startup-connection-ping.fail");
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe("Unreachable");
  });
});

describe("@ favorite snippets provider", () => {
  function fakeMonaco() {
    const providers: Array<{
      triggerCharacters?: string[];
      provideCompletionItems: (m: unknown, p: unknown) => Promise<unknown>;
    }> = [];
    const monaco = {
      languages: {
        CompletionItemKind: { Snippet: 27 },
        registerCompletionItemProvider: (_lang: string, provider: never) => {
          providers.push(provider);
          return { dispose: () => undefined };
        },
      },
    };
    return { monaco, providers };
  }

  function modelAt(line: string, startColumn: number, endColumn: number) {
    return {
      getWordUntilPosition: () => ({ startColumn, endColumn }),
      getLineContent: () => line,
    };
  }

  it("suggests favorites after @ and inserts SQL over the @token range", async () => {
    useSqlFavoritesStore.setState({
      favorites: [
        {
          id: "f1",
          name: "Top customers",
          sql: "SELECT * FROM customers LIMIT 10;",
          tags: [],
          createdAt: "",
          updatedAt: "",
        },
      ],
      isLoading: false,
    });
    const { monaco, providers } = fakeMonaco();
    registerSqlFavoriteSnippetsProvider(monaco as never);
    expect(providers).toHaveLength(1);
    expect(providers[0].triggerCharacters).toContain("@");

    // Cursor right after "@" on line 1: word is empty at column 2.
    const result = (await providers[0].provideCompletionItems(modelAt("@", 2, 2), {
      lineNumber: 1,
      column: 2,
    })) as { suggestions: Array<Record<string, unknown>> };
    expect(result.suggestions).toHaveLength(1);
    const s = result.suggestions[0];
    expect(s.insertText).toBe("SELECT * FROM customers LIMIT 10;");
    expect(s.filterText).toBe("@Top customers");
    expect(s.range).toMatchObject({ startColumn: 1, endColumn: 2 });
  });

  it("returns nothing when @ does not precede the cursor", async () => {
    const { monaco, providers } = fakeMonaco();
    registerSqlFavoriteSnippetsProvider(monaco as never);
    const result = (await providers[0].provideCompletionItems(modelAt("SELECT ", 8, 8), {
      lineNumber: 1,
      column: 8,
    })) as { suggestions: unknown[] };
    expect(result.suggestions).toHaveLength(0);
  });
});
