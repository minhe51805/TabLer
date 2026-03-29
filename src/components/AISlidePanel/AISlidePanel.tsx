import { Database, Loader2, RotateCcw, Sparkles, Target, Wand2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../i18n";
import type { AIConversationMessage } from "../../types";
import { AIWorkspaceMarkdown } from "./AIWorkspaceMarkdown";
import { AIBubbleDetailModal } from "./AIBubbleDetailModal";
import { useAISlidePanel } from "./hooks/use-ai-slide-panel";
import {
  aiModeAllowsInsert,
  aiModeAllowsRun,
  getDefaultAIWorkspaceInteractionMode,
  type AIWorkspaceBubbleData,
  type AIWorkspaceInteractionMode,
} from "./ai-workspace-types";
import { getAIWorkspaceCopy } from "./ai-workspace-copy";

interface Props {
  isOpen: boolean;
  initialPrompt?: string;
  initialPromptNonce?: number;
  onClose: () => void;
}

const ERROR_BUBBLE_AUTO_DISMISS_MS = 9000;
const MAX_HISTORY_BUBBLES = 4;
const MAX_HISTORY_MESSAGE_CHARS = 1000;

interface AIChatThread {
  id: string;
  workspaceKey: string;
  label: string;
  createdAt: number;
  isAutoLabel: boolean;
}

interface SelectionContextState {
  text: string;
  source: string;
  rect: { x: number; y: number; width: number; height: number } | null;
  updatedAt: number;
}

function createId() {
  return globalThis.crypto?.randomUUID?.() ?? `bubble-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function stripCodeFences(text: string) {
  return text.replace(/```sql?/gi, "").replace(/```/g, "").trim();
}

function summarizeResponse(rawResponse: string, sql?: string | null) {
  const cleaned = stripCodeFences(rawResponse).replace(/\s+/g, " ").trim();
  const compactSql = sql?.replace(/\s+/g, " ").trim() || "";
  if (cleaned && (!compactSql || cleaned !== compactSql)) {
    return cleaned.length > 180 ? `${cleaned.slice(0, 177)}...` : cleaned;
  }
  const firstLine = (sql || "").split("\n").find((line) => line.trim().length > 0) ?? sql ?? cleaned;
  return firstLine.length > 180 ? `${firstLine.slice(0, 177)}...` : firstLine;
}

function summarizeSelectionText(text: string) {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > 180 ? `${compact.slice(0, 177)}...` : compact;
}

function summarizePromptForDisplay(text: string) {
  return summarizeSelectionText(text);
}

function buildThreadLabel(prompt: string, index: number) {
  const summary = summarizePromptForDisplay(prompt);
  if (!summary) return `#${index}`;
  return summary.length > 24 ? `${summary.slice(0, 21).trimEnd()}...` : summary;
}

function buildAIWorkspaceKey(connectionId: string | null, database: string | null) {
  return `${connectionId || "no-connection"}::${database || "no-database"}`;
}

function createChatThread(index: number, workspaceKey: string): AIChatThread {
  return {
    id: createId(),
    workspaceKey,
    label: `#${index}`,
    createdAt: Date.now(),
    isAutoLabel: true,
  };
}

function getInteractionModeLabel(
  interactionMode: AIWorkspaceInteractionMode,
  copy: ReturnType<typeof getAIWorkspaceCopy>
) {
  if (interactionMode === "agent") return copy.composer.modeAgent;
  if (interactionMode === "edit") return copy.composer.modeEdit;
  return copy.composer.modePrompt;
}

function trimHistoryText(text: string, maxChars = MAX_HISTORY_MESSAGE_CHARS) {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function extractHistoryPrompt(prompt: string) {
  const normalized = prompt.trim();
  if (!normalized) return "";

  const userRequestMarker = "User request:\n";
  const selectedContentMarker = "\n\nSelected content:";
  if (normalized.includes(userRequestMarker)) {
    const requestPart = normalized.split(userRequestMarker)[1] ?? "";
    const userOnly = requestPart.split(selectedContentMarker)[0] ?? requestPart;
    return trimHistoryText(userOnly);
  }

  const [firstBlock] = normalized.split(/\n\s*\n/);
  return trimHistoryText(firstBlock || normalized);
}

function buildSelectionDraftPrompt(selection: SelectionContextState) {
  return [
    `Explain this ${selection.source} and suggest a better version if needed.`,
    "",
    selection.text,
  ].join("\n");
}

function buildPromptWithSelection(prompt: string, selection: SelectionContextState | null) {
  const normalizedPrompt = prompt.trim();
  if (!selection?.text.trim()) {
    return normalizedPrompt;
  }

  if (!normalizedPrompt) {
    return buildSelectionDraftPrompt(selection);
  }

  return [
    `Use this ${selection.source} as context for the request below.`,
    "",
    `User request: ${normalizedPrompt}`,
    "",
    "Selected content:",
    selection.text,
  ].join("\n");
}

function getBubbleConversationText(bubble: AIWorkspaceBubbleData) {
  const fallback = bubble.preview?.trim() || "";
  const normalizedDetail = stripCodeFences(bubble.detail || "").trim();
  const normalizedSql = stripCodeFences(bubble.sql || "").trim();

  if (!normalizedDetail) {
    return fallback;
  }

  if (normalizedSql && normalizedDetail === normalizedSql) {
    return fallback;
  }

  if (normalizedSql && normalizedDetail.includes(normalizedSql)) {
    const withoutSql = normalizedDetail.replace(normalizedSql, "").trim();
    return withoutSql || fallback;
  }

  return normalizedDetail;
}

function buildConversationHistoryMessages(bubbles: AIWorkspaceBubbleData[]): AIConversationMessage[] {
  return [...bubbles]
    .filter((bubble) => bubble.kind === "assistant" && bubble.status !== "loading")
    .sort((left, right) => left.createdAt - right.createdAt)
    .slice(-MAX_HISTORY_BUBBLES)
    .flatMap((bubble) => {
      const userPrompt = extractHistoryPrompt(bubble.prompt);
      const assistantReply = trimHistoryText(getBubbleConversationText(bubble) || bubble.preview || bubble.detail || "");
      const messages: AIConversationMessage[] = [];

      if (userPrompt) {
        messages.push({ role: "user", content: userPrompt });
      }
      if (assistantReply) {
        messages.push({ role: "assistant", content: assistantReply });
      }
      return messages;
    });
}

function getSelectionRect(range: Range | null) {
  if (!range) return null;
  const rect = range.getBoundingClientRect();
  if (!rect.width && !rect.height) return null;
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

function getSelectionFromActiveElement(activeElement: Element | null) {
  if (
    activeElement instanceof HTMLTextAreaElement ||
    (activeElement instanceof HTMLInputElement && typeof activeElement.selectionStart === "number")
  ) {
    const start = activeElement.selectionStart ?? 0;
    const end = activeElement.selectionEnd ?? 0;
    if (start === end) return null;
    const selectedText = activeElement.value.slice(start, end).trim();
    if (!selectedText) return null;
    const rect = activeElement.getBoundingClientRect();
    return {
      text: selectedText,
      source: activeElement instanceof HTMLTextAreaElement ? "text input" : "inline field",
      rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
    };
  }
  return null;
}

export function AISlidePanel({
  isOpen,
  initialPrompt = "",
  initialPromptNonce = 0,
  onClose,
}: Props) {
  const { language } = useI18n();
  const aiCopy = useMemo(() => getAIWorkspaceCopy(language), [language]);
  const {
    activeProvider,
    tableContextCount,
    connectionId,
    currentDatabase,
    error,
    setError,
    isGenerating,
    isRunning,
    generateAssist,
    copyText,
    insertSql,
    runSql,
  } = useAISlidePanel({ isOpen });

  const composerRef = useRef<HTMLDivElement>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement>(null);
  const chatThreadRef = useRef<HTMLDivElement>(null);
  const bubbleDismissTimersRef = useRef(new Map<string, number>());
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
  const [chatThreads, setChatThreads] = useState<AIChatThread[]>(() => [initialThreadRef.current!]);
  const [workspaceInteractionModes, setWorkspaceInteractionModes] = useState<Record<string, AIWorkspaceInteractionMode>>({});
  const [activeThreadId, setActiveThreadId] = useState<string>(() => initialThreadRef.current!.id);
  const [detailBubbleId, setDetailBubbleId] = useState<string | null>(null);
  const [isInspectMode, setIsInspectMode] = useState(false);
  const [selectionContext, setSelectionContext] = useState<SelectionContextState | null>(null);
  const [attachedSelection, setAttachedSelection] = useState<SelectionContextState | null>(null);

  const detailBubble = useMemo(
    () => bubbles.find((bubble) => bubble.id === detailBubbleId) ?? null,
    [bubbles, detailBubbleId]
  );
  const workspaceThreads = useMemo(
    () => chatThreads.filter((thread) => thread.workspaceKey === currentWorkspaceKey),
    [chatThreads, currentWorkspaceKey]
  );
  const currentThread = useMemo(
    () => workspaceThreads.find((thread) => thread.id === activeThreadId) ?? workspaceThreads[0] ?? null,
    [activeThreadId, workspaceThreads]
  );
  const activeInteractionMode = useMemo(
    () => workspaceInteractionModes[currentWorkspaceKey] ?? getDefaultAIWorkspaceInteractionMode(activeProvider?.allow_schema_context),
    [activeProvider?.allow_schema_context, currentWorkspaceKey, workspaceInteractionModes]
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
  const latestConversationBubble = useMemo(
    () => conversationBubbles[conversationBubbles.length - 1] ?? null,
    [conversationBubbles]
  );
  const isSchemaModeBlocked = activeInteractionMode !== "prompt" && !activeProvider?.allow_schema_context;
  const isLongformComposer = activeInteractionMode === "agent" || activeThreadBubbles.length >= 2;
  const composerModeHint = useMemo(() => {
    if (isSchemaModeBlocked) {
      return aiCopy.composer.modeNeedsSchemaHint;
    }
    if (activeInteractionMode === "agent") {
      return aiCopy.composer.modeAgentHint;
    }
    if (activeInteractionMode === "edit") {
      return aiCopy.composer.modeEditHint;
    }
    return aiCopy.composer.modePromptHint;
  }, [activeInteractionMode, aiCopy, isSchemaModeBlocked]);
  const hasConversation = conversationBubbles.length > 0;
  const agentStatusText = useMemo(() => {
    if (activeInteractionMode !== "agent") return "";
    if (!latestConversationBubble) return composerModeHint;
    if (latestConversationBubble.status === "loading") return aiCopy.bubbleMeta.thinking;
    if (latestConversationBubble.sql) {
      return latestConversationBubble.subtitle || aiCopy.bubbleStates.readySqlReviewSubtitle;
    }
    return latestConversationBubble.subtitle || aiCopy.bubbleMeta.ready;
  }, [
    activeInteractionMode,
    aiCopy.bubbleMeta.ready,
    aiCopy.bubbleMeta.thinking,
    aiCopy.bubbleStates.readySqlReviewSubtitle,
    composerModeHint,
    latestConversationBubble,
  ]);
  const agentStripState = useMemo(() => {
    if (activeInteractionMode !== "agent") return "is-idle";
    if (!latestConversationBubble) return "is-idle";
    if (latestConversationBubble.status === "loading") return "is-loading";
    if (latestConversationBubble.kind === "error") return "is-error";
    if (latestConversationBubble.kind === "result") return "is-done";
    if (latestConversationBubble.sql) return "is-actionable";
    return "is-ready";
  }, [activeInteractionMode, latestConversationBubble]);
  const shouldShowAgentActions =
    activeInteractionMode === "agent" &&
    !isSchemaModeBlocked &&
    !!latestConversationBubble &&
    latestConversationBubble.status !== "loading";
  const modePanelState = useMemo(() => {
    if (isSchemaModeBlocked) return "is-warning";
    if (activeInteractionMode === "agent") return agentStripState;
    if (activeInteractionMode === "edit") return "is-edit";
    return "is-prompt";
  }, [activeInteractionMode, agentStripState, isSchemaModeBlocked]);
  const shouldShowModeInline =
    isSchemaModeBlocked ||
    (activeInteractionMode === "agent" && (hasConversation || isGenerating || shouldShowAgentActions));
  const composerFooterNote = attachedSelection
    ? `${aiCopy.composer.selectionReady} · ${attachedSelection.source}`
    : isInspectMode
      ? aiCopy.composer.inspectHint
      : "";

  useEffect(() => {
    if (!isOpen || !isInspectMode) return;
    window.requestAnimationFrame(() => {
      const thread = chatThreadRef.current;
      if (!thread) return;
      thread.scrollTop = thread.scrollHeight;
    });
  }, [conversationBubbles, isOpen]);

  useEffect(() => {
    if (workspaceThreads.length === 0) {
      const nextThread = createChatThread(1, currentWorkspaceKey);
      setChatThreads((current) => (
        current.some((thread) => thread.workspaceKey === currentWorkspaceKey)
          ? current
          : [...current, nextThread]
      ));
      setActiveThreadId(nextThread.id);
      return;
    }

    if (!workspaceThreads.some((thread) => thread.id === activeThreadId)) {
      setActiveThreadId(workspaceThreads[0]?.id ?? "");
    }
  }, [activeThreadId, currentWorkspaceKey, workspaceThreads]);

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

      setSelectionContext((current) => {
        if (!current || Date.now() - current.updatedAt > 6_000) {
          return null;
        }
        return current;
      });
    };

    const handleEditorSelection = (event: Event) => {
      const detail = (event as CustomEvent<{ text?: string; source?: string }>).detail;
      if (!detail?.text?.trim()) {
        setSelectionContext((current) => {
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
      bubbleDismissTimersRef.current.forEach((timerId) => window.clearTimeout(timerId));
      bubbleDismissTimersRef.current.clear();
    };
  }, []);

  useEffect(() => {
    const activeIds = new Set(bubbles.map((bubble) => bubble.id));
    bubbleDismissTimersRef.current.forEach((timerId, bubbleId) => {
      if (!activeIds.has(bubbleId)) {
        window.clearTimeout(timerId);
        bubbleDismissTimersRef.current.delete(bubbleId);
      }
    });
  }, [bubbles]);

  useEffect(() => {
    bubbles.forEach((bubble) => {
      if (!bubble.autoDismissAt || bubbleDismissTimersRef.current.has(bubble.id)) {
        return;
      }

      const remainingMs = Math.max(0, bubble.autoDismissAt - Date.now());
      const timerId = window.setTimeout(() => {
        bubbleDismissTimersRef.current.delete(bubble.id);
        setBubbles((current) => current.filter((currentBubble) => currentBubble.id !== bubble.id));
        setDetailBubbleId((current) => (current === bubble.id ? null : current));
      }, remainingMs);

      bubbleDismissTimersRef.current.set(bubble.id, timerId);
    });
  }, [bubbles]);

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
    const id = createId();
    const workspaceKey = options?.workspaceKey || currentWorkspaceKey;
    const threadId = options?.threadId || currentThread?.id || workspaceThreads[0]?.id || createId();
    return {
      id,
      threadId,
      workspaceKey,
      interactionMode: options?.interactionMode || activeInteractionMode,
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

  const createAssistantBubble = useCallback(async (
    prompt: string,
    options?: {
      displayPrompt?: string;
      mode?: "compose" | "inspect";
      history?: AIConversationMessage[];
      threadId?: string;
      workspaceKey?: string;
      interactionMode?: AIWorkspaceInteractionMode;
    }
  ) => {
    const normalizedPrompt = prompt.trim();
    if (!normalizedPrompt) return;

    setError(null);
    const targetWorkspaceKey = options?.workspaceKey || currentWorkspaceKey;
    const targetThreadId = options?.threadId || currentThread?.id || workspaceThreads[0]?.id || createId();
    const interactionMode = options?.interactionMode || activeInteractionMode;
    const loadingBubble = buildLoadingBubble(normalizedPrompt, {
      mode: options?.mode,
      promptSummary: options?.displayPrompt?.trim() || summarizePromptForDisplay(normalizedPrompt),
      threadId: targetThreadId,
      workspaceKey: targetWorkspaceKey,
      interactionMode,
    });
    setBubbles((current) => [...current, loadingBubble]);
    setChatThreads((current) =>
      current.map((thread, index) =>
        thread.id === targetThreadId && thread.isAutoLabel
          ? {
              ...thread,
              label: buildThreadLabel(loadingBubble.promptSummary || normalizedPrompt, index + 1),
              isAutoLabel: false,
            }
          : thread
      )
    );

    try {
      const result = await generateAssist(normalizedPrompt, options?.history, { interactionMode });
      setBubbles((current) =>
        current.map((bubble) =>
          bubble.id === loadingBubble.id
            ? {
                ...bubble,
                status: "ready",
                title: options?.mode === "inspect" ? aiCopy.bubbleStates.readyInspectTitle : result.sql ? aiCopy.bubbleStates.readySqlTitle : aiCopy.bubbleStates.readyNoteTitle,
                subtitle: options?.mode === "inspect"
                  ? result.sql
                    ? aiCopy.bubbleStates.readyInspectSqlSubtitle
                    : aiCopy.bubbleStates.readyInspectNoteSubtitle
                  : result.sql
                    ? result.risk?.level === "safe" ? aiCopy.bubbleStates.readySqlSafeSubtitle : aiCopy.bubbleStates.readySqlReviewSubtitle
                    : aiCopy.bubbleStates.readyNoteSubtitle,
                promptSummary: loadingBubble.promptSummary,
                preview: summarizeResponse(result.rawResponse, result.sql),
                detail: result.rawResponse,
                sql: result.sql || undefined,
                risk: result.risk,
              }
            : bubble
        )
      );
      return { bubbleId: loadingBubble.id, success: true };
    } catch (errorValue) {
      const message = errorValue instanceof Error ? errorValue.message : String(errorValue);
      setBubbles((current) =>
        current
          .filter((bubble) =>
            bubble.id === loadingBubble.id ||
            !(
              bubble.kind === "error" &&
              bubble.title === aiCopy.bubbleStates.errorTitle &&
              bubble.subtitle === aiCopy.bubbleStates.errorSubtitle
            )
          )
          .map((bubble) =>
            bubble.id === loadingBubble.id
              ? {
                  ...bubble,
                  kind: "error",
                  status: "error",
                  title: aiCopy.bubbleStates.errorTitle,
                  subtitle: aiCopy.bubbleStates.errorSubtitle,
                  preview: message,
                  detail: message,
                  sql: undefined,
                  risk: undefined,
                autoDismissAt: Date.now() + ERROR_BUBBLE_AUTO_DISMISS_MS,
              }
              : bubble
          )
      );
      return { bubbleId: loadingBubble.id, success: false };
    }
  }, [activeInteractionMode, aiCopy, buildLoadingBubble, currentThread, currentWorkspaceKey, generateAssist, setError, workspaceThreads]);

  const handleGenerate = useCallback(async () => {
    const normalizedPrompt = promptDraft.trim();
    const promptWithSelection = buildPromptWithSelection(normalizedPrompt, attachedSelection);
    if (!promptWithSelection.trim()) return;

    const displayPrompt = normalizedPrompt || (
      attachedSelection
        ? `${aiCopy.composer.selectionReady} · ${attachedSelection.source}`
        : promptWithSelection
    );

    const result = await createAssistantBubble(promptWithSelection, {
      mode: "compose",
      displayPrompt,
      history: historyMessages,
      threadId: currentThread?.id,
      interactionMode: activeInteractionMode,
    });

    if (result?.success) {
      setPromptDraft("");
      setAttachedSelection(null);
    }
  }, [activeInteractionMode, aiCopy.composer.selectionReady, attachedSelection, createAssistantBubble, currentThread?.id, historyMessages, promptDraft]);

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

  const handleRunBubble = useCallback(async (bubble: AIWorkspaceBubbleData) => {
    if (!bubble.sql || !aiModeAllowsRun(bubble.interactionMode)) return;
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
                detail: `${result.summary}\n\nQuery:\n${result.queryResult.query}`,
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
  }, [aiCopy, runSql]);

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
  if (!isOpen) return null;

  return (
    <div className="ai-workspace-overlay">
      {error && (
        <div className="ai-workspace-alert">
          <span>{error}</span>
          <button type="button" className="ai-workspace-alert-dismiss" onClick={() => setError(null)}>
            {aiCopy.composer.alertDismiss}
          </button>
        </div>
      )}

      <div className="ai-workspace-stage ai-workspace-stage--sidebar">
        {isInspectMode && selectionContext?.rect && (
          <>
            <div
              className="ai-workspace-selection-highlight"
              style={{
                left: selectionContext.rect.x,
                top: selectionContext.rect.y,
                width: selectionContext.rect.width,
                height: selectionContext.rect.height,
              }}
            />
            <div
              className="ai-workspace-selection-badge"
              style={{
                left: selectionContext.rect.x + 8,
                top: Math.max(12, selectionContext.rect.y - 30),
              }}
            >
              <Target className="w-3 h-3" />
              <span>{aiCopy.composer.selectionReady}</span>
            </div>
          </>
        )}

        <aside className={`ai-workspace-sidebar ${isLongformComposer ? "is-longform" : ""}`}>
          <div
            ref={composerRef}
            className={`ai-workspace-composer is-docked ${isLongformComposer ? "is-longform" : ""} ${activeInteractionMode === "agent" ? "is-agent" : ""}`}
          >
            <div className="ai-workspace-composer-header">
              <div className="ai-workspace-composer-brand">
                <div className="ai-workspace-composer-icon">
                  <Sparkles className="w-4 h-4" />
                </div>
                <div className="ai-workspace-composer-copy">
                  <span className="ai-workspace-composer-kicker">{aiCopy.composer.kicker}</span>
                  <strong className="ai-workspace-composer-title">{aiCopy.composer.title}</strong>
                </div>
              </div>
              <div className="ai-workspace-composer-head-actions">
                <button
                  type="button"
                  className={`ai-workspace-composer-head-btn ${isInspectMode ? "is-active" : ""}`}
                  onClick={() => setIsInspectMode((current) => !current)}
                  title={isInspectMode ? aiCopy.composer.inspectOnTitle : aiCopy.composer.inspectOffTitle}
                >
                  <Target className="w-3.5 h-3.5" />
                </button>
                <button type="button" className="ai-workspace-composer-head-btn" onClick={handleResetStage}>
                  <RotateCcw className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  className="ai-workspace-composer-head-btn"
                  onClick={() => {
                    setIsInspectMode(false);
                    onClose();
                  }}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            <div className="ai-workspace-composer-body">
              <div className="ai-workspace-composer-toolbar">
                <div className="ai-workspace-chat-tabs" role="tablist" aria-label="AI chat threads">
                  <div className="ai-workspace-chat-tabs-list">
                    {workspaceThreads.map((thread) => (
                      <button
                        key={thread.id}
                        type="button"
                        role="tab"
                        aria-selected={thread.id === currentThread?.id}
                        className={`ai-workspace-chat-tab ${thread.id === currentThread?.id ? "is-active" : ""}`}
                        onClick={() => {
                          setActiveThreadId(thread.id);
                          setAttachedSelection(null);
                          setDetailBubbleId(null);
                        }}
                      >
                        {thread.label}
                      </button>
                    ))}
                  </div>
                  <button type="button" className="ai-workspace-chat-tab-add" onClick={handleCreateChatThread}>
                    +
                  </button>
                </div>

                <div className="ai-workspace-composer-context">
                  <span className="ai-workspace-composer-context-pill">
                    <Database className="w-3.5 h-3.5" />
                    {currentDatabase || aiCopy.composer.noDatabaseSelected}
                  </span>
                  <span className="ai-workspace-composer-context-pill">
                    <Wand2 className="w-3.5 h-3.5" />
                    {activeProvider?.name || aiCopy.composer.noProvider}
                  </span>
                  <span className="ai-workspace-composer-context-pill">
                    {tableContextCount} {tableContextCount === 1 ? aiCopy.composer.tableOne : aiCopy.composer.tableOther}
                  </span>
                </div>

                <div className="ai-workspace-composer-controls">
                  <div className="ai-workspace-mode-picker" role="tablist" aria-label={aiCopy.composer.title}>
                    {(["prompt", "edit", "agent"] as AIWorkspaceInteractionMode[]).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        role="tab"
                        aria-selected={mode === activeInteractionMode}
                        className={`ai-workspace-mode-option ${mode === activeInteractionMode ? "is-active" : ""}`}
                        onClick={() =>
                          setWorkspaceInteractionModes((current) => ({
                            ...current,
                            [currentWorkspaceKey]: mode,
                          }))
                        }
                        title={getInteractionModeLabel(mode, aiCopy)}
                      >
                        {getInteractionModeLabel(mode, aiCopy)}
                      </button>
                    ))}
                  </div>

                  {shouldShowModeInline && (
                    <div className={`ai-workspace-mode-inline ${modePanelState}`}>
                      <strong className="ai-workspace-mode-inline-text">
                        {activeInteractionMode === "agent" && !isSchemaModeBlocked ? agentStatusText : composerModeHint}
                      </strong>

                      {isSchemaModeBlocked && (
                        <div className="ai-workspace-mode-actions">
                          <button
                            type="button"
                            className="ai-workspace-mode-action-btn primary"
                            onClick={() => window.dispatchEvent(new CustomEvent("open-ai-settings"))}
                          >
                            {aiCopy.composer.openSettings}
                          </button>
                          <button
                            type="button"
                            className="ai-workspace-mode-action-btn"
                            onClick={() =>
                              setWorkspaceInteractionModes((current) => ({
                                ...current,
                                [currentWorkspaceKey]: "prompt",
                              }))
                            }
                          >
                            {aiCopy.composer.switchToPrompt}
                          </button>
                        </div>
                      )}

                      {shouldShowAgentActions && latestConversationBubble && (
                        <div className="ai-workspace-mode-actions">
                          <button
                            type="button"
                            className="ai-workspace-mode-action-btn"
                            onClick={() => setDetailBubbleId(latestConversationBubble.id)}
                          >
                            {aiCopy.bubbleActions.detail}
                          </button>
                          {latestConversationBubble.sql && aiModeAllowsInsert(latestConversationBubble.interactionMode) && (
                            <button
                              type="button"
                              className="ai-workspace-mode-action-btn"
                              onClick={() => handleInsertBubble(latestConversationBubble)}
                            >
                              {aiCopy.bubbleActions.insert}
                            </button>
                          )}
                          {latestConversationBubble.sql &&
                            latestConversationBubble.kind !== "result" &&
                            aiModeAllowsRun(latestConversationBubble.interactionMode) && (
                              <button
                                type="button"
                                className="ai-workspace-mode-action-btn primary"
                                onClick={() => void handleRunBubble(latestConversationBubble)}
                              >
                                {aiCopy.bubbleActions.approveRun}
                              </button>
                            )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              <div className="ai-workspace-chat-shell">
                <div className={`ai-workspace-chat-surface ${hasConversation ? "" : "is-empty"}`}>
                  {hasConversation ? (
                    <div ref={chatThreadRef} className="ai-workspace-chat-thread">
                      {conversationBubbles.map((bubble) => {
                        const conversationText = getBubbleConversationText(bubble);
                        return (
                          <article key={`chat-${bubble.id}`} className="ai-workspace-chat-turn">
                            <div className="ai-workspace-chat-turn-header">
                              <strong className="ai-workspace-chat-turn-label">{aiCopy.modal.originalRequest}</strong>
                            </div>
                            <div className="ai-workspace-chat-message ai-workspace-chat-message--user">
                              <p className="ai-workspace-chat-text">
                                {bubble.promptSummary || summarizePromptForDisplay(bubble.prompt)}
                              </p>
                            </div>
                            <div className="ai-workspace-chat-turn-header ai-workspace-chat-turn-header--assistant">
                              <strong className="ai-workspace-chat-turn-label">{aiCopy.modal.assistantExplanation}</strong>
                              <span className="ai-workspace-chat-state">
                                {bubble.status === "loading"
                                  ? aiCopy.bubbleMeta.thinking
                                  : bubble.sql
                                    ? aiCopy.modal.sql
                                    : aiCopy.bubbleMeta.ready}
                              </span>
                            </div>
                            <div className="ai-workspace-chat-message ai-workspace-chat-message--assistant">
                              {bubble.subtitle && bubble.subtitle !== bubble.title && (
                                <p className="ai-workspace-chat-subtitle">{bubble.subtitle}</p>
                              )}
                              {conversationText && <AIWorkspaceMarkdown className="ai-workspace-chat-text" text={conversationText} />}
                              {bubble.sql && bubble.status !== "error" && (
                                <pre className="ai-workspace-chat-code">{bubble.sql}</pre>
                              )}
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
            </div>

              <div className="ai-workspace-compose-dock">
                {attachedSelection && (
                  <div className="ai-workspace-selection-chip">
                    <div className="ai-workspace-selection-chip-copy">
                      <span className="ai-workspace-selection-chip-kicker">{aiCopy.composer.selectionReady}</span>
                      <strong className="ai-workspace-selection-chip-title">{attachedSelection.source}</strong>
                    </div>
                    <button type="button" className="ai-workspace-selection-chip-dismiss" onClick={() => setAttachedSelection(null)}>
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}

                <div className="ai-workspace-compose-box">
                  <textarea
                    ref={composerTextareaRef}
                    value={promptDraft}
                    onChange={(event) => setPromptDraft(event.target.value)}
                    onKeyDown={handleComposerKeyDown}
                    className="ai-workspace-composer-textarea"
                    placeholder={aiCopy.composer.placeholder}
                  />

                  <div className={`ai-workspace-composer-footer ${composerFooterNote ? "" : "is-note-hidden"}`}>
                    {composerFooterNote ? (
                      <div className="ai-workspace-composer-note">{composerFooterNote}</div>
                    ) : (
                      <div className="ai-workspace-composer-note-spacer" aria-hidden="true" />
                    )}
                    <button
                      type="button"
                      className="ai-workspace-generate-btn"
                      onClick={() => void handleGenerate()}
                      disabled={isGenerating || (!promptDraft.trim() && !attachedSelection?.text.trim())}
                    >
                      {isGenerating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                      {isGenerating ? aiCopy.composer.generating : aiCopy.composer.generateBubble}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </aside>
      </div>

      {detailBubble && (
        <AIBubbleDetailModal
          bubble={detailBubble}
          isGenerating={isGenerating}
          isRunning={isRunning}
          onClose={() => setDetailBubbleId(null)}
          onCopy={(bubble) => void handleCopyBubble(bubble)}
          onInsert={handleInsertBubble}
          onRun={(bubble) => void handleRunBubble(bubble)}
          onRewrite={(bubble, note) => void handleRewriteBubble(bubble, note)}
        />
      )}
    </div>
  );
}
