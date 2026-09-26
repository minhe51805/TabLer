import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `use-sql-editor`'s run state machine decides which executor a statement
 * reaches and which guards apply first. The editor and every store are
 * fakes — only the routing, interception, and error-surfacing contracts are
 * under test.
 */

const { connectionState, queryState, uiState, aiAutonomy, checkpointMock } = vi.hoisted(() => ({
  connectionState: {
    connections: [] as Array<Record<string, unknown>>,
    currentDatabase: null as string | null,
    tables: [] as unknown[],
    switchDatabase: vi.fn<(connectionId: string, database: string) => Promise<void>>(),
  },
  queryState: {
    executeQuery: vi.fn(),
    executeParameterizedQuery: vi.fn(),
    executeSandboxQuery: vi.fn(),
    getTableStructure: vi.fn(),
  },
  uiState: { updateTab: vi.fn() },
  aiAutonomy: { getAutonomy: vi.fn(() => "review") },
  checkpointMock: vi.fn(async (_params: unknown) => ({ fileName: "cp.sql" })),
}));

vi.mock("@/utils/tauri-utils", () => ({
  invokeWithTimeout: vi.fn().mockResolvedValue(null),
  invokeMutation: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: Object.assign(
    (selector: (state: typeof connectionState) => unknown) => selector(connectionState),
    { getState: () => connectionState },
  ),
}));
vi.mock("@/stores/queryStore", () => ({
  useQueryStore: Object.assign(
    (selector: (state: typeof queryState) => unknown) => selector(queryState),
    { getState: () => queryState },
  ),
}));
vi.mock("@/stores/uiStore", () => ({
  useUIStore: Object.assign((selector: (state: typeof uiState) => unknown) => selector(uiState), {
    getState: () => uiState,
  }),
}));
vi.mock("@/stores/aiAutonomyStore", () => ({
  useAIAutonomyStore: Object.assign(
    (selector: (state: typeof aiAutonomy) => unknown) => selector(aiAutonomy),
    { getState: () => aiAutonomy },
  ),
}));
vi.mock("@/stores/editorPreferencesStore", () => ({
  useEditorPreferencesStore: () => false,
}));
vi.mock("@/stores/queryHistoryStore", () => {
  const saveEntry = vi.fn(async () => undefined);
  const state = { saveEntry };
  return {
    useQueryHistoryStore: Object.assign(
      (selector: (state: { saveEntry: typeof saveEntry }) => unknown) => selector(state),
      { getState: () => state },
    ),
    __saveEntry: saveEntry,
  };
});
vi.mock("@/hooks/useConnectionCapabilities", () => ({
  useConnectionCapabilities: () => null,
}));
vi.mock("@/components/SQLEditor/agent-edit-safety", () => ({
  captureAgentEditedRunCheckpoint: (params: unknown) => checkpointMock(params),
}));
// Monaco wiring is not under test — registration returns inert disposables.
vi.mock("@/components/SQLEditor/SQLEditorAICompletion", () => ({
  registerInlineAICompletionProvider: () => ({ dispose: vi.fn() }),
}));
vi.mock("@/components/SQLEditor/SQLEditorMonacoSetup", () => ({
  registerSchemaCompletionProvider: () => ({ dispose: vi.fn() }),
  defineTableRTheme: vi.fn(),
}));
vi.mock("@/components/SQLEditor/sql-snippets", () => ({
  registerSqlFavoriteSnippetsProvider: () => ({ dispose: vi.fn() }),
}));
vi.mock("@/components/SQLEditor/inline-ai-controller", () => ({
  registerInlineAiEdit: () => ({ dispose: vi.fn() }),
}));
vi.mock("monaco-vim", () => ({ initVimMode: vi.fn(() => ({ dispose: vi.fn() })) }));

import { useSQLEditor } from "@/components/SQLEditor/hooks/use-sql-editor";
import type { OnMount } from "@monaco-editor/react";
import { EventCenter } from "@/stores/event-center";
import { SafeModeCancelledError } from "@/utils/safe-mode-query-guard";

const RESULT = {
  columns: [{ name: "n" }],
  rows: [[1]],
  execution_time_ms: 3,
  affected_rows: 0,
};

const PgConnection = {
  id: "conn-1",
  name: "pg",
  db_type: "postgresql",
  use_ssl: false,
};

function createEditor(content = "SELECT 1", selectedText?: string) {
  let value = content;
  const selection = selectedText !== undefined ? { isEmpty: () => false } : { isEmpty: () => true };
  return {
    getValue: () => value,
    setValue: vi.fn((next: string) => {
      value = next;
    }),
    getSelection: () => selection,
    getModel: () => ({ getValueInRange: () => selectedText ?? value }),
    focus: vi.fn(),
    getPosition: () => null,
    setPosition: vi.fn(),
    revealPositionInCenterIfOutsideViewport: vi.fn(),
    addAction: vi.fn(),
    onDidChangeCursorSelection: vi.fn(() => ({ dispose: vi.fn() })),
    updateOptions: vi.fn(),
    executeEdits: vi.fn(),
  };
}

function renderEditor(options: Partial<Parameters<typeof useSQLEditor>[0]> = {}) {
  return renderHook((props) => useSQLEditor(props), {
    initialProps: {
      connectionId: "conn-1",
      tabId: "tab-1",
      initialContent: "",
      runRequestNonce: 0,
      ...options,
    },
  });
}

const execute = async (current: ReturnType<typeof useSQLEditor>) => {
  await act(async () => {
    await current.handleExecute();
  });
};

beforeEach(() => {
  queryState.executeQuery.mockReset().mockResolvedValue(RESULT);
  queryState.executeParameterizedQuery.mockReset().mockResolvedValue(RESULT);
  queryState.executeSandboxQuery.mockReset().mockResolvedValue(RESULT);
  queryState.getTableStructure.mockReset();
  uiState.updateTab.mockClear();
  checkpointMock.mockClear();
  aiAutonomy.getAutonomy.mockClear().mockReturnValue("review");
  connectionState.switchDatabase.mockReset().mockResolvedValue(undefined);
  connectionState.connections = [PgConnection];
  connectionState.currentDatabase = "appdb";
  connectionState.tables = [];
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe("handleExecute routing", () => {
  it("a non-empty selection runs instead of the full editor text", async () => {
    const { result } = renderEditor();
    result.current.editorRef.current = createEditor("SELECT all", "SELECT only-this");

    await execute(result.current);

    expect(queryState.executeSandboxQuery).toHaveBeenCalledTimes(1);
    const [, statements] = queryState.executeSandboxQuery.mock.calls[0];
    expect(statements).toEqual(["SELECT only-this"]);
  });

  it("empty selection falls back to the full document", async () => {
    const { result } = renderEditor();
    result.current.editorRef.current = createEditor("SELECT 42");

    await execute(result.current);

    const [, statements] = queryState.executeSandboxQuery.mock.calls[0];
    expect(statements).toEqual(["SELECT 42"]);
  });

  it("{{param}} placeholders open the fill dialog and nothing executes", async () => {
    const { result } = renderEditor();
    result.current.editorRef.current = createEditor("SELECT * FROM t WHERE id = {{userId}}");

    await execute(result.current);

    expect(result.current.paramFillRequest?.params.map((p) => p.name)).toEqual(["userId"]);
    expect(result.current.paramFillRequest?.sql).toContain("{{userId}}");
    expect(queryState.executeSandboxQuery).not.toHaveBeenCalled();
    expect(queryState.executeParameterizedQuery).not.toHaveBeenCalled();
    expect(queryState.executeQuery).not.toHaveBeenCalled();
  });

  it(":named parameters route to executeParameterizedQuery with coerced drafts", async () => {
    const { result } = renderEditor({
      parameterDrafts: { uid: { value: "7", dataType: "integer" } },
    });
    result.current.editorRef.current = createEditor("SELECT * FROM t WHERE id = :uid");

    await execute(result.current);

    expect(queryState.executeParameterizedQuery).toHaveBeenCalledWith(
      "conn-1",
      "SELECT * FROM t WHERE id = :uid",
      [{ name: "uid", dataType: "integer", value: 7 }],
      { userInitiated: true },
    );
    expect(queryState.executeSandboxQuery).not.toHaveBeenCalled();
  });

  it("leading `USE db;` switches the session database, then runs the remainder", async () => {
    const { result } = renderEditor();
    result.current.editorRef.current = createEditor("USE analytics; SELECT 1");

    await execute(result.current);

    expect(connectionState.switchDatabase).toHaveBeenCalledWith("conn-1", "analytics");
    const [, statements] = queryState.executeSandboxQuery.mock.calls[0];
    expect(statements).toEqual(["SELECT 1"]);
  });

  it("`USE db` alone only switches — it reports the new database and runs nothing", async () => {
    const { result } = renderEditor();
    result.current.editorRef.current = createEditor("USE analytics");

    await execute(result.current);

    expect(connectionState.switchDatabase).toHaveBeenCalledWith("conn-1", "analytics");
    expect(queryState.executeSandboxQuery).not.toHaveBeenCalled();
    expect(result.current.error).toContain("analytics");
  });

  it("session-switch statements inside a batch are refused before execution", async () => {
    const { result } = renderEditor();
    result.current.editorRef.current = createEditor("SELECT 1; ATTACH 'x.db' AS x; SELECT 2");

    await execute(result.current);

    expect(result.current.error).toMatch(/session-switch/i);
    expect(queryState.executeSandboxQuery).not.toHaveBeenCalled();
    expect(connectionState.switchDatabase).not.toHaveBeenCalled();
  });

  it("an unusable USE directive surfaces the gateway error without switching", async () => {
    const { result } = renderEditor();
    result.current.editorRef.current = createEditor("USE db.schema; SELECT 1");

    await execute(result.current);

    expect(result.current.error).toMatch(/only accepts USE <database>/);
    expect(connectionState.switchDatabase).not.toHaveBeenCalled();
    expect(queryState.executeSandboxQuery).not.toHaveBeenCalled();
  });

  it("SafeModeCancelledError surfaces as a neutral notice, not an error", async () => {
    queryState.executeSandboxQuery.mockRejectedValue(new SafeModeCancelledError());
    const { result } = renderEditor();
    result.current.editorRef.current = createEditor("DROP TABLE t");

    await execute(result.current);

    expect(result.current.error).toBeNull();
    expect(result.current.notice).toBe("Query cancelled.");
  });

  it("an ordinary execution failure surfaces the stripped error message", async () => {
    queryState.executeSandboxQuery.mockRejectedValue(new Error("Error: syntax near FROM"));
    const { result } = renderEditor();
    result.current.editorRef.current = createEditor("SELEC 1");

    await execute(result.current);

    expect(result.current.error).toBe("syntax near FROM");
  });

  it("mongodb direct-execution path uses executeQuery, not the sandbox batch", async () => {
    connectionState.connections = [{ ...PgConnection, db_type: "mongodb" }];
    const { result } = renderEditor();
    result.current.editorRef.current = createEditor("db.t.find()");

    await execute(result.current);

    expect(queryState.executeQuery).toHaveBeenCalledWith("conn-1", "db.t.find()", undefined);
    expect(queryState.executeSandboxQuery).not.toHaveBeenCalled();
  });
});

describe("runRequestNonce", () => {
  it("fires handleExecute once per new nonce", async () => {
    const { result, rerender } = renderEditor({ runRequestNonce: 0 });
    result.current.editorRef.current = createEditor("SELECT 1");

    rerender({
      connectionId: "conn-1",
      tabId: "tab-1",
      initialContent: "",
      runRequestNonce: 1,
    });
    await waitFor(() => expect(queryState.executeSandboxQuery).toHaveBeenCalledTimes(1));

    // Same nonce again → no second run.
    rerender({
      connectionId: "conn-1",
      tabId: "tab-1",
      initialContent: "",
      runRequestNonce: 1,
    });
    await act(async () => {});
    expect(queryState.executeSandboxQuery).toHaveBeenCalledTimes(1);
  });

  it("a nonce arriving before mount defers until the editor is attached", async () => {
    const monacoStub = {
      KeyMod: { CtrlCmd: 1, Shift: 2, Alt: 4 },
      KeyCode: { Enter: 1, KeyP: 2, KeyF: 3 },
    };
    const { result } = renderEditor({ runRequestNonce: 1 });
    // No editor yet — the run must NOT fire.
    await act(async () => {});
    expect(queryState.executeSandboxQuery).not.toHaveBeenCalled();

    await act(async () => {
      result.current.handleEditorMount(
        createEditor("SELECT 1") as unknown as Parameters<OnMount>[0],
        monacoStub,
      );
    });
    await waitFor(() => expect(queryState.executeSandboxQuery).toHaveBeenCalledTimes(1));
  });
});

describe("agent-edited runs", () => {
  it("the first run of an accepted proposal captures exactly one checkpoint", async () => {
    const { result } = renderEditor({ tabId: "tab-1" });
    const editor = createEditor("SELECT 1");
    result.current.editorRef.current = editor;

    act(() => {
      EventCenter.emit("ai-edit-query-sql", {
        tabId: "tab-1",
        sql: "DELETE FROM users WHERE id > 10",
        reason: "cleanup",
      });
    });
    expect(result.current.aiProposal?.sql).toBe("DELETE FROM users WHERE id > 10");

    act(() => {
      result.current.acceptAiProposal();
    });
    expect(result.current.aiProposal).toBeNull();

    await execute(result.current);
    expect(checkpointMock).toHaveBeenCalledTimes(1);
    expect(checkpointMock).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: "conn-1", database: "appdb" }),
    );

    // The flag is one-shot: a follow-up run does not re-capture.
    await execute(result.current);
    expect(checkpointMock).toHaveBeenCalledTimes(1);
  });

  it("proposals for a different tab are ignored", async () => {
    const { result } = renderEditor({ tabId: "tab-1" });
    result.current.editorRef.current = createEditor("SELECT 1");

    act(() => {
      EventCenter.emit("ai-edit-query-sql", {
        tabId: "other-tab",
        sql: "DROP TABLE users",
        reason: "x",
      });
    });

    expect(result.current.aiProposal).toBeNull();
  });
});
