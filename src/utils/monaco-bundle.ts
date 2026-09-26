import { loader } from "@monaco-editor/react";
// Slim Monaco build: `import * as monaco from "monaco-editor"` pulls in
// editor.main.js, which statically registers every language service
// (typescript/css/html/json — ~9 MB of workers) plus ~70 basic languages.
// TableR only edits sql (all engines), javascript (MongoDB profile) and
// shell (Redis profile), so we compose the editor core + API + exactly those
// three contributions. This file is a pruned edcore.main.js — keep it in sync
// when bumping monaco-editor by diffing that file against this list.
import "monaco-editor/esm/vs/editor/internal/initialize.js";
import "monaco-editor/esm/vs/editor/browser/coreCommands.js";
import "monaco-editor/esm/vs/editor/browser/widget/codeEditor/codeEditorWidget.js";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
// ── Editing core (always needed) ──────────────────────────────────────────
import "monaco-editor/esm/vs/editor/contrib/caretOperations/browser/caretOperations.js";
import "monaco-editor/esm/vs/editor/contrib/caretOperations/browser/transpose.js";
import "monaco-editor/esm/vs/editor/contrib/clipboard/browser/clipboard.js";
import "monaco-editor/esm/vs/editor/contrib/contextmenu/browser/contextmenu.js";
import "monaco-editor/esm/vs/editor/contrib/cursorUndo/browser/cursorUndo.js";
import "monaco-editor/esm/vs/editor/contrib/dnd/browser/dnd.js";
import "monaco-editor/esm/vs/editor/contrib/dropOrPasteInto/browser/copyPasteContribution.js";
import "monaco-editor/esm/vs/editor/contrib/dropOrPasteInto/browser/dropIntoEditorContribution.js";
import "monaco-editor/esm/vs/editor/contrib/find/browser/findController.js";
import "monaco-editor/esm/vs/editor/contrib/indentation/browser/indentation.js";
import "monaco-editor/esm/vs/editor/contrib/lineSelection/browser/lineSelection.js";
import "monaco-editor/esm/vs/editor/contrib/linesOperations/browser/linesOperations.js";
import "monaco-editor/esm/vs/editor/contrib/middleScroll/browser/middleScroll.contribution.js";
import "monaco-editor/esm/vs/editor/contrib/multicursor/browser/multicursor.js";
import "monaco-editor/esm/vs/editor/contrib/wordOperations/browser/wordOperations.js";
import "monaco-editor/esm/vs/editor/contrib/wordPartOperations/browser/wordPartOperations.js";
import "monaco-editor/esm/vs/editor/contrib/toggleTabFocusMode/browser/toggleTabFocusMode.js";
import "monaco-editor/esm/vs/editor/contrib/unusualLineTerminators/browser/unusualLineTerminators.js";
import "monaco-editor/esm/vs/editor/contrib/longLinesHelper/browser/longLinesHelper.js";
import "monaco-editor/esm/vs/editor/contrib/fontZoom/browser/fontZoom.js";
import "monaco-editor/esm/vs/editor/contrib/readOnlyMessage/browser/contribution.js";
import "monaco-editor/esm/vs/editor/contrib/placeholderText/browser/placeholderText.contribution.js";
import "monaco-editor/esm/vs/editor/contrib/anchorSelect/browser/anchorSelect.js";
import "monaco-editor/esm/vs/editor/contrib/comment/browser/comment.js";
import "monaco-editor/esm/vs/editor/contrib/inPlaceReplace/browser/inPlaceReplace.js";
import "monaco-editor/esm/vs/editor/contrib/insertFinalNewLine/browser/insertFinalNewLine.js";
import "monaco-editor/esm/vs/editor/contrib/insertFinalNewLine/browser/insertFinalNewLineCommand.js";
import "monaco-editor/esm/vs/editor/contrib/unicodeHighlighter/browser/unicodeHighlighter.js";
// ── SQL editor experience (suggest + snippets + inline AI ghost text) ─────
import "monaco-editor/esm/vs/editor/contrib/suggest/browser/suggestController.js";
import "monaco-editor/esm/vs/editor/contrib/suggest/browser/suggestInlineCompletions.js";
import "monaco-editor/esm/vs/editor/contrib/inlineCompletions/browser/inlineCompletions.contribution.js";
import "monaco-editor/esm/vs/editor/contrib/snippet/browser/snippetController2.js";
import "monaco-editor/esm/vs/editor/contrib/hover/browser/hoverContribution.js";
import "monaco-editor/esm/vs/editor/contrib/parameterHints/browser/parameterHints.js";
import "monaco-editor/esm/vs/editor/contrib/codeAction/browser/codeActionContributions.js";
import "monaco-editor/esm/vs/editor/contrib/bracketMatching/browser/bracketMatching.js";
import "monaco-editor/esm/vs/editor/contrib/folding/browser/folding.js";
import "monaco-editor/esm/vs/editor/contrib/inlineProgress/browser/inlineProgress.js";
import "monaco-editor/esm/vs/editor/contrib/smartSelect/browser/smartSelect.js";
import "monaco-editor/esm/vs/editor/contrib/stickyScroll/browser/stickyScrollContribution.js";
import "monaco-editor/esm/vs/editor/contrib/tokenization/browser/tokenization.js";
import "monaco-editor/esm/vs/editor/contrib/wordHighlighter/browser/wordHighlighter.js";
import "monaco-editor/esm/vs/editor/contrib/linkedEditing/browser/linkedEditing.js";
import "monaco-editor/esm/vs/editor/contrib/links/browser/links.js";
import "monaco-editor/esm/vs/editor/contrib/gotoError/browser/gotoError.js";
import "monaco-editor/esm/vs/editor/contrib/format/browser/formatActions.js";
import "monaco-editor/esm/vs/editor/contrib/floatingMenu/browser/floatingMenu.contribution.js";
import "monaco-editor/esm/vs/editor/contrib/inlayHints/browser/inlayHintsContribution.js";
// ── Language contributions the app actually edits ──────────────────────────
import "monaco-editor/esm/vs/basic-languages/sql/sql.contribution.js";
import "monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js";
import "monaco-editor/esm/vs/basic-languages/shell/shell.contribution.js";
import "monaco-editor/esm/vs/editor/common/standaloneStrings.js";
import "monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.css";
import "monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon-modifiers.css";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

// Dropped from edcore.main and why (each was 40–300 KB minified):
//   diffEditor + diffEditorBreadcrumbs      — no diff UI in the app
//   codeLens                                — no CodeLens providers registered
//   colorPicker                             — no color providers (not CSS)
//   documentSymbols + sectionHeaders        — no outline/breadcrumb surface
//   documentSemanticTokens/viewportSemantic — no semantic-token providers
//   rename + gotoSymbol + referenceSearch   — no definition/reference providers
//   standalone quickAccess trio + help      — app's own palette, not Monaco's
//   iPadShowKeyboard + toggleHighContrast   — desktop-only shell
//   gpuActions                              — no WebGPU editor surface

// Bundle Monaco with the app instead of letting @monaco-editor/react pull it
// from a CDN at runtime. The packaged build's CSP only allows same-origin
// scripts, so the CDN path silently left the editor stuck on "Loading...".
self.MonacoEnvironment = {
  getWorker(): Worker {
    return new EditorWorker();
  },
};

loader.config({ monaco });

export { monaco };
