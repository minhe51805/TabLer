import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { AIConversationMessage, DatabaseType, MetricsWidgetType } from "../../../types";
import type { AIMetricsWidgetSpec } from "../../../utils/metrics-board-templates";
import { normalizeAIRequestError } from "../../../utils/ai-request-errors";
import { splitSqlStatements } from "../../../utils/sqlStatements";
import { shouldAgentAutoRunSql } from "../ai-execution-policy";
import {
  buildThreadLabel,
  createAIWorkspaceId,
  summarizePromptForDisplay,
  type AIChatThread,
} from "../ai-conversation-state";
import { getAIWorkspaceCopy } from "../ai-workspace-copy";
import type {
  AIWorkspaceAgentAutonomy,
  AIWorkspaceBubbleData,
  AIWorkspaceInteractionMode,
} from "../ai-workspace-types";
import {
  buildWorkspaceOverviewChartSql,
  hasMetricsDashboardAttachmentContext,
  isDashboardAttachmentReferencePrompt,
  isDashboardAugmentPrompt,
  isDashboardRebuildPrompt,
  isDashboardSelectionSource,
  isDashboardVisualizationPrompt,
  isDashboardWidgetAdjustmentPrompt,
  isOverviewVisualizationPrompt,
  isVisualizationPrompt,
  prefersVietnameseSystemReply,
  resolveDashboardWidgetEditInstruction,
  supportsOverviewMetricsBoard,
  waitForUIPaint,
  type VisualizationSelectionContext,
} from "../ai-visualization-intent";
import type { useAIDashboardBubbleUpdates } from "./use-ai-dashboard-bubble-updates";
import { isSupersededAIRequestError } from "./use-ai-slide-panel";
import type { useAISlidePanel } from "./use-ai-slide-panel";

type AISlidePanelActions = ReturnType<typeof useAISlidePanel>;
type DashboardBubbleUpdates = ReturnType<typeof useAIDashboardBubbleUpdates>;
type AIWorkspaceCopy = ReturnType<typeof getAIWorkspaceCopy>;

interface BuildLoadingBubbleOptions {
  mode?: "compose" | "inspect";
  promptSummary?: string;
  threadId?: string;
  workspaceKey?: string;
  interactionMode?: AIWorkspaceInteractionMode;
}

interface OpenMetricsBoardOptions {
  title?: string;
  template?: "database-overview";
  mode?: "create" | "augment" | "rebuild" | "edit";
  boardId?: string;
  focusWorkspace?: boolean;
  editTargetTitle?: string;
  editTargetType?: MetricsWidgetType;
  editQuery?: string;
  editTitle?: string;
  aiWidgets?: AIMetricsWidgetSpec[];
}

interface OpenMetricsBoardResult {
  success: boolean;
  boardId?: string;
  error?: string;
  didChange: boolean;
  addedCount: number;
  addedTitles: string[];
  created: boolean;
}

interface UseAIAssistantGenerationOptions {
  activeAgentAutonomy: AIWorkspaceAgentAutonomy;
  activeConnectionDbType?: DatabaseType;
  activeInteractionMode: AIWorkspaceInteractionMode;
  aiCopy: AIWorkspaceCopy;
  attachedSelection: VisualizationSelectionContext | null;
  buildLoadingBubble: (prompt: string, options?: BuildLoadingBubbleOptions) => AIWorkspaceBubbleData;
  completeWorkspaceRedirect: (bubbleId?: string, sessionId?: number) => void;
  currentThread?: AIChatThread;
  currentWorkspaceKey: string;
  dashboardBubbleUpdates: DashboardBubbleUpdates;
  generateAssist: AISlidePanelActions["generateAssist"];
  language: string;
  latestReadyAssistantBubble?: AIWorkspaceBubbleData | null;
  openMetricsBoardInWorkspace: (options?: OpenMetricsBoardOptions) => Promise<OpenMetricsBoardResult>;
  openSqlInWorkspace: (sql: string, options?: {
    title?: string;
    viewMode?: "table" | "chart";
    autoRun?: boolean;
    focusWorkspace?: boolean;
  }) => boolean;
  requestVisualizationReadConsent: (prompt: string) => Promise<boolean>;
  runSql: AISlidePanelActions["runSql"];
  setActiveThreadIdsByWorkspace: Dispatch<SetStateAction<Record<string, string>>>;
  setBubbles: Dispatch<SetStateAction<AIWorkspaceBubbleData[]>>;
  setChatThreads: Dispatch<SetStateAction<AIChatThread[]>>;
  setError: (error: string | null) => void;
  workspaceThreads: AIChatThread[];
  activeGenerationBubbleIdRef: MutableRefObject<string | null>;
  cancelledGenerationBubbleIdsRef: MutableRefObject<Set<string>>;
  openSessionRef: MutableRefObject<number>;
}

function stripCodeFences(text: string) {
  return text.replace(/```sql?/gi, "").replace(/```/g, "").trim();
}

export function summarizeAIResponse(rawResponse: string, sql?: string | null) {
  const cleaned = stripCodeFences(rawResponse).replace(/\s+/g, " ").trim();
  const compactSql = sql?.replace(/\s+/g, " ").trim() || "";
  if (cleaned && (!compactSql || cleaned !== compactSql)) {
    return cleaned.length > 180 ? `${cleaned.slice(0, 177)}...` : cleaned;
  }
  const firstLine = (sql || "").split("\n").find((line) => line.trim().length > 0) ?? sql ?? cleaned;
  return firstLine.length > 180 ? `${firstLine.slice(0, 177)}...` : firstLine;
}

export function buildAIExecutionDetail(summary: string, query: string, previousDetail?: string) {
  return [
    previousDetail?.trim() || "",
    `## Execution\n\n${summary}`,
    `## Query\n\n\`\`\`sql\n${query}\n\`\`\``,
  ]
    .filter(Boolean)
    .join("\n\n---\n\n");
}

export function buildAIAutoRunFailureDetail(message: string, sql: string, previousDetail?: string) {
  return [
    previousDetail?.trim() || "",
    `## Auto Run Error\n\n${message}`,
    `## Proposed SQL\n\n\`\`\`sql\n${sql}\n\`\`\``,
  ]
    .filter(Boolean)
    .join("\n\n---\n\n");
}

export function buildAIRequestFailureBubble(
  bubble: AIWorkspaceBubbleData,
  requestError: ReturnType<typeof normalizeAIRequestError>,
  wasCancelled: boolean,
  aiCopy: AIWorkspaceCopy,
): AIWorkspaceBubbleData {
  const message = wasCancelled ? "AI request cancelled." : requestError.message;
  const hasPartialEvidence = bubble.agentSteps?.some(
    (step) => step.action !== "plan" && step.status !== "running",
  ) ?? false;

  if (hasPartialEvidence) {
    return {
      ...bubble,
      kind: "assistant",
      status: "partial",
      title: aiCopy.bubbleStates.partialTitle,
      subtitle: aiCopy.bubbleStates.partialSubtitle,
      preview: message,
      detail: message,
      sql: undefined,
      risk: undefined,
      requestErrorCode: wasCancelled ? "cancelled" : requestError.code,
      retryable: true,
      autoDismissAt: undefined,
    };
  }

  if (wasCancelled) {
    return {
      ...bubble,
      kind: "assistant",
      status: "cancelled",
      title: aiCopy.bubbleStates.cancelledTitle,
      subtitle: aiCopy.bubbleStates.cancelledSubtitle,
      preview: message,
      detail: message,
      sql: undefined,
      risk: undefined,
      requestErrorCode: "cancelled",
      retryable: true,
      autoDismissAt: undefined,
    };
  }

  return {
    ...bubble,
    kind: "error",
    status: "error",
    title: aiCopy.bubbleStates.errorTitle,
    subtitle: aiCopy.bubbleStates.errorSubtitle,
    preview: message,
    detail: message,
    sql: undefined,
    risk: undefined,
    requestErrorCode: requestError.code,
    retryable: requestError.retryable,
    autoDismissAt: undefined,
  };
}

function isSingleSqlStatement(sql: string) {
  try {
    return splitSqlStatements(sql).length === 1;
  } catch {
    return false;
  }
}

export function useAIAssistantGeneration({
  activeAgentAutonomy,
  activeConnectionDbType,
  activeInteractionMode,
  aiCopy,
  attachedSelection,
  buildLoadingBubble,
  completeWorkspaceRedirect,
  currentThread,
  currentWorkspaceKey,
  dashboardBubbleUpdates: {
    updateBubbleForDashboardApplied,
    updateBubbleForDashboardActionFailed,
    updateBubbleForAttachedDashboardSummary,
    updateBubbleForDashboardEditNeedsClarification,
    updateBubbleForDashboardEdited,
    updateBubbleForDashboardNoChange,
    updateBubbleForDashboardRebuilt,
  },
  generateAssist,
  language,
  latestReadyAssistantBubble,
  openMetricsBoardInWorkspace,
  openSqlInWorkspace,
  requestVisualizationReadConsent,
  runSql,
  setActiveThreadIdsByWorkspace,
  setBubbles,
  setChatThreads,
  setError,
  workspaceThreads,
  activeGenerationBubbleIdRef,
  cancelledGenerationBubbleIdsRef,
  openSessionRef,
}: UseAIAssistantGenerationOptions) {
  const createAssistantBubble = useCallback(async (
    prompt: string,
    options?: {
      displayPrompt?: string;
      userPrompt?: string;
      attachmentSource?: string;
      mode?: "compose" | "inspect";
      history?: AIConversationMessage[];
      threadId?: string;
      workspaceKey?: string;
      interactionMode?: AIWorkspaceInteractionMode;
    }
  ) => {
    const normalizedPrompt = prompt.trim();
    if (!normalizedPrompt) return;
    const requestPrompt = options?.userPrompt?.trim() || normalizedPrompt;

    setError(null);
    const targetWorkspaceKey = options?.workspaceKey || currentWorkspaceKey;
    const targetThreadId = options?.threadId || currentThread?.id || workspaceThreads[0]?.id || createAIWorkspaceId();
    const interactionMode = options?.interactionMode || activeInteractionMode;
    const sessionId = openSessionRef.current;
    const loadingBubble = buildLoadingBubble(normalizedPrompt, {
      mode: options?.mode,
      promptSummary: options?.displayPrompt?.trim() || summarizePromptForDisplay(normalizedPrompt),
      threadId: targetThreadId,
      workspaceKey: targetWorkspaceKey,
      interactionMode,
    });
    activeGenerationBubbleIdRef.current = loadingBubble.id;
    setBubbles((current) => [...current, loadingBubble]);
    setChatThreads((current) =>
      current.map((thread, index) =>
        thread.id === targetThreadId
          ? {
              ...thread,
              updatedAt: loadingBubble.createdAt,
              ...(thread.isAutoLabel
                ? {
                    label: buildThreadLabel(loadingBubble.promptSummary || normalizedPrompt, index + 1),
                    isAutoLabel: false,
                  }
                : {}),
            }
          : thread
      )
    );
    setActiveThreadIdsByWorkspace((current) => ({
      ...current,
      [targetWorkspaceKey]: targetThreadId,
    }));

    await waitForUIPaint();

    const hasAttachedDashboardSelection =
      isDashboardSelectionSource(options?.attachmentSource) ||
      hasMetricsDashboardAttachmentContext(normalizedPrompt);
    const dashboardEditConversationContext =
      latestReadyAssistantBubble?.detail ||
      latestReadyAssistantBubble?.preview ||
      "";
    const directDashboardWidgetEdit =
      hasAttachedDashboardSelection
        ? resolveDashboardWidgetEditInstruction(requestPrompt, attachedSelection, dashboardEditConversationContext)
        : null;
    const shouldStayInDashboardEditContext =
      hasAttachedDashboardSelection &&
      !directDashboardWidgetEdit &&
      isDashboardWidgetAdjustmentPrompt(requestPrompt);
    const shouldHandleDashboardReferenceLocally =
      hasAttachedDashboardSelection &&
      !directDashboardWidgetEdit &&
      !isDashboardRebuildPrompt(requestPrompt) &&
      !isDashboardAugmentPrompt(requestPrompt) &&
      isDashboardAttachmentReferencePrompt(requestPrompt);
    const shouldRebuildDashboardDirectly =
      supportsOverviewMetricsBoard(activeConnectionDbType) &&
      hasAttachedDashboardSelection &&
      isDashboardRebuildPrompt(requestPrompt);
    const shouldAugmentDashboardDirectly =
      supportsOverviewMetricsBoard(activeConnectionDbType) &&
      !directDashboardWidgetEdit &&
      isDashboardAugmentPrompt(requestPrompt);

    if (shouldRebuildDashboardDirectly) {
      const visualizationReadApproved = await requestVisualizationReadConsent(requestPrompt);
      if (!visualizationReadApproved) {
        setError(
          prefersVietnameseSystemReply(requestPrompt, language)
            ? "Ban chua cap quyen doc data trong DB cho yeu cau visualization nay."
            : "Visualization data access was not approved for this request."
        );
        return { success: false, cancelled: true };
      }

      const dashboardResult = await openMetricsBoardInWorkspace({
        template: "database-overview",
        mode: "rebuild",
        focusWorkspace: true,
      });

      if (dashboardResult.success && dashboardResult.didChange) {
        updateBubbleForDashboardRebuilt(
          loadingBubble.id,
          requestPrompt,
          dashboardResult.addedCount,
          dashboardResult.addedTitles,
        );
        return { bubbleId: loadingBubble.id, success: true };
      }
      if (dashboardResult.success) {
        updateBubbleForDashboardNoChange(loadingBubble.id, requestPrompt, dashboardResult.addedCount);
        return { bubbleId: loadingBubble.id, success: true };
      }
      updateBubbleForDashboardActionFailed(loadingBubble.id, requestPrompt, dashboardResult.error);
      return { bubbleId: loadingBubble.id, success: false };
    }

    if (shouldAugmentDashboardDirectly) {
      const visualizationReadApproved = await requestVisualizationReadConsent(requestPrompt);
      if (!visualizationReadApproved) {
        setError(
          prefersVietnameseSystemReply(requestPrompt, language)
            ? "Ban chua cap quyen doc data trong DB cho yeu cau visualization nay."
            : "Visualization data access was not approved for this request."
        );
        return { success: false, cancelled: true };
      }

      const dashboardResult = await openMetricsBoardInWorkspace({
        title: "DB Overview Dashboard",
        template: "database-overview",
        mode: "augment",
        focusWorkspace: true,
      });

        if (dashboardResult.success && dashboardResult.didChange) {
          if (dashboardResult.created) {
            completeWorkspaceRedirect(loadingBubble.id, sessionId);
          } else {
            updateBubbleForDashboardApplied(
              loadingBubble.id,
              requestPrompt,
              dashboardResult.addedCount,
              dashboardResult.addedTitles,
            );
          }
          return { bubbleId: loadingBubble.id, success: true };
        }
        if (dashboardResult.success) {
        updateBubbleForDashboardNoChange(loadingBubble.id, requestPrompt, dashboardResult.addedCount);
          return { bubbleId: loadingBubble.id, success: true };
        }
      updateBubbleForDashboardActionFailed(loadingBubble.id, requestPrompt, dashboardResult.error);
      return { bubbleId: loadingBubble.id, success: false };
    }

    if (directDashboardWidgetEdit) {
      const dashboardResult = await openMetricsBoardInWorkspace({
        mode: "edit",
        boardId: directDashboardWidgetEdit.boardId,
        editTargetTitle: directDashboardWidgetEdit.targetTitle,
        editTargetType: directDashboardWidgetEdit.nextType,
        editQuery: directDashboardWidgetEdit.nextQuery,
        editTitle: directDashboardWidgetEdit.nextTitle,
        focusWorkspace: true,
      });

      if (dashboardResult.success && dashboardResult.didChange) {
        updateBubbleForDashboardEdited(
          loadingBubble.id,
          requestPrompt,
          directDashboardWidgetEdit.targetTitle,
          directDashboardWidgetEdit.nextType,
        );
        return { bubbleId: loadingBubble.id, success: true };
      }
      if (dashboardResult.success) {
        updateBubbleForDashboardNoChange(loadingBubble.id, requestPrompt, dashboardResult.addedCount);
        return { bubbleId: loadingBubble.id, success: true };
      }
      updateBubbleForDashboardActionFailed(loadingBubble.id, requestPrompt, dashboardResult.error);
      return { bubbleId: loadingBubble.id, success: false };
    }

    if (shouldStayInDashboardEditContext) {
      updateBubbleForDashboardEditNeedsClarification(loadingBubble.id, requestPrompt);
      return { bubbleId: loadingBubble.id, success: true };
    }

    if (shouldHandleDashboardReferenceLocally && attachedSelection) {
      updateBubbleForAttachedDashboardSummary(loadingBubble.id, requestPrompt, attachedSelection);
      return { bubbleId: loadingBubble.id, success: true };
    }

    try {
      const result = await generateAssist(normalizedPrompt, options?.history, {
        interactionMode,
        requestDataReadConsent: () => requestVisualizationReadConsent(requestPrompt),
        userPrompt: requestPrompt,
        onAgentProgress: (steps) => {
          if (openSessionRef.current !== sessionId) return;
          setBubbles((current) =>
            current.map((bubble) =>
              bubble.id === loadingBubble.id ? { ...bubble, agentSteps: steps } : bubble
            )
          );
        },
      });
      const readyTitle = options?.mode === "inspect"
        ? aiCopy.bubbleStates.readyInspectTitle
        : result.intent === "optimize"
          ? aiCopy.bubbleStates.readyOptimizeTitle
          : result.intent === "fix-error"
            ? aiCopy.bubbleStates.readyFixErrorTitle
            : result.sql
              ? aiCopy.bubbleStates.readySqlTitle
              : aiCopy.bubbleStates.readyNoteTitle;
      const readySubtitle = options?.mode === "inspect"
        ? result.sql
          ? aiCopy.bubbleStates.readyInspectSqlSubtitle
          : aiCopy.bubbleStates.readyInspectNoteSubtitle
        : result.intent === "optimize"
          ? aiCopy.bubbleStates.readyOptimizeSubtitle
          : result.intent === "fix-error"
            ? aiCopy.bubbleStates.readyFixErrorSubtitle
            : result.sql
              ? result.risk?.level === "safe" ? aiCopy.bubbleStates.readySqlSafeSubtitle : aiCopy.bubbleStates.readySqlReviewSubtitle
              : aiCopy.bubbleStates.readyNoteSubtitle;
      const readyPreview = summarizeAIResponse(result.rawResponse, result.sql);
      const wantsVisualization = isVisualizationPrompt(requestPrompt);
      const agentWidgets = result.agentWidgets ?? [];
      const hasAgentWidgets = agentWidgets.length > 0;
      const wantsMetricsDashboard =
        hasAgentWidgets ||
        (isDashboardVisualizationPrompt(requestPrompt, result.intent) &&
          supportsOverviewMetricsBoard(activeConnectionDbType));
      const deterministicOverviewChartSql =
        isOverviewVisualizationPrompt(requestPrompt, result.intent)
          ? buildWorkspaceOverviewChartSql(activeConnectionDbType)
          : null;
      const preferredVisualizationSql =
        deterministicOverviewChartSql ||
        (result.sql && isSingleSqlStatement(result.sql) ? result.sql : null);

      if (wantsMetricsDashboard) {
        const visualizationReadApproved = await requestVisualizationReadConsent(requestPrompt);
        if (!visualizationReadApproved) {
          setError(
            prefersVietnameseSystemReply(requestPrompt, language)
              ? "Ban chua cap quyen doc data trong DB cho yeu cau visualization nay."
              : "Visualization data access was not approved for this request."
          );
          return { bubbleId: loadingBubble.id, success: false, cancelled: true };
        }

        const dashboardOpened = await openMetricsBoardInWorkspace({
          title: hasAgentWidgets ? "AI Metrics Summary" : "DB Overview Dashboard",
          template: "database-overview",
          aiWidgets: hasAgentWidgets ? agentWidgets : undefined,
          focusWorkspace: true,
        });

        if (dashboardOpened.success && dashboardOpened.didChange) {
          if (dashboardOpened.created) {
            completeWorkspaceRedirect(loadingBubble.id, sessionId);
          } else {
            updateBubbleForDashboardApplied(
              loadingBubble.id,
              requestPrompt,
              dashboardOpened.addedCount,
              dashboardOpened.addedTitles,
            );
          }
          return { bubbleId: loadingBubble.id, success: true };
        }
        if (dashboardOpened.success) {
          updateBubbleForDashboardNoChange(loadingBubble.id, requestPrompt, dashboardOpened.addedCount);
          return { bubbleId: loadingBubble.id, success: true };
        }
        updateBubbleForDashboardActionFailed(loadingBubble.id, requestPrompt, dashboardOpened.error);
        return { bubbleId: loadingBubble.id, success: false };
      }

      if (wantsVisualization && preferredVisualizationSql) {
        const autoRunInWorkspace =
          deterministicOverviewChartSql !== null || result.risk?.level === "safe";
        if (autoRunInWorkspace) {
          const visualizationReadApproved = await requestVisualizationReadConsent(requestPrompt);
          if (!visualizationReadApproved) {
            setError(
              prefersVietnameseSystemReply(requestPrompt, language)
                ? "Ban chua cap quyen doc data trong DB cho yeu cau visualization nay."
                : "Visualization data access was not approved for this request."
            );
            return { bubbleId: loadingBubble.id, success: false, cancelled: true };
          }
        }
        const workspaceOpened = openSqlInWorkspace(preferredVisualizationSql, {
          title: deterministicOverviewChartSql ? "DB Overview Chart" : "AI Chart",
          viewMode: "chart",
          autoRun: autoRunInWorkspace,
          focusWorkspace: true,
        });

        if (workspaceOpened) {
          completeWorkspaceRedirect(loadingBubble.id, sessionId);
          return { bubbleId: loadingBubble.id, success: true };
        }
      }

      // In agent mode, any grounded SQL the agent produced is eligible to auto-run;
      // the autonomy level + risk classification decide whether it actually runs.
      const agentCanAutoRun =
        interactionMode === "agent" &&
        Boolean(result.sql) &&
        shouldAgentAutoRunSql(activeAgentAutonomy, result.risk?.level);
      if (agentCanAutoRun && result.sql) {
        try {
          const runResult = await runSql(result.sql);
          setBubbles((current) =>
            current.map((bubble) =>
              bubble.id === loadingBubble.id
                ? {
                    ...bubble,
                    kind: "result",
                    status: "ready",
                    title: aiCopy.bubbleStates.runSuccessTitle,
                    subtitle: runResult.queryResult.sandboxed
                      ? aiCopy.bubbleStates.runSuccessSandboxSubtitle
                      : aiCopy.bubbleStates.runSuccessDirectSubtitle,
                    promptSummary: loadingBubble.promptSummary,
                    preview: runResult.summary,
                    detail: buildAIExecutionDetail(runResult.summary, runResult.queryResult.query, result.rawResponse),
                    sql: result.sql || undefined,
                    risk: result.risk,
                    reasoning: result.reasoning,
                    agentSteps: result.agentSteps,
                    autoDismissAt: undefined,
                  }
                : bubble
            )
          );
          return { bubbleId: loadingBubble.id, success: true };
        } catch (errorValue) {
          const message = errorValue instanceof Error ? errorValue.message : String(errorValue);
          setBubbles((current) =>
            current.map((bubble) =>
              bubble.id === loadingBubble.id
                ? {
                    ...bubble,
                    kind: "assistant",
                    status: "ready",
                    title: readyTitle,
                    subtitle: aiCopy.bubbleStates.runFailedSubtitle,
                    promptSummary: loadingBubble.promptSummary,
                    preview: message,
                    detail: buildAIAutoRunFailureDetail(message, result.sql || "", result.rawResponse),
                    sql: result.sql || undefined,
                    risk: result.risk,
                    reasoning: result.reasoning,
                    agentSteps: result.agentSteps,
                    autoDismissAt: undefined,
                  }
                : bubble
            )
          );
          return { bubbleId: loadingBubble.id, success: true };
        }
      }

      setBubbles((current) =>
        current.map((bubble) =>
          bubble.id === loadingBubble.id
            ? {
                ...bubble,
                status: "ready",
                title: readyTitle,
                subtitle: readySubtitle,
                promptSummary: loadingBubble.promptSummary,
                preview: readyPreview,
                detail: result.rawResponse,
                sql: result.sql || undefined,
                risk: result.risk,
                reasoning: result.reasoning,
                agentSteps: result.agentSteps,
              }
            : bubble
        )
      );
      return { bubbleId: loadingBubble.id, success: true };
    } catch (errorValue) {
      const requestError = normalizeAIRequestError(errorValue);
      const wasCancelled = cancelledGenerationBubbleIdsRef.current.has(loadingBubble.id)
        || requestError.code === "cancelled";
      cancelledGenerationBubbleIdsRef.current.delete(loadingBubble.id);

      if (isSupersededAIRequestError(errorValue) && !wasCancelled) {
        setBubbles((current) => current.filter((bubble) => bubble.id !== loadingBubble.id));
        return { bubbleId: loadingBubble.id, success: false, cancelled: true };
      }

      setBubbles((current) =>
        current
          .filter((bubble) =>
            bubble.id === loadingBubble.id ||
            !(
              bubble.kind === "error" &&
              bubble.title === aiCopy.bubbleStates.errorTitle &&
              bubble.subtitle === aiCopy.bubbleStates.errorSubtitle
            )
          )
          .map((bubble) =>
            bubble.id === loadingBubble.id
              ? buildAIRequestFailureBubble(bubble, requestError, wasCancelled, aiCopy)
              : bubble
          )
      );
      if (wasCancelled) setError(null);
      return { bubbleId: loadingBubble.id, success: false, cancelled: wasCancelled };
    }
  }, [
    activeAgentAutonomy,
    activeConnectionDbType,
    activeInteractionMode,
    aiCopy,
    attachedSelection,
    buildLoadingBubble,
    currentThread,
    currentWorkspaceKey,
    generateAssist,
    language,
    latestReadyAssistantBubble,
    completeWorkspaceRedirect,
    openMetricsBoardInWorkspace,
    openSqlInWorkspace,
    requestVisualizationReadConsent,
    runSql,
    setError,
    updateBubbleForDashboardApplied,
    updateBubbleForDashboardActionFailed,
    updateBubbleForAttachedDashboardSummary,
    updateBubbleForDashboardEditNeedsClarification,
    updateBubbleForDashboardEdited,
    updateBubbleForDashboardNoChange,
    updateBubbleForDashboardRebuilt,
    workspaceThreads,
    activeGenerationBubbleIdRef,
    cancelledGenerationBubbleIdsRef,
    openSessionRef,
    setActiveThreadIdsByWorkspace,
    setBubbles,
    setChatThreads,
  ]);

  return { createAssistantBubble };
}
