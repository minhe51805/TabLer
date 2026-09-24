import { useCallback, type MutableRefObject } from "react";
import type { AppLanguage } from "../../../i18n";
import type { MetricsWidgetType } from "../../../types";
import type { AIMetricsWidgetSpec } from "../../../utils/metrics-board-templates";
import { createAIWorkspaceId } from "../ai-conversation-state";
import type { AIWorkspaceBubbleData } from "../ai-workspace-types";
import type { getAIWorkspaceCopy } from "../ai-workspace-copy";

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

interface UseAIWorkspaceBridgeOptions {
  aiCopy: ReturnType<typeof getAIWorkspaceCopy>;
  connectionId: string | null;
  currentDatabase: string | null;
  language: AppLanguage;
  openSessionRef: MutableRefObject<number>;
  setBubbles: (updater: (current: AIWorkspaceBubbleData[]) => AIWorkspaceBubbleData[]) => void;
  setError: (message: string | null) => void;
}

/**
 * Panel → workspace bridge: push AI SQL into a Query tab, open/augment a
 * metrics board via the window event bus (with a 10s completion timeout), and
 * mark a bubble as "opened in workspace" once the handoff succeeds.
 */
export function useAIWorkspaceBridge({
  aiCopy,
  connectionId,
  currentDatabase,
  language,
  openSessionRef,
  setBubbles,
  setError,
}: UseAIWorkspaceBridgeOptions) {
  const openSqlInWorkspace = useCallback(
    (
      sql: string,
      options?: {
        title?: string;
        viewMode?: "table" | "chart";
        autoRun?: boolean;
        focusWorkspace?: boolean;
      },
    ) => {
      const normalizedSql = sql.trim();
      if (!normalizedSql) return false;

      if (!connectionId) {
        setError(
          language === "vi"
            ? "Hãy kết nối database trước khi mở query AI trong workspace."
            : "Connect to a database before opening an AI query in the workspace.",
        );
        return false;
      }

      window.dispatchEvent(
        new CustomEvent("open-ai-workspace-query", {
          detail: {
            sql: normalizedSql,
            connectionId,
            database: currentDatabase || undefined,
            title: options?.title,
            resultViewMode: options?.viewMode ?? "table",
            autoRun: options?.autoRun ?? false,
            focusWorkspace: options?.focusWorkspace ?? false,
          },
        }),
      );
      return true;
    },
    [connectionId, currentDatabase, language, setError],
  );

  const openMetricsBoardInWorkspace = useCallback(
    async (options?: OpenMetricsBoardOptions) => {
      if (!connectionId) {
        setError(
          language === "vi"
            ? "Hãy kết nối database trước khi mở dashboard AI trong workspace."
            : "Connect to a database before opening an AI dashboard in the workspace.",
        );
        return {
          success: false,
          didChange: false,
          addedCount: 0,
          addedTitles: [],
          created: false,
        } satisfies OpenMetricsBoardResult;
      }

      const requestId = createAIWorkspaceId();

      const completion = await new Promise<OpenMetricsBoardResult>((resolve) => {
        const timeoutId = window.setTimeout(() => {
          window.removeEventListener("open-ai-metrics-board-complete", handleComplete);
          resolve({
            success: false,
            error:
              language === "vi"
                ? "Thao tac dashboard AI het thoi gian cho."
                : "The AI dashboard action timed out.",
            didChange: false,
            addedCount: 0,
            addedTitles: [],
            created: false,
          });
        }, 10_000);

        const handleComplete = (event: Event) => {
          const detail = (
            event as CustomEvent<{
              requestId?: string;
              success?: boolean;
              error?: string;
              boardId?: string;
              didChange?: boolean;
              addedCount?: number;
              addedTitles?: string[];
              created?: boolean;
            }>
          ).detail;
          if (detail?.requestId !== requestId) return;
          window.clearTimeout(timeoutId);
          window.removeEventListener("open-ai-metrics-board-complete", handleComplete);
          if (!detail.success && detail.error) {
            setError(detail.error);
          }
          resolve({
            success: Boolean(detail?.success),
            boardId: detail?.boardId,
            error: detail?.error,
            didChange: Boolean(detail?.didChange),
            addedCount: Math.max(0, detail?.addedCount ?? 0),
            addedTitles: Array.isArray(detail?.addedTitles)
              ? detail.addedTitles.filter((value) => typeof value === "string")
              : [],
            created: Boolean(detail?.created),
          });
        };

        window.addEventListener("open-ai-metrics-board-complete", handleComplete);
        window.dispatchEvent(
          new CustomEvent("open-ai-metrics-board", {
            detail: {
              requestId,
              template: options?.template ?? "database-overview",
              mode: options?.mode ?? "create",
              boardId: options?.boardId,
              editTargetTitle: options?.editTargetTitle,
              editTargetType: options?.editTargetType,
              editQuery: options?.editQuery,
              editTitle: options?.editTitle,
              aiWidgets: options?.aiWidgets,
              connectionId,
              database: currentDatabase || undefined,
              title: options?.title,
              focusWorkspace: options?.focusWorkspace ?? false,
            },
          }),
        );
      });

      return completion;
    },
    [connectionId, currentDatabase, language, setError],
  );

  const completeWorkspaceRedirect = useCallback(
    (bubbleId?: string, sessionId?: number) => {
      if (typeof sessionId === "number" && sessionId !== openSessionRef.current) return;
      // Keep the conversation intact: instead of deleting the bubble and closing
      // the panel, mark the bubble as opened in a workspace tab so the user can
      // ask follow-up questions in the same thread.
      if (bubbleId) {
        setBubbles((current) =>
          current.map((bubble) =>
            bubble.id === bubbleId
              ? {
                  ...bubble,
                  kind: "result",
                  status: "ready",
                  title: aiCopy.bubbleStates.openedInWorkspaceTitle,
                  subtitle: aiCopy.bubbleStates.openedInWorkspaceSubtitle,
                  preview: aiCopy.bubbleStates.openedInWorkspacePreview,
                  detail: bubble.detail || aiCopy.bubbleStates.openedInWorkspacePreview,
                  autoDismissAt: undefined,
                }
              : bubble,
          ),
        );
      }
    },
    [aiCopy, openSessionRef, setBubbles],
  );

  return {
    completeWorkspaceRedirect,
    openMetricsBoardInWorkspace,
    openSqlInWorkspace,
  };
}
