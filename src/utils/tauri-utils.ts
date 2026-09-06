import { invoke } from "@tauri-apps/api/core";

export class TauriTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TauriTimeoutError";
  }
}

interface InvokeTimeoutOptions {
  onTimeout?: () => unknown | Promise<unknown>;
}

/**
 * Native save bridge for grid exports. Anchor downloads
 * (`<a download>` with `blob:` URLs) are silent no-ops inside the Tauri
 * WebView, so every export must funnel through the Rust `save_export_file`
 * command: it opens a native save dialog and writes the bytes with std::fs.
 * Binary payloads (the XLSX workbook) travel base64-encoded.
 */
export interface SaveExportFilter {
  name: string;
  extensions: string[];
}

export async function saveExportFile(options: {
  fileName: string;
  content?: string;
  contentBase64?: string;
  filters?: SaveExportFilter[];
}): Promise<string | null> {
  const { fileName, content, contentBase64, filters } = options;
  const isBinary = typeof contentBase64 === "string";
  return invokeMutation<string | null>("save_export_file", {
    fileName,
    content: isBinary ? "" : content ?? "",
    encoding: isBinary ? "base64" : "utf8",
    contentBase64: contentBase64 ?? null,
    filters: filters ?? null,
  });
}

/** Encodes text to UTF-8 base64 via the browser APIs available in the
 *  WebView (no Buffer in the renderer). */
export function textToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function invokeWithTimeout<T>(
  command: string,
  args: Record<string, unknown>,
  timeoutMs: number,
  label: string,
  options?: InvokeTimeoutOptions,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      action();
    };
    const timer = window.setTimeout(() => {
      void Promise.resolve(options?.onTimeout?.()).catch(() => undefined).finally(() => {
        finish(() => {
          reject(new TauriTimeoutError(
            `${label} timed out after ${Math.round(timeoutMs / 1000)}s. The request was cancelled and can be retried.`,
          ));
        });
      });
    }, timeoutMs);
    invoke<T>(command, args).then(
      (value) => { finish(() => resolve(value)); },
      (error) => { finish(() => reject(error)); }
    );
  });
}

export function invokeMutation<T>(command: string, args: Record<string, unknown>): Promise<T> {
  return invoke<T>(command, args);
}
