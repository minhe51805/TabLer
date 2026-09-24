import { useCallback, useMemo, useState, type MutableRefObject, type RefObject } from "react";
import { emitAppToast } from "../../../utils/app-toast";
import { invokeMutation } from "../../../utils/tauri-utils";
import {
  createAIWorkspaceId,
  createChatThread,
  sanitizePersistedAIWorkspaceState,
  type AIChatThread,
  type PersistedAIWorkspaceState,
} from "../ai-conversation-state";
import type { AIWorkspaceBubbleData, AIWorkspaceInteractionMode } from "../ai-workspace-types";
import type { AppLanguage } from "../../../i18n";
import type { ThreadMemoryEntry } from "./use-ai-chat-workspaces";

interface UseAIChatThreadsOptions {
  bubbles: AIWorkspaceBubbleData[];
  chatThreads: AIChatThread[];
  workspaceThreads: AIChatThread[];
  currentWorkspaceKey: string;
  activeThreadId: string;
  activeThreadIdsByWorkspace: Record<string, string>;
  activeChatWorkspace: { id: string } | null;
  threadMemories: Record<string, ThreadMemoryEntry>;
  initialThreadRef: MutableRefObject<AIChatThread | null>;
  composerTextareaRef: RefObject<HTMLTextAreaElement | null>;
  activeGenerationBubbleIdRef: MutableRefObject<string | null>;
  cancelledGenerationBubbleIdsRef: MutableRefObject<Set<string>>;
  initialPrompt: string;
  isGenerating: boolean;
  isRunning: boolean;
  language: AppLanguage;
  cancelGeneration: () => void;
  setActiveThreadId: (id: string) => void;
  setActiveThreadIdsByWorkspace: (
    updater: Record<string, string> | ((current: Record<string, string>) => Record<string, string>),
  ) => void;
  setAttachedSelection: (value: null) => void;
  setBubbles: (
    updater:
      AIWorkspaceBubbleData[] | ((current: AIWorkspaceBubbleData[]) => AIWorkspaceBubbleData[]),
  ) => void;
  setChatThreads: (updater: AIChatThread[] | ((current: AIChatThread[]) => AIChatThread[])) => void;
  setError: (message: string | null) => void;
  setIsHistoryOpen: (open: boolean) => void;
  setPromptDraft: (value: string) => void;
  setThreadMemories: (
    updater:
      | Record<string, ThreadMemoryEntry>
      | ((current: Record<string, ThreadMemoryEntry>) => Record<string, ThreadMemoryEntry>),
  ) => void;
  setWorkspaceInteractionModes: (
    modes:
      | Record<string, AIWorkspaceInteractionMode>
      | ((
          current: Record<string, AIWorkspaceInteractionMode>,
        ) => Record<string, AIWorkspaceInteractionMode>),
  ) => void;
}

/**
 * Chat-thread CRUD and history operations: select/delete/rename/create,
 * reset-stage (which also cancels an in-flight run), reload from the persisted
 * SQLite history, and cross-workspace thread import. Thread state itself stays
 * in the panel; this hook owns the handlers and the delete-confirmation state.
 */
export function useAIChatThreads({
  bubbles,
  chatThreads,
  workspaceThreads,
  currentWorkspaceKey,
  activeThreadId,
  activeThreadIdsByWorkspace,
  activeChatWorkspace,
  threadMemories,
  initialThreadRef,
  composerTextareaRef,
  activeGenerationBubbleIdRef,
  cancelledGenerationBubbleIdsRef,
  initialPrompt,
  isGenerating,
  isRunning,
  language,
  cancelGeneration,
  setActiveThreadId,
  setActiveThreadIdsByWorkspace,
  setAttachedSelection,
  setBubbles,
  setChatThreads,
  setError,
  setIsHistoryOpen,
  setPromptDraft,
  setThreadMemories,
  setWorkspaceInteractionModes,
}: UseAIChatThreadsOptions) {
  const [deleteThreadPending, setDeleteThreadPending] = useState<string | null>(null);

  const handleSelectThread = useCallback(
    (threadId: string) => {
      setActiveThreadId(threadId);
      setActiveThreadIdsByWorkspace((current) => ({
        ...current,
        [currentWorkspaceKey]: threadId,
      }));
      setIsHistoryOpen(false);
      setAttachedSelection(null);
    },
    [
      currentWorkspaceKey,
      setActiveThreadId,
      setActiveThreadIdsByWorkspace,
      setAttachedSelection,
      setIsHistoryOpen,
    ],
  );

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
    const remainingWorkspaceThreads = updatedThreads.filter(
      (thread) => thread.workspaceKey === currentWorkspaceKey,
    );
    const nextActiveThreadId =
      activeThreadIdsByWorkspace[currentWorkspaceKey] === threadId
        ? (remainingWorkspaceThreads[0]?.id ?? null)
        : (activeThreadIdsByWorkspace[currentWorkspaceKey] ?? activeThreadId);

    setChatThreads(updatedThreads);
    setBubbles(updatedBubbles);
    setThreadMemories((current) => {
      if (!current[threadId]) return current;
      const next = { ...current };
      delete next[threadId];
      return next;
    });
    invokeMutation("delete_thread_memory_for_thread", { threadId }).catch((error: unknown) =>
      console.error("[AIWorkspace] Failed to delete thread memory:", error),
    );
    invokeMutation("delete_ai_attachments_for_thread", { threadId }).catch((error: unknown) =>
      console.error("[AIWorkspace] Failed to delete thread attachments:", error),
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
  }, [
    activeThreadId,
    activeThreadIdsByWorkspace,
    bubbles,
    chatThreads,
    currentWorkspaceKey,
    deleteThreadPending,
    initialThreadRef,
    setActiveThreadId,
    setActiveThreadIdsByWorkspace,
    setBubbles,
    setChatThreads,
    setThreadMemories,
  ]);

  const handleRenameChatThread = useCallback(
    (threadId: string, label: string) => {
      const trimmed = label.trim();
      if (!trimmed) return;
      setChatThreads((current) =>
        current.map((thread) =>
          thread.id === threadId ? { ...thread, label: trimmed, updatedAt: Date.now() } : thread,
        ),
      );
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
        }).catch((error: unknown) => {
          console.error("[AIWorkspace] Failed to rename thread memory:", error);
          emitAppToast({
            tone: "error",
            title: language === "vi" ? "Không lưu được ghi nhớ thread" : "Thread memory not saved",
            durationMs: 4000,
          });
        });
      }
    },
    [activeChatWorkspace, language, setChatThreads, setThreadMemories, threadMemories],
  );

  const handleCancelDeleteThread = useCallback(() => {
    setDeleteThreadPending(null);
  }, []);

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
    setError(null);
    window.requestAnimationFrame(() => {
      composerTextareaRef.current?.focus();
      if (initialPrompt.trim()) {
        composerTextareaRef.current?.setSelectionRange(initialPrompt.length, initialPrompt.length);
      }
    });
  }, [
    composerTextareaRef,
    currentWorkspaceKey,
    initialPrompt,
    setActiveThreadId,
    setActiveThreadIdsByWorkspace,
    setAttachedSelection,
    setChatThreads,
    setError,
    setIsHistoryOpen,
    setPromptDraft,
    workspaceThreads.length,
  ]);

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
  }, [
    activeGenerationBubbleIdRef,
    cancelGeneration,
    cancelledGenerationBubbleIdsRef,
    handleCreateChatThread,
  ]);

  /** Reloads the current conversation from the persisted SQLite history so a
   *  stale-looking chat can be refreshed without touching live generations. */
  const handleReloadChat = useCallback(async () => {
    if (isGenerating || isRunning) return;
    try {
      const persistedState = sanitizePersistedAIWorkspaceState(
        await invokeMutation<PersistedAIWorkspaceState>("get_ai_workspace_history", {}),
      );
      const threads = persistedState.threads;
      const loadedBubbles = persistedState.bubbles.filter((bubble) => bubble.status !== "loading");
      setChatThreads(threads);
      setBubbles(loadedBubbles);
      setWorkspaceInteractionModes(persistedState.interactionModes);
      const activeMap = persistedState.activeThreadIds;
      setActiveThreadIdsByWorkspace(activeMap);
      const workspaceThreadsForCurrentKey = threads.filter(
        (thread) => thread.workspaceKey === currentWorkspaceKey,
      );
      const preferredThreadId = activeMap[currentWorkspaceKey];
      const nextThreadId =
        workspaceThreadsForCurrentKey.find((thread) => thread.id === preferredThreadId)?.id ??
        [...workspaceThreadsForCurrentKey].sort(
          (left, right) => right.updatedAt - left.updatedAt,
        )[0]?.id ??
        workspaceThreadsForCurrentKey[0]?.id;
      if (nextThreadId) setActiveThreadId(nextThreadId);
      setError(null);
    } catch (error) {
      console.error("[AIWorkspace] Failed to reload chat:", error);
    }
  }, [
    currentWorkspaceKey,
    isGenerating,
    isRunning,
    setActiveThreadId,
    setActiveThreadIdsByWorkspace,
    setBubbles,
    setChatThreads,
    setError,
    setWorkspaceInteractionModes,
  ]);

  const importableChatThreads = useMemo(
    () =>
      chatThreads
        .filter((thread) => thread.workspaceKey !== currentWorkspaceKey)
        .sort((left, right) => right.updatedAt - left.updatedAt),
    [chatThreads, currentWorkspaceKey],
  );

  /** Copies threads (and their bubbles) from other workspaces/scopes into the
   *  current one — "import các đoạn chat liên quan" into this workspace. */
  const handleImportChatThreads = useCallback(
    (threadIds: string[]) => {
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
    },
    [
      bubbles,
      chatThreads,
      currentWorkspaceKey,
      setActiveThreadId,
      setActiveThreadIdsByWorkspace,
      setBubbles,
      setChatThreads,
      setIsHistoryOpen,
    ],
  );

  return {
    deleteThreadPending,
    handleCancelDeleteThread,
    handleConfirmDeleteThread,
    handleCreateChatThread,
    handleImportChatThreads,
    handleReloadChat,
    handleRenameChatThread,
    handleRequestDeleteThread,
    handleResetStage,
    handleSelectThread,
    importableChatThreads,
  };
}
