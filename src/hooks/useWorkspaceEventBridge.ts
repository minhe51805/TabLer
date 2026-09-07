import { useEffect, type Dispatch, type SetStateAction } from "react";

import type { OpenAIMetricsBoardDetail } from "../utils/metrics-board-templates";
import type { WorkspaceActivityState } from "../types/app-types";
import { useAppLayoutStore } from "../stores/appLayoutStore";
import { useModalStore } from "../stores/modalStore";

export interface OpenAIWorkspaceQueryDetail {
  sql?: string;
  connectionId?: string;
  database?: string;
  title?: string;
  resultViewMode?: "table" | "chart";
  autoRun?: boolean;
  focusWorkspace?: boolean;
}

interface AIWorkspaceAttachment {
  text: string;
  source: string;
  boardId?: string;
}

interface UseWorkspaceEventBridgeOptions {
  openAI: (prompt?: string, attachment?: AIWorkspaceAttachment) => void;
  openAIWorkspaceQuery: (detail: OpenAIWorkspaceQueryDetail) => void;
  openAIMetricsBoard: (detail: OpenAIMetricsBoardDetail) => void | Promise<void>;
  setWorkspaceActivity: Dispatch<
    SetStateAction<Record<string, WorkspaceActivityState>>
  >;
}

export function useWorkspaceEventBridge({
  openAI,
  openAIWorkspaceQuery,
  openAIMetricsBoard,
  setWorkspaceActivity,
}: UseWorkspaceEventBridgeOptions) {
  const setShowAISettings = useModalStore((state) => state.setShowAISettings);
  const setIsSidebarCollapsed = useAppLayoutStore((state) => state.setIsSidebarCollapsed);
  const setLeftPanel = useAppLayoutStore((state) => state.setLeftPanel);

  useEffect(() => {
    const handleOpenAI = (event: Event) => {
      const detail = (event as CustomEvent<{
        prompt?: string;
        attachment?: { text?: string; source?: string; boardId?: string };
      }>).detail;
      openAI(
        detail?.prompt,
        detail?.attachment?.text
          ? {
              text: detail.attachment.text,
              source: detail.attachment.source || "Workspace attachment",
              boardId: detail.attachment.boardId,
            }
          : undefined,
      );
    };

    const handleOpenAIWorkspaceQuery = (event: Event) => {
      openAIWorkspaceQuery(
        (event as CustomEvent<OpenAIWorkspaceQueryDetail>).detail ?? {},
      );
    };

    const handleOpenAIMetricsBoard = (event: Event) => {
      void openAIMetricsBoard(
        (event as CustomEvent<OpenAIMetricsBoardDetail>).detail ?? {},
      );
    };

    const handleOpenAISettings = () => setShowAISettings(true);

    const handleOpenLeftSidebarPanel = (event: Event) => {
      const detail = (event as CustomEvent<{
        panel?: "database" | "metrics";
        focusSearch?: boolean;
      }>).detail;
      if (!detail?.panel) return;

      setIsSidebarCollapsed(false);
      setLeftPanel(detail.panel);
      if (detail.panel === "database" && detail.focusSearch) {
        window.setTimeout(() => {
          window.dispatchEvent(new CustomEvent("focus-explorer-search"));
        }, 0);
      }
    };

    const handleWorkspaceActivity = (event: Event) => {
      const detail = (event as CustomEvent<{
        connectionId?: string;
        label?: string;
        durationMs?: number;
      }>).detail;
      if (!detail?.connectionId || typeof detail.durationMs !== "number" || detail.durationMs < 0) {
        return;
      }

      setWorkspaceActivity((current) => ({
        ...current,
        [detail.connectionId as string]: {
          label: detail.label?.trim() || "Load",
          durationMs: Math.round(detail.durationMs as number),
          at: Date.now(),
        },
      }));
    };

    window.addEventListener("open-ai-slide-panel", handleOpenAI);
    window.addEventListener("open-ai-workspace-query", handleOpenAIWorkspaceQuery);
    window.addEventListener("open-ai-metrics-board", handleOpenAIMetricsBoard);
    window.addEventListener("open-ai-settings", handleOpenAISettings);
    window.addEventListener("open-left-sidebar-panel", handleOpenLeftSidebarPanel);
    window.addEventListener("workspace-activity", handleWorkspaceActivity);
    return () => {
      window.removeEventListener("open-ai-slide-panel", handleOpenAI);
      window.removeEventListener("open-ai-workspace-query", handleOpenAIWorkspaceQuery);
      window.removeEventListener("open-ai-metrics-board", handleOpenAIMetricsBoard);
      window.removeEventListener("open-ai-settings", handleOpenAISettings);
      window.removeEventListener("open-left-sidebar-panel", handleOpenLeftSidebarPanel);
      window.removeEventListener("workspace-activity", handleWorkspaceActivity);
    };
  }, [
    openAI,
    openAIMetricsBoard,
    openAIWorkspaceQuery,
    setIsSidebarCollapsed,
    setLeftPanel,
    setShowAISettings,
    setWorkspaceActivity,
  ]);
}
