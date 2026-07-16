import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../i18n";
import { useAIStore } from "../../stores/aiStore";
import { useConnectionStore } from "../../stores/connectionStore";
import { useUIStore } from "../../stores/uiStore";
import type { MetricsWidgetType } from "../../types";
import type { AIMetricsWidgetSpec } from "../../utils/metrics-board-templates";
import { normalizeAIProviderConfigs } from "../../utils/ai-provider-registry";
import { invokeMutation } from "../../utils/tauri-utils";
import { AIWorkspacePanelView } from "./AIWorkspacePanelView";
import { useAIAssistantGeneration } from "./hooks/use-ai-assistant-generation";
import { useAIDashboardBubbleUpdates } from "./hooks/use-ai-dashboard-bubble-updates";
import { useAIWorkspaceEffects } from "./hooks/use-ai-workspace-effects";
import { useAIPanelPreferences } from "./hooks/use-ai-panel-preferences";
import { AI_REQUEST_REPLACED_MESSAGE, useAISlidePanel } from "./hooks/use-ai-slide-panel";
import {
  aiModeAllowsInsert,
  aiModeAllowsRun,
  getDefaultAIWorkspaceInteractionMode,
  isAIWorkspaceAgentAutonomy,
  DEFAULT_AI_WORKSPACE_AGENT_AUTONOMY,
  type AIWorkspaceAgentAutonomy,
  type AIWorkspaceBubbleData,
  type AIWorkspaceInteractionMode,
} from "./ai-workspace-types";
import { getAIWorkspaceCopy } from "./ai-workspace-copy";
import {
  buildWorkspaceOverviewChartSql,
  isDashboardSelectionSource,
  isDashboardVisualizationPrompt,
  isOverviewVisualizationPrompt,
  isVisualizationPrompt,
  prefersVietnameseSystemReply,
  supportsOverviewMetricsBoard,
} from "./ai-visualization-intent";
import { buildAIWorkspaceKey, buildConversationHistoryMessages, createAIWorkspaceId, createChatThread, prunePersistedAIWorkspaceState, summarizePromptForDisplay, type AIChatThread, type PersistedAIWorkspaceState } from "./ai-conversation-state";
import { buildExecutionDetail, buildPromptWithSelection, isSingleSqlStatement, type SelectionContextState } from "./ai-panel-selection";
import type { AIAgentRecordLink } from "./ai-agent-record-links";

interface Props {
  isOpen: boolean;
  initialPrompt?: string;
  initialPromptNonce?: number;
  initialAttachment?: {
    text: string;
    source: string;
    boardId?: string;
  };
  initialAttachmentNonce?: number;
  onClose: () => void;
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

interface VisualizationReadConsentState {
  title: string;
  message: string;
  confirmText: string;
  cancelText: string;
}

const AI_WORKSPACE_AGENT_AUTONOMY_STORAGE_KEY = "tabler.ai.workspace.agentAutonomy.v1";
const AI_WORKSPACE_THINKING_STORAGE_KEY = "tabler.ai.workspace.showThinking.v1";

export function AISlidePanel({
  isOpen,
  initialPrompt = "",
  initialPromptNonce = 0,
  initialAttachment,
  initialAttachmentNonce = 0,
  onClose,
}: Props) {
  const { language } = useI18n();
  const aiCopy = useMemo(() => getAIWorkspaceCopy(language), [language]);
  const aiConfigs = useAIStore((state) => state.aiConfigs);
  const loadAIConfigs = useAIStore((state) => state.loadAIConfigs);
  const saveAIConfigs = useAIStore((state) => state.saveAIConfigs);
  const activeConnectionDbType = useConnectionStore((state) =>
    state.connections.find((connection) => connection.id === state.activeConnectionId)?.db_type
  );
  const {
    activeProvider,
    tableContextCount,
    connectionId,
    currentDatabase,
    error,
    setError,
    isGenerating,
    isCancelling,
    isRunning,
    cancelGeneration,
    generateAssist,
    copyText,
    insertSql,
    runSql,
  } = useAISlidePanel({ isOpen });

  const composerRef = useRef<HTMLDivElement>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement>(null);
  const chatThreadRef = useRef<HTMLDivElement>(null);
  const historyPanelRef = useRef<HTMLDivElement>(null);
  const bubbleDismissTimersRef = useRef(new Map<string, number>());
  const historySaveTimerRef = useRef<number | null>(null);
  const openSessionRef = useRef(0);
  const isOpenRef = useRef(isOpen);
  const visualizationConsentResolverRef = useRef<((value: boolean) => void) | null>(null);
  const visualizationApprovalScopeRef = useRef<string | null>(null);
  const activeGenerationBubbleIdRef = useRef<string | null>(null);
  const cancelledGenerationBubbleIdsRef = useRef(new Set<string>());
  const currentWorkspaceKey = useMemo(
    () => buildAIWorkspaceKey(connectionId, currentDatabase),
    [connectionId, currentDatabase]
  );
  const lastWorkspaceKeyRef = useRef(currentWorkspaceKey);
  const initialThreadRef = useRef<AIChatThread | null>(null);
  if (!initialThreadRef.current) {
    initialThreadRef.current = createChatThread(1, currentWorkspaceKey);
  }

  const [promptDraft, setPromptDraft] = useState(initialPrompt);
  const [bubbles, setBubbles] = useState<AIWorkspaceBubbleData[]>([]);
  const [chatThreads, setChatThreads] = useState<AIChatThread[]>([]);
  const [workspaceInteractionModes, setWorkspaceInteractionModes] = useState<Record<string, AIWorkspaceInteractionMode>>(
    {}
  );
  const [workspaceAgentAutonomy, setWorkspaceAgentAutonomy] = useState<Record<string, AIWorkspaceAgentAutonomy>>(() => {
    if (typeof window === "undefined") return {};
    try {
      const raw = window.localStorage.getItem(AI_WORKSPACE_AGENT_AUTONOMY_STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw) as Record<string, unknown> | null;
      if (!parsed || typeof parsed !== "object") return {};
      const result: Record<string, AIWorkspaceAgentAutonomy> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (isAIWorkspaceAgentAutonomy(value)) result[key] = value;
      }
      return result;
    } catch {
      return {};
    }
  });
  const [showThinking, setShowThinking] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    try {
      const raw = window.localStorage.getItem(AI_WORKSPACE_THINKING_STORAGE_KEY);
      return raw === null ? true : raw === "true";
    } catch {
      return true;
    }
  });
  const [activeThreadIdsByWorkspace, setActiveThreadIdsByWorkspace] = useState<Record<string, string>>(
    {}
  );
  const [activeThreadId, setActiveThreadId] = useState<string>(initialThreadRef.current!.id);
  const [historyHydrated, setHistoryHydrated] = useState(false);
  const [detailBubbleId, setDetailBubbleId] = useState<string | null>(null);
  const [isInspectMode, setIsInspectMode] = useState(false);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [isSwitchingProvider, setIsSwitchingProvider] = useState(false);
  const [selectionContext, setSelectionContext] = useState<SelectionContextState | null>(null);
  const [attachedSelection, setAttachedSelection] = useState<SelectionContextState | null>(null);
  const [deleteThreadPending, setDeleteThreadPending] = useState<string | null>(null);
  const [visualizationConsentPending, setVisualizationConsentPending] = useState<VisualizationReadConsentState | null>(null);
  const [isSessionDataReadEnabled, setIsSessionDataReadEnabled] = useState(false);

  const detailBubble = useMemo(
    () => bubbles.find((bubble) => bubble.id === detailBubbleId) ?? null,
    [bubbles, detailBubbleId]
  );
  const workspaceThreads = useMemo(
    () => chatThreads.filter((thread) => thread.workspaceKey === currentWorkspaceKey),
    [chatThreads, currentWorkspaceKey]
  );
  const recentWorkspaceThreads = useMemo(
    () => [...workspaceThreads].sort((left, right) => right.updatedAt - left.updatedAt),
    [workspaceThreads]
  );
  const currentThread = useMemo(
    () => workspaceThreads.find((thread) => thread.id === activeThreadId) ?? workspaceThreads[0] ?? null,
    [activeThreadId, workspaceThreads]
  );
  const activeInteractionMode = useMemo(
    () => workspaceInteractionModes[currentWorkspaceKey] ?? getDefaultAIWorkspaceInteractionMode(activeProvider?.allow_schema_context),
    [activeProvider?.allow_schema_context, currentWorkspaceKey, workspaceInteractionModes]
  );
  const activeAgentAutonomy = useMemo<AIWorkspaceAgentAutonomy>(
    () => workspaceAgentAutonomy[currentWorkspaceKey] ?? DEFAULT_AI_WORKSPACE_AGENT_AUTONOMY,
    [currentWorkspaceKey, workspaceAgentAutonomy]
  );
  const activeThreadBubbles = useMemo(
    () => (
      !currentThread
        ? []
        : bubbles.filter((bubble) => bubble.threadId === currentThread.id && bubble.workspaceKey === currentWorkspaceKey)
    ),
    [bubbles, currentThread, currentWorkspaceKey]
  );
  const historyMessages = useMemo(
    () => buildConversationHistoryMessages(activeThreadBubbles),
    [activeThreadBubbles]
  );
  const conversationBubbles = useMemo(
    () => [...activeThreadBubbles].sort((left, right) => left.createdAt - right.createdAt),
    [activeThreadBubbles]
  );
  const bubbleCountByThread = useMemo(() => {
    const counts = new Map<string, number>();
    bubbles
      .filter((bubble) => bubble.workspaceKey === currentWorkspaceKey && bubble.status !== "loading")
      .forEach((bubble) => {
        counts.set(bubble.threadId, (counts.get(bubble.threadId) || 0) + 1);
      });
    return counts;
  }, [bubbles, currentWorkspaceKey]);
  const isLongformComposer = activeInteractionMode === "agent" || activeThreadBubbles.length >= 2;
  const hasConversation = conversationBubbles.length > 0;
  const latestConversationBubbleId = conversationBubbles[conversationBubbles.length - 1]?.id ?? null;
  const latestConversationBubbleSnapshot = useMemo(() => {
    const latestBubble = conversationBubbles[conversationBubbles.length - 1];
    if (!latestBubble) return null;
    return [
      latestBubble.id,
      latestBubble.status,
      latestBubble.preview.length,
      latestBubble.detail.length,
      latestBubble.sql?.length ?? 0,
      latestBubble.agentSteps?.length ?? 0,
      latestBubble.createdAt,
    ].join(":");
  }, [conversationBubbles]);
  const latestReadyAssistantBubble = useMemo(
    () => [...conversationBubbles].reverse().find((bubble) => bubble.kind === "assistant" && bubble.status === "ready") ?? null,
    [conversationBubbles],
  );
  const switchableProviders = useMemo(() => {
    const normalized = normalizeAIProviderConfigs(aiConfigs);
    return [...normalized].sort((left, right) => {
      const leftScore =
        (left.id === activeProvider?.id ? 4 : 0) +
        (left.is_enabled ? 2 : 0) +
        (left.is_primary ? 1 : 0);
      const rightScore =
        (right.id === activeProvider?.id ? 4 : 0) +
        (right.is_enabled ? 2 : 0) +
        (right.is_primary ? 1 : 0);
      return rightScore - leftScore;
    });
  }, [activeProvider?.id, aiConfigs]);
  const composerFooterNote = attachedSelection
    ? `${aiCopy.composer.selectionReady} · ${attachedSelection.source}`
    : isInspectMode
      ? aiCopy.composer.inspectHint
      : "";

  const sessionDataReadButtonLabel = language === "vi"
    ? (isSessionDataReadEnabled ? "Data: Bat" : "Data: Hoi")
    : (isSessionDataReadEnabled ? "Data: On" : "Data: Ask");
  const sessionDataReadButtonTitle = !connectionId
    ? (
      language === "vi"
        ? "Hay ket noi database truoc khi bat quyen doc live data theo session."
        : "Connect to a database before enabling session-wide live data reads."
    )
    : isSessionDataReadEnabled
      ? (
        language === "vi"
          ? `Dang cho phep doc live data lien tuc trong session AI nay cho ${currentDatabase || "database hien tai"}. Bam de quay lai che do hoi quyen tung lan.`
          : `Live data reads are allowed for this AI session on ${currentDatabase || "the current database"}. Click to go back to ask-per-request mode.`
      )
      : (
        language === "vi"
          ? `Dang o che do hoi quyen tung lan cho ${currentDatabase || "database hien tai"}. Bam de cho phep doc live data lien tuc trong session AI nay.`
          : `The AI will ask before each live data read on ${currentDatabase || "the current database"}. Click to allow session-wide live data reads.`
      );

  const persistHistoryState = useCallback(async (state: PersistedAIWorkspaceState) => {
    const prunedState = prunePersistedAIWorkspaceState(state);
    await invokeMutation<void>("save_ai_workspace_history", { state: prunedState });
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        AI_WORKSPACE_AGENT_AUTONOMY_STORAGE_KEY,
        JSON.stringify(workspaceAgentAutonomy)
      );
    } catch {
      // Ignore storage write failures (private mode, quota, etc.).
    }
  }, [workspaceAgentAutonomy]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(AI_WORKSPACE_THINKING_STORAGE_KEY, String(showThinking));
    } catch {
      // Ignore storage write failures.
    }
  }, [showThinking]);

  const scrollChatToLatest = useCallback(() => {
    const jump = () => {
      const thread = chatThreadRef.current;
      if (!thread) return;
      thread.scrollTop = thread.scrollHeight;
    };
    // Run across several frames + a short timeout so the scroll lands after
    // markdown, code blocks, and agent steps finish laying out (their height
    // is not known on the first frame, which left the view stuck up top).
    window.requestAnimationFrame(() => {
      jump();
      window.requestAnimationFrame(jump);
    });
    window.setTimeout(jump, 60);
    window.setTimeout(jump, 180);
  }, []);

  const getCurrentVisualizationApprovalScope = useCallback(
    () => `${openSessionRef.current}:${connectionId || "no-connection"}:${currentDatabase || "no-database"}`,
    [connectionId, currentDatabase]
  );

  const resolveVisualizationConsent = useCallback((approved: boolean) => {
    const resolver = visualizationConsentResolverRef.current;
    visualizationConsentResolverRef.current = null;
    setVisualizationConsentPending(null);
    if (approved) {
      visualizationApprovalScopeRef.current = getCurrentVisualizationApprovalScope();
      setIsSessionDataReadEnabled(true);
    } else if (visualizationApprovalScopeRef.current === getCurrentVisualizationApprovalScope()) {
      visualizationApprovalScopeRef.current = null;
      setIsSessionDataReadEnabled(false);
    }
    resolver?.(approved);
  }, [getCurrentVisualizationApprovalScope]);

  const requestVisualizationReadConsent = useCallback(async (promptText: string) => {
    if (!connectionId) {
      return true;
    }

    if (visualizationApprovalScopeRef.current === getCurrentVisualizationApprovalScope()) {
      return true;
    }

    if (visualizationConsentResolverRef.current) {
      visualizationConsentResolverRef.current(false);
      visualizationConsentResolverRef.current = null;
    }

    const isVietnamese = prefersVietnameseSystemReply(promptText, language);
    const isVisualization = isVisualizationPrompt(promptText);
    const databaseLabel = currentDatabase || "current database";

    return new Promise<boolean>((resolve) => {
      visualizationConsentResolverRef.current = resolve;
      setVisualizationConsentPending({
        title: isVietnamese
          ? (isVisualization ? "Cap quyen doc data de ve bieu do?" : "Cap quyen doc data cho Agent?")
          : (isVisualization ? "Allow AI to read data for charts?" : "Allow Agent to read live data?"),
        message: isVietnamese
          ? (isVisualization
            ? `Model hien da co schema capsule de hieu cau truc DB. Buoc tiep theo can doc du lieu chi-doc trong ${databaseLabel} de tao chart/dashboard. TableR se chi cho phep doc du lieu trong session AI hien tai. Ban co muon tiep tuc khong?`
            : `Agent da co schema de hieu cau truc DB. Buoc tiep theo can doc du lieu chi-doc trong ${databaseLabel} de tra loi. TableR chi cho phep doc trong session AI hien tai. Ban co muon tiep tuc khong?`)
          : (isVisualization
            ? `The model already has a schema capsule for structure. The next step needs read-only access to live data in ${databaseLabel} to build charts or dashboards. TableR will scope this to the current AI session only. Continue?`
            : `The agent already has the database schema. The next step needs read-only access to live data in ${databaseLabel} to answer your request. TableR scopes this to the current AI session only. Continue?`),
        confirmText: isVietnamese ? "Cho phep doc data" : "Allow data read",
        cancelText: isVietnamese ? "Khong cho phep" : "Deny",
      });
    });
  }, [connectionId, currentDatabase, getCurrentVisualizationApprovalScope, language]);

  const setSessionDataReadEnabled = useCallback((enabled: boolean) => {
    if (enabled) {
      visualizationApprovalScopeRef.current = getCurrentVisualizationApprovalScope();
      setIsSessionDataReadEnabled(true);
      if (visualizationConsentResolverRef.current) {
        resolveVisualizationConsent(true);
      }
      return;
    }

    if (visualizationConsentResolverRef.current) {
      visualizationConsentResolverRef.current(false);
      visualizationConsentResolverRef.current = null;
    }
    visualizationApprovalScopeRef.current = null;
    setVisualizationConsentPending(null);
    setIsSessionDataReadEnabled(false);
  }, [getCurrentVisualizationApprovalScope, resolveVisualizationConsent]);

  useAIWorkspaceEffects({
    historyHydrated, isOpen, setChatThreads, setBubbles, setWorkspaceInteractionModes, setActiveThreadIdsByWorkspace,
    currentWorkspaceKey, initialThreadRef, activeThreadId, setActiveThreadId, setHistoryHydrated,
    hasConversation, scrollChatToLatest, currentThread, isGenerating, latestConversationBubbleId, latestConversationBubbleSnapshot,
    chatThreadRef, setIsHistoryOpen, isOpenRef, openSessionRef, visualizationApprovalScopeRef, setIsSessionDataReadEnabled,
    visualizationConsentResolverRef, setVisualizationConsentPending, isHistoryOpen, historyPanelRef, aiConfigs, loadAIConfigs,
    workspaceThreads, recentWorkspaceThreads, activeThreadIdsByWorkspace, lastWorkspaceKeyRef, setAttachedSelection,
    setSelectionContext, setDetailBubbleId, setIsInspectMode, isInspectMode, setPromptDraft, setError, initialPromptNonce, initialPrompt,
    composerTextareaRef, initialAttachmentNonce, initialAttachment, detailBubbleId, onClose, historySaveTimerRef,
    bubbleDismissTimersRef, bubbles, chatThreads, workspaceInteractionModes, persistHistoryState,
  });

  const buildLoadingBubble = useCallback((
    prompt: string,
    options?: {
      mode?: "compose" | "inspect";
      promptSummary?: string;
      threadId?: string;
      workspaceKey?: string;
      interactionMode?: AIWorkspaceInteractionMode;
    }
  ): AIWorkspaceBubbleData => {
    const id = createAIWorkspaceId();
    const workspaceKey = options?.workspaceKey || currentWorkspaceKey;
    const threadId = options?.threadId || currentThread?.id || workspaceThreads[0]?.id || createAIWorkspaceId();
    const interactionMode = options?.interactionMode || activeInteractionMode;
    return {
      id,
      threadId,
      workspaceKey,
      interactionMode,
      kind: "assistant",
      status: "loading",
      title: options?.mode === "inspect" ? aiCopy.bubbleStates.loadingInspectTitle : aiCopy.bubbleStates.loadingComposeTitle,
      subtitle: options?.mode === "inspect" ? aiCopy.bubbleStates.loadingInspectSubtitle : activeProvider?.name || aiCopy.composer.noProvider,
      prompt,
      promptSummary: options?.promptSummary || summarizePromptForDisplay(prompt),
      preview: options?.mode === "inspect"
        ? aiCopy.bubbleStates.loadingInspectPreview
        : aiCopy.bubbleStates.loadingComposePreview,
      detail: "",
      agentSteps: interactionMode === "agent"
        ? [{
            step: 1,
            action: "plan",
            message: "",
            status: "running",
          }]
        : undefined,
      x: 0,
      y: 0,
      pointer: {
        visible: false,
        x: 0,
        y: 0,
      },
      createdAt: Date.now(),
    };
  }, [activeInteractionMode, activeProvider?.name, aiCopy, currentThread, currentWorkspaceKey, workspaceThreads]);

  const openSqlInWorkspace = useCallback((
    sql: string,
    options?: {
      title?: string;
      viewMode?: "table" | "chart";
      autoRun?: boolean;
      focusWorkspace?: boolean;
    }
  ) => {
    const normalizedSql = sql.trim();
    if (!normalizedSql) return false;

    if (!connectionId) {
      setError(
        language === "vi"
          ? "Hay ket noi database truoc khi mo query AI trong workspace."
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
  }, [connectionId, currentDatabase, language, setError]);

  const openMetricsBoardInWorkspace = useCallback(async (
    options?: {
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
  ) => {
    if (!connectionId) {
      setError(
        language === "vi"
          ? "Hay ket noi database truoc khi mo dashboard AI trong workspace."
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
          error: language === "vi"
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
          addedTitles: Array.isArray(detail?.addedTitles) ? detail.addedTitles.filter((value) => typeof value === "string") : [],
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
  }, [connectionId, currentDatabase, language, setError]);

  const {
    updateBubbleForDashboardNoChange,
    updateBubbleForDashboardActionFailed,
    updateBubbleForDashboardEditNeedsClarification,
    updateBubbleForAttachedDashboardSummary,
    updateBubbleForDashboardApplied,
    updateBubbleForDashboardEdited,
    updateBubbleForDashboardRebuilt,
  } = useAIDashboardBubbleUpdates({ language, setBubbles });

  const completeWorkspaceRedirect = useCallback((bubbleId?: string, sessionId?: number) => {
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
            : bubble
        )
      );
    }
  }, [aiCopy]);

  const { createAssistantBubble } = useAIAssistantGeneration({
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
  });

  const handleGenerate = useCallback(async () => {
    if (isGenerating) return;
    const normalizedPrompt = promptDraft.trim();
    const promptWithSelection = buildPromptWithSelection(normalizedPrompt, attachedSelection);
    if (!promptWithSelection.trim()) return;

    const displayPrompt = normalizedPrompt || (
      attachedSelection
        ? `${aiCopy.composer.selectionReady} · ${attachedSelection.source}`
        : promptWithSelection
    );

    // The request is now captured in its own chat turn, so clear the composer
    // immediately instead of leaving an already-sent draft visible while it runs.
    setPromptDraft("");
    const result = await createAssistantBubble(promptWithSelection, {
      mode: "compose",
      displayPrompt,
      userPrompt: normalizedPrompt || displayPrompt,
      attachmentSource: attachedSelection?.source,
      history: historyMessages,
      threadId: currentThread?.id,
      interactionMode: activeInteractionMode,
    });

    if (result?.success) {
      if (!isDashboardSelectionSource(attachedSelection?.source)) {
        setAttachedSelection(null);
      }
    }
  }, [activeInteractionMode, aiCopy.composer.selectionReady, attachedSelection, createAssistantBubble, currentThread?.id, historyMessages, isGenerating, promptDraft]);

  const handleCancelGeneration = useCallback(() => {
    const activeBubbleId = activeGenerationBubbleIdRef.current;
    if (activeBubbleId) {
      cancelledGenerationBubbleIdsRef.current.add(activeBubbleId);
    }
    cancelGeneration();
  }, [cancelGeneration]);

  const handleRetryBubble = useCallback(async (bubble: AIWorkspaceBubbleData) => {
    if (isGenerating) return;
    const retryHistory = buildConversationHistoryMessages(
      bubbles.filter((currentBubble) => (
        currentBubble.threadId === bubble.threadId && currentBubble.id !== bubble.id
      )),
    );
    setActiveThreadId(bubble.threadId);
    await createAssistantBubble(bubble.prompt, {
      mode: "compose",
      displayPrompt: bubble.promptSummary,
      userPrompt: bubble.prompt,
      history: retryHistory,
      threadId: bubble.threadId,
      workspaceKey: bubble.workspaceKey,
      interactionMode: bubble.interactionMode,
    });
  }, [bubbles, createAssistantBubble, isGenerating]);

  const handleAskFromSelection = useCallback(async () => {
    if (!selectionContext?.text.trim()) {
      setError(aiCopy.bubbleStates.selectSomethingError);
      return;
    }
    setAttachedSelection(selectionContext);
    setIsInspectMode(false);
    setError(null);
    window.requestAnimationFrame(() => {
      composerTextareaRef.current?.focus();
      const cursorPosition = composerTextareaRef.current?.value.length ?? 0;
      composerTextareaRef.current?.setSelectionRange(cursorPosition, cursorPosition);
    });
  }, [aiCopy.bubbleStates.selectSomethingError, selectionContext, setError]);

  const handleComposerKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      void handleGenerate();
    }
  }, [handleGenerate]);

  useEffect(() => {
    if (!isOpen || !isInspectMode) return;

    const handleInspectEnter = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest(".ai-workspace-composer, .ai-workspace-modal")) return;
      if (!selectionContext?.text.trim()) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      void handleAskFromSelection();
    };

    window.addEventListener("keydown", handleInspectEnter, true);
    return () => window.removeEventListener("keydown", handleInspectEnter, true);
  }, [handleAskFromSelection, isInspectMode, isOpen, selectionContext]);

  const handleCopyBubble = useCallback(async (bubble: AIWorkspaceBubbleData) => {
    const text = bubble.sql || bubble.detail || bubble.preview;
    await copyText(text);
  }, [copyText]);

  const handleInsertBubble = useCallback((bubble: AIWorkspaceBubbleData) => {
    if (!bubble.sql || !aiModeAllowsInsert(bubble.interactionMode)) return;
    insertSql(bubble.sql, bubble.risk);
  }, [insertSql]);

  const handleOpenAgentRecord = useCallback((link: AIAgentRecordLink) => {
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
  }, [connectionId, currentDatabase, setError]);

  const handleRunBubble = useCallback(async (bubble: AIWorkspaceBubbleData) => {
    if (!bubble.sql || !aiModeAllowsRun(bubble.interactionMode)) return;
    const sessionId = openSessionRef.current;
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
        (bubble.sql && isSingleSqlStatement(bubble.sql) ? bubble.sql : null);

      if (wantsMetricsDashboard) {
        const visualizationReadApproved = await requestVisualizationReadConsent(bubbleIntentPrompt);
        if (!visualizationReadApproved) {
          setError(
            prefersVietnameseSystemReply(bubbleIntentPrompt, language)
              ? "Ban chua cap quyen doc data trong DB cho yeu cau visualization nay."
              : "Visualization data access was not approved for this request."
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
          updateBubbleForDashboardNoChange(bubble.id, bubbleIntentPrompt, dashboardOpened.addedCount);
          return;
        }
        updateBubbleForDashboardActionFailed(bubble.id, bubbleIntentPrompt, dashboardOpened.error);
        return;
      }

      if (!preferredVisualizationSql) {
        return;
      }

      const autoRunInWorkspace =
        deterministicOverviewChartSql !== null || bubble.risk?.level === "safe";
      if (autoRunInWorkspace) {
        const visualizationReadApproved = await requestVisualizationReadConsent(bubbleIntentPrompt);
        if (!visualizationReadApproved) {
          setError(
            prefersVietnameseSystemReply(bubbleIntentPrompt, language)
              ? "Ban chua cap quyen doc data trong DB cho yeu cau visualization nay."
              : "Visualization data access was not approved for this request."
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

    try {
      const result = await runSql(bubble.sql);
      setBubbles((current) =>
        current.map((currentBubble) =>
          currentBubble.id === bubble.id
              ? {
                  ...currentBubble,
                  kind: "result",
                  status: "ready",
                  title: aiCopy.bubbleStates.runSuccessTitle,
                  subtitle: result.queryResult.sandboxed ? aiCopy.bubbleStates.runSuccessSandboxSubtitle : aiCopy.bubbleStates.runSuccessDirectSubtitle,
                  preview: result.summary,
                  detail: buildExecutionDetail(result.summary, result.queryResult.query, currentBubble.detail),
                  autoDismissAt: undefined,
                }
            : currentBubble
        )
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
            : currentBubble
        )
      );
    }
  }, [activeAgentAutonomy, activeConnectionDbType, aiCopy, completeWorkspaceRedirect, language, openMetricsBoardInWorkspace, openSqlInWorkspace, requestVisualizationReadConsent, runSql, setError, updateBubbleForDashboardApplied, updateBubbleForDashboardNoChange]);

  const handleSelectThread = useCallback((threadId: string) => {
    setActiveThreadId(threadId);
    setActiveThreadIdsByWorkspace((current) => ({
      ...current,
      [currentWorkspaceKey]: threadId,
    }));
    setIsHistoryOpen(false);
    setAttachedSelection(null);
    setDetailBubbleId(null);
  }, [currentWorkspaceKey]);

  const handleRequestDeleteThread = useCallback((threadId: string, event: React.MouseEvent) => {
    event.stopPropagation();
    setDeleteThreadPending(threadId);
  }, []);

  const handleConfirmDeleteThread = useCallback(() => {
    const threadId = deleteThreadPending;
    if (!threadId) return;

    setDeleteThreadPending(null);

    const updatedThreads = chatThreads.filter((thread) => thread.id !== threadId);
    const updatedBubbles = bubbles.filter((bubble) => bubble.threadId !== threadId);
    const remainingWorkspaceThreads = updatedThreads.filter((thread) => thread.workspaceKey === currentWorkspaceKey);
    const nextActiveThreadId =
      activeThreadIdsByWorkspace[currentWorkspaceKey] === threadId
        ? remainingWorkspaceThreads[0]?.id ?? null
        : activeThreadIdsByWorkspace[currentWorkspaceKey] ?? activeThreadId;

    setChatThreads(updatedThreads);
    setBubbles(updatedBubbles);
    setActiveThreadIdsByWorkspace((current) => {
      const next = { ...current };
      if (nextActiveThreadId) {
        next[currentWorkspaceKey] = nextActiveThreadId;
      } else {
        delete next[currentWorkspaceKey];
      }
      return next;
    });
    setActiveThreadId(nextActiveThreadId ?? initialThreadRef.current?.id ?? createAIWorkspaceId());
  }, [activeThreadId, activeThreadIdsByWorkspace, bubbles, chatThreads, currentWorkspaceKey, deleteThreadPending]);

  const handleCancelDeleteThread = useCallback(() => {
    setDeleteThreadPending(null);
  }, []);



  const handleRewriteBubble = useCallback(async (bubble: AIWorkspaceBubbleData, note: string) => {
    const normalizedNote = note.trim();
    if (!normalizedNote) return;
    const rewritePrompt = `${bubble.prompt}\n\nRewrite or adjust it with these instructions:\n${normalizedNote}`;
    const rewriteHistory = buildConversationHistoryMessages(
      bubbles.filter((currentBubble) => currentBubble.threadId === bubble.threadId)
    );
    const result = await createAssistantBubble(rewritePrompt, {
      history: rewriteHistory,
      threadId: bubble.threadId,
      workspaceKey: bubble.workspaceKey,
      interactionMode: bubble.interactionMode,
      userPrompt: normalizedNote,
    });
    if (result?.success) {
      setActiveThreadId(bubble.threadId);
      setDetailBubbleId(null);
    }
  }, [bubbles, createAssistantBubble]);

  const handleCreateChatThread = useCallback(() => {
    const nextThread = createChatThread(workspaceThreads.length + 1, currentWorkspaceKey);
    setChatThreads((current) => [...current, nextThread]);
    setActiveThreadId(nextThread.id);
    setIsHistoryOpen(false);
    setPromptDraft(initialPrompt);
    setAttachedSelection(null);
    setSelectionContext(null);
    setIsInspectMode(false);
    setDetailBubbleId(null);
    setError(null);
    window.requestAnimationFrame(() => {
      composerTextareaRef.current?.focus();
      if (initialPrompt.trim()) {
        composerTextareaRef.current?.setSelectionRange(initialPrompt.length, initialPrompt.length);
      }
    });
  }, [currentWorkspaceKey, initialPrompt, setError, workspaceThreads.length]);

  const handleResetStage = useCallback(() => {
    handleCreateChatThread();
  }, [handleCreateChatThread]);

  const {
    activateProvider: handleActivateProvider,
    openSettings: handleOpenAISettings,
    selectAgentAutonomy: handleSelectAgentAutonomy,
    selectInteractionMode: handleSelectInteractionMode,
  } = useAIPanelPreferences({
    activeProvider,
    aiConfigs,
    currentWorkspaceKey,
    saveAIConfigs,
    setError,
    setIsHistoryOpen,
    setIsSwitchingProvider,
    setWorkspaceAgentAutonomy,
    setWorkspaceInteractionModes,
  });

  if (!isOpen) return null;
  const visibleError = error && error !== AI_REQUEST_REPLACED_MESSAGE ? error : null;
  return <AIWorkspacePanelView model={{ activeAgentAutonomy, activeInteractionMode, activeProvider, aiCopy, attachedSelection, bubbleCountByThread, composerFooterNote, composerRef, composerTextareaRef, connectionId, conversationBubbles, currentDatabase, currentThread, deleteThreadPending, detailBubble, historyPanelRef, isCancelling, isGenerating, isHistoryOpen, isInspectMode, isLongformComposer, isRunning, isSessionDataReadEnabled, isSwitchingProvider, language, promptDraft, recentWorkspaceThreads, selectionContext, sessionDataReadButtonLabel, sessionDataReadButtonTitle, showThinking, switchableProviders, tableContextCount, visibleError, visualizationConsentPending, chatThreadRef, close: () => { setIsInspectMode(false); onClose(); }, confirmDeleteThread: handleConfirmDeleteThread, createThread: handleCreateChatThread, dismissError: () => setError(null), dismissSelection: () => setAttachedSelection(null), generate: () => void handleGenerate(), cancelGeneration: handleCancelGeneration, openSettings: handleOpenAISettings, requestDeleteThread: handleRequestDeleteThread, retryBubble: (bubble) => void handleRetryBubble(bubble), rewriteBubble: (bubble, note) => void handleRewriteBubble(bubble, note), runBubble: (bubble) => void handleRunBubble(bubble), copyBubble: (bubble) => void handleCopyBubble(bubble), insertBubble: handleInsertBubble, openAgentRecord: handleOpenAgentRecord, reset: handleResetStage, selectThread: handleSelectThread, setDetailBubbleId, setHistoryOpen: setIsHistoryOpen, setInspectMode: setIsInspectMode, setPromptDraft, setSessionDataReadEnabled, setShowThinking, selectAgentAutonomy: handleSelectAgentAutonomy, selectInteractionMode: handleSelectInteractionMode, activateProvider: (id) => void handleActivateProvider(id), confirmVisualizationConsent: resolveVisualizationConsent, cancelDeleteThread: handleCancelDeleteThread, composerKeyDown: handleComposerKeyDown }} />;
}
