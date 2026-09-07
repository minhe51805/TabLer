import { invokeMutation, invokeWithTimeout } from "./tauri-utils";
import type {
  AIWorkspaceToolCommandArgs,
  AIWorkspaceToolCommandName,
  AIWorkspaceToolCommandResult,
} from "../types/ai-tool-contracts";

export function invokeAIWorkspaceToolWithTimeout<TCommand extends AIWorkspaceToolCommandName>(
  command: TCommand,
  args: AIWorkspaceToolCommandArgs<TCommand>,
  timeoutMs: number,
  label: string,
) {
  return invokeWithTimeout<AIWorkspaceToolCommandResult<TCommand>>(
    command,
    args,
    timeoutMs,
    label,
  );
}

export function invokeAIWorkspaceToolMutation<TCommand extends AIWorkspaceToolCommandName>(
  command: TCommand,
  args: AIWorkspaceToolCommandArgs<TCommand>,
) {
  return invokeMutation<AIWorkspaceToolCommandResult<TCommand>>(command, args);
}
