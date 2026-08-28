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
