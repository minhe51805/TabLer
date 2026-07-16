import { invoke } from "@tauri-apps/api/core";

export class TauriTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TauriTimeoutError";
  }
}

interface InvokeTimeoutOptions {
  onTimeout?: () => void;
}

export function invokeWithTimeout<T>(
  command: string,
  args: Record<string, unknown>,
  timeoutMs: number,
  label: string,
  options?: InvokeTimeoutOptions,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      options?.onTimeout?.();
      reject(new TauriTimeoutError(
        `${label} timed out after ${Math.round(timeoutMs / 1000)}s. The request was cancelled and can be retried.`,
      ));
    }, timeoutMs);
    invoke<T>(command, args).then(
      (value) => { window.clearTimeout(timer); resolve(value); },
      (error) => { window.clearTimeout(timer); reject(error); }
    );
  });
}

export function invokeMutation<T>(command: string, args: Record<string, unknown>): Promise<T> {
  return invoke<T>(command, args);
}
