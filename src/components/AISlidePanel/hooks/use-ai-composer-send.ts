import { useCallback, type MutableRefObject, type RefObject } from "react";
import { getLinkedWorkspaceDir } from "../../../hooks/useLinkedFolders";
import { useConnectionStore } from "../../../stores/connectionStore";
import { useUIStore } from "../../../stores/uiStore";
import type { AIConversationMessage, AIProviderConfig, DatabaseType } from "../../../types";
import {
  estimateTokensFromChars,
  isCompactCommand,
  resolveAutoCompactTokenLimit,
} from "../../../utils/ai-context-compact";
import { emitAppToast } from "../../../utils/app-toast";
import { invokeMutation } from "../../../utils/tauri-utils";
import {
  createAIWorkspaceId,
  estimateConversationFootprint,
  summarizePromptForDisplay,
  type AIChatThread,
} from "../ai-conversation-state";
import { buildPromptWithSelection } from "../ai-panel-selection";
import {
  buildComposerCommandContext,
  describeMissingCommandContext,
  describeMissingCommandContextItems,
  findFileCommandName,
  isBackupCommand,
  isRollbackCommand,
  type AgentFileCommand,
  type ResolvedFileCommand,
} from "../ai-slash-commands";
import { isDashboardSelectionSource } from "../ai-visualization-intent";
import type { AIWorkspaceCopy } from "../ai-workspace-copy";
import type { AIWorkspaceBubbleData, AIWorkspaceInteractionMode } from "../ai-workspace-types";
import { useAIPanelStore } from "../store/aiPanelStore";
import type { useAIAssistantGeneration } from "./use-ai-assistant-generation";
import type { PendingPrompt } from "./use-ai-bubble-rerun";
import { resolveEditorAssistPrompt, type useAISlidePanel } from "./use-ai-slide-panel";

type CreateAssistantBubble = ReturnType<typeof useAIAssistantGeneration>["createAssistantBubble"];

export function useBuildLoadingBubble({
  activeInteractionMode,
  activeProvider,
  aiCopy,
  currentThread,
  currentWorkspaceKey,
  workspaceThreads,
}: {
  activeInteractionMode: AIWorkspaceInteractionMode;
  activeProvider: AIProviderConfig | undefined;
  aiCopy: AIWorkspaceCopy;
  currentThread: AIChatThread | null;
  currentWorkspaceKey: string;
  workspaceThreads: AIChatThread[];
}) {
  return useCallback(
    (
      prompt: string,
      options?: {
        mode?: "compose" | "inspect";
        promptSummary?: string;
        threadId?: string;
        workspaceKey?: string;
        interactionMode?: AIWorkspaceInteractionMode;
      },
    ): AIWorkspaceBubbleData => {
      const id = createAIWorkspaceId();
      const workspaceKey = options?.workspaceKey || currentWorkspaceKey;
      const threadId =
        options?.threadId || currentThread?.id || workspaceThreads[0]?.id || createAIWorkspaceId();
      const interactionMode = options?.interactionMode || activeInteractionMode;
      return {
        id,
        threadId,
        workspaceKey,
        interactionMode,
        kind: "assistant",
        status: "loading",
        title:
          options?.mode === "inspect"
            ? aiCopy.bubbleStates.loadingInspectTitle
            : aiCopy.bubbleStates.loadingComposeTitle,
        subtitle:
          options?.mode === "inspect"
            ? aiCopy.bubbleStates.loadingInspectSubtitle
            : activeProvider?.name || aiCopy.composer.noProvider,
        prompt,
        promptSummary: options?.promptSummary || summarizePromptForDisplay(prompt),
        preview:
          options?.mode === "inspect"
            ? aiCopy.bubbleStates.loadingInspectPreview
            : aiCopy.bubbleStates.loadingComposePreview,
        detail: "",
        agentSteps:
          interactionMode === "agent"
            ? [
                {
                  step: 1,
                  action: "plan",
                  message: "",
                  status: "running",
                },
              ]
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
    },
    [
      activeInteractionMode,
      activeProvider?.name,
      aiCopy,
      currentThread,
      currentWorkspaceKey,
      workspaceThreads,
    ],
  );
}

interface UseAIComposerSendOptions {
  activeChatWorkspace: { id: string } | null;
  activeConnectionDbType: DatabaseType | undefined;
  activeGenerationBubbleIdRef: MutableRefObject<string | null>;
  activeInteractionMode: AIWorkspaceInteractionMode;
  activeThreadBubbles: AIWorkspaceBubbleData[];
  aiCopy: AIWorkspaceCopy;
  bubblesRef: MutableRefObject<AIWorkspaceBubbleData[]>;
  cancelGeneration: () => void;
  cancelledGenerationBubbleIdsRef: MutableRefObject<Set<string>>;
  composerTextareaRef: RefObject<HTMLTextAreaElement | null>;
  connectionId: string | null;
  contextWindowLimit: number | null;
  createAssistantBubble: CreateAssistantBubble;
  currentDatabase: string | null;
  currentThread: AIChatThread | null;
  effectiveHistoryMessages: AIConversationMessage[];
  fileCommands: AgentFileCommand[];
  handleBackupCommand: () => Promise<void>;
  handleCompactContext: (
    silent: boolean,
  ) => Promise<{ recentHistory: AIConversationMessage[] } | null>;
  handleRollbackCommand: () => Promise<void>;
  isGenerating: boolean;
  listCheckpoints: ReturnType<typeof useAISlidePanel>["listCheckpoints"];
  pendingQueueRef: MutableRefObject<PendingPrompt[]>;
  runEditedPrompt: (bubble: AIWorkspaceBubbleData, editedPrompt: string) => Promise<void>;
  setError: (message: string | null) => void;
  syncPendingQueue: (queue: PendingPrompt[]) => void;
}

export function useAIComposerSend({
  activeChatWorkspace,
  activeConnectionDbType,
  activeGenerationBubbleIdRef,
  activeInteractionMode,
  activeThreadBubbles,
  aiCopy,
  bubblesRef,
  cancelGeneration,
  cancelledGenerationBubbleIdsRef,
  composerTextareaRef,
  connectionId,
  contextWindowLimit,
  createAssistantBubble,
  currentDatabase,
  currentThread,
  effectiveHistoryMessages,
  fileCommands,
  handleBackupCommand,
  handleCompactContext,
  handleRollbackCommand,
  isGenerating,
  listCheckpoints,
  pendingQueueRef,
  runEditedPrompt,
  setError,
  syncPendingQueue,
}: UseAIComposerSendOptions) {
  const setPromptDraft = useAIPanelStore((state) => state.setPromptDraft);
  const setComposerAttachments = useAIPanelStore((state) => state.setComposerAttachments);
  const setAttachedSelection = useAIPanelStore((state) => state.setAttachedSelection);

  const handleGenerate = useCallback(
    async (item?: PendingPrompt | string) => {
      const snapshot = useAIPanelStore.getState();
      const current: PendingPrompt =
        typeof item === "string"
          ? { kind: "prompt", draft: item, attachments: [], selection: null }
          : (item ?? {
              kind: "prompt",
              draft: snapshot.promptDraft,
              attachments: snapshot.composerAttachments,
              selection: snapshot.attachedSelection,
            });
      if (isGenerating) {
        if (current.kind === "rerun" || current.draft.trim() || current.attachments.length > 0) {
          syncPendingQueue([...pendingQueueRef.current, current]);
          if (current.kind === "prompt") {
            setPromptDraft("");
            setComposerAttachments([]);
            if (!isDashboardSelectionSource(current.selection?.source)) {
              setAttachedSelection(null);
            }
          }
        }
        return;
      }
      const normalizedPrompt = (current.kind === "prompt" ? current.draft : "").trim();
      const currentSelection = current.kind === "prompt" ? current.selection : null;
      const currentAttachments = current.kind === "prompt" ? current.attachments : [];

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

      let promptToRun = normalizedPrompt;
      let commandToolRestriction: string[] | undefined;

      const editorAssist = await resolveEditorAssistPrompt({
        commandLine: normalizedPrompt,
        connectionId,
        dbType: activeConnectionDbType,
        databaseLabel: currentDatabase || null,
        attachedSql: currentSelection?.text ?? null,
      });
      if (editorAssist) {
        promptToRun = editorAssist.prompt;
        const missingContextNote = describeMissingCommandContextItems(editorAssist.missingContext);
        if (missingContextNote) {
          emitAppToast({
            tone: "info",
            title: `/${editorAssist.command}`,
            description: missingContextNote,
            durationMs: 8000,
          });
        }
      }

      if (findFileCommandName(normalizedPrompt, fileCommands)) {
        try {
          const connectionName = useConnectionStore
            .getState()
            .connections.find((connection) => connection.id === connectionId)?.name;
          const uiState = useUIStore.getState();
          const activeTab = uiState.tabs.find((tab) => tab.id === uiState.activeTabId);
          const activeQueryTab =
            activeTab?.type === "query" && activeTab.connectionId === connectionId
              ? activeTab
              : null;
          const schemaSummary = useConnectionStore
            .getState()
            .tables.slice(0, 60)
            .map((table) => table.name)
            .join(", ");
          const checkpointList = connectionId
            ? await listCheckpoints(connectionId)
                .then((entries) =>
                  entries
                    .slice(0, 10)
                    .map(
                      (entry) =>
                        `${entry.label} (${new Date(entry.createdAt).toISOString()}, ${entry.tableCount} tables, ${entry.rowCount} rows)`,
                    )
                    .join("\n"),
                )
                .catch(() => "")
            : "";
          const resolved = await invokeMutation<ResolvedFileCommand>("resolve_ai_command", {
            workspaceDir: await getLinkedWorkspaceDir(),
            commandLine: normalizedPrompt,
            context: buildComposerCommandContext({
              currentDatabase,
              boundConnection: connectionName,
              activeTabSql: activeQueryTab?.content ?? currentSelection?.text ?? null,
              selectedTable:
                activeTab?.type === "table" || activeTab?.type === "structure"
                  ? (activeTab.tableName ?? activeTab.title)
                  : null,
              schemaSummary: schemaSummary || null,
              checkpointList: checkpointList || null,
            }),
          });
          promptToRun = resolved.prompt;
          commandToolRestriction =
            resolved.allowedTools.length > 0 ? resolved.allowedTools : undefined;
          const missingContextNote = describeMissingCommandContext(resolved);
          if (missingContextNote) {
            emitAppToast({
              tone: "info",
              title: `/${resolved.command.name}`,
              description: missingContextNote,
              durationMs: 8000,
            });
          }
        } catch (error) {
          setError(error instanceof Error ? error.message : String(error));
          return;
        }
      }

      const promptWithSelection = buildPromptWithSelection(promptToRun, currentSelection);
      if (!promptWithSelection.trim()) return;

      const displayPrompt =
        normalizedPrompt ||
        (currentSelection
          ? `${aiCopy.composer.selectionReady} · ${currentSelection.source}`
          : promptWithSelection);

      setPromptDraft("");

      let historyForRun = effectiveHistoryMessages;
      const historyChars = estimateConversationFootprint(activeThreadBubbles);
      const overContextWindow =
        estimateTokensFromChars(historyChars) > resolveAutoCompactTokenLimit(contextWindowLimit);
      if (activeChatWorkspace && overContextWindow) {
        const compacted = await handleCompactContext(true);
        if (compacted) historyForRun = compacted.recentHistory;
      }

      const result = await createAssistantBubble(promptWithSelection, {
        mode: "compose",
        displayPrompt,
        userPrompt: normalizedPrompt || displayPrompt,
        attachmentSource: currentSelection?.source,
        history: historyForRun,
        threadId: currentThread?.id,
        interactionMode: activeInteractionMode,
        attachments: currentAttachments.length > 0 ? currentAttachments : undefined,
        commandToolRestriction,
      });

      if (result?.success) {
        setComposerAttachments([]);
        if (!isDashboardSelectionSource(currentSelection?.source)) {
          setAttachedSelection(null);
        }
      }

      while (pendingQueueRef.current.length > 0) {
        const next = pendingQueueRef.current[0];
        syncPendingQueue(pendingQueueRef.current.slice(1));
        if (next.kind === "rerun") {
          const bubble = bubblesRef.current.find((entry) => entry.id === next.bubbleId);
          if (bubble) await runEditedPrompt(bubble, next.prompt);
          continue;
        }
        await handleGenerate(next);
      }
    },
    [
      activeChatWorkspace,
      activeConnectionDbType,
      activeInteractionMode,
      activeThreadBubbles,
      aiCopy.composer.selectionReady,
      bubblesRef,
      connectionId,
      contextWindowLimit,
      createAssistantBubble,
      currentDatabase,
      currentThread?.id,
      effectiveHistoryMessages,
      fileCommands,
      handleBackupCommand,
      handleCompactContext,
      handleRollbackCommand,
      isGenerating,
      listCheckpoints,
      pendingQueueRef,
      runEditedPrompt,
      setAttachedSelection,
      setComposerAttachments,
      setError,
      setPromptDraft,
      syncPendingQueue,
    ],
  );

  const handleAskUserOptionSelect = useCallback(
    (option: string) => {
      void handleGenerate(option);
    },
    [handleGenerate],
  );

  const handleAskUserCustomInput = useCallback(() => {
    composerTextareaRef.current?.focus();
  }, [composerTextareaRef]);

  const handleCancelGeneration = useCallback(() => {
    const activeBubbleId = activeGenerationBubbleIdRef.current;
    if (activeBubbleId) {
      cancelledGenerationBubbleIdsRef.current.add(activeBubbleId);
    }
    syncPendingQueue([]);
    cancelGeneration();
  }, [
    activeGenerationBubbleIdRef,
    cancelGeneration,
    cancelledGenerationBubbleIdsRef,
    syncPendingQueue,
  ]);

  return {
    handleGenerate,
    handleAskUserOptionSelect,
    handleAskUserCustomInput,
    handleCancelGeneration,
  };
}
