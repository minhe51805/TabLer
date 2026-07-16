import type { AIConversationMessage, AIResponseLanguage } from "../../types";
import type { AssistIntent } from "./ai-agent-context";
import {
  buildSchemaRegroundingPrompt,
  buildSqlRegroundingPrompt,
  isOverviewContextMissingResponse,
  responseConflictsWithSchema,
  sqlResponseConflictsWithSchema,
} from "./ai-agent-grounding";
import { isLikelySqlOnlyResponse, extractSqlFromResponse } from "./ai-sql-response";

const MAX_REMOTE_RECOVERY_PASSES = 1;

interface RecoverNonAgentAssistOptions {
  appLanguage: AIResponseLanguage;
  askAI: (prompt: string, context: string, history: AIConversationMessage[]) => Promise<string>;
  availableSchemaTables: string[];
  context: string;
  currentDatabase: string | null;
  fastRemoteRecovery: boolean;
  intent: AssistIntent;
  isCurrentRequest: () => boolean;
  normalizedPrompt: string;
  requestHistory: AIConversationMessage[];
  schemaContextEnabled: boolean;
  strictRecoveryContext: string;
  wantsVisualization: boolean;
}

export async function recoverNonAgentAssistResponse({
  appLanguage, askAI, availableSchemaTables, context, currentDatabase, fastRemoteRecovery,
  intent, isCurrentRequest, normalizedPrompt, requestHistory, schemaContextEnabled,
  strictRecoveryContext, wantsVisualization,
}: RecoverNonAgentAssistOptions) {
  const ensureCurrent = () => {
    if (!isCurrentRequest()) throw new Error("This AI request was replaced by a newer one.");
  };
  let rawResponse = await askAI(normalizedPrompt, context, requestHistory);
  ensureCurrent();
  let recoveryPasses = 0;
  const canRecover = () => !fastRemoteRecovery || recoveryPasses < MAX_REMOTE_RECOVERY_PASSES;
  const recover = async (prompt: string, repairContext: string, repairHistory: AIConversationMessage[]) => {
    recoveryPasses += 1;
    rawResponse = await askAI(prompt, repairContext, repairHistory);
    ensureCurrent();
  };

  if (schemaContextEnabled && (intent === "sql" || intent === "optimize" || intent === "fix-error")) {
    let sql = extractSqlFromResponse(rawResponse);
    let conflict = sql ? sqlResponseConflictsWithSchema(sql, availableSchemaTables) : false;
    if ((!sql || conflict) && canRecover()) {
      await recover(buildSqlRegroundingPrompt(currentDatabase, availableSchemaTables, normalizedPrompt, "prompt"), strictRecoveryContext || context, []);
      sql = extractSqlFromResponse(rawResponse);
      conflict = sql ? sqlResponseConflictsWithSchema(sql, availableSchemaTables) : false;
    }
    if (sql && conflict && canRecover()) {
      await recover([
        "Return SQL again using only the verified current schema.", `Current database: ${currentDatabase || "Default"}.`,
        `Allowed tables only: ${availableSchemaTables.join(", ")}.`, "Do not mention or query any other table.",
        "Return only runnable SQL in a single ```sql fenced block.", "", normalizedPrompt,
      ].join("\n"), strictRecoveryContext || context, []);
    }
  }

  if ((intent === "explain" || intent === "overview") && isLikelySqlOnlyResponse(rawResponse) && !wantsVisualization && canRecover()) {
    await recover([
      intent === "overview" ? "The previous reply returned SQL, but the user is asking for a database overview." : "The previous reply returned SQL, but the user is asking for an explanation.",
      intent === "overview" ? "Read the provided database context and summarize the actual database, main tables, and relationships in plain language." : "Explain the meaning, purpose, or role of the referenced table, columns, or values in plain language.",
      "Do not output SQL, code blocks, or query snippets.", "", normalizedPrompt,
    ].join("\n"), context, requestHistory);
  }

  const nonSqlIntent = intent !== "sql" && intent !== "optimize" && intent !== "fix-error";
  if (schemaContextEnabled && nonSqlIntent && canRecover() && (responseConflictsWithSchema(rawResponse, availableSchemaTables) || (intent === "overview" && isOverviewContextMissingResponse(rawResponse)))) {
    await recover([
      "Your previous answer was not grounded in the current database context.", `You must stay strictly within these tables: ${availableSchemaTables.join(", ")}.`,
      "Ignore any earlier assistant guesses that mention tables or columns outside the current database context.",
      intent === "overview" ? "Write a grounded overview of the CURRENT database only. Do not say the database context is missing or ask the user to provide tables or columns. Format the answer with short markdown sections and flat bullets. Mention the actual tables from the current database context." : "Answer the user's question using ONLY the current database context, or say clearly that the current context is not enough.",
      "Do not invent example domains, tables, or columns.", "", normalizedPrompt,
    ].join("\n"), context, requestHistory);
  }

  if (schemaContextEnabled && intent === "overview" && isOverviewContextMissingResponse(rawResponse) && canRecover()) {
    await recover([
      "The current database context is already attached below and must be used.", `The exact current tables are: ${availableSchemaTables.join(", ")}.`,
      "Never say that the database, schema, tables, or columns were not provided.", "Return a compact markdown answer in the user's language with exactly these sections:",
      "## Overview", "## Main Tables", "## Relationships", "## Notes", "If the domain is uncertain, say that briefly, but still summarize the visible tables and likely relationship paths.", "", normalizedPrompt,
    ].join("\n"), context, []);
  }

  let schemaConflict = responseConflictsWithSchema(rawResponse, availableSchemaTables);
  if (schemaContextEnabled && nonSqlIntent && schemaConflict && canRecover()) {
    await recover(buildSchemaRegroundingPrompt(appLanguage, currentDatabase, availableSchemaTables, intent, normalizedPrompt), strictRecoveryContext || context, []);
    schemaConflict = responseConflictsWithSchema(rawResponse, availableSchemaTables);
  }
  if (schemaContextEnabled && intent === "overview" && schemaConflict && canRecover()) {
    await recover([
      "Return a fresh database overview from the verified schema only.", `Current database: ${currentDatabase || "Default"}.`, `Allowed tables only: ${availableSchemaTables.join(", ")}.`,
      "Do not mention any other tables.", "Do not ask for more schema details because they are already attached.", "Format the answer as short markdown with sections:",
      "## Overview", "## Main Tables", "## Relationships", "## Notes", "", normalizedPrompt,
    ].join("\n"), strictRecoveryContext || context, []);
  }

  return (intent === "explain" || intent === "overview") && isLikelySqlOnlyResponse(rawResponse) && !wantsVisualization
    ? intent === "overview"
      ? "The current model kept returning SQL instead of a database overview. Try again with more schema context or switch to a stronger model."
      : "The current model kept returning SQL instead of an explanation. Try again with more context or switch to a stronger model for schema explanations."
    : rawResponse;
}
