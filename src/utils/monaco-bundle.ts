import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
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
