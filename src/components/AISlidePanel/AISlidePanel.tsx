import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { translateLanguage, useI18n } from "../../i18n";
import { useAIStore } from "../../stores/aiStore";
import { useAIAutonomyStore } from "../../stores/aiAutonomyStore";
import { useSafeModeStore } from "../../stores/safeModeStore";
import { emitAppToast } from "../../utils/app-toast";
import { useConnectionStore } from "../../stores/connectionStore";
import { useUIStore } from "../../stores/uiStore";
import { inferDatabaseFromWorkspaceName, selectActiveAIChatWorkspace, useAIChatWorkspaceStore } from "../../stores/aiChatWorkspaceStore";
import { AUTO_COMPACT_TRIGGER_CHARS, COMPACT_COMMAND, buildCompactTranscript, buildCompactUserPrompt, buildPostCompactHistory, buildWorkspaceContextMessages, deriveMemoryTitle, extractDigestFromReply, extractMemoryKeywords, isCompactCommand, estimateTokensFromChars, formatTokensCompact } from "../../utils/ai-context-compact";
import type { AIConversationMessage, MetricsWidgetType } from "../../types";
import type { AIMetricsWidgetSpec } from "../../utils/metrics-board-templates";
import { normalizeAIProviderConfigs } from "../../utils/ai-provider-registry";
import { resolveAIFailoverConsent } from "../../utils/ai-failover-consent";
import { invokeMutation } from "../../utils/tauri-utils";
import { isBackupCommand, isRollbackCommand, matchSlashCommands, type AISlashCommand, type AIDatabaseCheckpoint } from "./ai-slash-commands";
import { requestAICheckpointPick } from "./ai-checkpoint-picker";
import { formatAgentSql } from "../../utils/ai-sql-format";
import { AIWorkspacePanelView } from "./AIWorkspacePanelView";
import { useAIAssistantGeneration } from "./hooks/use-ai-assistant-generation";
import { useAIDashboardBubbleUpdates } from "./hooks/use-ai-dashboard-bubble-updates";
import { useAIWorkspaceEffects } from "./hooks/use-ai-workspace-effects";
import { useAIPanelPreferences } from "./hooks/use-ai-panel-preferences";
import { AI_REQUEST_REPLACED_MESSAGE, useAISlidePanel } from "./hooks/use-ai-slide-panel";
import {
  approveDataRead,
  dataReadScopeKey,
  isDataReadApproved,
  revokeDataRead,
} from "./ai-data-read-approvals";
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
import { buildAIWorkspaceKey, estimateConversationFootprint, buildConversationHistoryMessages, createAIWorkspaceId, createChatThread, prunePersistedAIWorkspaceState, summarizePromptForDisplay, type AIChatThread, type PersistedAIWorkspaceState } from "./ai-conversation-state";
import { buildExecutionDetail, buildPromptWithSelection, isSingleSqlStatement, type SelectionContextState } from "./ai-panel-selection";
import { processFilesIntoAttachmentDrafts, type AIAttachmentDraft } from "../../utils/ai-attachments";
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
  const chatWorkspaces = useAIChatWorkspaceStore((state) => state.workspaces);
  const activeChatWorkspaceId = useAIChatWorkspaceStore((state) => state.activeWorkspaceId);
  const createChatWorkspace = useAIChatWorkspaceStore((state) => state.createWorkspace);
  const renameChatWorkspace = useAIChatWorkspaceStore((state) => state.renameWorkspace);
  const deleteChatWorkspace = useAIChatWorkspaceStore((state) => state.deleteWorkspace);
  const setActiveChatWorkspace = useAIChatWorkspaceStore((state) => state.setActiveWorkspace);
  const saveChatContextDigest = useAIChatWorkspaceStore((state) => state.saveContextDigest);
  const hydrateChatContextDigests = useAIChatWorkspaceStore((state) => state.hydrateDigests);
  const bindChatWorkspaceDatabase = useAIChatWorkspaceStore((state) => state.bindWorkspaceDatabase);
  const chatDatabaseCatalog = useConnectionStore((state) => state.databases);
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
    listCheckpoints,
    restoreCheckpoint,
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
  const activeChatWorkspace = useMemo(
    () => selectActiveAIChatWorkspace({ workspaces: chatWorkspaces, activeWorkspaceId: activeChatWorkspaceId }),
    [chatWorkspaces, activeChatWorkspaceId]
  );
  const currentWorkspaceKey = useMemo(
    () => buildAIWorkspaceKey(connectionId, currentDatabase, activeChatWorkspaceId),
    [connectionId, currentDatabase, activeChatWorkspaceId]
  );
  const lastWorkspaceKeyRef = useRef(currentWorkspaceKey);
  const initialThreadRef = useRef<AIChatThread | null>(null);
  if (!initialThreadRef.current) {
    initialThreadRef.current = createChatThread(1, currentWorkspaceKey);
  }

  // A chat workspace owns its database context (like separate SSMS windows):
  // activating a workspace must re-scope the connection to that workspace's
  // database so tables/schemaObjects and the AI schema capsule follow it.
  const ensureWorkspaceDatabase = useCallback((workspaceId: string | null) => {
    if (!workspaceId || !connectionId) return;
    const workspace = chatWorkspaces.find((item) => item.id === workspaceId);
    if (!workspace) return;

    void (async () => {
      let boundDatabase = workspace.database ?? null;
      let catalog = chatDatabaseCatalog;

      // The catalog may be empty right after an app restart (the connection
      // store keeps no per-session database list until it is fetched); legacy
      // workspaces also need it to backfill their database from the name.
      if (!boundDatabase || catalog.length === 0) {
        if (catalog.length === 0) {
          await useConnectionStore.getState().fetchDatabases(connectionId);
          catalog = useConnectionStore.getState().databases;
        }
        if (!boundDatabase) {
          const inferred = inferDatabaseFromWorkspaceName(workspace.name, catalog);
          if (inferred) {
            boundDatabase = inferred;
            bindChatWorkspaceDatabase(workspace.id, inferred);
          }
        }
      }

      if (!boundDatabase) return;
      // The workspace is bound to a database this server does not expose
      // (e.g. the binding came from a different connection): leave the
      // current context untouched instead of erroring on `use_database`.
      if (catalog.length > 0 && !catalog.some((item) => item.name === boundDatabase)) return;
      if (boundDatabase === useConnectionStore.getState().currentDatabase) return;
      await useConnectionStore.getState().switchDatabase(connectionId, boundDatabase);
    })();
  }, [bindChatWorkspaceDatabase, chatDatabaseCatalog, chatWorkspaces, connectionId]);

  const handleSelectChatWorkspace = useCallback((workspaceId: string | null) => {
    setActiveChatWorkspace(workspaceId);
    ensureWorkspaceDatabase(workspaceId);
  }, [ensureWorkspaceDatabase, setActiveChatWorkspace]);

  // Re-scopes the database once per workspace activation (panel open or
  // workspace switch); manual database changes elsewhere are never reverted.
  const syncedWorkspaceIdRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!isOpen) return;
    if (syncedWorkspaceIdRef.current === activeChatWorkspaceId) return;
    syncedWorkspaceIdRef.current = activeChatWorkspaceId;
    ensureWorkspaceDatabase(activeChatWorkspaceId);
  }, [activeChatWorkspaceId, ensureWorkspaceDatabase, isOpen]);

  const [promptDraft, setPromptDraft] = useState(initialPrompt);
  // Composer "/" command menu: open while the draft is exactly "/<letters>",
  // dismissed by Escape until the draft changes again.
  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [isBackingUp, setIsBackingUp] = useState(false);
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
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [isSwitchingProvider, setIsSwitchingProvider] = useState(false);
  const isProviderFailingOver = useAIStore((state) => state.isProviderFailingOver);
  // The composer model trigger shows the switching spinner for BOTH manual
  // picks and automatic failovers — either way the active provider is moving.
  const isProviderSwitching = isSwitchingProvider || isProviderFailingOver;
  const [attachedSelection, setAttachedSelection] = useState<SelectionContextState | null>(null);
  const [deleteThreadPending, setDeleteThreadPending] = useState<string | null>(null);
  const [composerAttachments, setComposerAttachments] = useState<AIAttachmentDraft[]>([]);
  const [isAttachmentManagerOpen, setIsAttachmentManagerOpen] = useState(false);
  const [visualizationConsentPending, setVisualizationConsentPending] = useState<VisualizationReadConsentState | null>(null);
  const [isFailoverConsentPending, setIsFailoverConsentPending] = useState(false);

  // The agent hook raises "ai-failover-consent-request" the first time a
  // provider fails; the dialog below collects the once-only decision.
  useEffect(() => {
    const onRequest = () => setIsFailoverConsentPending(true);
    window.addEventListener("ai-failover-consent-request", onRequest);
    return () => window.removeEventListener("ai-failover-consent-request", onRequest);
  }, []);

  const handleResolveFailoverConsent = useCallback((approved: boolean) => {
    setIsFailoverConsentPending(false);
    resolveAIFailoverConsent(approved);
  }, []);

  const failoverConsentState = isFailoverConsentPending ? {
    title: translateLanguage(language, "ai.failover.consentTitle"),
    message: translateLanguage(language, "ai.failover.consentBody", {
      failed: activeProvider?.name?.trim() || activeProvider?.model?.trim() || "",
    }),
    confirmText: translateLanguage(language, "ai.failover.consentAllow"),
    cancelText: translateLanguage(language, "ai.failover.consentDeny"),
  } : null;

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
  // Mirror the active autonomy into a per-connection signal so AI-origin
  // workspace tabs (outside this panel) can honor the full-autonomy grant
  // for THIS connection only — another connection's tabs keep their own.
  useEffect(() => {
    if (!connectionId) return;
    useAIAutonomyStore.getState().setAutonomy(connectionId, activeAgentAutonomy);
  }, [activeAgentAutonomy, connectionId]);
  const activeThreadBubbles = useMemo(
    () => (
      !currentThread
        ? []
        : bubbles.filter((bubble) => bubble.threadId === currentThread.id && bubble.workspaceKey === currentWorkspaceKey && !bubble.compactedAt)
    ),
    [bubbles, currentThread, currentWorkspaceKey]
  );
  const historyMessages = useMemo(
    () => buildConversationHistoryMessages(activeThreadBubbles),
    [activeThreadBubbles]
  );
  const workspaceContextMessages = useMemo(
    () => buildWorkspaceContextMessages(activeChatWorkspace?.contextDigest),
    [activeChatWorkspace?.contextDigest]
  );
  const effectiveHistoryMessages = useMemo(
    () => [...workspaceContextMessages, ...historyMessages],
    [workspaceContextMessages, historyMessages]
  );
  // Model context_window is authored in TOKENS (matches Claude-Code-style meters).
  // null = not configured → meter falls back to the auto-compact display window.
  const contextWindowLimit = useMemo(() => {
    const settings = activeProvider?.model_settings?.[activeProvider.model ?? ""];
    const configured = settings?.context_window;
    return configured && configured > 0 ? configured : null;
  }, [activeProvider]);
  // The meter counts the conversation FOOTPRINT (every visible bubble,
  // untrimmed) — not the trimmed send window. Otherwise /compact could never
  // visibly shrink the meter: it folds old bubbles into the digest, and the
  // send window was already capped at the last 4 bubbles before any compact.
  const contextUsage = useMemo(
    () => ({
      used: estimateTokensFromChars(
        estimateConversationFootprint(activeThreadBubbles)
        + workspaceContextMessages.reduce((sum, message) => sum + message.content.length, 0)
        + promptDraft.length,
      ),
      limit: contextWindowLimit ?? estimateTokensFromChars(AUTO_COMPACT_TRIGGER_CHARS),
    }),
    [contextWindowLimit, activeThreadBubbles, workspaceContextMessages, promptDraft]
  );
  const conversationBubbles = useMemo(
    () => [...activeThreadBubbles].sort((left, right) => left.createdAt - right.createdAt),
    [activeThreadBubbles]
  );
  const bubbleCountByThread = useMemo(() => {
    const counts = new Map<string, number>();
    bubbles
      .filter((bubble) => bubble.workspaceKey === currentWorkspaceKey && bubble.status !== "loading" && !bubble.compactedAt)
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
    // Disabled providers are managed in the settings modal only; the composer
    // switcher lists enabled providers (each expandable into its models).
    const normalized = normalizeAIProviderConfigs(aiConfigs).filter((config) => config.is_enabled);
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
    : "";

  const sessionDataReadButtonLabel = language === "vi"
    ? (isSessionDataReadEnabled ? "Data: Bật" : "Data: Hỏi")
    : (isSessionDataReadEnabled ? "Data: On" : "Data: Ask");
  const sessionDataReadButtonTitle = !connectionId
    ? (
      language === "vi"
        ? "Hãy kết nối database trước khi bật quyền đọc live data."
        : "Connect to a database before enabling session-wide live data reads."
    )
    : isSessionDataReadEnabled
      ? (
        language === "vi"
          ? `Đang cho phép đọc live data liên tục cho ${currentDatabase || "database hiện tại"}. Bấm để quay lại chế độ hỏi từng lần.`
          : `Live data reads are allowed for this AI session on ${currentDatabase || "the current database"}. Click to go back to ask-per-request mode.`
      )
      : (
        language === "vi"
          ? `Đang ở chế độ hỏi từng lần cho ${currentDatabase || "database hiện tại"}. Bấm để cho phép đọc live data liên tục (sẽ hiện modal xác nhận).`
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
    // Persistent scope: connection + database only. Once a database is
    // approved the prompt stays quiet across app launches and AI sessions
    // (see ai-data-read-approvals.ts).
    () => dataReadScopeKey(connectionId, currentDatabase),
    [connectionId, currentDatabase]
  );

  const resolveVisualizationConsent = useCallback((approved: boolean) => {
    const resolver = visualizationConsentResolverRef.current;
    visualizationConsentResolverRef.current = null;
    setVisualizationConsentPending(null);
    if (approved) {
      approveDataRead(connectionId, currentDatabase);
      visualizationApprovalScopeRef.current = getCurrentVisualizationApprovalScope();
      setIsSessionDataReadEnabled(true);
    } else if (visualizationApprovalScopeRef.current === getCurrentVisualizationApprovalScope()) {
      revokeDataRead(connectionId, currentDatabase);
      visualizationApprovalScopeRef.current = null;
      setIsSessionDataReadEnabled(false);
    }
    resolver?.(approved);
  }, [connectionId, currentDatabase, getCurrentVisualizationApprovalScope]);

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
          ? (isVisualization ? "Cấp quyền đọc data để vẽ biểu đồ?" : "Cấp quyền đọc data cho Agent?")
          : (isVisualization ? "Allow AI to read data for charts?" : "Allow Agent to read live data?"),
        message: isVietnamese
          ? (isVisualization
            ? `Model đã có schema để hiểu cấu trúc DB. Bước tiếp theo cần đọc dữ liệu chỉ-đọc trong ${databaseLabel} để tạo chart/dashboard. Quyền sẽ được ghi nhớ cho database này, không hỏi lại. Bạn có muốn tiếp tục không?`
            : `Agent đã có schema để hiểu cấu trúc DB. Bước tiếp theo cần đọc dữ liệu chỉ-đọc trong ${databaseLabel} để trả lời. Quyền sẽ được ghi nhớ cho database này, không hỏi lại. Bạn có muốn tiếp tục không?`)
          : (isVisualization
            ? `The model already has a schema capsule for structure. The next step needs read-only access to live data in ${databaseLabel} to build charts or dashboards. The grant is remembered for this database and will not be asked again. Continue?`
            : `The agent already has the database schema. The next step needs read-only access to live data in ${databaseLabel} to answer your request. The grant is remembered for this database and will not be asked again. Continue?`),
        confirmText: isVietnamese ? "Cho phép đọc data" : "Allow data read",
        cancelText: isVietnamese ? "Không cho phép" : "Deny",
      });
    });
  }, [connectionId, currentDatabase, getCurrentVisualizationApprovalScope, language]);

  // Clicking the Data toggle only OPENS the confirmation dialog; the grant
  // happens in resolveVisualizationConsent once the user confirms, so no
  // permission is ever remembered from a single click.
  const confirmSessionDataReadEnable = useCallback(() => {
    if (!connectionId) {
      return;
    }
    if (visualizationApprovalScopeRef.current === getCurrentVisualizationApprovalScope()) {
      return;
    }
    if (visualizationConsentResolverRef.current) {
      visualizationConsentResolverRef.current(false);
      visualizationConsentResolverRef.current = null;
    }
    const isVietnamese = language === "vi";
    const databaseLabel = currentDatabase || (isVietnamese ? "database hiện tại" : "the current database");
    visualizationConsentResolverRef.current = (approved: boolean) => {
      resolveVisualizationConsent(approved);
    };
    setVisualizationConsentPending({
      title: isVietnamese ? "Cho phép AI đọc live data?" : "Allow AI to read live data?",
      message: isVietnamese
        ? `TableR sẽ cho AI đọc dữ liệu chỉ-đọc trong ${databaseLabel} cho đến khi bạn tắt quyền này hoặc đổi sang database khác. Quyền được ghi nhớ, không hỏi lại. Tiếp tục?`
        : `TableR will let the AI read read-only data in ${databaseLabel} until you turn this off or switch databases. The grant is remembered and will not be asked again. Continue?`,
      confirmText: isVietnamese ? "Cho phép đọc data" : "Allow data read",
      cancelText: isVietnamese ? "Không cho phép" : "Deny",
    });
  }, [connectionId, currentDatabase, getCurrentVisualizationApprovalScope, language, resolveVisualizationConsent, visualizationApprovalScopeRef, visualizationConsentResolverRef]);

  const setSessionDataReadEnabled = useCallback((enabled: boolean) => {
    if (enabled) {
      confirmSessionDataReadEnable();
      return;
    }

    if (visualizationConsentResolverRef.current) {
      visualizationConsentResolverRef.current(false);
      visualizationConsentResolverRef.current = null;
    }
    // An explicit toggle back to Ask re-arms the prompt for this database
    // only; approvals for other databases stay remembered.
    revokeDataRead(connectionId, currentDatabase);
    visualizationApprovalScopeRef.current = null;
    setVisualizationConsentPending(null);
    setIsSessionDataReadEnabled(false);
  }, [confirmSessionDataReadEnable, connectionId, currentDatabase, visualizationApprovalScopeRef, visualizationConsentResolverRef]);

  useAIWorkspaceEffects({
    historyHydrated, isOpen, setChatThreads, setBubbles, setWorkspaceInteractionModes, setActiveThreadIdsByWorkspace,
    currentWorkspaceKey, initialThreadRef, activeThreadId, setActiveThreadId, setHistoryHydrated,
    hasConversation, scrollChatToLatest, currentThread, isGenerating, latestConversationBubbleId, latestConversationBubbleSnapshot,
    chatThreadRef, setIsHistoryOpen, isOpenRef, openSessionRef, visualizationApprovalScopeRef, setIsSessionDataReadEnabled,
    visualizationConsentResolverRef, setVisualizationConsentPending, isHistoryOpen, historyPanelRef, aiConfigs, loadAIConfigs,
    workspaceThreads, recentWorkspaceThreads, activeThreadIdsByWorkspace, lastWorkspaceKeyRef, setAttachedSelection,
    setDetailBubbleId, setPromptDraft, setError, initialPromptNonce, initialPrompt,
    composerTextareaRef, initialAttachmentNonce, initialAttachment, detailBubbleId, onClose, historySaveTimerRef,
    bubbleDismissTimersRef, bubbles, chatThreads, workspaceInteractionModes, persistHistoryState,
  });

  // Restore remembered data-read consent whenever the panel opens or the
  // target database changes. Must run AFTER useAIWorkspaceEffects (whose
  // open-reset clears the approval) so a remembered approval survives
  // opening the panel and app restarts; a database without a stored
  // approval re-arms the consent prompt.
  useEffect(() => {
    if (!connectionId) {
      visualizationApprovalScopeRef.current = null;
      setIsSessionDataReadEnabled(false);
      return;
    }
    if (isDataReadApproved(connectionId, currentDatabase)) {
      visualizationApprovalScopeRef.current = getCurrentVisualizationApprovalScope();
      setIsSessionDataReadEnabled(true);
    } else {
      visualizationApprovalScopeRef.current = null;
      setIsSessionDataReadEnabled(false);
    }
  }, [isOpen, connectionId, currentDatabase, getCurrentVisualizationApprovalScope, visualizationApprovalScopeRef]);

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

  const [isCompacting, setIsCompacting] = useState(false);
  const [threadMemories, setThreadMemories] = useState<
    Record<string, { title: string; keywords: string[]; summary: string }>
  >({});

  const handleCompactContext = useCallback(async (silent = false): Promise<{ digest: string; recentHistory: AIConversationMessage[] } | null> => {
    if (isCompacting) return null;
    if (!activeChatWorkspace) {
      if (!silent) setError(aiCopy.workspace.compactNeedsWorkspace);
      return null;
    }
    const readyBubbles = activeThreadBubbles.filter(
      (bubble) => bubble.kind === "assistant" && bubble.status === "ready"
    );
    if (readyBubbles.length === 0) {
      if (!silent) setError(aiCopy.workspace.compactEmpty);
      return null;
    }

    setIsCompacting(true);
    try {
      const transcript = buildCompactTranscript(activeThreadBubbles);
      const reply = await useAIStore.getState().askAI(
        buildCompactUserPrompt(transcript, activeChatWorkspace.contextDigest, activeChatWorkspace.name),
        "",
        "panel",
        "general",
        [],
      );
      const digest = extractDigestFromReply(reply);
      if (digest.trim()) {
        saveChatContextDigest(activeChatWorkspace.id, digest);
        try {
          await invokeMutation("save_workspace_context_snapshot", {
            workspaceId: activeChatWorkspace.id,
            kind: "digest",
            threadId: null,
            payload: { digest },
          });
        } catch (digestCacheError) {
          console.error("[AIWorkspace] Failed to cache digest:", digestCacheError);
        }
      }
      // Claude Code / opencode semantics: the digest is the essence of the
      // WHOLE conversation up to this point — every ready bubble is folded in
      // (the summarizer sees them all via buildCompactTranscript) and no
      // verbatim scrollback survives beside the digest afterwards.
      const sortedReady = [...readyBubbles].sort((left, right) => left.createdAt - right.createdAt);
      const removedIds = sortedReady.map((bubble) => bubble.id);

      // Archive the FULL thread transcript in the SQLite cache before touching
      // anything — compacting never destroys the original conversation (same
      // contract as opencode's pruned-but-stored entries / Claude Code's
      // pre-compaction scrollback).
      const beforeBubbles = activeThreadBubbles.filter(
        (bubble) => bubble.status !== "loading" && !bubble.compactedAt,
      );
      const beforeTokens = estimateTokensFromChars(estimateConversationFootprint(beforeBubbles));
      const beforeMessages = beforeBubbles.length;
      const compactedAt = Date.now();
      const archivedBubbles = activeThreadBubbles.filter((bubble) => bubble.status !== "loading");
      try {
        await invokeMutation("save_workspace_context_snapshot", {
          workspaceId: activeChatWorkspace.id,
          kind: "transcript",
          threadId: currentThread?.id ?? null,
          payload: { compactedAt, bubbles: archivedBubbles },
        });
      } catch (archiveError) {
        console.error("[AIWorkspace] Failed to archive transcript:", archiveError);
      }

      if (removedIds.length > 0) {
        setBubbles((current) => current.map((bubble) => (
          removedIds.includes(bubble.id) ? { ...bubble, compactedAt } : bubble
        )));
      }

      const effectiveDigest = digest.trim() || activeChatWorkspace.contextDigest;

      // Codex-style memory: name this thread's digest and tag it with
      // keywords so related context can be found and re-imported later.
      if (currentThread?.id && effectiveDigest.trim()) {
        const memoryTitle = deriveMemoryTitle(effectiveDigest, currentThread.label || activeChatWorkspace.name);
        const memoryKeywords = extractMemoryKeywords(effectiveDigest);
        try {
          await invokeMutation("upsert_thread_memory", {
            workspaceId: activeChatWorkspace.id,
            threadId: currentThread.id,
            title: memoryTitle,
            summary: effectiveDigest,
            keywords: memoryKeywords,
          });
          setThreadMemories((current) => ({
            ...current,
            [currentThread.id]: { title: memoryTitle, keywords: memoryKeywords, summary: effectiveDigest },
          }));
        } catch (memoryError) {
          console.error("[AIWorkspace] Failed to persist thread memory:", memoryError);
        }
      }
      if (currentThread?.id) {
        const markerBubble: AIWorkspaceBubbleData = {
          id: createAIWorkspaceId(),
          threadId: currentThread.id,
          workspaceKey: currentWorkspaceKey,
          interactionMode: activeInteractionMode,
          kind: "assistant",
          status: "ready",
          title: aiCopy.workspace.compactDoneTitle,
          subtitle: aiCopy.workspace.compactDoneSubtitle,
          prompt: COMPACT_COMMAND,
          promptSummary: COMPACT_COMMAND,
          preview: summarizePromptForDisplay(effectiveDigest),
          detail: effectiveDigest,
          x: 0,
          y: 0,
          pointer: { x: 0, y: 0, visible: false },
          createdAt: Date.now(),
        };
        const afterTokens = estimateTokensFromChars(
          estimateConversationFootprint([markerBubble]),
        );
        const afterMessages = 1;
        markerBubble.subtitle =
          `${formatTokensCompact(beforeTokens)} → ${formatTokensCompact(afterTokens)} tokens · ${beforeMessages} → ${afterMessages} messages`;
        setBubbles((current) => [...current, markerBubble]);
      }
      return { digest: effectiveDigest, recentHistory: buildPostCompactHistory(effectiveDigest) };
    } catch (compactError) {
      setError(compactError instanceof Error ? compactError.message : String(compactError));
      return null;
    } finally {
      setIsCompacting(false);
    }
  }, [
    activeChatWorkspace,
    activeInteractionMode,
    activeThreadBubbles,
    aiCopy,
    currentThread?.id,
    currentWorkspaceKey,
    isCompacting,
    saveChatContextDigest,
    setActiveChatWorkspace,
    setError,
  ]);

  // Image attachments require the active model to advertise image input
  // (per-model `input_types` in the settings modal); text files always work.
  const canAttachImages = Boolean(
    activeProvider?.model
      && activeProvider?.model_settings?.[activeProvider.model]?.input_types?.includes("image"),
  );

  const handleAddComposerAttachmentFiles = useCallback(async (files: File[]) => {
    const drafts = await processFilesIntoAttachmentDrafts(files);
    // Gate images on the active model's advertised input types; text files
    // always ride the prompt so they are never blocked.
    const accepted = canAttachImages ? drafts : drafts.filter((draft) => draft.kind !== "image");
    if (accepted.length === 0) {
      if (drafts.length > 0) setError(aiCopy.attachments.imageUnsupported);
      return;
    }
    if (accepted.length < drafts.length) setError(aiCopy.attachments.imageUnsupported);
    setComposerAttachments((current) => {
      const existing = new Set(current.map((draft) => `${draft.kind}:${draft.name}:${draft.size}`));
      const merged = [...current];
      accepted.forEach((draft) => {
        const key = `${draft.kind}:${draft.name}:${draft.size}`;
        if (!existing.has(key)) {
          existing.add(key);
          merged.push(draft);
        }
      });
      return merged;
    });
  }, [aiCopy.attachments.imageUnsupported, canAttachImages, setError]);

  const handleRemoveComposerAttachment = useCallback((id: string) => {
    setComposerAttachments((current) => current.filter((draft) => draft.id !== id));
  }, []);

  // --- Composer "/" slash commands (/backup, /compact) ---
  const slashCommands = useMemo<AISlashCommand[]>(() => [
    { name: "backup", description: aiCopy.composer.slashBackupDescription },
    { name: "rollback", description: aiCopy.composer.slashRollbackDescription },
    { name: "compact", description: aiCopy.composer.slashCompactDescription },
  ], [aiCopy]);
  // Menu opens only while the draft is exactly "/<letters>" — plain typing,
  // not mid-sentence slashes, so normal prompts are never interrupted.
  const slashQueryMatch = /^\/([a-zA-Z]*)$/.exec(promptDraft.trim());
  const slashMatches = useMemo(
    () => (slashQueryMatch ? matchSlashCommands(slashQueryMatch[1], slashCommands) : []),
    [slashCommands, slashQueryMatch],
  );
  const slashMenuOpen = slashQueryMatch !== null && slashMatches.length > 0 && !slashDismissed;

  const handleBackupCommand = useCallback(async () => {
    if (isBackingUp) return;
    if (!connectionId || !activeConnectionDbType) {
      setError(aiCopy.composer.noDatabaseSelected);
      return;
    }
    setIsBackingUp(true);
    try {
      // "/backup <note>" — the trailing note becomes the checkpoint label.
      const noteMatch = /^\/backup\s+(.+)$/i.exec(promptDraft.trim());
      const result = await invokeMutation<{
        fileName: string;
        label: string;
        createdAt: number;
        engine: string;
        database: string | null;
        tableCount: number;
        rowCount: number;
        sizeBytes: number;
      }>("create_database_checkpoint", {
        connectionId,
        database: currentDatabase || null,
        dbType: activeConnectionDbType,
        label: noteMatch?.[1]?.trim() || null,
      });
      emitAppToast({
        tone: "success",
        title: language === "vi" ? "Đã tạo điểm khôi phục" : "Restore checkpoint created",
        description:
          language === "vi"
            ? `${result.tableCount} bảng · ${result.rowCount} dòng — dùng /rollback để khôi phục khi cần.`
            : `${result.tableCount} tables · ${result.rowCount} rows — use /rollback to restore when needed.`,
        durationMs: 10_000,
      });
    } catch (errorValue) {
      const message = errorValue instanceof Error ? errorValue.message : String(errorValue);
      emitAppToast({
        tone: "error",
        title: language === "vi" ? "Tạo checkpoint thất bại" : "Checkpoint failed",
        description: message,
        durationMs: 10_000,
      });
    } finally {
      setIsBackingUp(false);
    }
  }, [activeConnectionDbType, aiCopy.composer.noDatabaseSelected, connectionId, currentDatabase, isBackingUp, language, promptDraft, setError]);

  const handleRollbackCommand = useCallback(async () => {
    if (!connectionId || !activeConnectionDbType) {
      setError(aiCopy.composer.noDatabaseSelected);
      return;
    }
    try {
      const checkpoints = await invokeMutation<AIDatabaseCheckpoint[]>(
        "list_database_checkpoints",
        { connectionId },
      );
      const fileName = await requestAICheckpointPick(
        checkpoints ?? [],
        language,
        connectionId,
        activeConnectionDbType,
      );
      if (!fileName) return;
      const restoreResult = await invokeMutation<{
        warning?: string | null;
      }>("restore_database_checkpoint", {
        connectionId,
        fileName,
        dbType: activeConnectionDbType,
      });
      if (restoreResult?.warning) {
        emitAppToast({
          tone: "error",
          title: language === "vi" ? "Snapshot pre-restore thất bại" : "Pre-restore snapshot failed",
          description: restoreResult.warning,
          durationMs: 10_000,
        });
      }
      // Schema caches across the app must not keep serving pre-rollback data.
      window.dispatchEvent(
        new CustomEvent("table-data-updated", {
          detail: { connectionId, invalidateStructure: true },
        }),
      );
      emitAppToast({
        tone: "success",
        title: language === "vi" ? "Đã rollback database" : "Database restored",
        description:
          language === "vi"
            ? "Database đã quay về điểm checkpoint. Hãy refresh explorer nếu cần."
            : "The database was restored to the checkpoint. Refresh the explorer if needed.",
        durationMs: 10_000,
      });
    } catch (errorValue) {
      const message = errorValue instanceof Error ? errorValue.message : String(errorValue);
      emitAppToast({
        tone: "error",
        title: language === "vi" ? "Rollback thất bại" : "Rollback failed",
        description: message,
        durationMs: 10_000,
      });
    }
  }, [activeConnectionDbType, aiCopy.composer.noDatabaseSelected, connectionId, language, setError]);

  const runSlashCommand = useCallback((name: string) => {
    setPromptDraft("");
    setSlashDismissed(false);
    setSlashActiveIndex(0);
    if (name === "compact") {
      void handleCompactContext(false);
      return;
    }
    if (name === "backup") {
      void handleBackupCommand();
      return;
    }
    if (name === "rollback") {
      void handleRollbackCommand();
    }
  }, [handleBackupCommand, handleCompactContext, handleRollbackCommand]);

  // Composer edits re-arm the "/" menu (Escape dismissal lasts one keystroke).
  const handleComposerPromptChange = useCallback((value: string) => {
    setSlashDismissed(false);
    setSlashActiveIndex(0);
    setPromptDraft(value);
  }, []);

  const handleGenerate = useCallback(async () => {
    if (isGenerating) return;
    const normalizedPrompt = promptDraft.trim();
    if (isCompactCommand(normalizedPrompt)) {
      setPromptDraft("");
      await handleCompactContext(false);
      return;
    }
    if (isBackupCommand(normalizedPrompt)) {
      setPromptDraft("");
      await handleBackupCommand();
      return;
    }
    if (isRollbackCommand(normalizedPrompt)) {
      setPromptDraft("");
      await handleRollbackCommand();
      return;
    }
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

    // Auto-compact: long workspace histories get summarized into the
    // workspace context digest before the request goes out, so the prompt
    // never grows unbounded (same idea as Claude Code auto-compact).
    let historyForRun = effectiveHistoryMessages;
    // Auto-compact against the same footprint the meter shows (hơn là window
    // trim đã cap sẵn ~10k — so sánh đó khiến auto-compact không bao giờ chạy).
    const historyChars = estimateConversationFootprint(activeThreadBubbles);
    const overContextWindow = contextWindowLimit
      ? estimateTokensFromChars(historyChars) > contextWindowLimit
      : historyChars > AUTO_COMPACT_TRIGGER_CHARS;
    if (activeChatWorkspace && overContextWindow) {
      const compacted = await handleCompactContext(true);
      if (compacted) historyForRun = compacted.recentHistory;
    }

    const result = await createAssistantBubble(promptWithSelection, {
      mode: "compose",
      displayPrompt,
      userPrompt: normalizedPrompt || displayPrompt,
      attachmentSource: attachedSelection?.source,
      history: historyForRun,
      threadId: currentThread?.id,
      interactionMode: activeInteractionMode,
      attachments: composerAttachments.length > 0 ? composerAttachments : undefined,
    });

    if (result?.success) {
      setComposerAttachments([]);
      if (!isDashboardSelectionSource(attachedSelection?.source)) {
        setAttachedSelection(null);
      }
    }
  }, [activeChatWorkspace, activeInteractionMode, aiCopy.composer.selectionReady, attachedSelection, composerAttachments, contextWindowLimit, createAssistantBubble, currentThread?.id, effectiveHistoryMessages, handleBackupCommand, handleCompactContext, handleRollbackCommand, isGenerating, promptDraft]);

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
        currentBubble.threadId === bubble.threadId && currentBubble.id !== bubble.id && !currentBubble.compactedAt
      )),
    );
    setActiveThreadId(bubble.threadId);
    await createAssistantBubble(bubble.prompt, {
      mode: "compose",
      displayPrompt: bubble.promptSummary,
      userPrompt: bubble.prompt,
      history: [...workspaceContextMessages, ...retryHistory],
      threadId: bubble.threadId,
      workspaceKey: bubble.workspaceKey,
      interactionMode: bubble.interactionMode,
    });
  }, [bubbles, createAssistantBubble, isGenerating, workspaceContextMessages]);

  const handleComposerKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // The "/" command menu owns the keyboard while it is open: arrows move the
    // highlight, Enter/Tab run the highlighted command, Escape dismisses.
    if (slashMenuOpen && slashMatches.length > 0) {
      const activeIndex = Math.min(slashActiveIndex, slashMatches.length - 1);
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSlashActiveIndex((current) => Math.min(current + 1, slashMatches.length - 1));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSlashActiveIndex((current) => Math.max(current - 1, 0));
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        runSlashCommand(slashMatches[activeIndex].name);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setSlashDismissed(true);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      void handleGenerate();
    }
  }, [handleGenerate, runSlashCommand, slashActiveIndex, slashMatches, slashMenuOpen]);

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
        const visualizationReadApproved = await requestVisualizationReadConsent(bubbleIntentPrompt);
        if (!visualizationReadApproved) {
          setError(
            prefersVietnameseSystemReply(bubbleIntentPrompt, language)
              ? "Bạn chưa cấp quyền đọc data trong DB cho yêu cầu visualization này."
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
              ? "Bạn chưa cấp quyền đọc data trong DB cho yêu cầu visualization này."
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
            : currentBubble
        )
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
    setThreadMemories((current) => {
      if (!current[threadId]) return current;
      const next = { ...current };
      delete next[threadId];
      return next;
    });
    invokeMutation("delete_thread_memory_for_thread", { threadId }).catch(
      (error: unknown) => console.error("[AIWorkspace] Failed to delete thread memory:", error),
    );
    invokeMutation("delete_ai_attachments_for_thread", { threadId }).catch(
      (error: unknown) => console.error("[AIWorkspace] Failed to delete thread attachments:", error),
    );
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

  const handleRenameChatThread = useCallback((threadId: string, label: string) => {
    const trimmed = label.trim();
    if (!trimmed) return;
    setChatThreads((current) => current.map((thread) => (
      thread.id === threadId
        ? { ...thread, label: trimmed, updatedAt: Date.now() }
        : thread
    )));
    // A compacted thread displays its memory title; keep both in sync so the
    // rename survives the next compact too.
    const memory = threadMemories[threadId];
    if (memory && activeChatWorkspace) {
      setThreadMemories((current) => ({
        ...current,
        [threadId]: { ...memory, title: trimmed },
      }));
      invokeMutation("upsert_thread_memory", {
        workspaceId: activeChatWorkspace.id,
        threadId,
        title: trimmed,
        summary: memory.summary,
        keywords: memory.keywords,
      }).catch((error: unknown) => console.error("[AIWorkspace] Failed to rename thread memory:", error));
    }
  }, [activeChatWorkspace, threadMemories]);

  const handleCancelDeleteThread = useCallback(() => {
    setDeleteThreadPending(null);
  }, []);



  const handleRewriteBubble = useCallback(async (bubble: AIWorkspaceBubbleData, note: string) => {
    const normalizedNote = note.trim();
    if (!normalizedNote) return;
    const rewritePrompt = `${bubble.prompt}\n\nRewrite or adjust it with these instructions:\n${normalizedNote}`;
    const rewriteHistory = buildConversationHistoryMessages(
      bubbles.filter((currentBubble) => currentBubble.threadId === bubble.threadId && !currentBubble.compactedAt)
    );
    const result = await createAssistantBubble(rewritePrompt, {
      history: [...workspaceContextMessages, ...rewriteHistory],
      threadId: bubble.threadId,
      workspaceKey: bubble.workspaceKey,
      interactionMode: bubble.interactionMode,
      userPrompt: normalizedNote,
    });
    if (result?.success) {
      setActiveThreadId(bubble.threadId);
      setDetailBubbleId(null);
    }
  }, [bubbles, createAssistantBubble, workspaceContextMessages]);

  const handleCreateChatThread = useCallback(() => {
    const nextThread = createChatThread(workspaceThreads.length + 1, currentWorkspaceKey);
    setChatThreads((current) => [...current, nextThread]);
    setActiveThreadId(nextThread.id);
    // Update the per-workspace active map in the same tick: the workspace
    // effects re-derive activeThreadId from this map, so leaving it on the
    // old thread makes two effects ping-pong the view between the new empty
    // chat and the in-progress one forever (constant visible jitter).
    setActiveThreadIdsByWorkspace((current) => ({
      ...current,
      [currentWorkspaceKey]: nextThread.id,
    }));
    setIsHistoryOpen(false);
    setPromptDraft(initialPrompt);
    setAttachedSelection(null);
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
    // Starting a fresh thread must also stop any in-flight generation: the
    // background run keeps publishing progress (provider failover retries)
    // and re-rendering the panel while the user looks at the new empty
    // thread, which reads as constant jitter.
    const activeBubbleId = activeGenerationBubbleIdRef.current;
    if (activeBubbleId) {
      cancelledGenerationBubbleIdsRef.current.add(activeBubbleId);
    }
    cancelGeneration();
    handleCreateChatThread();
  }, [cancelGeneration, handleCreateChatThread]);

  /** Reloads the current conversation from the persisted SQLite history so a
   *  stale-looking chat can be refreshed without touching live generations. */
  const handleReloadChat = useCallback(async () => {
    if (isGenerating || isRunning) return;
    try {
      const persistedState = await invokeMutation<PersistedAIWorkspaceState>("get_ai_workspace_history", {});
      const threads = Array.isArray(persistedState?.threads) ? persistedState.threads : [];
      const loadedBubbles = (Array.isArray(persistedState?.bubbles) ? persistedState.bubbles : [])
        .filter((bubble) => bubble.status !== "loading");
      setChatThreads(threads);
      setBubbles(loadedBubbles);
      setWorkspaceInteractionModes(persistedState?.interactionModes ?? {});
      const activeMap = persistedState?.activeThreadIds ?? {};
      setActiveThreadIdsByWorkspace(activeMap);
      const workspaceThreadsForCurrentKey = threads.filter((thread) => thread.workspaceKey === currentWorkspaceKey);
      const preferredThreadId = activeMap[currentWorkspaceKey];
      const nextThreadId =
        workspaceThreadsForCurrentKey.find((thread) => thread.id === preferredThreadId)?.id ??
        [...workspaceThreadsForCurrentKey].sort((left, right) => right.updatedAt - left.updatedAt)[0]?.id ??
        workspaceThreadsForCurrentKey[0]?.id;
      if (nextThreadId) setActiveThreadId(nextThreadId);
      setError(null);
    } catch (error) {
      console.error("[AIWorkspace] Failed to reload chat:", error);
    }
  }, [currentWorkspaceKey, isGenerating, isRunning, setActiveThreadId, setActiveThreadIdsByWorkspace, setBubbles, setChatThreads, setError, setWorkspaceInteractionModes]);

  const importableChatThreads = useMemo(
    () => chatThreads
      .filter((thread) => thread.workspaceKey !== currentWorkspaceKey)
      .sort((left, right) => right.updatedAt - left.updatedAt),
    [chatThreads, currentWorkspaceKey]
  );

  /** Copies threads (and their bubbles) from other workspaces/scopes into the
   *  current one — "import các đoạn chat liên quan" into this workspace. */
  const handleImportChatThreads = useCallback((threadIds: string[]) => {
    if (threadIds.length === 0) return;
    const selectedIds = new Set(threadIds);
    const sourceThreads = chatThreads.filter((thread) => selectedIds.has(thread.id));
    if (sourceThreads.length === 0) return;
    const now = Date.now();
    const importedThreads: AIChatThread[] = [];
    const importedBubbles: AIWorkspaceBubbleData[] = [];
    sourceThreads.forEach((sourceThread) => {
      const importedThread: AIChatThread = {
        ...sourceThread,
        id: createAIWorkspaceId(),
        workspaceKey: currentWorkspaceKey,
        createdAt: now,
        updatedAt: now,
      };
      importedThreads.push(importedThread);
      bubbles
        .filter((bubble) => bubble.threadId === sourceThread.id && bubble.status !== "loading")
        .forEach((bubble) => {
          importedBubbles.push({
            ...bubble,
            id: createAIWorkspaceId(),
            threadId: importedThread.id,
            workspaceKey: currentWorkspaceKey,
            pointer: { ...bubble.pointer },
          });
        });
    });
    const lastImportedThreadId = importedThreads[importedThreads.length - 1].id;
    setChatThreads((current) => [...current, ...importedThreads]);
    setBubbles((current) => [...current, ...importedBubbles]);
    setActiveThreadIdsByWorkspace((current) => ({
      ...current,
      [currentWorkspaceKey]: lastImportedThreadId,
    }));
    setActiveThreadId(lastImportedThreadId);
    setIsHistoryOpen(false);
  }, [bubbles, chatThreads, currentWorkspaceKey]);

  const handleCreateUserWorkspace = useCallback(() => {
    // Deliberately UNBOUND: the workspace starts in auto mode and follows
    // whatever database is current when it is used. Binding it to
    // `currentDatabase` here (the database that happened to be open at click
    // time) is what made every later activation yank the connection back to
    // that database. The user can pin a database via the switcher's DB chip;
    // naming the workspace "db C" also binds it via name inference.
    createChatWorkspace(
      `${aiCopy.workspace.defaultName} ${chatWorkspaces.length + 1}`,
      connectionId,
      null,
    );
  }, [aiCopy.workspace.defaultName, chatWorkspaces.length, connectionId, createChatWorkspace]);

  // Rebind (or unbind) a workspace's database from the switcher's DB chip.
  // Binding to a new database also clears the workspace's compacted digest
  // (store handles that) so the old database's context cannot leak through.
  const handleRebindChatWorkspaceDatabase = useCallback((workspaceId: string, database: string) => {
    // Audit fix: rebinding re-scopes the connection/schema immediately, which
    // would make an in-flight agent run read evidence from a database it never
    // verified. The switcher chip is disabled during runs; this guard is the
    // backstop for programmatic calls.
    if (isGenerating || isRunning) {
      console.warn("[AIWorkspace] Rebind ignored while an agent run is active.");
      return;
    }
    bindChatWorkspaceDatabase(workspaceId, database);
    if (database) {
      // Re-scope the connection immediately so the schema capsule and
      // tables/schemaObjects follow the new binding.
      ensureWorkspaceDatabase(workspaceId);
    }
  }, [bindChatWorkspaceDatabase, ensureWorkspaceDatabase, isGenerating, isRunning]);

  const handleDeleteUserWorkspace = useCallback((workspaceId: string) => {
    deleteChatWorkspace(workspaceId);
    invokeMutation("delete_workspace_context_snapshots", { workspaceId }).catch(
      (error: unknown) => console.error("[AIWorkspace] Failed to delete workspace cache:", error),
    );
    invokeMutation("delete_thread_memories_for_workspace", { workspaceId }).catch(
      (error: unknown) => console.error("[AIWorkspace] Failed to delete workspace memories:", error),
    );
    invokeMutation("delete_ai_attachments_for_workspace", { workspaceKey: workspaceId }).catch(
      (error: unknown) => console.error("[AIWorkspace] Failed to delete workspace attachments:", error),
    );
  }, [deleteChatWorkspace]);

  // Hydrate compacted digests from the SQLite cache so workspace context
  // survives restarts and localStorage clears.
  useEffect(() => {
    if (!historyHydrated || !isOpen || chatWorkspaces.length === 0) return;
    let cancelled = false;
    invokeMutation<{ workspaceId: string; digest: string; updatedAt: number }[]>(
      "list_latest_workspace_digests",
      {},
    )
      .then((entries) => {
        if (!cancelled && Array.isArray(entries) && entries.length > 0) {
          hydrateChatContextDigests(entries);
        }
      })
      .catch((error: unknown) => {
        console.error("[AIWorkspace] Failed to hydrate context digests:", error);
      });

    invokeMutation<
      { threadId: string; title: string; keywords: string[]; summary: string }[]
    >("list_thread_memories", {})
      .then((memories) => {
        if (cancelled || !Array.isArray(memories)) return;
        const mapped: Record<string, { title: string; keywords: string[]; summary: string }> = {};
        memories.forEach((memory) => {
          if (memory.threadId) {
            mapped[memory.threadId] = {
              title: memory.title,
              keywords: Array.isArray(memory.keywords) ? memory.keywords : [],
              summary: memory.summary ?? "",
            };
          }
        });
        setThreadMemories(mapped);
      })
      .catch((error: unknown) => {
        console.error("[AIWorkspace] Failed to hydrate thread memories:", error);
      });

    return () => {
      cancelled = true;
    };
  }, [chatWorkspaces.length, historyHydrated, hydrateChatContextDigests, isOpen]);

  const {
    activateProvider: handleActivateProvider,
    toggleModelVisibility: handleToggleModelVisibility,
    openSettings: handleOpenAISettings,
    selectAgentAutonomy: handleSelectAgentAutonomy,
    selectInteractionMode: handleSelectInteractionMode,
  } = useAIPanelPreferences({
    aiConfigs,
    currentWorkspaceKey,
    saveAIConfigs,
    setError,
    setIsHistoryOpen,
    setIsSwitchingProvider,
    setWorkspaceAgentAutonomy,
    setWorkspaceInteractionModes,
  });

  const safeModeEnabled = useSafeModeStore((state) => state.settings.globalLevel >= 1);
  const handleToggleSafeMode = useCallback((next: boolean) => {
    const store = useSafeModeStore.getState();
    const vi = language === "vi";
    if (next) {
      store.setGlobalLevel(1);
      emitAppToast({ tone: "info", title: vi ? "Safe Mode: bật" : "Safe Mode: on", description: vi ? "Mức Read Only — mọi lệnh ghi bị chặn." : "Read Only level — every write statement is blocked.", durationMs: 6000 });
    } else {
      const level = store.settings.globalLevel;
      if (level >= 4) {
        emitAppToast({ tone: "error", title: vi ? "Không thể tắt Safe Mode" : "Cannot disable Safe Mode", description: vi ? "Mức Strict/Paranoid chỉ hạ được trong Safe Mode settings." : "Strict/Paranoid levels can only be lowered in Safe Mode settings.", durationMs: 8000 });
        return;
      }
      store.setGlobalLevel(0);
      emitAppToast({ tone: "success", title: vi ? "Safe Mode: tắt" : "Safe Mode: off", description: vi ? "Agent có thể chạy lệnh ghi không bị chặn. DROP/TRUNCATE vẫn bị cấm." : "The agent can run writes unblocked. DROP/TRUNCATE stay blocked.", durationMs: 8000 });
    }
  }, [language]);
  // Choosing "Full access" is a standing human approval — auto-disable Safe
  // Mode (levels 1-3 only; Strict/Paranoid and production-marked setups stay).
  const handleSelectAgentAutonomyWithSafeMode = useCallback((autonomy: Parameters<typeof handleSelectAgentAutonomy>[0]) => {
    handleSelectAgentAutonomy(autonomy);
    if (autonomy !== "full") return;
    const store = useSafeModeStore.getState();
    const level = store.settings.globalLevel;
    if (level === 0 || level >= 4) return;
    const hasProduction = Object.values(store.settings.connectionEnvironments ?? {}).some((env) => env === "production");
    if (hasProduction) return;
    store.setGlobalLevel(0);
    const vi = language === "vi";
    emitAppToast({ tone: "success", title: vi ? "Đã tắt Safe Mode" : "Safe Mode disabled", description: vi ? "Toàn quyền: agent chạy ghi không bị chặn. DROP/TRUNCATE vẫn cấm." : "Full access: the agent writes unblocked. DROP/TRUNCATE stay blocked.", durationMs: 8000 });
  }, [handleSelectAgentAutonomy, language]);
  if (!isOpen) return null;
  const visibleError = error && error !== AI_REQUEST_REPLACED_MESSAGE ? error : null;

  return <AIWorkspacePanelView model={{ activeAgentAutonomy, activeInteractionMode, activeProvider, aiCopy, attachedSelection, bubbleCountByThread, composerFooterNote, composerRef, composerTextareaRef, connectionId, conversationBubbles, currentDatabase, currentThread, deleteThreadPending, detailBubble, historyPanelRef, isAttachmentManagerOpen, canAttachImages, composerAttachments, isCancelling, isGenerating, isHistoryOpen, isLongformComposer, isRunning, isSessionDataReadEnabled, language, promptDraft, recentWorkspaceThreads, sessionDataReadButtonLabel, sessionDataReadButtonTitle, showThinking, switchableProviders, tableContextCount, visibleError, visualizationConsentPending, failoverConsentPending: failoverConsentState, chatThreadRef, contextUsage, activeChatWorkspaceId, activeChatWorkspaceName: activeChatWorkspace?.name ?? null, activeChatWorkspaceContextUpdatedAt: activeChatWorkspace?.contextUpdatedAt ?? null, chatWorkspaces, importableChatThreads, threadMemories, isCompacting, isSwitchingProvider: isProviderSwitching, safeModeEnabled, onToggleSafeMode: handleToggleSafeMode, listCheckpoints, restoreCheckpoint, close: () => { handleCancelGeneration(); onClose(); }, confirmDeleteThread: handleConfirmDeleteThread, createThread: handleCreateChatThread, reloadChat: () => void handleReloadChat(), dismissError: () => setError(null), dismissSelection: () => setAttachedSelection(null), generate: () => void handleGenerate(), cancelGeneration: handleCancelGeneration, openSettings: handleOpenAISettings, openAttachmentManager: () => setIsAttachmentManagerOpen(true), closeAttachmentManager: () => setIsAttachmentManagerOpen(false), addAttachmentFiles: (files) => void handleAddComposerAttachmentFiles(files), removeAttachment: handleRemoveComposerAttachment, requestDeleteThread: handleRequestDeleteThread, renameThread: handleRenameChatThread, retryBubble: (bubble) => void handleRetryBubble(bubble), rewriteBubble: (bubble, note) => void handleRewriteBubble(bubble, note), runBubble: (bubble) => void handleRunBubble(bubble), copyBubble: (bubble) => void handleCopyBubble(bubble), insertBubble: handleInsertBubble, openAgentRecord: handleOpenAgentRecord, reset: handleResetStage, selectThread: handleSelectThread, setDetailBubbleId, setHistoryOpen: setIsHistoryOpen, setPromptDraft: handleComposerPromptChange, slashMenu: slashMenuOpen ? { commands: slashMatches, activeIndex: Math.min(slashActiveIndex, slashMatches.length - 1) } : null, onSelectSlashCommand: runSlashCommand, setSessionDataReadEnabled, setShowThinking, selectAgentAutonomy: handleSelectAgentAutonomyWithSafeMode, selectInteractionMode: handleSelectInteractionMode, activateProvider: (id, model) => {
                const wasRunning = isRunning || isGenerating;
                void handleActivateProvider(id, model).then(() => {
                  // Mid-run manual switch: announce it in the conversation as
                  // an inline agent step, like the automatic failover note.
                  if (!wasRunning) return;
                  const target = aiConfigs.find((config) => config.id === id);
                  const label = target?.name?.trim() || target?.model || model;
                  if (!label) return;
                  window.dispatchEvent(new CustomEvent("ai-provider-switched-during-run", { detail: { providerLabel: label } }));
                });
              }, toggleModelVisibility: (id, model) => void handleToggleModelVisibility(id, model), confirmVisualizationConsent: resolveVisualizationConsent, resolveFailoverConsent: handleResolveFailoverConsent, cancelDeleteThread: handleCancelDeleteThread, composerKeyDown: handleComposerKeyDown, compactContext: () => void handleCompactContext(false), selectChatWorkspace: handleSelectChatWorkspace, createChatWorkspace: handleCreateUserWorkspace, renameChatWorkspace: renameChatWorkspace, deleteChatWorkspace: handleDeleteUserWorkspace, importChatThreads: handleImportChatThreads, databases: chatDatabaseCatalog.map((item) => item.name), rebindChatWorkspace: handleRebindChatWorkspaceDatabase }} />;
}
