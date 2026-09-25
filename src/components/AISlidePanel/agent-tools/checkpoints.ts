import { requestAICheckpointPick } from "../ai-checkpoint-picker";
import { agentSqlToolBlockedMessage } from "../ai-agent-engine-gates";
import { agentToolError, isRetryableAgentToolError } from "../agent-tool-executor-helpers";
import type { AgentToolModule } from "./shared";

export const tools: AgentToolModule[] = [
  {
    name: "create_checkpoint",
    handler: async (ctx, args) => {
      if (ctx.checkpointCallsUsed >= 3) {
        return agentToolError(
          "create_checkpoint budget exhausted for this run (3 snapshots max). The user can always create one manually with /backup.",
        );
      }
      ctx.checkpointCallsUsed += 1;
      if (typeof ctx.createCheckpoint !== "function") {
        return agentToolError("create_checkpoint is unavailable in this context.");
      }
      const label = typeof args?.label === "string" ? args.label.trim() : "";
      try {
        const result = await ctx.createCheckpoint(label || null);
        return `Checkpoint created: ${result.tableCount} tables, ${result.rowCount} rows saved locally (label: "${result.label}"). The user can restore it with the /rollback command — suggest that command if an upcoming or just-executed change looks wrong.`;
      } catch (errorValue) {
        return agentToolError(
          `create_checkpoint failed. ${errorValue instanceof Error ? errorValue.message : String(errorValue)}`,
          { retryable: isRetryableAgentToolError(errorValue) },
        );
      }
    },
  },
  {
    name: "restore_checkpoint",
    handler: async (ctx, args) => {
      // In-handler availability re-check: the catalog gate hides the tool, but a
      // hallucinated call must still fail closed on engines whose checkpoints
      // are SQL dumps they cannot replay (mongodb/redis/opensearch/elasticsearch/typesense/weaviate).
      if (ctx.toolAvailability && !ctx.toolAvailability.checkpointRestore) {
        return agentSqlToolBlockedMessage("restore_checkpoint", ctx.toolAvailability);
      }
      if (ctx.restoreCallsUsed >= 1) {
        return agentToolError(
          "restore_checkpoint budget exhausted for this run (1 rollback max). The user can always run /rollback manually.",
        );
      }
      ctx.restoreCallsUsed += 1;
      if (
        !ctx.connectionId ||
        !ctx.dbType ||
        typeof ctx.listCheckpoints !== "function" ||
        typeof ctx.restoreCheckpoint !== "function"
      ) {
        return agentToolError("restore_checkpoint is unavailable in this context.");
      }
      const hint = typeof args?.label_hint === "string" ? args.label_hint.trim().toLowerCase() : "";
      const checkpoints = await ctx.listCheckpoints(ctx.connectionId);
      if (!checkpoints.length) {
        return "No checkpoints exist for this connection. The user can create one with /backup or your create_checkpoint tool.";
      }
      const chosen = hint
        ? (checkpoints.find((entry) => entry.label.toLowerCase().includes(hint)) ?? checkpoints[0])
        : checkpoints[0];
      // Human confirmation is mandatory: the picker modal opens directly on
      // this checkpoint; the run resumes only after Restore/Cancel.
      ctx.publishAgentProgress({
        action: "restore_checkpoint",
        message: `Rollback to "${chosen.label}" — waiting for the user to confirm.`,
      });
      const fileName = await requestAICheckpointPick(
        [chosen],
        ctx.language || "en",
        ctx.connectionId,
        ctx.dbType,
      );
      if (!fileName) {
        return "User cancelled the rollback. No changes were made.";
      }
      try {
        await ctx.restoreCheckpoint(ctx.connectionId, fileName, ctx.dbType);
        return `Database restored to checkpoint "${chosen.label}". Remind the user to reopen tables if a stale view remains, and continue follow-up work on the restored data.`;
      } catch (errorValue) {
        return agentToolError(
          `rollback failed. ${errorValue instanceof Error ? errorValue.message : String(errorValue)}`,
          { retryable: isRetryableAgentToolError(errorValue) },
        );
      }
    },
  },
];
