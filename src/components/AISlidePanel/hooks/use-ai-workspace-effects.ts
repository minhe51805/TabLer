/* The hook receives stable React setters/refs from its controller; spelling all
   of them in every dependency array obscures each effect's real data inputs. */
/* eslint-disable react-hooks/exhaustive-deps */
import { useEffect } from "react";
import { invokeMutation } from "../../../utils/tauri-utils";
import { AI_WORKSPACE_HISTORY_SAVE_DEBOUNCE_MS, AI_WORKSPACE_HISTORY_VERSION, createChatThread, createEmptyPersistedAIWorkspaceState, hasPersistedAIWorkspaceStateData, loadLegacyPersistedAIWorkspaceState, prunePersistedAIWorkspaceState, type PersistedAIWorkspaceState } from "../ai-conversation-state";
import { getSelectionFromActiveElement, getSelectionRect } from "../ai-panel-selection";

export function useAIWorkspaceEffects(options: Record<string, any>) {
  const { historyHydrated, isOpen, setChatThreads, setBubbles, setWorkspaceInteractionModes, setActiveThreadIdsByWorkspace, currentWorkspaceKey, initialThreadRef, activeThreadId, setActiveThreadId, setHistoryHydrated, hasConversation, scrollChatToLatest, currentThread, isGenerating, latestConversationBubbleId, latestConversationBubbleSnapshot, chatThreadRef, setIsHistoryOpen, isOpenRef, openSessionRef, visualizationApprovalScopeRef, setIsSessionDataReadEnabled, visualizationConsentResolverRef, setVisualizationConsentPending, isHistoryOpen, historyPanelRef, aiConfigs, loadAIConfigs, workspaceThreads, recentWorkspaceThreads, activeThreadIdsByWorkspace, lastWorkspaceKeyRef, setAttachedSelection, setSelectionContext, setDetailBubbleId, setIsInspectMode, setPromptDraft, setError, initialPromptNonce, initialPrompt, composerTextareaRef, initialAttachmentNonce, initialAttachment, detailBubbleId, onClose, historySaveTimerRef, bubbleDismissTimersRef, bubbles, chatThreads, workspaceInteractionModes, persistHistoryState, isInspectMode } = options;
  useEffect(() => {
    if (historyHydrated || !isOpen) return;

    let isCancelled = false;

    const hydrateHistory = async () => {
      try {
        let persistedState = await invokeMutation<PersistedAIWorkspaceState>("get_ai_workspace_history", {});
        const normalizedPersistedState = createEmptyPersistedAIWorkspaceState();
        normalizedPersistedState.version = typeof persistedState.version === "number"
          ? persistedState.version
          : AI_WORKSPACE_HISTORY_VERSION;
        normalizedPersistedState.threads = Array.isArray(persistedState.threads) ? persistedState.threads : [];
        normalizedPersistedState.bubbles = Array.isArray(persistedState.bubbles) ? persistedState.bubbles : [];
        normalizedPersistedState.interactionModes = persistedState.interactionModes || {};
        normalizedPersistedState.activeThreadIds = persistedState.activeThreadIds || {};
        persistedState = normalizedPersistedState;

        if (!hasPersistedAIWorkspaceStateData(persistedState)) {
          const legacyState = prunePersistedAIWorkspaceState(loadLegacyPersistedAIWorkspaceState());
          if (hasPersistedAIWorkspaceStateData(legacyState)) {
            persistedState = legacyState;
            await invokeMutation<void>("save_ai_workspace_history", { state: legacyState });
          }
        }

        if (isCancelled) return;

        setChatThreads(persistedState.threads);
        setBubbles(persistedState.bubbles);
        setWorkspaceInteractionModes(persistedState.interactionModes);
        setActiveThreadIdsByWorkspace(persistedState.activeThreadIds);

        const workspaceThreadsForCurrentKey = persistedState.threads.filter(
          (thread: any) => thread.workspaceKey === currentWorkspaceKey
        );
        const preferredThreadId = persistedState.activeThreadIds[currentWorkspaceKey];
        const nextThreadId =
          workspaceThreadsForCurrentKey.find((thread: any) => thread.id === preferredThreadId)?.id ??
          [...workspaceThreadsForCurrentKey].sort((left: any, right: any) => right.updatedAt - left.updatedAt)[0]?.id ??
          initialThreadRef.current?.id ??
          activeThreadId;

        setActiveThreadId(nextThreadId);
      } catch {
        if (isCancelled) return;
      } finally {
        if (!isCancelled) {
          setHistoryHydrated(true);
        }
      }
    };

    void hydrateHistory();

    return () => {
      isCancelled = true;
    };
  }, [activeThreadId, currentWorkspaceKey, historyHydrated, isOpen]);

  useEffect(() => {
    if (!isOpen || !historyHydrated || !hasConversation) return;
    scrollChatToLatest();
  }, [
    currentThread?.id,
    hasConversation,
    historyHydrated,
    isGenerating,
    isOpen,
    latestConversationBubbleId,
    latestConversationBubbleSnapshot,
    scrollChatToLatest,
  ]);

  // Keep the view pinned to the newest message while content grows (markdown,
  // code, agent steps streaming in) ? but only when the user is already near the
  // bottom, so scrolling up to read old messages is never interrupted.
  useEffect(() => {
    if (!isOpen || !hasConversation) return;
    const thread = chatThreadRef.current;
    if (!thread || typeof ResizeObserver === "undefined") return;

    const NEAR_BOTTOM_PX = 120;
    const observer = new ResizeObserver(() => {
      const el = chatThreadRef.current;
      if (!el) return;
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (distanceFromBottom <= NEAR_BOTTOM_PX) {
        el.scrollTop = el.scrollHeight;
      }
    });
    observer.observe(thread);
    return () => observer.disconnect();
  }, [isOpen, hasConversation, currentThread?.id]);

  useEffect(() => {
    if (!isOpen) {
      setIsHistoryOpen(false);
    }
  }, [isOpen]);

  useEffect(() => {
    isOpenRef.current = isOpen;
    if (isOpen) {
      openSessionRef.current += 1;
      visualizationApprovalScopeRef.current = null;
      setIsSessionDataReadEnabled(false);
    } else {
      if (visualizationConsentResolverRef.current) {
        visualizationConsentResolverRef.current(false);
        visualizationConsentResolverRef.current = null;
      }
      setVisualizationConsentPending(null);
      setIsSessionDataReadEnabled(false);
    }
  }, [isOpen]);

  useEffect(() => {
    setIsHistoryOpen(false);
  }, [currentWorkspaceKey]);

  useEffect(() => {
    if (!isHistoryOpen) return;

    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (target && historyPanelRef.current?.contains(target)) return;
      setIsHistoryOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsHistoryOpen(false);
      }
    };

    window.addEventListener("mousedown", handlePointerDown, true);
    window.addEventListener("touchstart", handlePointerDown, true);
    window.addEventListener("keydown", handleKeyDown, true);

    return () => {
      window.removeEventListener("mousedown", handlePointerDown, true);
      window.removeEventListener("touchstart", handlePointerDown, true);
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [isHistoryOpen]);

  useEffect(() => {
    if (!isOpen || aiConfigs.length > 0) return;
    void loadAIConfigs().catch(() => {
      /* Keep the panel usable even if settings fail to hydrate here. */
    });
  }, [aiConfigs.length, isOpen, loadAIConfigs]);

  useEffect(() => {
    if (!historyHydrated) return;

    if (workspaceThreads.length === 0) {
      const nextThread = createChatThread(1, currentWorkspaceKey);
      setChatThreads((current: any) => (
        current.some((thread: any) => thread.workspaceKey === currentWorkspaceKey)
          ? current
          : [...current, nextThread]
      ));
      setActiveThreadId(nextThread.id);
      setActiveThreadIdsByWorkspace((current: any) => ({
        ...current,
        [currentWorkspaceKey]: nextThread.id,
      }));
      return;
    }

    const preferredThreadId = activeThreadIdsByWorkspace[currentWorkspaceKey];
    const nextActiveThread =
      workspaceThreads.find((thread: any) => thread.id === preferredThreadId) ??
      recentWorkspaceThreads[0] ??
      workspaceThreads[0] ??
      null;

    if (nextActiveThread && nextActiveThread.id !== activeThreadId) {
      setActiveThreadId(nextActiveThread.id);
    }
  }, [activeThreadId, activeThreadIdsByWorkspace, currentWorkspaceKey, historyHydrated, recentWorkspaceThreads, workspaceThreads]);

  useEffect(() => {
    if (!currentThread?.id) return;
    setActiveThreadIdsByWorkspace((current: any) => (
      current[currentWorkspaceKey] === currentThread.id
        ? current
        : {
            ...current,
            [currentWorkspaceKey]: currentThread.id,
          }
    ));
  }, [currentThread?.id, currentWorkspaceKey]);

  useEffect(() => {
    if (lastWorkspaceKeyRef.current === currentWorkspaceKey) {
      return;
    }
    lastWorkspaceKeyRef.current = currentWorkspaceKey;
    setAttachedSelection(null);
    setSelectionContext(null);
    setDetailBubbleId(null);
    setIsInspectMode(false);
    setPromptDraft("");
    visualizationApprovalScopeRef.current = null;
    setIsSessionDataReadEnabled(false);
    setError(null);
  }, [currentWorkspaceKey, setError]);

  useEffect(() => {
    if (!initialPromptNonce) return;
    setPromptDraft(initialPrompt);
    setError(null);
    window.requestAnimationFrame(() => {
      composerTextareaRef.current?.focus();
      composerTextareaRef.current?.setSelectionRange(initialPrompt.length, initialPrompt.length);
    });
  }, [initialPrompt, initialPromptNonce, setError]);

  useEffect(() => {
    if (!initialAttachmentNonce || !initialAttachment?.text.trim()) return;

    setAttachedSelection({
      text: initialAttachment.text.trim(),
      source: initialAttachment.source?.trim() || "Workspace attachment",
      boardId: initialAttachment.boardId,
      rect: null,
      updatedAt: Date.now(),
    });
    setIsInspectMode(false);
    setError(null);

    window.requestAnimationFrame(() => {
      composerTextareaRef.current?.focus();
      const cursorPosition = composerTextareaRef.current?.value.length ?? 0;
      composerTextareaRef.current?.setSelectionRange(cursorPosition, cursorPosition);
    });
  }, [initialAttachment, initialAttachmentNonce, setError]);

  useEffect(() => {
    if (!isOpen) return;

    const handleSelectionChange = () => {
      const activeElement = document.activeElement;
      if (activeElement instanceof HTMLElement && activeElement.closest(".ai-workspace-overlay")) {
        return;
      }

      const selection = window.getSelection();
      const selectedText = selection?.toString().trim() ?? "";
      if (selectedText.length > 1 && selection?.rangeCount) {
        const range = selection.getRangeAt(0);
        const rect = getSelectionRect(range);
        setSelectionContext({
          text: selectedText,
          source: "workspace selection",
          rect,
          updatedAt: Date.now(),
        });
        return;
      }

      const fallbackSelection = getSelectionFromActiveElement(activeElement);
      if (fallbackSelection) {
        setSelectionContext({
          ...fallbackSelection,
          updatedAt: Date.now(),
        });
        return;
      }

      setSelectionContext((current: any) => {
        if (!current || Date.now() - current.updatedAt > 6_000) {
          return null;
        }
        return current;
      });
    };

    const handleEditorSelection = (event: Event) => {
      const detail = (event as CustomEvent<{ text?: string; source?: string }>).detail;
      if (!detail?.text?.trim()) {
        setSelectionContext((current: any) => {
          if (current?.source === (detail?.source || "SQL editor selection")) {
            return null;
          }
          return current;
        });
        return;
      }
      setSelectionContext({
        text: detail.text.trim(),
        source: detail.source || "SQL editor selection",
        rect: null,
        updatedAt: Date.now(),
      });
    };

    document.addEventListener("selectionchange", handleSelectionChange);
    window.addEventListener("ai-selection-context", handleEditorSelection);
    return () => {
      document.removeEventListener("selectionchange", handleSelectionChange);
      window.removeEventListener("ai-selection-context", handleEditorSelection);
    };
  }, [isInspectMode, isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (detailBubbleId) {
        setDetailBubbleId(null);
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [detailBubbleId, isOpen, onClose]);

  useEffect(() => {
    return () => {
      if (historySaveTimerRef.current !== null) {
        window.clearTimeout(historySaveTimerRef.current);
        historySaveTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    return () => {
      bubbleDismissTimersRef.current.forEach((timerId: any) => window.clearTimeout(timerId));
      bubbleDismissTimersRef.current.clear();
    };
  }, []);

  useEffect(() => {
    const activeIds = new Set(bubbles.map((bubble: any) => bubble.id));
    bubbleDismissTimersRef.current.forEach((timerId: any, bubbleId: any) => {
      if (!activeIds.has(bubbleId)) {
        window.clearTimeout(timerId);
        bubbleDismissTimersRef.current.delete(bubbleId);
      }
    });
  }, [bubbles]);

  useEffect(() => {
    bubbles.forEach((bubble: any) => {
      if (!bubble.autoDismissAt || bubbleDismissTimersRef.current.has(bubble.id)) {
        return;
      }

      const remainingMs = Math.max(0, bubble.autoDismissAt - Date.now());
      const timerId = window.setTimeout(() => {
        bubbleDismissTimersRef.current.delete(bubble.id);
        setBubbles((current: any) => current.filter((currentBubble: any) => currentBubble.id !== bubble.id));
        setDetailBubbleId((current: any) => (current === bubble.id ? null : current));
      }, remainingMs);

      bubbleDismissTimersRef.current.set(bubble.id, timerId);
    });
  }, [bubbles]);

  useEffect(() => {
    if (!historyHydrated) {
      return;
    }

    const nextState: PersistedAIWorkspaceState = {
      version: AI_WORKSPACE_HISTORY_VERSION,
      threads: chatThreads,
      bubbles,
      interactionModes: workspaceInteractionModes,
      activeThreadIds: activeThreadIdsByWorkspace,
    };

    if (historySaveTimerRef.current !== null) {
      window.clearTimeout(historySaveTimerRef.current);
    }

    historySaveTimerRef.current = window.setTimeout(() => {
      historySaveTimerRef.current = null;
      persistHistoryState(nextState).catch((error: unknown) => {
        console.error("[AIWorkspace] Failed to persist workspace state:", error);
      });
    }, AI_WORKSPACE_HISTORY_SAVE_DEBOUNCE_MS);

    return () => {
      if (historySaveTimerRef.current !== null) {
        window.clearTimeout(historySaveTimerRef.current);
        historySaveTimerRef.current = null;
      }
    };
  }, [
    activeThreadIdsByWorkspace,
    bubbles,
    chatThreads,
    historyHydrated,
    persistHistoryState,
    workspaceInteractionModes,
  ]);


}
