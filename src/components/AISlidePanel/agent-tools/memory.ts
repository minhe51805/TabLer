import { formatExecutionError } from "../../SQLEditor/SQLEditorUtils";
import { isSupersededAIRequestError } from "../ai-agent-action-requestor";
import { agentToolError, isRetryableAgentToolError } from "../agent-tool-executor-helpers";
import { invalidateAgentMemoryIndex } from "../hooks/use-agent-memory";
import { formatMemoryCopy, getAIMemoryCopy } from "../ai-memory-copy";
import { emitAppToast } from "../../../utils/app-toast";
import { invokeMutation } from "../../../utils/tauri-utils";
import type { AgentToolModule } from "./shared";

/** Native memory-tool commands that destroy stored content. */
const NATIVE_MEMORY_DESTRUCTIVE_COMMANDS: Record<string, true> = { delete: true };

export const tools: AgentToolModule[] = [
  {
    name: "delete_memory",
    handler: async (ctx, args) => {
      const memoryName = typeof args?.name === "string" ? args.name.trim() : "";
      if (!memoryName) {
        return agentToolError(
          "delete_memory requires args.name taken from the <agent_memory> index.",
          {
            hint: "Send args.name exactly as listed in <agent_memory>.",
          },
        );
      }
      if (!ctx.memoryScope?.connectionId) {
        return agentToolError("delete_memory requires an active connection scope.");
      }
      // Destructive and irreversible: this must be a per-call dialog that
      // ALWAYS asks. It deliberately does NOT reuse requestDataReadConsent —
      // that consent is a standing per-database grant which auto-approves
      // silently, and would let deletes ride on a read permission. Fail
      // closed when no destructive dialog is wired in this context.
      if (!ctx.requestDataDestructiveConsent) {
        return "Tool blocked: delete_memory requires a destructive-action confirmation dialog, which is unavailable in this context.";
      }
      const memoryCopy = getAIMemoryCopy(ctx.language ?? "en");
      const approved = await ctx.requestDataDestructiveConsent({
        title: memoryCopy.deleteTitle,
        message: formatMemoryCopy(memoryCopy.deleteBody, { name: memoryName }),
        confirmText: memoryCopy.deleteConfirm,
        cancelText: memoryCopy.cancelLabel,
      });
      if (!approved) {
        return "Tool blocked: The user did not approve deleting this memory.";
      }
      try {
        await invokeMutation("delete_agent_memory", {
          name: memoryName,
          connectionId: ctx.memoryScope.connectionId,
          database: ctx.memoryScope.database ?? null,
        });
        // Same freshness contract as saves: the next run must not serve a
        // deleted entry from the TTL cache.
        invalidateAgentMemoryIndex(ctx.memoryScope.connectionId);
        window.dispatchEvent(
          new CustomEvent("workspace-activity", {
            detail: {
              connectionId: ctx.connectionId,
              label: `Memory deleted: ${memoryName}`,
              durationMs: 0,
            },
          }),
        );
        return `Memory "${memoryName}" permanently deleted from this scope. The freed slot is available to the next save_memory.`;
      } catch (errorValue) {
        if (isSupersededAIRequestError(errorValue)) throw errorValue;
        return agentToolError(
          `could not delete memory "${memoryName}": ${formatExecutionError(errorValue)}`,
          {
            retryable: isRetryableAgentToolError(errorValue),
          },
        );
      }
    },
  },
  {
    name: "read_memory",
    handler: async (ctx, args) => {
      const memoryName = typeof args?.name === "string" ? args.name.trim() : "";
      if (!memoryName) {
        return agentToolError(
          "read_memory requires args.name taken from the <agent_memory> index.",
          {
            hint: "Send args.name exactly as listed in <agent_memory>.",
          },
        );
      }
      // Same scope contract as delete_memory: without a connection scope the
      // backend would silently read the shared "global" scope — a different
      // connection's memories leaking into this run.
      if (!ctx.memoryScope?.connectionId) {
        return agentToolError("read_memory requires an active connection scope.");
      }
      try {
        const content = await invokeMutation<{ name: string; body: string; updatedAt?: string }>(
          "read_agent_memory",
          {
            name: memoryName,
            connectionId: ctx.memoryScope.connectionId,
            database: ctx.memoryScope.database ?? null,
          },
        );
        window.dispatchEvent(
          new CustomEvent("workspace-activity", {
            detail: {
              connectionId: ctx.connectionId,
              label: `Memory: ${content.name}`,
              durationMs: 0,
            },
          }),
        );
        const updatedNote = content.updatedAt ? ` (last updated ${content.updatedAt})` : "";
        return [
          `Memory "${content.name}" loaded${updatedNote}. Treat it as a saved observation, not a live fact — re-verify anything the schema contradicts:`,
          "",
          content.body ?? "",
        ].join("\n");
      } catch (errorValue) {
        if (isSupersededAIRequestError(errorValue)) throw errorValue;
        return agentToolError(
          `could not load memory "${memoryName}": ${formatExecutionError(errorValue)}`,
          {
            retryable: isRetryableAgentToolError(errorValue),
          },
        );
      }
    },
  },
  {
    name: "save_memory",
    handler: async (ctx, args) => {
      const memoryName = typeof args?.name === "string" ? args.name.trim() : "";
      const memoryBody = typeof args?.body === "string" ? args.body.trim() : "";
      const memoryDescription =
        typeof args?.description === "string" ? args.description.trim() : "";
      if (!memoryName || !memoryBody) {
        return agentToolError(
          "save_memory requires non-empty args.name (short slug) and args.body (the fact worth remembering).",
          {
            hint: 'Send args.name like "revenue-metric" and args.body with the fact. Never store credentials.',
          },
        );
      }
      // Same scope contract as delete_memory: a null scope would orphan the
      // save into the shared "global" scope instead of this run's
      // connection/database — a silent cross-scope write.
      if (!ctx.memoryScope?.connectionId) {
        return agentToolError("save_memory requires an active connection scope.");
      }
      try {
        const saved = await invokeMutation<{ name: string; updatedAt: string }>(
          "save_agent_memory",
          {
            name: memoryName,
            body: memoryBody,
            description: memoryDescription || null,
            connectionId: ctx.memoryScope.connectionId,
            database: ctx.memoryScope.database ?? null,
            origin: "agent",
          },
        );
        // Memory writes are invisible to the user by default — a toast keeps
        // "the agent remembered something" observable instead of silent.
        emitAppToast({
          tone: "info",
          title: getAIMemoryCopy(ctx.language ?? "en").savedToastTitle,
          description: formatMemoryCopy(getAIMemoryCopy(ctx.language ?? "en").savedToastBody, {
            name: saved.name,
          }),
          durationMs: 4000,
        });
        window.dispatchEvent(
          new CustomEvent("workspace-activity", {
            detail: {
              connectionId: ctx.connectionId,
              label: `Memory saved: ${saved.name}`,
              durationMs: 0,
            },
          }),
        );
        // The injected index must not serve a stale (pre-save) view on the
        // next run within the TTL window.
        invalidateAgentMemoryIndex(ctx.memoryScope.connectionId);
        return `Memory "${saved.name}" saved for this connection/database scope${saved.updatedAt ? ` at ${saved.updatedAt}` : ""}. Future runs in this scope will see it in their <agent_memory> index. Never store credentials in memory.`;
      } catch (errorValue) {
        if (isSupersededAIRequestError(errorValue)) throw errorValue;
        return agentToolError(
          `could not save memory "${memoryName}": ${formatExecutionError(errorValue)}`,
          {
            retryable: isRetryableAgentToolError(errorValue),
          },
        );
      }
    },
  },
  {
    name: "memory",
    handler: async (ctx, args) => {
      // Anthropic's NATIVE memory tool (memory_20250818). Forward the command
      // plus filesystem args to the sandboxed backend, which returns the
      // tool_result string the agent loop feeds back to the model. Errors are
      // returned as observations (not thrown) so Claude can self-correct — the
      // same contract as an `is_error` tool_result.
      const memoryArgs = args;
      // Same scope contract as the other memory tools: the native tree is
      // sandboxed per (connection, database), and a null scope would write the
      // shared "global" tree from a scoped run.
      if (!ctx.memoryScope?.connectionId) {
        return agentToolError("memory requires an active connection scope.");
      }
      // Destructive commands ride the same per-call consent as delete_memory:
      // the native tool must not bypass the confirmation the JSON tool needs.
      const command = typeof memoryArgs.command === "string" ? memoryArgs.command : "";
      if (NATIVE_MEMORY_DESTRUCTIVE_COMMANDS[command]) {
        if (!ctx.requestDataDestructiveConsent) {
          return `Tool blocked: memory "${command}" requires a destructive-action confirmation dialog, which is unavailable in this context.`;
        }
        const memoryCopy = getAIMemoryCopy(ctx.language ?? "en");
        const approved = await ctx.requestDataDestructiveConsent({
          title: memoryCopy.nativeDeleteTitle,
          message: formatMemoryCopy(memoryCopy.nativeDeleteBody, {
            command,
            path: typeof memoryArgs.path === "string" ? memoryArgs.path : "/memories",
          }),
          confirmText: memoryCopy.nativeDeleteConfirm,
          cancelText: memoryCopy.cancelLabel,
        });
        if (!approved) {
          return `Tool blocked: The user did not approve the memory "${command}" command.`;
        }
      }
      try {
        const result = await invokeMutation<string>("run_agent_memory_tool", {
          command: memoryArgs.command,
          path: memoryArgs.path ?? null,
          fileText: memoryArgs.file_text ?? null,
          oldStr: memoryArgs.old_str ?? null,
          newStr: memoryArgs.new_str ?? null,
          insertLine: typeof memoryArgs.insert_line === "number" ? memoryArgs.insert_line : null,
          insertText: memoryArgs.insert_text ?? null,
          oldPath: memoryArgs.old_path ?? null,
          newPath: memoryArgs.new_path ?? null,
          viewRange: Array.isArray(memoryArgs.view_range) ? memoryArgs.view_range : null,
          connectionId: ctx.memoryScope.connectionId,
          database: ctx.memoryScope.database ?? null,
        });
        // Writes through the native tool are as invisible as save_memory —
        // toast the mutating commands so the store never changes silently.
        if (command && command !== "view") {
          const memoryCopy = getAIMemoryCopy(ctx.language ?? "en");
          emitAppToast({
            tone: "info",
            title: memoryCopy.savedToastTitle,
            description: formatMemoryCopy(memoryCopy.savedToastBody, {
              name: typeof memoryArgs.path === "string" ? memoryArgs.path : command,
            }),
            durationMs: 4000,
          });
        }
        window.dispatchEvent(
          new CustomEvent("workspace-activity", {
            detail: {
              connectionId: ctx.connectionId,
              label: `Memory tool: ${memoryArgs.command}`,
              durationMs: 0,
            },
          }),
        );
        return result;
      } catch (errorValue) {
        if (isSupersededAIRequestError(errorValue)) throw errorValue;
        return agentToolError(
          `memory ${memoryArgs.command} failed: ${formatExecutionError(errorValue)}`,
          {
            retryable: isRetryableAgentToolError(errorValue),
          },
        );
      }
    },
  },
];
