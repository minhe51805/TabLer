import type { AppLanguage } from "../../../i18n";
import { buildInsightScope, useAgentInsightsStore } from "../../../stores/agent-insights-store";
import { useAgentLearningStore } from "../../../stores/agent-learning-store";
import { SANDBOX_AGENT_MAX_ROWS } from "../../../stores/queryStore";
import type { AIConversationMessage } from "../../../types";
import { invokeMutation } from "../../../utils/tauri-utils";
import {
  formatExecutionError,
  isHighRiskStatement,
  isMutatingStatement,
} from "../../SQLEditor/SQLEditorUtils";
import { isSupersededAIRequestError } from "../ai-agent-action-requestor";
import { mergeRunNotes, type AgentTraceStep, type AssistIntent } from "../ai-agent-context";
import { runAgentEvidenceLoop } from "../ai-agent-evidence-loop";
import { finalizeAgentResult } from "../ai-agent-finalization";
import { collectRunEndInsights } from "../ai-agent-insights";
import { proposeRunLearnings } from "../ai-agent-learning";
import { resolveEvidenceRounds } from "../ai-agent-quality-gates";
import type { AIAgentToolName } from "../ai-agent-tools";
import { recoverNonAgentAssistResponse } from "../ai-assist-recovery";
import { extractSqlFromResponse, hasSqlStartKeyword } from "../ai-sql-response";
import { analyzeGeneratedSqlWithBackend } from "../AISlidePanelUtils";
import type { AIGeneratedAssistResult } from "../hooks/use-ai-slide-panel";
import type { AgentTurnDriverResult } from "./turn-driver";
import type {
  AgentAssistContext,
  AgentAssistOptions,
  AskAI,
  LoadedAgentWorkspaceContext,
} from "./types";

export async function finalizeAgentRun(params: {
  ctx: AgentAssistContext;
  loaded: LoadedAgentWorkspaceContext;
  driver: AgentTurnDriverResult;
  options?: AgentAssistOptions;
  requestId: number;
  normalizedPrompt: string;
  assistIntent: AssistIntent;
  appLanguage: AppLanguage;
  unattendedReadOnly: boolean;
  runTokensUsed: () => number;
  runModelUsed: () => string | undefined;
}): Promise<AIGeneratedAssistResult> {
  const {
    ctx,
    loaded,
    driver,
    options,
    requestId,
    normalizedPrompt,
    assistIntent,
    appLanguage,
    unattendedReadOnly,
    runTokensUsed,
    runModelUsed,
  } = params;

  const {
    activeDbType,
    connectionId,
    currentDatabase,
    executeSandboxQuery,
    requestIdRef,
    lastReasoningRef,
  } = ctx;
  const { availableSchemaTables, workspaceToolsEnabled, sharedAgentInstruction } = loaded;
  const requestDataReadConsent = options?.requestDataReadConsent;

  try {
    let finalAction = driver.runnerResult.finalAction;
    let finalSteps: AgentTraceStep[] = driver.runnerResult.steps;

    if (driver.endedWithAskUser && typeof finalAction.args?.response === "string") {
      const askStep: AgentTraceStep = {
        step: finalSteps.length + 1,
        action: "ask_user",
        message: finalAction.args.response,
        observation: "",
      };
      finalSteps = [...finalSteps, askStep];
    }

    const wantsReportTable = /(báo cáo|bảng báo cáo|report|tổng hợp|summary|dashboard)/i.test(
      normalizedPrompt,
    );
    ({ finalAction, finalSteps } = await runAgentEvidenceLoop({
      workspaceToolsEnabled,
      endedWithAskUser: driver.endedWithAskUser,
      assistIntent,
      wantsReportTable,
      maxRounds: resolveEvidenceRounds({ assistIntent, wantsReportTable }),
      knownIdentifiers: availableSchemaTables,
      sharedAgentInstruction,
      initialAction: finalAction,
      initialSteps: finalSteps,
      requestAgentAction: (prompt, includeHistory) =>
        driver.runWithProgressTicker({ action: "think", message: "Thinking…" }, () =>
          driver.requestSingleActionForPostGates(prompt, includeHistory),
        ),
      buildControllerPrompt: driver.buildControllerPrompt,
      isSupersededAIRequestError,
      runAgentTool: (action) =>
        driver.runWithProgressTicker(
          {
            action: action.action,
            message: action.message || "Gathering the missing data.",
          },
          () => driver.runAgentTool(action),
        ),
      publishAgentProgress: driver.publishAgentProgress,
      recoverAgentFinishAction: (reason) =>
        driver.runWithProgressTicker({ action: "think", message: "Finalizing answer." }, () =>
          driver.recoverAgentFinishAction(reason),
        ),
    }));

    if (requestId === requestIdRef.current) {
      const insights = collectRunEndInsights(finalSteps);
      const scope = buildInsightScope(connectionId, currentDatabase);
      useAgentInsightsStore.getState().recordRunInsights(insights, scope);
      useAgentLearningStore
        .getState()
        .recordRunLearnings(proposeRunLearnings({ insights, steps: finalSteps }), scope, {
          connectionId,
          database: currentDatabase,
        });
    }

    try {
      const traceLines = [
        JSON.stringify({
          kind: "meta",
          at: new Date().toISOString(),
          prompt: normalizedPrompt,
          intent: assistIntent,
          connectionId,
          database: currentDatabase,
          workspaceToolsEnabled,
        }),
        ...driver.runnerResult.snapshots.map((snapshot) =>
          JSON.stringify({
            kind: "snapshot",
            phase: snapshot.phase,
            iteration: snapshot.iteration,
            action: snapshot.action ?? null,
            steps: snapshot.steps,
          }),
        ),
        JSON.stringify({ kind: "final", steps: finalSteps }),
      ].join("\n");
      void invokeMutation<string>("save_agent_trace", {
        requestId: String(requestId),
        content: traceLines,
      }).catch((err) => {
        console.debug("[AI Agent] Optional trace persistence skipped:", err);
      });
    } catch (err) {
      console.debug("[AI Agent] Optional trace serialization skipped:", err);
    }

    const finalization = await finalizeAgentResult({
      availableSchemaTables,
      buildControllerPrompt: driver.buildControllerPrompt,
      sharedAgentInstruction,
      language: appLanguage,
      initialAction: finalAction,
      initialSteps: finalSteps,
      recoverFinishAction: (reason) =>
        driver.runWithProgressTicker({ action: "think", message: "Finalizing answer." }, () =>
          driver.recoverAgentFinishAction(reason),
        ),
      requestAgentAction: (prompt, includeHistory) =>
        driver.runWithProgressTicker({ action: "think", message: "Thinking…" }, () =>
          driver.requestSingleActionForPostGates(prompt, includeHistory),
        ),
      validateSql: async (proposedSql) => {
        if (isMutatingStatement(proposedSql) || isHighRiskStatement(proposedSql)) {
          return null;
        }
        if (!connectionId || requestId !== requestIdRef.current) {
          return null;
        }
        if (requestDataReadConsent) {
          const approved = await requestDataReadConsent();
          if (!approved) return null;
        }
        if (requestId !== requestIdRef.current) {
          return null;
        }
        try {
          await executeSandboxQuery(connectionId, [proposedSql], true, {
            maxRows: SANDBOX_AGENT_MAX_ROWS,
          });
          return null;
        } catch (errorValue) {
          if (isSupersededAIRequestError(errorValue)) {
            throw errorValue;
          }
          return formatExecutionError(errorValue);
        }
      },
    });

    const finalActionArgs = (finalAction.args ?? {}) as Record<string, unknown>;
    const askUserOptions = Array.isArray(finalActionArgs.options)
      ? (finalActionArgs.options as unknown[])
          .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
          .slice(0, 8)
      : undefined;
    const hasValidSql = Boolean(finalization.sql);

    return {
      prompt: normalizedPrompt,
      rawResponse: finalization.rawResponse,
      sql: finalization.sql,
      risk:
        hasValidSql && finalization.sql
          ? await analyzeGeneratedSqlWithBackend(finalization.sql, activeDbType)
          : undefined,
      intent: assistIntent,
      reasoning: lastReasoningRef.current,
      agentSteps: mergeRunNotes(finalization.agentSteps ?? [], driver.manualSwitchNotes),
      agentWidgets: finalization.agentWidgets,
      askUserOptions,
      failoverNotes: driver.failoverNotes.length > 0 ? driver.failoverNotes : undefined,
      unattendedBlockedTools: unattendedReadOnly
        ? (driver.unattendedBlockedTools as AIAgentToolName[] | undefined)
        : undefined,
      tokensUsed: runTokensUsed(),
      tokenBudgetExhausted: driver.runnerResult.tokenBudgetExhausted === true || undefined,
      modelUsed: runModelUsed(),
      runTrace: driver.runTrace,
    };
  } finally {
    driver.cleanup();
  }
}

export async function finalizeNonAgentAssist(params: {
  ctx: AgentAssistContext;
  loaded: LoadedAgentWorkspaceContext;
  requestId: number;
  normalizedPrompt: string;
  promptForRequest: string;
  assistIntent: AssistIntent;
  appLanguage: AppLanguage;
  fastRemoteRecovery: boolean;
  schemaContextEnabled: boolean;
  wantsVisualization: boolean;
  requestHistory: AIConversationMessage[];
  trackedAskAI: AskAI;
  runTokensUsed: () => number;
  runModelUsed: () => string | undefined;
}): Promise<AIGeneratedAssistResult> {
  const {
    ctx,
    loaded,
    requestId,
    normalizedPrompt,
    promptForRequest,
    assistIntent,
    appLanguage,
    fastRemoteRecovery,
    schemaContextEnabled,
    wantsVisualization,
    requestHistory,
    trackedAskAI,
    runTokensUsed,
    runModelUsed,
  } = params;

  const finalResponse = await recoverNonAgentAssistResponse({
    appLanguage,
    askAI: (requestPrompt, requestContext, history) =>
      trackedAskAI(requestPrompt, requestContext, "panel", assistIntent, history),
    availableSchemaTables: loaded.availableSchemaTables,
    context: loaded.context,
    currentDatabase: ctx.currentDatabase,
    fastRemoteRecovery,
    intent: assistIntent,
    isCurrentRequest: () => requestId === ctx.requestIdRef.current,
    normalizedPrompt: promptForRequest,
    requestHistory,
    schemaContextEnabled,
    strictRecoveryContext: loaded.strictRecoveryContext ?? "",
    wantsVisualization,
  });

  const extractedSql = extractSqlFromResponse(finalResponse);
  const hasValidSql = hasSqlStartKeyword(extractedSql);
  const shouldAttachSql =
    hasValidSql &&
    (assistIntent === "sql" ||
      assistIntent === "optimize" ||
      assistIntent === "fix-error" ||
      wantsVisualization);

  return {
    prompt: normalizedPrompt,
    rawResponse: finalResponse,
    sql: shouldAttachSql ? extractedSql : null,
    risk: hasValidSql
      ? await analyzeGeneratedSqlWithBackend(extractedSql, ctx.activeDbType)
      : undefined,
    intent: assistIntent,
    reasoning: ctx.lastReasoningRef.current,
    tokensUsed: runTokensUsed(),
    modelUsed: runModelUsed(),
  };
}
