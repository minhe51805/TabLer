import { useCallback, useEffect, useMemo } from "react";
import type { AppLanguage } from "../../../i18n";
import { useAIAutonomyStore } from "../../../stores/aiAutonomyStore";
import { useSafeModeStore } from "../../../stores/safeModeStore";
import type { AIProviderConfig } from "../../../types";
import {
  AUTO_COMPACT_TRIGGER_CHARS,
  buildWorkspaceContextMessages,
  estimateTokensFromChars,
} from "../../../utils/ai-context-compact";
import { normalizeAIProviderConfigs } from "../../../utils/ai-provider-registry";
import { emitAppToast } from "../../../utils/app-toast";
import {
  buildConversationHistoryMessages,
  estimateConversationFootprint,
  resolveHistoryBudget,
  type AIChatThread,
} from "../ai-conversation-state";
import { resolveSandboxPolicy, type SandboxPolicy } from "../ai-execution-policy";
import {
  DEFAULT_AI_WORKSPACE_AGENT_AUTONOMY,
  getDefaultAIWorkspaceInteractionMode,
  type AIWorkspaceAgentAutonomy,
  type AIWorkspaceBubbleData,
  type AIWorkspaceInteractionMode,
} from "../ai-workspace-types";

interface UseAIPanelDerivedStateOptions {
  activeChatWorkspace: { id: string; contextDigest?: string | null } | null;
  activeProvider: AIProviderConfig | undefined;
  activeThreadId: string;
  aiConfigs: AIProviderConfig[];
  bubbles: AIWorkspaceBubbleData[];
  chatThreads: AIChatThread[];
  connectionId: string | null;
  currentDatabase: string | null;
  currentWorkspaceKey: string;
  isSessionDataReadEnabled: boolean;
  language: AppLanguage;
  workspaceAgentAutonomy: Record<string, AIWorkspaceAgentAutonomy>;
  workspaceInteractionModes: Record<string, AIWorkspaceInteractionMode>;
}

export function useAIPanelDerivedState({
  activeChatWorkspace,
  activeProvider,
  activeThreadId,
  aiConfigs,
  bubbles,
  chatThreads,
  connectionId,
  currentDatabase,
  currentWorkspaceKey,
  isSessionDataReadEnabled,
  language,
  workspaceAgentAutonomy,
  workspaceInteractionModes,
}: UseAIPanelDerivedStateOptions) {
  const workspaceThreads = useMemo(
    () => chatThreads.filter((thread) => thread.workspaceKey === currentWorkspaceKey),
    [chatThreads, currentWorkspaceKey],
  );
  const recentWorkspaceThreads = useMemo(
    () => [...workspaceThreads].sort((left, right) => right.updatedAt - left.updatedAt),
    [workspaceThreads],
  );
  const currentThread = useMemo(
    () =>
      workspaceThreads.find((thread) => thread.id === activeThreadId) ??
      workspaceThreads[0] ??
      null,
    [activeThreadId, workspaceThreads],
  );
  const activeInteractionMode = useMemo(
    () =>
      workspaceInteractionModes[currentWorkspaceKey] ??
      getDefaultAIWorkspaceInteractionMode(activeProvider?.allow_schema_context),
    [activeProvider?.allow_schema_context, currentWorkspaceKey, workspaceInteractionModes],
  );
  const activeAgentAutonomy = useMemo<AIWorkspaceAgentAutonomy>(
    () => workspaceAgentAutonomy[currentWorkspaceKey] ?? DEFAULT_AI_WORKSPACE_AGENT_AUTONOMY,
    [currentWorkspaceKey, workspaceAgentAutonomy],
  );

  useEffect(() => {
    if (!connectionId) return;
    useAIAutonomyStore.getState().setAutonomy(connectionId, activeAgentAutonomy);
  }, [activeAgentAutonomy, connectionId]);

  const activeThreadBubbles = useMemo(
    () =>
      !currentThread
        ? []
        : bubbles.filter(
            (bubble) =>
              bubble.threadId === currentThread.id &&
              bubble.workspaceKey === currentWorkspaceKey &&
              !bubble.compactedAt,
          ),
    [bubbles, currentThread, currentWorkspaceKey],
  );
  const historyBudget = useMemo(
    () =>
      resolveHistoryBudget(
        activeProvider?.model_settings?.[activeProvider.model ?? ""]?.context_window ?? null,
      ),
    [activeProvider],
  );
  const historyMessages = useMemo(
    () => buildConversationHistoryMessages(activeThreadBubbles, historyBudget),
    [activeThreadBubbles, historyBudget],
  );
  const workspaceContextMessages = useMemo(
    () => buildWorkspaceContextMessages(activeChatWorkspace?.contextDigest),
    [activeChatWorkspace?.contextDigest],
  );
  const effectiveHistoryMessages = useMemo(
    () => [...workspaceContextMessages, ...historyMessages],
    [workspaceContextMessages, historyMessages],
  );
  const contextWindowLimit = useMemo(() => {
    const settings = activeProvider?.model_settings?.[activeProvider.model ?? ""];
    const configured = settings?.context_window;
    return configured && configured > 0 ? configured : null;
  }, [activeProvider]);
  const baseContextChars = useMemo(
    () =>
      estimateConversationFootprint(activeThreadBubbles) +
      workspaceContextMessages.reduce((sum, message) => sum + message.content.length, 0),
    [activeThreadBubbles, workspaceContextMessages],
  );
  const contextLimitTokens = useMemo(
    () => contextWindowLimit ?? estimateTokensFromChars(AUTO_COMPACT_TRIGGER_CHARS),
    [contextWindowLimit],
  );
  const conversationBubbles = useMemo(
    () => [...activeThreadBubbles].sort((left, right) => left.createdAt - right.createdAt),
    [activeThreadBubbles],
  );
  const bubbleCountByThread = useMemo(() => {
    const counts = new Map<string, number>();
    bubbles
      .filter(
        (bubble) =>
          bubble.workspaceKey === currentWorkspaceKey &&
          bubble.status !== "loading" &&
          !bubble.compactedAt,
      )
      .forEach((bubble) => {
        counts.set(bubble.threadId, (counts.get(bubble.threadId) || 0) + 1);
      });
    return counts;
  }, [bubbles, currentWorkspaceKey]);
  const isLongformComposer = activeInteractionMode === "agent" || activeThreadBubbles.length >= 2;
  const hasConversation = conversationBubbles.length > 0;
  const latestConversationBubbleId =
    conversationBubbles[conversationBubbles.length - 1]?.id ?? null;
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
    () =>
      [...conversationBubbles]
        .reverse()
        .find((bubble) => bubble.kind === "assistant" && bubble.status === "ready") ?? null,
    [conversationBubbles],
  );
  const switchableProviders = useMemo(() => {
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

  const sessionDataReadButtonLabel =
    language === "vi"
      ? isSessionDataReadEnabled
        ? "Data: Bật"
        : "Data: Hỏi"
      : isSessionDataReadEnabled
        ? "Data: On"
        : "Data: Ask";
  const sessionDataReadButtonTitle = !connectionId
    ? language === "vi"
      ? "Hãy kết nối database trước khi bật quyền đọc live data."
      : "Connect to a database before enabling session-wide live data reads."
    : isSessionDataReadEnabled
      ? language === "vi"
        ? `Đang cho phép đọc live data cho ${currentDatabase || "database hiện tại"} — quyền được ghi nhớ cho database này, không hỏi lại. Bấm để thu hồi và quay lại chế độ hỏi từng lần.`
        : `Live data reads are allowed for ${currentDatabase || "the current database"} — remembered for this database, so it won't ask again. Click to revoke and go back to ask-per-request mode.`
      : language === "vi"
        ? `Đang ở chế độ hỏi từng lần cho ${currentDatabase || "database hiện tại"}. Bấm để cho phép đọc live data liên tục (sẽ hiện modal xác nhận).`
        : `The AI will ask before each live data read on ${currentDatabase || "the current database"}. Click to allow live data reads (a confirmation appears).`;

  const safeModeEnabled = useSafeModeStore((state) => state.settings.globalLevel >= 1);
  const sandboxEffectiveLevel = useSafeModeStore((state) =>
    connectionId ? state.getEffectiveLevel(connectionId) : state.settings.globalLevel,
  );
  const sandboxPolicy = useMemo<SandboxPolicy>(
    () => resolveSandboxPolicy(sandboxEffectiveLevel, activeAgentAutonomy),
    [sandboxEffectiveLevel, activeAgentAutonomy],
  );
  const handleToggleSafeMode = useCallback(
    (next: boolean) => {
      const store = useSafeModeStore.getState();
      const vi = language === "vi";
      if (next) {
        store.setGlobalLevel(1);
        emitAppToast({
          tone: "info",
          title: vi ? "Safe Mode: bật" : "Safe Mode: on",
          description: vi
            ? "Mức Read Only — mọi lệnh ghi bị chặn."
            : "Read Only level — every write statement is blocked.",
          durationMs: 6000,
        });
      } else {
        const level = store.settings.globalLevel;
        if (level >= 4) {
          emitAppToast({
            tone: "error",
            title: vi ? "Không thể tắt Safe Mode" : "Cannot disable Safe Mode",
            description: vi
              ? "Mức Strict/Paranoid chỉ hạ được trong Safe Mode settings."
              : "Strict/Paranoid levels can only be lowered in Safe Mode settings.",
            durationMs: 8000,
          });
          return;
        }
        store.setGlobalLevel(0);
        emitAppToast({
          tone: "success",
          title: vi ? "Safe Mode: tắt" : "Safe Mode: off",
          description: vi
            ? "Agent có thể chạy lệnh ghi không bị chặn. DROP/TRUNCATE vẫn bị cấm."
            : "The agent can run writes unblocked. DROP/TRUNCATE stay blocked.",
          durationMs: 8000,
        });
      }
    },
    [language],
  );

  return {
    activeAgentAutonomy,
    activeInteractionMode,
    activeThreadBubbles,
    baseContextChars,
    bubbleCountByThread,
    contextLimitTokens,
    contextWindowLimit,
    conversationBubbles,
    currentThread,
    effectiveHistoryMessages,
    handleToggleSafeMode,
    hasConversation,
    historyBudget,
    isLongformComposer,
    latestConversationBubbleId,
    latestConversationBubbleSnapshot,
    latestReadyAssistantBubble,
    recentWorkspaceThreads,
    safeModeEnabled,
    sandboxPolicy,
    sessionDataReadButtonLabel,
    sessionDataReadButtonTitle,
    switchableProviders,
    workspaceContextMessages,
    workspaceThreads,
  };
}
