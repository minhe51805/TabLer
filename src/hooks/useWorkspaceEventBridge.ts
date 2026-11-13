import { useEffect, type Dispatch, type SetStateAction } from "react";

import type { OpenAIMetricsBoardDetail } from "../utils/metrics-board-templates";
import type { WorkspaceActivityState } from "../types/app-types";
import { useAppLayoutStore } from "../stores/appLayoutStore";
import { useModalStore } from "../stores/modalStore";
import { EventCenter } from "../stores/event-center";
import { APP_EVENTS } from "../utils/app-events";

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
  setWorkspaceActivity: Dispatch<SetStateAction<Record<string, WorkspaceActivityState>>>;
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
    const offOpenAI = EventCenter.on(APP_EVENTS.openAISlidePanel, (event) => {
      const detail = event.detail;
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
    });

    const offOpenAIWorkspaceQuery = EventCenter.on(APP_EVENTS.openAIWorkspaceQuery, (event) => {
      openAIWorkspaceQuery(event.detail ?? {});
    });

    const offOpenAIMetricsBoard = EventCenter.on(APP_EVENTS.openAIMetricsBoard, (event) => {
      void openAIMetricsBoard(event.detail ?? {});
    });

    const offOpenAISettings = EventCenter.on(APP_EVENTS.openAISettings, () =>
      setShowAISettings(true),
    );

    const offOpenLeftSidebarPanel = EventCenter.on(APP_EVENTS.openLeftSidebarPanel, (event) => {
      const detail = event.detail;
      if (!detail?.panel) return;

      setIsSidebarCollapsed(false);
      setLeftPanel(detail.panel);
      if (detail.panel === "database" && detail.focusSearch) {
        window.setTimeout(() => {
          EventCenter.emit(APP_EVENTS.focusExplorerSearch);
        }, 0);
      }
    });

    const offWorkspaceActivity = EventCenter.on(APP_EVENTS.workspaceActivity, (event) => {
      const detail = event.detail;
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
    });

    return () => {
      offOpenAI();
      offOpenAIWorkspaceQuery();
      offOpenAIMetricsBoard();
      offOpenAISettings();
      offOpenLeftSidebarPanel();
      offWorkspaceActivity();
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
