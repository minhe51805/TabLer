import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { MetricsWidgetType } from "../../../types";
import type { AIWorkspaceBubbleData } from "../ai-workspace-types";
import {
  prefersVietnameseSystemReply,
  summarizeAttachedDashboardSelection,
  type VisualizationSelectionContext,
} from "../ai-visualization-intent";

interface UseAIDashboardBubbleUpdatesOptions {
  language: string;
  setBubbles: Dispatch<SetStateAction<AIWorkspaceBubbleData[]>>;
}

export function formatDashboardWidgetType(type: MetricsWidgetType, useVietnamese: boolean) {
  const labels: Record<MetricsWidgetType, [vietnamese: string, english: string]> = {
    table: ["bang du lieu", "table"],
    scoreboard: ["scoreboard", "scoreboard"],
    bar: ["bar chart", "bar chart"],
    "horizontal-bar": ["horizontal bar chart", "horizontal bar chart"],
    line: ["line chart", "line chart"],
    area: ["area chart", "area chart"],
    pie: ["pie chart", "pie chart"],
    donut: ["donut chart", "donut chart"],
    radial: ["radial chart", "radial chart"],
  };
  return labels[type][useVietnamese ? 0 : 1];
}

export function useAIDashboardBubbleUpdates({
  language,
  setBubbles,
}: UseAIDashboardBubbleUpdatesOptions) {
  const updateBubbleForDashboardNoChange = useCallback((bubbleId: string, promptText: string, addedCount = 0) => {
    const useVietnamese = prefersVietnameseSystemReply(promptText, language);
    const preview = useVietnamese
      ? "Dashboard hien tai chua co widget moi de them tu dong. Mình giu chat mo de ban noi ro muon them hoac doi chart nao."
      : "The current dashboard does not have new widgets to add automatically yet. I kept chat open so you can tell me which charts to add or change.";
    const detail = useVietnamese
      ? [
          "Dashboard hien tai da duoc mo, nhung TableR chua tim thay chart moi de them vao board nay tu template hien co.",
          addedCount > 0 ? `So widget vua them: ${addedCount}.` : "Chua co thay doi chart nao duoc ap dung.",
          "",
          "Hay noi ro hon, vi du:",
          "- them bieu do kich thuoc bang",
          "- doi pie chart nay thanh bar chart",
          "- them widget thong ke tong so cot",
        ].join("\n")
      : [
          "The dashboard is open, but TableR did not find any new template widgets to add to this board.",
          addedCount > 0 ? `Widgets added just now: ${addedCount}.` : "No chart changes were applied.",
          "",
          "Try being more specific, for example:",
          "- add a table size chart",
          "- change this pie chart to a bar chart",
          "- add a total columns scoreboard",
        ].join("\n");

    setBubbles((current) =>
      current.map((bubble) =>
        bubble.id === bubbleId
          ? {
              ...bubble,
              kind: "assistant",
              status: "ready",
              title: useVietnamese ? "Dashboard chua thay doi" : "Dashboard unchanged",
              subtitle: useVietnamese ? "Khong co chart moi duoc ap dung" : "No new chart changes were applied",
              preview,
              detail,
              sql: undefined,
              risk: undefined,
              autoDismissAt: undefined,
            }
          : bubble,
      ),
    );
  }, [language, setBubbles]);

  const updateBubbleForDashboardActionFailed = useCallback((
    bubbleId: string,
    promptText: string,
    reason?: string,
  ) => {
    const useVietnamese = prefersVietnameseSystemReply(promptText, language);
    const fallbackReason = useVietnamese
      ? "TableR khong the hoan tat thao tac dashboard trong lan nay."
      : "TableR could not finish the dashboard action for this request.";
    const resolvedReason = reason?.trim() || fallbackReason;
    const preview = useVietnamese
      ? "Thao tac dashboard da dung lai, chat van mo de ban thu lai hoac doi yeu cau cu the hon."
      : "The dashboard action stopped here. Chat stays open so you can retry or make the request more specific.";
    const detail = useVietnamese
      ? [
          resolvedReason,
          "",
          "Ban co the thu lai voi cac yeu cau ro hon, vi du:",
          "- doi OAuth Clients thanh scoreboard",
          "- lam moi dashboard nay theo schema hien tai",
          "- bo cac chart thua va giu lai chart co y nghia",
        ].join("\n")
      : [
          resolvedReason,
          "",
          "Try again with a more specific request, for example:",
          '- change "OAuth Clients" to a scoreboard',
          "- rebuild this dashboard from the current schema",
          "- remove redundant charts and keep only useful ones",
        ].join("\n");

    setBubbles((current) =>
      current.map((bubble) =>
        bubble.id === bubbleId
          ? {
              ...bubble,
              kind: "assistant",
              status: "error",
              title: useVietnamese ? "Thao tac dashboard khong thanh cong" : "Dashboard action failed",
              subtitle: useVietnamese ? "Khong ap dung thay doi nao" : "No dashboard change was applied",
              preview,
              detail,
              sql: undefined,
              risk: undefined,
              autoDismissAt: undefined,
            }
          : bubble,
      ),
    );
  }, [language, setBubbles]);

  const updateBubbleForDashboardEditNeedsClarification = useCallback((bubbleId: string, promptText: string) => {
    const useVietnamese = prefersVietnameseSystemReply(promptText, language);
    const preview = useVietnamese
      ? "Mình giu nguyen thao tac trong dashboard, nhung chua xac dinh chinh xac widget hoac loai chart can doi."
      : "I stayed in dashboard edit mode, but I could not identify the exact widget or replacement chart yet.";
    const detail = useVietnamese
      ? [
          "TableR da giu yeu cau nay trong dashboard hien tai thay vi mo query ben ngoai.",
          "Nhung de sua dung widget, minh can ban noi ro hon mot chut, vi du:",
          "- doi OAuth Clients thanh scoreboard",
          "- doi Average Rating by Product thanh table",
          "- doi pie chart Products by Brand thanh bar chart",
        ].join("\n")
      : [
          "TableR kept this request inside the current dashboard instead of opening an external query tab.",
          "To edit the correct widget, be a bit more specific, for example:",
          '- change "OAuth Clients" to a scoreboard',
          '- change "Average Rating by Product" to a table',
          '- change the pie chart "Products by Brand" to a bar chart',
        ].join("\n");

    setBubbles((current) =>
      current.map((bubble) =>
        bubble.id === bubbleId
          ? {
              ...bubble,
              kind: "assistant",
              status: "ready",
              title: useVietnamese ? "Can noi ro widget can sua" : "Need a clearer widget target",
              subtitle: useVietnamese ? "Chua sua dashboard vi chua map duoc widget" : "Dashboard edit was not applied yet",
              preview,
              detail,
              sql: undefined,
              risk: undefined,
              autoDismissAt: undefined,
            }
          : bubble,
      ),
    );
  }, [language, setBubbles]);

  const updateBubbleForAttachedDashboardSummary = useCallback((
    bubbleId: string,
    promptText: string,
    selection: VisualizationSelectionContext,
  ) => {
    const useVietnamese = prefersVietnameseSystemReply(promptText, language);
    const summary = summarizeAttachedDashboardSelection(selection);
    const topTitles = summary.widgetTitles.slice(0, 6);
    const remainingCount = Math.max(0, summary.widgetCount - topTitles.length);

    const preview = useVietnamese
      ? `Minh da doc snapshot cua board "${summary.boardName}" ngay trong app, khong can goi them model hay mo query ben ngoai.`
      : `I read the attached snapshot for "${summary.boardName}" locally, without calling the model or opening an external query.`;

    const detail = useVietnamese
      ? [
          `Board hien tai: ${summary.boardName}`,
          `So widget dang co: ${summary.widgetCount}`,
          topTitles.length > 0 ? `Widget dang hien: ${topTitles.join(", ")}.` : "",
          remainingCount > 0 ? `Con ${remainingCount} widget nua dang co tren board nay.` : "",
          "",
          "Ban co the noi ro tiep, vi du:",
          "- doi OAuth Clients thanh scoreboard",
          "- xoa cac chart thua",
          "- sap xep lai hang dau cho gon hon",
          "- lam moi dashboard nay theo data hien tai",
        ].filter(Boolean).join("\n")
      : [
          `Current board: ${summary.boardName}`,
          `Current widget count: ${summary.widgetCount}`,
          topTitles.length > 0 ? `Visible widgets: ${topTitles.join(", ")}.` : "",
          remainingCount > 0 ? `${remainingCount} more widget(s) are also present on this board.` : "",
          "",
          "You can be more specific next, for example:",
          '- change "OAuth Clients" to a scoreboard',
          "- remove redundant charts",
          "- tighten the first row layout",
          "- rebuild this dashboard from the current data",
        ].filter(Boolean).join("\n");

    setBubbles((current) =>
      current.map((bubble) =>
        bubble.id === bubbleId
          ? {
              ...bubble,
              kind: "assistant",
              status: "ready",
              title: useVietnamese ? "Da doc snapshot dashboard" : "Dashboard snapshot loaded",
              subtitle: useVietnamese ? "San sang sua truc tiep tren board hien tai" : "Ready to edit the current board directly",
              preview,
              detail,
              sql: undefined,
              risk: undefined,
              autoDismissAt: undefined,
            }
          : bubble,
      ),
    );
  }, [language, setBubbles]);

  const updateBubbleForDashboardApplied = useCallback((
    bubbleId: string,
    promptText: string,
    addedCount = 0,
    addedTitles: string[] = [],
  ) => {
    const normalizedCount = Math.max(0, addedCount);
    const useVietnamese = prefersVietnameseSystemReply(promptText, language);
    const summarizedTitles = addedTitles.slice(0, 4);
    const title = useVietnamese
      ? normalizedCount > 0
        ? "Da bo sung dashboard"
        : "Dashboard da duoc dong bo"
      : normalizedCount > 0
        ? "Dashboard updated"
        : "Dashboard synced";
    const subtitle = useVietnamese
      ? normalizedCount > 0
        ? `Da them ${normalizedCount} widget moi vao board hien tai`
        : "Khong can tao board moi"
      : normalizedCount > 0
        ? `Added ${normalizedCount} new widget${normalizedCount === 1 ? "" : "s"} to the current board`
        : "No new board was created";
    const preview = useVietnamese
      ? normalizedCount > 0
        ? `Mình da bo sung ${normalizedCount} widget vao dashboard hien tai va giu chat mo de ban chinh tiep.`
        : "Mình da dong bo dashboard hien tai va giu chat mo de ban chinh tiep."
      : normalizedCount > 0
        ? `I added ${normalizedCount} chart widget${normalizedCount === 1 ? "" : "s"} directly to the current dashboard and kept chat open for follow-up changes.`
        : "I updated the current dashboard and kept chat open for follow-up changes.";
    const detail = useVietnamese
      ? [
          normalizedCount > 0
            ? `Dashboard hien tai da duoc cap nhat voi ${normalizedCount} widget moi.`
            : "Dashboard hien tai da duoc mo va dong bo lai.",
          summarizedTitles.length > 0 ? `Da them: ${summarizedTitles.join(", ")}.` : "",
          "",
          "Ban co the yeu cau tiep, vi du:",
          "- doi pie chart thanh bar chart",
          "- them bieu do kich thuoc bang",
          "- gop bieu do score vao hang dau",
        ].filter(Boolean).join("\n")
      : [
          normalizedCount > 0
            ? `The current dashboard was updated with ${normalizedCount} new widget${normalizedCount === 1 ? "" : "s"}.`
            : "The current dashboard is active and ready for more edits.",
          summarizedTitles.length > 0 ? `Added: ${summarizedTitles.join(", ")}.` : "",
          "",
          "You can keep going, for example:",
          "- change the pie chart to a bar chart",
          "- add a table size chart",
          "- move the score widgets to the first row",
        ].filter(Boolean).join("\n");

    setBubbles((current) =>
      current.map((bubble) =>
        bubble.id === bubbleId
          ? {
              ...bubble,
              kind: "assistant",
              status: "ready",
              title,
              subtitle,
              preview,
              detail,
              sql: undefined,
              risk: undefined,
              autoDismissAt: undefined,
            }
          : bubble,
      ),
    );
  }, [language, setBubbles]);

  const updateBubbleForDashboardEdited = useCallback((
    bubbleId: string,
    promptText: string,
    widgetTitle: string,
    nextType: MetricsWidgetType,
  ) => {
    const useVietnamese = prefersVietnameseSystemReply(promptText, language);
    const chartTypeLabel = formatDashboardWidgetType(nextType, useVietnamese);

    setBubbles((current) =>
      current.map((bubble) =>
        bubble.id === bubbleId
          ? {
              ...bubble,
              kind: "assistant",
              status: "ready",
              title: useVietnamese ? "Da sua widget tren dashboard" : "Dashboard widget updated",
              subtitle: useVietnamese
                ? `Da doi "${widgetTitle}" sang ${chartTypeLabel}`
                : `Changed "${widgetTitle}" to ${chartTypeLabel}`,
              preview: useVietnamese
                ? `Mình da sua truc tiep widget "${widgetTitle}" tren dashboard hien tai.`
                : `I updated "${widgetTitle}" directly on the current dashboard.`,
              detail: useVietnamese
                ? [
                    `Widget "${widgetTitle}" da duoc doi sang ${chartTypeLabel} ngay tren board hien tai.`,
                    "",
                    "Ban co the yeu cau tiep, vi du:",
                    "- doi tiep widget nay thanh line chart",
                    "- sua query cua widget nay",
                    "- xoa widget nay neu khong can nua",
                  ].join("\n")
                : [
                    `The widget "${widgetTitle}" was updated to ${chartTypeLabel} on the current board.`,
                    "",
                    "You can keep going, for example:",
                    "- change this widget to a line chart",
                    "- update this widget query",
                    "- remove this widget if it is not useful",
                  ].join("\n"),
              sql: undefined,
              risk: undefined,
              autoDismissAt: undefined,
            }
          : bubble,
      ),
    );
  }, [language, setBubbles]);

  const updateBubbleForDashboardRebuilt = useCallback((
    bubbleId: string,
    promptText: string,
    widgetCount = 0,
    widgetTitles: string[] = [],
  ) => {
    const normalizedCount = Math.max(0, widgetCount);
    const useVietnamese = prefersVietnameseSystemReply(promptText, language);
    const summarizedTitles = widgetTitles.slice(0, 5);
    const title = useVietnamese ? "Da lam moi dashboard" : "Dashboard rebuilt";
    const subtitle = useVietnamese
      ? `Da tao lai ${normalizedCount} widget theo schema hien tai`
      : `Rebuilt ${normalizedCount} widget${normalizedCount === 1 ? "" : "s"} from the current schema`;
    const preview = useVietnamese
      ? `Mình da lam moi dashboard hien tai dua tren schema/DB dang mo va giu chat mo de ban chinh tiep.`
      : "I rebuilt the current dashboard from the live schema and kept chat open for follow-up edits.";
    const detail = useVietnamese
      ? [
          `Dashboard hien tai da duoc lam moi lai voi ${normalizedCount} widget bam sat schema hien tai.`,
          summarizedTitles.length > 0 ? `Widget chinh: ${summarizedTitles.join(", ")}.` : "",
          "",
          "Ban co the yeu cau tiep, vi du:",
          "- doi pie chart thanh bar chart",
          "- xoa widget nao chua can",
          "- uu tien chart ve users, orders, auth, hoac messages",
        ].filter(Boolean).join("\n")
      : [
          `The current dashboard was rebuilt with ${normalizedCount} widget${normalizedCount === 1 ? "" : "s"} based on the live schema.`,
          summarizedTitles.length > 0 ? `Main widgets: ${summarizedTitles.join(", ")}.` : "",
          "",
          "You can keep going, for example:",
          "- change the pie chart to a bar chart",
          "- remove widgets you do not need",
          "- focus the board on users, orders, auth, or messaging",
        ].filter(Boolean).join("\n");

    setBubbles((current) =>
      current.map((bubble) =>
        bubble.id === bubbleId
          ? {
              ...bubble,
              kind: "assistant",
              status: "ready",
              title,
              subtitle,
              preview,
              detail,
              sql: undefined,
              risk: undefined,
              autoDismissAt: undefined,
            }
          : bubble,
      ),
    );
  }, [language, setBubbles]);

  return {
    updateBubbleForDashboardNoChange,
    updateBubbleForDashboardActionFailed,
    updateBubbleForDashboardEditNeedsClarification,
    updateBubbleForAttachedDashboardSummary,
    updateBubbleForDashboardApplied,
    updateBubbleForDashboardEdited,
    updateBubbleForDashboardRebuilt,
  };
}
