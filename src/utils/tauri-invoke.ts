import { invoke } from "@tauri-apps/api/core";
import { toTauriCommandError } from "./tauri-error";

export async function invokeCommand<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  try {
    return await (args === undefined ? invoke<T>(command) : invoke<T>(command, args));
  } catch (error) {
    throw toTauriCommandError(error);
  }
}
