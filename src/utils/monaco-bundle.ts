import { loader } from "@monaco-editor/react";
// Slim Monaco build: `import * as monaco from "monaco-editor"` pulls in
// editor.main.js, which statically registers every language service
// (typescript/css/html/json — ~9 MB of workers) plus ~70 basic languages.
// TableR only edits sql (all engines), javascript (MongoDB profile) and
// shell (Redis profile), so we compose the editor core + API + exactly those
// three contributions. editor.api re-exports the full API surface
// (editor, languages, KeyCode, KeyMod, Position, Range, Uri, …).
import "monaco-editor/esm/vs/editor/edcore.main.js";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import "monaco-editor/esm/vs/basic-languages/sql/sql.contribution.js";
import "monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js";
import "monaco-editor/esm/vs/basic-languages/shell/shell.contribution.js";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

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
