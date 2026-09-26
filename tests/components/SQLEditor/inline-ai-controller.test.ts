import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Ctrl+K phase machine (closed → input → loading → preview/error) guards
 * two dangerous edges: a late askAI response must not apply after close, and
 * rejectPreview must restore `originalText` even over user edits made inside
 * the preview. Monaco is faked; the model underneath is real text.
 */

const { connectionState, aiState } = vi.hoisted(() => ({
  connectionState: {
    connections: [] as Array<Record<string, unknown>>,
    currentDatabase: "appdb" as string | null,
    tables: [] as Array<{ name: string }>,
  },
  aiState: {
    aiConfigs: [] as Array<Record<string, unknown>>,
    askAI: vi.fn<(prompt: string, context: string) => Promise<string>>(),
  },
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: Object.assign(
    (selector: (state: typeof connectionState) => unknown) => selector(connectionState),
    { getState: () => connectionState },
  ),
}));
vi.mock("@/stores/aiStore", () => ({
  useAIStore: Object.assign((selector: (state: typeof aiState) => unknown) => selector(aiState), {
    getState: () => aiState,
  }),
}));

import { registerInlineAiEdit } from "@/components/SQLEditor/inline-ai-controller";

interface FakeRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
  getStartPosition: () => { lineNumber: number; column: number };
  getEndPosition: () => { lineNumber: number; column: number };
  isEmpty: () => boolean;
}

function createMonaco() {
  class Range implements FakeRange {
    constructor(
      public startLineNumber: number,
      public startColumn: number,
      public endLineNumber: number,
      public endColumn: number,
    ) {}
    getStartPosition() {
      return { lineNumber: this.startLineNumber, column: this.startColumn };
    }
    getEndPosition() {
      return { lineNumber: this.endLineNumber, column: this.endColumn };
    }
    isEmpty() {
      return this.startLineNumber === this.endLineNumber && this.startColumn === this.endColumn;
    }
  }
  class Position {
    constructor(
      public lineNumber: number,
      public column: number,
    ) {}
  }
  return {
    Range,
    Position,
    KeyMod: { CtrlCmd: 1, Shift: 2, Alt: 4 },
    KeyCode: { KeyK: 1, Escape: 9 },
    editor: {
      ContentWidgetPositionPreference: { BELOW: 1, ABOVE: 2 },
      TrackedRangeStickiness: { AlwaysGrowsWhenTypingAtEdges: 1 },
      EditorOption: { lineHeight: 1 },
    },
  };
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

function offsetAt(text: string, pos: { lineNumber: number; column: number }): number {
  const starts = lineStarts(text);
  return (starts[pos.lineNumber - 1] ?? text.length) + pos.column - 1;
}

function positionAt(text: string, offset: number) {
  const starts = lineStarts(text);
  let line = 1;
  for (let i = 0; i < starts.length; i += 1) {
    if (starts[i] <= offset) line = i + 1;
  }
  return { lineNumber: line, column: offset - starts[line - 1] + 1 };
}

function createEditor(initialValue: string, caret = { lineNumber: 1, column: 1 }) {
  const monaco = createMonaco();
  let value = initialValue;
  let selection: FakeRange | null = null;
  const collections: Array<{ ranges: FakeRange[] }> = [];
  const zonesAdded: Array<{ afterLineNumber: number; text: string }> = [];
  const zonesRemoved: number[] = [];
  const actions = new Map<string, () => void>();
  const keyHandlers: Array<
    (e: { keyCode: number; preventDefault(): void; stopPropagation(): void }) => void
  > = [];
  let contentWidget: { getDomNode(): HTMLElement } | null = null;
  let zoneSeq = 0;

  const model = {
    getValue: () => value,
    getValueInRange: (range: FakeRange) =>
      value.slice(
        offsetAt(value, range.getStartPosition()),
        offsetAt(value, range.getEndPosition()),
      ),
    getOffsetAt: (pos: { lineNumber: number; column: number }) => offsetAt(value, pos),
    getPositionAt: (offset: number) => positionAt(value, offset),
    getLineContent: (line: number) => value.split("\n")[line - 1] ?? "",
    getLineMaxColumn: (line: number) => (value.split("\n")[line - 1] ?? "").length + 1,
  };

  const applyEdit = (range: FakeRange, text: string) => {
    const start = offsetAt(value, range.getStartPosition());
    const end = offsetAt(value, range.getEndPosition());
    const delta = text.length - (end - start);
    value = value.slice(0, start) + text + value.slice(end);
    // Keep tracked ranges live across the edit — the invariant rejectPreview
    // relies on. A range fully after the edit shifts; a range containing the
    // edit point grows by the delta.
    for (const collection of collections) {
      for (const tracked of collection.ranges) {
        const tStart = offsetAt(value, tracked.getStartPosition());
        const tEnd = offsetAt(value, tracked.getEndPosition());
        if (tStart >= end) {
          const newStart = positionAt(value, tStart + delta);
          const newEnd = positionAt(value, tEnd + delta);
          Object.assign(
            tracked,
            newStart && {
              startLineNumber: newStart.lineNumber,
              startColumn: newStart.column,
              endLineNumber: newEnd.lineNumber,
              endColumn: newEnd.column,
            },
          );
        } else if (tEnd >= start) {
          const newEnd = positionAt(value, tEnd + delta);
          tracked.endLineNumber = newEnd.lineNumber;
          tracked.endColumn = newEnd.column;
        }
      }
    }
  };

  const editor = {
    getModel: () => model,
    getPosition: () => caret,
    getSelection: () => selection,
    setSelection: vi.fn((next: FakeRange) => {
      selection = next;
    }),
    setValue: vi.fn((next: string) => {
      value = next;
    }),
    executeEdits: vi.fn((_source: string, edits: Array<{ range: FakeRange; text: string }>) => {
      for (const edit of edits) applyEdit(edit.range, edit.text);
    }),
    pushUndoStop: vi.fn(),
    createDecorationsCollection: vi.fn((specs: Array<{ range: FakeRange }>) => {
      const collection = {
        ranges: specs.map((s) => s.range),
        clear: vi.fn(() => {
          collections.splice(collections.indexOf(collection), 1);
        }),
        getRange: (index: number) => collection.ranges[index] ?? null,
      };
      collections.push(collection);
      return collection;
    }),
    changeViewZones: vi.fn(
      (
        cb: (accessor: {
          addZone(z: { afterLineNumber: number; domNode: HTMLElement }): number;
          removeZone(id: number): void;
        }) => void,
      ) => {
        cb({
          addZone: (zone: { afterLineNumber: number; domNode: HTMLElement }) => {
            const id = ++zoneSeq;
            zonesAdded.push({
              afterLineNumber: zone.afterLineNumber,
              text: zone.domNode.textContent ?? "",
            });
            return id;
          },
          removeZone: (id: number) => {
            zonesRemoved.push(id);
          },
        });
      },
    ),
    addContentWidget: vi.fn((w: { getDomNode(): HTMLElement }) => {
      contentWidget = w;
    }),
    removeContentWidget: vi.fn(() => {
      contentWidget = null;
    }),
    layoutContentWidget: vi.fn(),
    addAction: vi.fn((action: { id: string; run: () => void }) => {
      actions.set(action.id, action.run);
      return { dispose: vi.fn() };
    }),
    onKeyDown: vi.fn((handler: (typeof keyHandlers)[number]) => {
      keyHandlers.push(handler);
      return { dispose: vi.fn() };
    }),
    getOption: vi.fn(() => 19),
    revealRangeInCenterIfOutsideViewport: vi.fn(),
    focus: vi.fn(),
    selectAll: (offset: number) => {
      caret = positionAt(value, offset);
      selection = null;
    },
    selectRange: (range: FakeRange) => {
      selection = range;
    },
    pressEscape: () => {
      for (const handler of keyHandlers) {
        handler({ keyCode: 9, preventDefault: () => {}, stopPropagation: () => {} });
      }
    },
    runAction: (id: string) => actions.get(id)?.(),
    widgetRoot: () => contentWidget?.getDomNode() ?? null,
    getValue: () => value,
  };

  return { monaco, editor };
}

function inputOf(root: HTMLElement | null): HTMLInputElement {
  const input = root?.querySelector("input");
  if (!input) throw new Error("inline-ai input not rendered");
  return input;
}

const pressEnter = (input: HTMLInputElement, value: string) => {
  input.value = value;
  input.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
  );
};

beforeEach(() => {
  aiState.askAI.mockReset().mockResolvedValue("SELECT id, name FROM users");
  aiState.aiConfigs = [
    {
      id: "p1",
      is_enabled: true,
      is_primary: true,
      allow_inline_completion: true,
      allow_schema_context: false,
    },
  ];
  connectionState.connections = [{ id: "conn-1", name: "c", db_type: "postgresql" }];
  connectionState.currentDatabase = "appdb";
  connectionState.tables = [];
});

describe("inline AI edit controller", () => {
  it("Ctrl+K → instruction → preview applies the rewrite with decorations and ghost zones", async () => {
    const { monaco, editor } = createEditor("SELECT id\nFROM users");
    editor.selectAll(0); // caret inside the statement
    registerInlineAiEdit(editor as never, monaco as never, { connectionId: "conn-1" });

    editor.runAction("inline-ai-edit");
    const root = editor.widgetRoot();
    expect(root).not.toBeNull();
    pressEnter(inputOf(root), "add name");

    await vi.waitFor(() => {
      expect(root?.classList.contains("is-preview")).toBe(true);
    });

    // The model now holds the AI rewrite.
    expect(editor.getValue()).toBe("SELECT id, name FROM users");
    expect(aiState.askAI).toHaveBeenCalledWith(
      expect.stringContaining("add name"),
      "",
      "inline",
      "sql",
    );
    // Removed-line ghosts render as view zones; decorations track the region.
    expect(editor.changeViewZones).toHaveBeenCalled();
    expect(editor.createDecorationsCollection).toHaveBeenCalled();
  });

  it("reject restores originalText even when the user typed inside the preview", async () => {
    const { monaco, editor } = createEditor("SELECT id\nFROM users");
    registerInlineAiEdit(editor as never, monaco as never, { connectionId: "conn-1" });

    editor.runAction("inline-ai-edit");
    const root = editor.widgetRoot();
    pressEnter(inputOf(root), "add name");
    await vi.waitFor(() => expect(root?.classList.contains("is-preview")).toBe(true));

    // User types inside the preview region (mid-text insert).
    const previewText = editor.getValue();
    const insertAt = previewText.indexOf("name");
    const start = positionAt(previewText, insertAt);
    editor.executeEdits("user", [
      {
        range: new monaco.Range(start.lineNumber, start.column, start.lineNumber, start.column),
        text: "XX",
      },
    ]);
    expect(editor.getValue()).toContain("XXname");

    // Click Reject on the preview toolbar.
    const reject = root?.querySelector(".sql-editor-proposal-reject") as HTMLElement;
    reject.click();

    // The whole preview — including the user's edit — reverts to original.
    expect(editor.getValue()).toBe("SELECT id\nFROM users");
    expect(editor.widgetRoot()).toBeNull();
  });

  it("closing during loading discards the late askAI response", async () => {
    let resolve!: (value: string) => void;
    const promise = new Promise<string>((res) => {
      resolve = res;
    });
    aiState.askAI.mockReturnValue(promise);
    const { monaco, editor } = createEditor("SELECT id");
    registerInlineAiEdit(editor as never, monaco as never, { connectionId: "conn-1" });

    editor.runAction("inline-ai-edit");
    const root = editor.widgetRoot();
    pressEnter(inputOf(root), "rewrite it");
    await vi.waitFor(() => expect(aiState.askAI).toHaveBeenCalled());

    editor.pressEscape(); // close while the request is in flight
    resolve("DELETE FROM users");
    await flushMicrotasks();

    expect(editor.getValue()).toBe("SELECT id");
    expect(editor.widgetRoot()).toBeNull();
  });

  it("an identical rewrite lands in the error phase and never edits", async () => {
    aiState.askAI.mockResolvedValue("SELECT id\nFROM users");
    const { monaco, editor } = createEditor("SELECT id\nFROM users");
    registerInlineAiEdit(editor as never, monaco as never, { connectionId: "conn-1" });

    editor.runAction("inline-ai-edit");
    const root = editor.widgetRoot();
    pressEnter(inputOf(root), "make no changes");
    await vi.waitFor(() =>
      expect(root?.querySelector(".sql-inline-ai-error")?.textContent).toBe(
        "AI returned the statement unchanged.",
      ),
    );

    expect(editor.getValue()).toBe("SELECT id\nFROM users");
    expect(editor.widgetRoot()?.classList.contains("is-preview")).toBe(false);
  });

  it("a non-empty selection targets the selection, not the statement at caret", async () => {
    const doc = "SELECT 1;\nSELECT 2";
    const { monaco, editor } = createEditor(doc);
    const monacoTypes = monaco;
    // Select the second statement.
    const sel = new monacoTypes.Range(2, 1, 2, 9);
    editor.selectRange(sel);
    registerInlineAiEdit(editor as never, monacoTypes as never, { connectionId: "conn-1" });

    editor.runAction("inline-ai-edit");
    const root = editor.widgetRoot();
    pressEnter(inputOf(root), "make it three");
    await vi.waitFor(() => expect(aiState.askAI).toHaveBeenCalled());

    expect(aiState.askAI).toHaveBeenCalledWith(
      expect.stringContaining("SELECT 2"),
      "",
      "inline",
      "sql",
    );
  });
});

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}
