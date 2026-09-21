/**
 * Ctrl+K inline AI edit for the SQL editor (Cursor-style).
 *
 * Imperative Monaco controller registered from `handleEditorMount`: it owns a
 * single content widget (instruction input → loading → diff toolbar), the
 * preview decorations (inserted-line highlights + view-zone ghosts for removed
 * lines), and the askAI round-trip. It is deliberately separate from the
 * `aiProposal` banner flow — that one previews whole-tab agent edits, this one
 * previews a scoped rewrite of the selection or the statement at the cursor.
 */

import type * as Monaco from "monaco-editor";
import { useAIStore } from "../../stores/aiStore";
import { useConnectionStore } from "../../stores/connectionStore";
import { getActiveAIProvider } from "../../utils/ai-provider-registry";
import { getCurrentAppLanguage } from "../../i18n";
import { getInlineAiCopy } from "./inline-ai-copy";
import {
  buildInlineEditPrompt,
  diffLines,
  extractSqlFromAiResponse,
  findStatementRangeAt,
} from "./inline-ai-edit";

type Phase = "closed" | "input" | "loading" | "preview" | "error";

export interface InlineAiEditOptions {
  connectionId: string;
  /** SQL dialect label for the prompt (connection db_type). */
  dbType?: string;
}

export function registerInlineAiEdit(
  editor: Monaco.editor.IStandaloneCodeEditor,
  monaco: typeof Monaco,
  options: InlineAiEditOptions,
): { dispose: () => void } {
  const copy = () => getInlineAiCopy(getCurrentAppLanguage());

  let phase: Phase = "closed";
  /** Bumped on every close/reject so a late askAI response cannot apply. */
  let session = 0;
  let errorMessage: string | null = null;
  let lastInstruction = "";

  /** Range the rewrite targets (selection, statement at cursor, or caret). */
  let targetRange: Monaco.Range | null = null;
  /** Tracks targetRange across edits made while the input sits open. */
  let targetTracker: Monaco.editor.IEditorDecorationsCollection | null = null;
  let originalText = "";
  /** Instruction shown on the preview toolbar. */
  let previewLabel = "";

  const disposables: Monaco.IDisposable[] = [];
  /** Preview decorations; index 0 is the tracked region used by reject. */
  let decorations: Monaco.editor.IEditorDecorationsCollection | null = null;
  let zoneIds: string[] = [];

  // -------------------------------------------------------------------------
  // Content widget (input + preview toolbar share one widget; DOM is rebuilt
  // on phase changes and repositioned via layoutContentWidget).
  // -------------------------------------------------------------------------

  const root = document.createElement("div");
  root.className = "sql-inline-ai";

  const widget: Monaco.editor.IContentWidget = {
    getId: () => "sql-inline-ai-widget",
    getDomNode: () => root,
    getPosition: () => {
      if (phase === "closed") return null;
      const model = editor.getModel();
      if (!model) return null;
      let lineNumber: number;
      let column = 1;
      const tracked = phase === "preview" ? decorations?.getRange(0) : null;
      if (tracked) {
        lineNumber = tracked.endLineNumber;
      } else if (targetRange) {
        lineNumber = targetRange.startLineNumber;
        column = targetRange.startColumn;
      } else {
        const position = editor.getPosition();
        if (!position) return null;
        lineNumber = position.lineNumber;
        column = position.column;
      }
      return {
        position: { lineNumber, column },
        preference: [
          monaco.editor.ContentWidgetPositionPreference.BELOW,
          monaco.editor.ContentWidgetPositionPreference.ABOVE,
        ],
      };
    },
  };

  const renderWidget = () => {
    root.textContent = "";
    root.classList.toggle("is-preview", phase === "preview");
    if (phase === "input" || phase === "loading" || phase === "error") {
      const input = document.createElement("input");
      input.className = "sql-inline-ai-input";
      input.type = "text";
      input.placeholder = copy().placeholder;
      input.value = lastInstruction;
      // Enabled even while loading so Esc still reaches the keydown handler;
      // submit() guards on the phase instead.
      input.setAttribute("aria-label", copy().placeholder);
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          void submit(input.value);
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      });
      root.appendChild(input);
      if (phase === "loading") {
        const spinner = document.createElement("span");
        spinner.className = "sql-inline-ai-spinner";
        spinner.setAttribute("role", "status");
        const label = document.createElement("span");
        label.className = "sql-inline-ai-status";
        label.textContent = copy().generating;
        root.appendChild(spinner);
        root.appendChild(label);
      }
      if (phase === "error" && errorMessage) {
        const error = document.createElement("span");
        error.className = "sql-inline-ai-error";
        error.textContent = errorMessage;
        root.appendChild(error);
      }
      // Focus after the node is in the tree; Monaco ignores focus() before add.
      window.setTimeout(() => input.focus(), 0);
    } else if (phase === "preview") {
      const label = document.createElement("span");
      label.className = "sql-inline-ai-label";
      label.textContent = previewLabel;
      label.title = previewLabel;
      const accept = document.createElement("button");
      accept.type = "button";
      accept.className = "sql-editor-tool-btn sql-editor-proposal-accept";
      accept.textContent = copy().accept;
      accept.addEventListener("click", () => acceptPreview());
      const reject = document.createElement("button");
      reject.type = "button";
      reject.className = "sql-editor-tool-btn sql-editor-proposal-reject";
      reject.textContent = copy().reject;
      reject.addEventListener("click", () => rejectPreview());
      root.appendChild(label);
      root.appendChild(accept);
      root.appendChild(reject);
    }
    editor.layoutContentWidget(widget);
  };

  // -------------------------------------------------------------------------
  // Preview artifacts: tracked range + inserted-line decorations + removed-line
  // ghost view zones.
  // -------------------------------------------------------------------------

  const clearPreviewArtifacts = () => {
    decorations?.clear();
    decorations = null;
    if (zoneIds.length > 0) {
      const ids = zoneIds;
      zoneIds = [];
      editor.changeViewZones((accessor) => {
        for (const id of ids) accessor.removeZone(id);
      });
    }
  };

  const applyPreview = (newText: string) => {
    const model = editor.getModel();
    if (!model || !targetRange) return;

    const startOffset = model.getOffsetAt(targetRange.getStartPosition());
    editor.pushUndoStop();
    editor.executeEdits("inline-ai", [
      { range: targetRange, text: newText, forceMoveMarkers: true },
    ]);
    editor.pushUndoStop();

    const startPosition = targetRange.getStartPosition();
    const endPosition = model.getPositionAt(startOffset + newText.length);
    const ops = diffLines(originalText, newText);

    const specs: Monaco.editor.IModelDeltaDecoration[] = [
      // Tracked region (index 0): reject resolves it back to a live range so
      // edits the user made inside the preview still revert cleanly.
      {
        range: new monaco.Range(
          startPosition.lineNumber,
          startPosition.column,
          endPosition.lineNumber,
          endPosition.column,
        ),
        options: {
          stickiness: monaco.editor.TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges,
        },
      },
    ];

    const lineHeight = editor.getOption(monaco.editor.EditorOption.lineHeight);
    const zones: { afterLine: number; lines: string[] }[] = [];
    let newLine = startPosition.lineNumber;
    for (const op of ops) {
      if (op.type === "equal") {
        newLine += 1;
      } else if (op.type === "insert") {
        specs.push({
          range: new monaco.Range(newLine, 1, newLine, model.getLineMaxColumn(newLine)),
          options: {
            isWholeLine: true,
            className: "sql-inline-ai-line-added",
            linesDecorationsClassName: "sql-inline-ai-gutter-added",
          },
        });
        newLine += 1;
      } else {
        // Deleted line: ghost it below the line that preceded it in the new
        // text (clamped to line 1 — Monaco has no "before line 1" anchor).
        const afterLine = Math.max(1, newLine - 1);
        const last = zones[zones.length - 1];
        if (last && last.afterLine === afterLine) {
          last.lines.push(op.line);
        } else {
          zones.push({ afterLine, lines: [op.line] });
        }
      }
    }

    decorations = editor.createDecorationsCollection(specs);

    editor.changeViewZones((accessor) => {
      for (const zone of zones) {
        const dom = document.createElement("div");
        dom.className = "sql-inline-ai-zone";
        for (const line of zone.lines) {
          const row = document.createElement("div");
          row.className = "sql-inline-ai-line-removed";
          row.style.height = `${lineHeight}px`;
          row.style.lineHeight = `${lineHeight}px`;
          row.textContent = line;
          dom.appendChild(row);
        }
        zoneIds.push(
          accessor.addZone({
            afterLineNumber: zone.afterLine,
            heightInPx: zone.lines.length * lineHeight,
            domNode: dom,
          }),
        );
      }
    });
  };

  // -------------------------------------------------------------------------
  // Flow
  // -------------------------------------------------------------------------

  const openInput = () => {
    if (phase !== "closed") {
      // Re-triggering Ctrl+K mid-flow just refocuses the input.
      root.querySelector("input")?.focus();
      return;
    }
    const model = editor.getModel();
    if (!model) return;

    const selection = editor.getSelection();
    if (selection && !selection.isEmpty()) {
      targetRange = selection;
      originalText = model.getValueInRange(selection);
    } else {
      const position = editor.getPosition();
      const offset = position ? model.getOffsetAt(position) : 0;
      const statement = findStatementRangeAt(model.getValue(), offset);
      if (statement) {
        const start = model.getPositionAt(statement.start);
        const end = model.getPositionAt(statement.end);
        targetRange = new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column);
        originalText = model.getValueInRange(targetRange);
        // Show the user exactly what the rewrite will replace.
        editor.setSelection(targetRange);
        editor.revealRangeInCenterIfOutsideViewport(targetRange);
      } else {
        // Empty document: the rewrite becomes an insertion at the caret.
        const caret = position ?? new monaco.Position(1, 1);
        targetRange = new monaco.Range(
          caret.lineNumber,
          caret.column,
          caret.lineNumber,
          caret.column,
        );
        originalText = "";
      }
    }

    // Track the target while the input is open: typing elsewhere shifts the
    // marker so submit still rewrites the statement the user pointed at.
    targetTracker?.clear();
    targetTracker = editor.createDecorationsCollection([
      {
        range: targetRange,
        options: {
          stickiness: monaco.editor.TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges,
        },
      },
    ]);

    errorMessage = null;
    phase = "input";
    editor.addContentWidget(widget);
    renderWidget();
  };

  const submit = async (instruction: string) => {
    const trimmed = instruction.trim();
    if (!trimmed || phase === "loading") return;
    // Resolve the live target: the user may have typed while the input was
    // open, so re-read both the range and the text it covers.
    if (targetTracker) {
      targetRange = targetTracker.getRange(0) ?? targetRange;
      originalText = targetRange ? (editor.getModel()?.getValueInRange(targetRange) ?? "") : "";
    }
    lastInstruction = trimmed;
    errorMessage = null;
    phase = "loading";
    renderWidget();

    const mySession = session;
    try {
      const connectionState = useConnectionStore.getState();
      const databaseLabel = connectionState.currentDatabase || null;
      const activeProvider = getActiveAIProvider(useAIStore.getState().aiConfigs);
      const context = activeProvider?.allow_schema_context
        ? `Database: ${databaseLabel ?? "Default"}\nAvailable Tables: ${connectionState.tables
            .slice(0, 20)
            .map((table) => table.name)
            .join(", ")}`
        : "";
      const response = await useAIStore.getState().askAI(
        buildInlineEditPrompt({
          instruction: trimmed,
          sql: originalText,
          dialect: options.dbType,
          databaseLabel,
        }),
        context,
        "inline",
        "sql",
      );
      if (mySession !== session) return; // closed while in flight
      const rewritten = extractSqlFromAiResponse(response);
      if (!rewritten) throw new Error("empty response");
      if (rewritten === originalText.trim()) {
        errorMessage = copy().noChanges;
        phase = "error";
        renderWidget();
        return;
      }
      previewLabel = trimmed;
      applyPreview(rewritten);
      phase = "preview";
      renderWidget();
      editor.focus();
    } catch (error) {
      if (mySession !== session) return;
      errorMessage = error instanceof Error ? error.message : String(error);
      phase = "error";
      renderWidget();
    }
  };

  const close = () => {
    session += 1;
    phase = "closed";
    errorMessage = null;
    targetTracker?.clear();
    targetTracker = null;
    editor.removeContentWidget(widget);
    editor.focus();
  };

  const acceptPreview = () => {
    clearPreviewArtifacts();
    close();
  };

  const rejectPreview = () => {
    const model = editor.getModel();
    const range = model && decorations ? decorations.getRange(0) : null;
    clearPreviewArtifacts();
    if (range) {
      editor.pushUndoStop();
      editor.executeEdits("inline-ai-reject", [
        { range, text: originalText, forceMoveMarkers: true },
      ]);
      editor.pushUndoStop();
      editor.setSelection(range);
    }
    close();
  };

  // -------------------------------------------------------------------------
  // Keybindings
  // -------------------------------------------------------------------------

  disposables.push(
    editor.addAction({
      id: "inline-ai-edit",
      label: "Inline AI Edit",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK],
      run: () => openInput(),
    }),
  );

  // Esc rejects a live preview (or closes the widget) even when focus is back
  // in the editor; the input handles its own Esc before this fires.
  disposables.push(
    editor.onKeyDown((event) => {
      if (event.keyCode !== monaco.KeyCode.Escape) return;
      if (phase === "preview") {
        event.preventDefault();
        event.stopPropagation();
        rejectPreview();
      } else if (phase !== "closed") {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    }),
  );

  return {
    dispose: () => {
      session += 1;
      targetTracker?.clear();
      targetTracker = null;
      clearPreviewArtifacts();
      editor.removeContentWidget(widget);
      for (const disposable of disposables) disposable.dispose();
    },
  };
}
