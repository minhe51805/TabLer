import { useCallback, type MutableRefObject } from "react";
import { emitAppToast } from "../../../utils/app-toast";
import { useUIStore } from "../../../stores/uiStore";
import type { AppLanguage } from "../../../i18n";
import type { DatabaseType } from "../../../types";
import { formatAgentSql } from "../../../utils/ai-sql-format";
import { buildExecutionDetail, isSingleSqlStatement } from "../ai-panel-selection";
import {
  buildWorkspaceOverviewChartSql,
  isDashboardVisualizationPrompt,
  isOverviewVisualizationPrompt,
  isVisualizationPrompt,
  supportsOverviewMetricsBoard,
} from "../ai-visualization-intent";
import { aiModeAllowsInsert, aiModeAllowsRun } from "../ai-workspace-types";
import type { AIWorkspaceBubbleData, AIWorkspaceAgentAutonomy } from "../ai-workspace-types";
import type { AIAgentRecordLink } from "../ai-agent-record-links";
import type { getAIWorkspaceCopy } from "../ai-workspace-copy";
import { prefersVietnameseSystemReply } from "../ai-visualization-intent";
import type { AIExecutedSqlResult, AIRunSqlOptions } from "./use-ai-sql-runner";

interface OpenMetricsBoardResult {
  success: boolean;
  boardId?: string;
  error?: string;
  didChange: boolean;
  addedCount: number;
  addedTitles: string[];
  created: boolean;
}

interface UseAIBubbleActionsOptions {
  activeAgentAutonomy: AIWorkspaceAgentAutonomy;
  activeConnectionDbType: DatabaseType | undefined;
  aiCopy: ReturnType<typeof getAIWorkspaceCopy>;
  connectionId: string | null;
  currentDatabase: string | null;
  language: AppLanguage;
  openSessionRef: MutableRefObject<number>;
  copyText: (text: string) => Promise<boolean>;
  completeWorkspaceRedirect: (bubbleId?: string, sessionId?: number) => void;
  insertSql: (sql: string, risk?: AIWorkspaceBubbleData["risk"]) => void;
  openMetricsBoardInWorkspace: (options?: {
    title?: string;
    template?: "database-overview";
    focusWorkspace?: boolean;
  }) => Promise<OpenMetricsBoardResult>;
  openSqlInWorkspace: (
    sql: string,
    options?: {
      title?: string;
      viewMode?: "table" | "chart";
      autoRun?: boolean;
      focusWorkspace?: boolean;
    },
  ) => boolean;
  requestVisualizationReadConsent: (prompt: string) => Promise<boolean>;
  runSql: (sql: string, options?: AIRunSqlOptions) => Promise<AIExecutedSqlResult>;
  setBubbles: (updater: (current: AIWorkspaceBubbleData[]) => AIWorkspaceBubbleData[]) => void;
  setError: (message: string | null) => void;
  updateBubbleForDashboardActionFailed: (bubbleId: string, prompt: string, error?: string) => void;
  updateBubbleForDashboardApplied: (
    bubbleId: string,
    prompt: string,
    addedCount: number,
    addedTitles: string[],
  ) => void;
  updateBubbleForDashboardNoChange: (bubbleId: string, prompt: string, addedCount: number) => void;
}

/**
 * Per-bubble user actions: copy to clipboard, insert into the SQL editor,
 * open a referenced table record, and the big "run in workspace" path that
 * routes visualization prompts to charts/metrics boards and approved SQL to a
 * Query tab (or the sandbox under full autonomy).
 */
export function useAIBubbleActions({
  activeAgentAutonomy,
  activeConnectionDbType,
  aiCopy,
  connectionId,
  currentDatabase,
  language,
  openSessionRef,
  copyText,
  completeWorkspaceRedirect,
  insertSql,
  openMetricsBoardInWorkspace,
  openSqlInWorkspace,
  requestVisualizationReadConsent,
  runSql,
  setBubbles,
  setError,
  updateBubbleForDashboardActionFailed,
  updateBubbleForDashboardApplied,
  updateBubbleForDashboardNoChange,
}: UseAIBubbleActionsOptions) {
  const handleCopyBubble = useCallback(
    async (bubble: AIWorkspaceBubbleData): Promise<boolean> => {
      const text = bubble.sql || bubble.detail || bubble.preview;
      if (!text) return false;
      const ok = await copyText(text);
      const vi = language === "vi";
      if (ok) {
        emitAppToast({
          tone: "success",
          title: vi ? "Đã sao chép" : "Copied",
          description: vi ? "Nội dung đã nằm trên clipboard." : "Content is on the clipboard.",
          durationMs: 3_000,
        });
      } else {
        emitAppToast({
          tone: "error",
          title: vi ? "Sao chép thất bại" : "Copy failed",
          description: vi ? "Không thể ghi vào clipboard." : "Could not write to the clipboard.",
          durationMs: 5_000,
        });
      }
      return ok;
    },
    [copyText, language],
  );

  const handleInsertBubble = useCallback(
    (bubble: AIWorkspaceBubbleData) => {
      if (!bubble.sql || !aiModeAllowsInsert(bubble.interactionMode)) return;
      insertSql(bubble.sql, bubble.risk);
    },
    [insertSql],
  );

  const handleOpenAgentRecord = useCallback(
    (link: AIAgentRecordLink) => {
      if (!connectionId) {
        setError("Connect to a database before opening a record.");
        return;
      }

      useUIStore.getState().addTab({
        id: `table-${connectionId}-${currentDatabase || ""}-${link.tableName}-${crypto.randomUUID()}`,
        type: "table",
        title: link.tableName,
        connectionId,
        tableName: link.tableName,
        database: currentDatabase || undefined,
        rowFocus: {
          token: crypto.randomUUID(),
          values: link.rowKey,
        },
      });
    },
    [connectionId, currentDatabase, setError],
  );

  const handleRunBubble = useCallback(
    async (bubble: AIWorkspaceBubbleData) => {
      if (!bubble.sql || !aiModeAllowsRun(bubble.interactionMode)) return;
      const sessionId = openSessionRef.current;
      // The workspace Query tab should receive pretty-printed SQL — the same
      // formatting the chat bubble shows — instead of the model's one-liner.
      const runnableSql = formatAgentSql(bubble.sql);
      const bubbleIntentPrompt = bubble.promptSummary?.trim() || bubble.prompt;

      if (isVisualizationPrompt(bubbleIntentPrompt)) {
        const wantsMetricsDashboard =
          isDashboardVisualizationPrompt(bubbleIntentPrompt) &&
          supportsOverviewMetricsBoard(activeConnectionDbType);
        const deterministicOverviewChartSql = isOverviewVisualizationPrompt(bubbleIntentPrompt)
          ? buildWorkspaceOverviewChartSql(activeConnectionDbType)
          : null;
        const preferredVisualizationSql =
          deterministicOverviewChartSql ||
          (runnableSql && isSingleSqlStatement(runnableSql) ? runnableSql : null);

        if (wantsMetricsDashboard) {
          const visualizationReadApproved =
            await requestVisualizationReadConsent(bubbleIntentPrompt);
          if (!visualizationReadApproved) {
            setError(
              prefersVietnameseSystemReply(bubbleIntentPrompt, language)
                ? "Bạn chưa cấp quyền đọc data trong DB cho yêu cầu visualization này."
                : "Visualization data access was not approved for this request.",
            );
            return;
          }

          const dashboardOpened = await openMetricsBoardInWorkspace({
            title: "DB Overview Dashboard",
            template: "database-overview",
            focusWorkspace: true,
          });

          if (dashboardOpened.success && dashboardOpened.didChange) {
            if (dashboardOpened.created) {
              completeWorkspaceRedirect(bubble.id, sessionId);
            } else {
              updateBubbleForDashboardApplied(
                bubble.id,
                bubbleIntentPrompt,
                dashboardOpened.addedCount,
                dashboardOpened.addedTitles,
              );
            }
            return;
          }
          if (dashboardOpened.success) {
            updateBubbleForDashboardNoChange(
              bubble.id,
              bubbleIntentPrompt,
              dashboardOpened.addedCount,
            );
            return;
          }
          updateBubbleForDashboardActionFailed(
            bubble.id,
            bubbleIntentPrompt,
            dashboardOpened.error,
          );
          return;
        }

        if (!preferredVisualizationSql) {
          return;
        }

        const autoRunInWorkspace =
          deterministicOverviewChartSql !== null || bubble.risk?.level === "safe";
        if (autoRunInWorkspace) {
          const visualizationReadApproved =
            await requestVisualizationReadConsent(bubbleIntentPrompt);
          if (!visualizationReadApproved) {
            setError(
              prefersVietnameseSystemReply(bubbleIntentPrompt, language)
                ? "Bạn chưa cấp quyền đọc data trong DB cho yêu cầu visualization này."
                : "Visualization data access was not approved for this request.",
            );
            return;
          }
        }
        const workspaceOpened = openSqlInWorkspace(preferredVisualizationSql, {
          title: deterministicOverviewChartSql ? "DB Overview Chart" : "AI Chart",
          viewMode: "chart",
          autoRun: autoRunInWorkspace,
          focusWorkspace: true,
        });

        if (workspaceOpened) {
          completeWorkspaceRedirect(bubble.id, sessionId);
          return;
        }
      }

      // Approved SQL should run where the user can see it: push it into a
      // Query tab in the workspace and execute there, instead of only running
      // inside the AI sandbox. Safe read-only SQL auto-runs; mutating or
      // dangerous SQL opens ready-to-run so the user presses Chạy themselves.
      // The Duyệt chạy button itself never disappears — but a bubble that was
      // already opened in the workspace must not spawn yet another tab.
      // Exception: "full" autonomy is a standing human approval, so the run
      // executes immediately in the sandbox — no ready-to-run tab that would
      // only end in another confirmation dialog.
      if (bubble.openedInWorkspace) {
        return;
      }
      const approvedRiskLevel = bubble.risk?.level;
      const fullAutonomyRun = activeAgentAutonomy === "full";
      const workspaceOpened = fullAutonomyRun
        ? false
        : openSqlInWorkspace(runnableSql, {
            title: "AI Query",
            autoRun: approvedRiskLevel === "safe",
            focusWorkspace: true,
          });
      if (workspaceOpened) {
        setBubbles((current) =>
          current.map((currentBubble) =>
            currentBubble.id === bubble.id
              ? { ...currentBubble, openedInWorkspace: true }
              : currentBubble,
          ),
        );
        return;
      }

      try {
        const result = await runSql(runnableSql, { agentAutonomy: activeAgentAutonomy, language });
        setBubbles((current) =>
          current.map((currentBubble) =>
            currentBubble.id === bubble.id
              ? {
                  ...currentBubble,
                  kind: "result",
                  status: "ready",
                  title: aiCopy.bubbleStates.runSuccessTitle,
                  subtitle: result.queryResult.sandboxed
                    ? aiCopy.bubbleStates.runSuccessSandboxSubtitle
                    : aiCopy.bubbleStates.runSuccessDirectSubtitle,
                  preview: result.summary,
                  detail: buildExecutionDetail(
                    result.summary,
                    result.queryResult.query,
                    currentBubble.detail,
                  ),
                  autoDismissAt: undefined,
                }
              : currentBubble,
          ),
        );
      } catch (errorValue) {
        const message = errorValue instanceof Error ? errorValue.message : String(errorValue);
        setBubbles((current) =>
          current.map((currentBubble) =>
            currentBubble.id === bubble.id
              ? {
                  ...currentBubble,
                  kind: "error",
                  status: "error",
                  title: aiCopy.bubbleStates.runFailedTitle,
                  subtitle: aiCopy.bubbleStates.runFailedSubtitle,
                  preview: message,
                  detail: message,
                  autoDismissAt: undefined,
                }
              : currentBubble,
          ),
        );
      }
    },
    [
      activeAgentAutonomy,
      activeConnectionDbType,
      aiCopy.bubbleStates.runFailedSubtitle,
      aiCopy.bubbleStates.runFailedTitle,
      aiCopy.bubbleStates.runSuccessDirectSubtitle,
      aiCopy.bubbleStates.runSuccessSandboxSubtitle,
      aiCopy.bubbleStates.runSuccessTitle,
      completeWorkspaceRedirect,
      language,
      openMetricsBoardInWorkspace,
      openSessionRef,
      openSqlInWorkspace,
      requestVisualizationReadConsent,
      runSql,
      setBubbles,
      setError,
      updateBubbleForDashboardActionFailed,
      updateBubbleForDashboardApplied,
      updateBubbleForDashboardNoChange,
    ],
  );

  return {
    handleCopyBubble,
    handleInsertBubble,
    handleOpenAgentRecord,
    handleRunBubble,
  };
}
