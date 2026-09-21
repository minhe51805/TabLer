import { formatExecutionError } from "../../SQLEditor/SQLEditorUtils";
import { isSupersededAIRequestError } from "../ai-agent-action-requestor";
import { agentToolError, isRetryableAgentToolError } from "../agent-tool-executor-helpers";
import { invalidateAgentMemoryIndex } from "../hooks/use-agent-memory";
import { invokeMutation } from "../../../utils/tauri-utils";
import type { AgentToolModule } from "./shared";

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
      const approved = await ctx.requestDataDestructiveConsent({
        title: "Permanently delete this memory?",
        message: `The agent wants to permanently delete the memory "${memoryName}" from this connection's memory store. This cannot be undone.`,
        confirmText: "Delete memory",
        cancelText: "Keep it",
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
      try {
        const content = await invokeMutation<{ name: string; body: string; updatedAt?: string }>(
          "read_agent_memory",
          {
            name: memoryName,
            connectionId: ctx.memoryScope?.connectionId ?? null,
            database: ctx.memoryScope?.database ?? null,
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
      try {
        const saved = await invokeMutation<{ name: string; updatedAt: string }>(
          "save_agent_memory",
          {
            name: memoryName,
            body: memoryBody,
            description: memoryDescription || null,
            connectionId: ctx.memoryScope?.connectionId ?? null,
            database: ctx.memoryScope?.database ?? null,
          },
        );
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
        invalidateAgentMemoryIndex(ctx.connectionId ?? undefined);
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
          connectionId: ctx.memoryScope?.connectionId ?? null,
          database: ctx.memoryScope?.database ?? null,
        });
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
