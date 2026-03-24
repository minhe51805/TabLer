import { Bot, Database, Loader2, RotateCcw, Sparkles, Target, Wand2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useI18n } from "../../i18n";
import type { AIConversationMessage } from "../../types";
import { AIWorkspaceBubble } from "./AIWorkspaceBubble";
import { AIBubbleDetailModal } from "./AIBubbleDetailModal";
import { useAISlidePanel } from "./hooks/use-ai-slide-panel";
import type { AIWorkspaceBubbleData } from "./ai-workspace-types";
import { getAIWorkspaceCopy } from "./ai-workspace-copy";

interface Props {
  isOpen: boolean;
  initialPrompt?: string;
  initialPromptNonce?: number;
  onClose: () => void;
}

const DEFAULT_COMPOSER_SIZE = { width: 360, height: 430 };
const DEFAULT_BUBBLE_SIZE = { width: 312, height: 224 };
const ORB_SIZE = 68;
const STAGE_PADDING = 24;
const ERROR_BUBBLE_AUTO_DISMISS_MS = 9000;
const MAX_HISTORY_BUBBLES = 4;
const MAX_HISTORY_MESSAGE_CHARS = 1000;

interface AIChatThread {
  id: string;
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

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
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

function createChatThread(index: number): AIChatThread {
  return {
    id: createId(),
    label: `#${index}`,
    createdAt: Date.now(),
    isAutoLabel: true,
  };
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

function getComposerDefaultPosition() {
  if (typeof window === "undefined") return { x: 36, y: 220 };
  const width = window.innerWidth;
  const defaultX = Math.max(18, width - ORB_SIZE - 26);
  return {
    x: width < 900 ? 16 : defaultX,
    y: width < 900 ? 82 : 86,
  };
}

function getComposerPanelPosition(
  anchor: { x: number; y: number },
  workspace: HTMLDivElement | null
) {
  const { width, height } = getStageSize(workspace);
  const preferredX = anchor.x - DEFAULT_COMPOSER_SIZE.width + ORB_SIZE;
  const fallbackX = anchor.x + ORB_SIZE + 14;
  const nextX = preferredX < STAGE_PADDING ? fallbackX : preferredX;
  return {
    x: clamp(nextX, STAGE_PADDING, Math.max(STAGE_PADDING, width - DEFAULT_COMPOSER_SIZE.width - STAGE_PADDING)),
    y: clamp(anchor.y + ORB_SIZE + 14, 74, Math.max(74, height - DEFAULT_COMPOSER_SIZE.height - STAGE_PADDING)),
  };
}

function getStageSize(workspace: HTMLDivElement | null) {
  if (workspace) {
    const rect = workspace.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  }
  if (typeof window === "undefined") return { width: 1440, height: 860 };
  return { width: window.innerWidth, height: window.innerHeight };
}

function getNextBubblePosition(
  workspace: HTMLDivElement | null,
  existingCount: number,
  anchorPosition?: { x: number; y: number }
) {
  const { width, height } = getStageSize(workspace);
  const baseX = anchorPosition
    ? anchorPosition.x - DEFAULT_BUBBLE_SIZE.width - 28
    : clamp(Math.max(520, width * 0.37), 460, Math.max(520, width - 420));
  const fallbackX = anchorPosition
    ? anchorPosition.x + 36
    : baseX;
  const nextX = baseX < STAGE_PADDING ? fallbackX : baseX;
  const nextY = anchorPosition ? anchorPosition.y + existingCount * 36 : 106 + existingCount * 52;
  return {
    x: clamp(nextX, STAGE_PADDING, Math.max(STAGE_PADDING, width - DEFAULT_BUBBLE_SIZE.width - STAGE_PADDING)),
    y: clamp(nextY, 76, Math.max(76, height - DEFAULT_BUBBLE_SIZE.height - STAGE_PADDING)),
  };
}

function getPointerTone(bubble: AIWorkspaceBubbleData) {
  if (bubble.kind === "result") return "success";
  if (bubble.kind === "error" || bubble.status === "error") return "danger";
  if (bubble.risk?.level === "dangerous") return "danger";
  if (bubble.risk?.level === "review") return "warning";
  return "accent";
}

function getArrowHeadPoints(fromX: number, fromY: number, toX: number, toY: number) {
  const angle = Math.atan2(toY - fromY, toX - fromX);
  const length = 12;
  const spread = Math.PI / 7;
  const leftX = toX - length * Math.cos(angle - spread);
  const leftY = toY - length * Math.sin(angle - spread);
  const rightX = toX - length * Math.cos(angle + spread);
  const rightY = toY - length * Math.sin(angle + spread);
  return `${toX},${toY} ${leftX},${leftY} ${rightX},${rightY}`;
}

function getPointerPath(bubble: AIWorkspaceBubbleData, size: { width: number; height: number }) {
  const target = bubble.pointer;
  const centerX = bubble.x + size.width / 2;
  const centerY = bubble.y + size.height / 2;
  const dx = target.x - centerX;
  const dy = target.y - centerY;

  let startX = centerX;
  let startY = centerY;
  if (Math.abs(dx) > Math.abs(dy)) {
    startX = dx >= 0 ? bubble.x + size.width : bubble.x;
    startY = clamp(target.y, bubble.y + 28, bubble.y + size.height - 28);
  } else {
    startX = clamp(target.x, bubble.x + 28, bubble.x + size.width - 28);
    startY = dy >= 0 ? bubble.y + size.height : bubble.y;
  }

  const midX = (startX + target.x) / 2;
  const midY = (startY + target.y) / 2;
  const controlX = Math.abs(dx) > Math.abs(dy) ? midX : midX + (dx >= 0 ? 32 : -32);
  const controlY = Math.abs(dx) > Math.abs(dy) ? midY + (dy >= 0 ? 32 : -32) : midY;

  return {
    path: `M ${startX} ${startY} Q ${controlX} ${controlY} ${target.x} ${target.y}`,
    arrowHead: getArrowHeadPoints(controlX, controlY, target.x, target.y),
    startX,
    startY,
  };
}

type DragState =
  | { type: "orb"; offsetX: number; offsetY: number }
  | { type: "composerPanel"; offsetX: number; offsetY: number }
  | { type: "bubble"; bubbleId: string; offsetX: number; offsetY: number }
  | { type: "pointer"; bubbleId: string };

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

  const workspaceRef = useRef<HTMLDivElement>(null);
  const orbRef = useRef<HTMLButtonElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement>(null);
  const chatThreadRef = useRef<HTMLDivElement>(null);
  const dragStateRef = useRef<DragState | null>(null);
  const dragMovedRef = useRef(false);
  const orbClickTimerRef = useRef<number | null>(null);
  const bubbleObserversRef = useRef(new Map<string, ResizeObserver>());
  const bubbleRefCallbacksRef = useRef(new Map<string, (node: HTMLDivElement | null) => void>());
  const bubbleDismissTimersRef = useRef(new Map<string, number>());
  const initialThreadRef = useRef<AIChatThread | null>(null);
  if (!initialThreadRef.current) {
    initialThreadRef.current = createChatThread(1);
  }

  const [promptDraft, setPromptDraft] = useState(initialPrompt);
  const [composerPosition, setComposerPosition] = useState(getComposerDefaultPosition);
  const [bubbles, setBubbles] = useState<AIWorkspaceBubbleData[]>([]);
  const [chatThreads, setChatThreads] = useState<AIChatThread[]>(() => [initialThreadRef.current!]);
  const [activeThreadId, setActiveThreadId] = useState<string>(() => initialThreadRef.current!.id);
  const [bubbleSizes, setBubbleSizes] = useState<Record<string, { width: number; height: number }>>({});
  const [detailBubbleId, setDetailBubbleId] = useState<string | null>(null);
  const [isComposerExpanded, setIsComposerExpanded] = useState(Boolean(initialPrompt.trim()));
  const [isInspectMode, setIsInspectMode] = useState(false);
  const [selectionContext, setSelectionContext] = useState<SelectionContextState | null>(null);
  const [attachedSelection, setAttachedSelection] = useState<SelectionContextState | null>(null);

  const detailBubble = useMemo(
    () => bubbles.find((bubble) => bubble.id === detailBubbleId) ?? null,
    [bubbles, detailBubbleId]
  );
  const composerPanelPosition = useMemo(
    () => getComposerPanelPosition(composerPosition, workspaceRef.current),
    [composerPosition]
  );
  const currentThread = useMemo(
    () => chatThreads.find((thread) => thread.id === activeThreadId) ?? chatThreads[0] ?? null,
    [activeThreadId, chatThreads]
  );
  const stageBubbles = useMemo(
    () => (isComposerExpanded || !currentThread ? [] : bubbles.filter((bubble) => bubble.threadId === currentThread.id)),
    [bubbles, currentThread, isComposerExpanded]
  );
  const activeThreadBubbles = useMemo(
    () => (!currentThread ? [] : bubbles.filter((bubble) => bubble.threadId === currentThread.id)),
    [bubbles, currentThread]
  );
  const historyMessages = useMemo(
    () => buildConversationHistoryMessages(activeThreadBubbles),
    [activeThreadBubbles]
  );
  const conversationBubbles = useMemo(
    () => [...activeThreadBubbles].sort((left, right) => left.createdAt - right.createdAt).slice(-4),
    [activeThreadBubbles]
  );

  useEffect(() => {
    if (!isOpen || !isComposerExpanded) return;
    window.requestAnimationFrame(() => {
      composerTextareaRef.current?.focus();
    });
  }, [isComposerExpanded, isOpen]);

  useEffect(() => {
    if (!isComposerExpanded) return;
    window.requestAnimationFrame(() => {
      const thread = chatThreadRef.current;
      if (!thread) return;
      thread.scrollTop = thread.scrollHeight;
    });
  }, [conversationBubbles, isComposerExpanded]);

  useEffect(() => {
    if (!chatThreads.some((thread) => thread.id === activeThreadId)) {
      setActiveThreadId(chatThreads[0]?.id ?? "");
    }
  }, [activeThreadId, chatThreads]);

  useEffect(() => {
    if (!initialPromptNonce) return;
    setPromptDraft(initialPrompt);
    setError(null);
    setIsComposerExpanded(true);
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
  }, [isOpen]);

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
      if (orbClickTimerRef.current !== null) {
        window.clearTimeout(orbClickTimerRef.current);
        orbClickTimerRef.current = null;
      }
      bubbleObserversRef.current.forEach((observer) => observer.disconnect());
      bubbleObserversRef.current.clear();
      bubbleRefCallbacksRef.current.clear();
      bubbleDismissTimersRef.current.forEach((timerId) => window.clearTimeout(timerId));
      bubbleDismissTimersRef.current.clear();
    };
  }, []);

  useEffect(() => {
    const activeIds = new Set(bubbles.map((bubble) => bubble.id));
    bubbleRefCallbacksRef.current.forEach((_, bubbleId) => {
      if (!activeIds.has(bubbleId)) {
        bubbleRefCallbacksRef.current.delete(bubbleId);
      }
    });
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

  useEffect(() => {
    const handleMove = (event: MouseEvent) => {
      const dragState = dragStateRef.current;
      if (!dragState) return;
      dragMovedRef.current = true;

      const workspace = workspaceRef.current;
      if (!workspace) return;
      const rect = workspace.getBoundingClientRect();

      if (dragState.type === "orb") {
        setComposerPosition({
          x: clamp(event.clientX - rect.left - dragState.offsetX, STAGE_PADDING, Math.max(STAGE_PADDING, rect.width - ORB_SIZE - STAGE_PADDING)),
          y: clamp(event.clientY - rect.top - dragState.offsetY, STAGE_PADDING, Math.max(STAGE_PADDING, rect.height - ORB_SIZE - STAGE_PADDING)),
        });
        return;
      }

      if (dragState.type === "composerPanel") {
        const width = composerRef.current?.offsetWidth ?? DEFAULT_COMPOSER_SIZE.width;
        const height = composerRef.current?.offsetHeight ?? DEFAULT_COMPOSER_SIZE.height;
        const nextPanelX = clamp(
          event.clientX - rect.left - dragState.offsetX,
          STAGE_PADDING,
          Math.max(STAGE_PADDING, rect.width - width - STAGE_PADDING)
        );
        const nextPanelY = clamp(
          event.clientY - rect.top - dragState.offsetY,
          STAGE_PADDING,
          Math.max(STAGE_PADDING, rect.height - height - STAGE_PADDING)
        );
        setComposerPosition({
          x: clamp(nextPanelX + width - ORB_SIZE, STAGE_PADDING, Math.max(STAGE_PADDING, rect.width - ORB_SIZE - STAGE_PADDING)),
          y: clamp(nextPanelY - ORB_SIZE - 14, STAGE_PADDING, Math.max(STAGE_PADDING, rect.height - ORB_SIZE - STAGE_PADDING)),
        });
        return;
      }

      if (dragState.type === "bubble") {
        const size = bubbleSizes[dragState.bubbleId] ?? DEFAULT_BUBBLE_SIZE;
        setBubbles((current) =>
          current.map((bubble) =>
            bubble.id === dragState.bubbleId
              ? {
                  ...bubble,
                  x: clamp(event.clientX - rect.left - dragState.offsetX, STAGE_PADDING, Math.max(STAGE_PADDING, rect.width - size.width - STAGE_PADDING)),
                  y: clamp(event.clientY - rect.top - dragState.offsetY, STAGE_PADDING, Math.max(STAGE_PADDING, rect.height - size.height - STAGE_PADDING)),
                }
              : bubble
          )
        );
        return;
      }

      setBubbles((current) =>
        current.map((bubble) =>
          bubble.id === dragState.bubbleId
            ? {
                ...bubble,
                pointer: {
                  visible: true,
                  x: clamp(event.clientX - rect.left, STAGE_PADDING, rect.width - STAGE_PADDING),
                  y: clamp(event.clientY - rect.top, STAGE_PADDING, rect.height - STAGE_PADDING),
                },
              }
            : bubble
        )
      );
    };

    const handleUp = () => {
      dragStateRef.current = null;
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };

    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, [bubbleSizes]);

  const bindBubbleNode = useCallback((bubbleId: string, node: HTMLDivElement | null) => {
    const existingObserver = bubbleObserversRef.current.get(bubbleId);
    existingObserver?.disconnect();
    bubbleObserversRef.current.delete(bubbleId);

    if (!node) {
      setBubbleSizes((current) => {
        const next = { ...current };
        delete next[bubbleId];
        return next;
      });
      return;
    }

    const measureNode = () => {
      const nextSize = {
        width: node.offsetWidth || DEFAULT_BUBBLE_SIZE.width,
        height: node.offsetHeight || DEFAULT_BUBBLE_SIZE.height,
      };
      setBubbleSizes((current) => {
        const previous = current[bubbleId];
        if (previous && previous.width === nextSize.width && previous.height === nextSize.height) {
          return current;
        }
        return { ...current, [bubbleId]: nextSize };
      });
    };

    measureNode();
    if (typeof ResizeObserver === "undefined") {
      return;
    }

    let observer: ResizeObserver | null = null;
    try {
      observer = new ResizeObserver(measureNode);
      observer.observe(node);
    } catch {
      return;
    }

    if (!observer) {
      return;
    }
    bubbleObserversRef.current.set(bubbleId, observer);
  }, []);

  const getBubbleRefCallback = useCallback((bubbleId: string) => {
    const existingCallback = bubbleRefCallbacksRef.current.get(bubbleId);
    if (existingCallback) {
      return existingCallback;
    }

    const callback = (node: HTMLDivElement | null) => {
      bindBubbleNode(bubbleId, node);
    };
    bubbleRefCallbacksRef.current.set(bubbleId, callback);
    return callback;
  }, [bindBubbleNode]);

  const startDrag = useCallback((state: DragState) => {
    dragStateRef.current = state;
    dragMovedRef.current = false;
    document.body.style.userSelect = "none";
    document.body.style.cursor = state.type === "pointer" ? "crosshair" : "grabbing";
  }, []);

  const handleOrbDragStart = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const rect = workspace.getBoundingClientRect();
    startDrag({
      type: "orb",
      offsetX: event.clientX - rect.left - composerPosition.x,
      offsetY: event.clientY - rect.top - composerPosition.y,
    });
  }, [composerPosition.x, composerPosition.y, startDrag]);

  const handleComposerPanelDragStart = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const rect = workspace.getBoundingClientRect();
    startDrag({
      type: "composerPanel",
      offsetX: event.clientX - rect.left - composerPanelPosition.x,
      offsetY: event.clientY - rect.top - composerPanelPosition.y,
    });
  }, [composerPanelPosition.x, composerPanelPosition.y, startDrag]);

  const handleBubbleDragStart = useCallback((bubbleId: string, event: ReactMouseEvent<HTMLDivElement>) => {
    const workspace = workspaceRef.current;
    const bubble = bubbles.find((item) => item.id === bubbleId);
    if (!workspace || !bubble) return;
    const rect = workspace.getBoundingClientRect();
    startDrag({
      type: "bubble",
      bubbleId,
      offsetX: event.clientX - rect.left - bubble.x,
      offsetY: event.clientY - rect.top - bubble.y,
    });
  }, [bubbles, startDrag]);

  const handlePointerDragStart = useCallback((bubbleId: string, event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    event.preventDefault();
    startDrag({ type: "pointer", bubbleId });
  }, [startDrag]);

  const resetPointer = useCallback((bubbleId: string) => {
    setBubbles((current) =>
      current.map((bubble) => (bubble.id === bubbleId ? { ...bubble, pointer: { ...bubble.pointer, visible: false } } : bubble))
    );
  }, []);

  const buildLoadingBubble = useCallback((
    prompt: string,
    options?: {
      mode?: "compose" | "inspect";
      promptSummary?: string;
      threadId?: string;
    }
  ): AIWorkspaceBubbleData => {
    const id = createId();
    const threadId = options?.threadId || currentThread?.id || chatThreads[0]?.id || createId();
    const threadBubbleCount = bubbles.filter((bubble) => bubble.threadId === threadId).length;
    const position = getNextBubblePosition(workspaceRef.current, threadBubbleCount, composerPosition);
    return {
      id,
      threadId,
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
      x: position.x,
      y: position.y,
      pointer: {
        visible: false,
        x: position.x + DEFAULT_BUBBLE_SIZE.width + 52,
        y: position.y + 72,
      },
      createdAt: Date.now(),
    };
  }, [activeProvider?.name, aiCopy, bubbles, chatThreads, composerPosition, currentThread]);

  const createAssistantBubble = useCallback(async (
    prompt: string,
    options?: {
      displayPrompt?: string;
      mode?: "compose" | "inspect";
      history?: AIConversationMessage[];
      threadId?: string;
    }
  ) => {
    const normalizedPrompt = prompt.trim();
    if (!normalizedPrompt) return;

    setError(null);
    const targetThreadId = options?.threadId || currentThread?.id || chatThreads[0]?.id || createId();
    const loadingBubble = buildLoadingBubble(normalizedPrompt, {
      mode: options?.mode,
      promptSummary: options?.displayPrompt?.trim() || summarizePromptForDisplay(normalizedPrompt),
      threadId: targetThreadId,
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
      const result = await generateAssist(normalizedPrompt, options?.history);
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
  }, [aiCopy, buildLoadingBubble, chatThreads, currentThread, generateAssist, setError]);

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
    });

    if (result?.success) {
      setPromptDraft("");
      setAttachedSelection(null);
    }
  }, [aiCopy.composer.selectionReady, attachedSelection, createAssistantBubble, currentThread?.id, historyMessages, promptDraft]);

  const handleAskFromSelection = useCallback(async () => {
    if (!selectionContext?.text.trim()) {
      setError(aiCopy.bubbleStates.selectSomethingError);
      return;
    }
    setAttachedSelection(selectionContext);
    setIsComposerExpanded(true);
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

  const handleUseSuggestion = useCallback((prompt: string) => {
    setPromptDraft(prompt);
    setError(null);
    window.requestAnimationFrame(() => {
      composerTextareaRef.current?.focus();
      composerTextareaRef.current?.setSelectionRange(prompt.length, prompt.length);
    });
  }, [setError]);

  const handleCopyBubble = useCallback(async (bubble: AIWorkspaceBubbleData) => {
    const text = bubble.sql || bubble.detail || bubble.preview;
    await copyText(text);
  }, [copyText]);

  const handleDismissBubble = useCallback((bubbleId: string) => {
    const observer = bubbleObserversRef.current.get(bubbleId);
    observer?.disconnect();
    bubbleObserversRef.current.delete(bubbleId);
    bubbleRefCallbacksRef.current.delete(bubbleId);

    const timerId = bubbleDismissTimersRef.current.get(bubbleId);
    if (timerId !== undefined) {
      window.clearTimeout(timerId);
      bubbleDismissTimersRef.current.delete(bubbleId);
    }

    setBubbleSizes((current) => {
      if (!(bubbleId in current)) {
        return current;
      }
      const next = { ...current };
      delete next[bubbleId];
      return next;
    });
    setBubbles((current) => current.filter((bubble) => bubble.id !== bubbleId));
    setDetailBubbleId((current) => (current === bubbleId ? null : current));
  }, []);

  const handleInsertBubble = useCallback((bubble: AIWorkspaceBubbleData) => {
    if (!bubble.sql) return;
    insertSql(bubble.sql, bubble.risk);
  }, [insertSql]);

  const handleRunBubble = useCallback(async (bubble: AIWorkspaceBubbleData) => {
    if (!bubble.sql) return;
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
    });
    if (result?.success) {
      setActiveThreadId(bubble.threadId);
      setDetailBubbleId(null);
    }
  }, [bubbles, createAssistantBubble]);

  const handleCreateChatThread = useCallback(() => {
    const nextThread = createChatThread(chatThreads.length + 1);
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
  }, [chatThreads.length, initialPrompt, setError]);

  const handleResetStage = useCallback(() => {
    handleCreateChatThread();
  }, [handleCreateChatThread]);

  const pointerLines = useMemo(() => {
    return stageBubbles
      .filter((bubble) => bubble.pointer.visible)
      .map((bubble) => {
        const size = bubbleSizes[bubble.id] ?? DEFAULT_BUBBLE_SIZE;
        return {
          bubble,
          ...getPointerPath(bubble, size),
        };
      });
  }, [bubbleSizes, stageBubbles]);
  const inspectPointerLine = useMemo(() => {
    if (!isInspectMode || !selectionContext?.rect) return null;
    return getPointerPath(
      {
        id: "inspect-orb",
        threadId: currentThread?.id || "inspect-orb",
        kind: "assistant",
        status: "ready",
        title: "",
        subtitle: "",
        prompt: "",
        preview: "",
        detail: "",
        x: composerPosition.x,
        y: composerPosition.y,
        pointer: {
          visible: true,
          x: selectionContext.rect.x + selectionContext.rect.width / 2,
          y: selectionContext.rect.y + selectionContext.rect.height / 2,
        },
        createdAt: 0,
      },
      { width: ORB_SIZE, height: ORB_SIZE }
    );
  }, [composerPosition.x, composerPosition.y, isInspectMode, selectionContext]);

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

      <div ref={workspaceRef} className="ai-workspace-stage">
        <svg className="ai-workspace-pointer-layer" aria-hidden="true">
          {inspectPointerLine && (
            <g className="ai-workspace-pointer ai-workspace-pointer--accent ai-workspace-pointer--inspect">
              <path d={inspectPointerLine.path} className="ai-workspace-pointer-line" />
              <circle cx={inspectPointerLine.startX} cy={inspectPointerLine.startY} r="4.5" className="ai-workspace-pointer-origin" />
              <circle
                cx={(selectionContext?.rect?.x ?? 0) + (selectionContext?.rect?.width ?? 0) / 2}
                cy={(selectionContext?.rect?.y ?? 0) + (selectionContext?.rect?.height ?? 0) / 2}
                r="5"
                className="ai-workspace-pointer-target"
              />
              <polygon points={inspectPointerLine.arrowHead} className="ai-workspace-pointer-head" />
            </g>
          )}
          {pointerLines.map(({ bubble, path, arrowHead, startX, startY }) => {
            const tone = getPointerTone(bubble);
            return (
              <g key={`${bubble.id}-pointer`} className={`ai-workspace-pointer ai-workspace-pointer--${tone}`}>
                <path d={path} className="ai-workspace-pointer-line" />
                <circle cx={startX} cy={startY} r="4.5" className="ai-workspace-pointer-origin" />
                <circle cx={bubble.pointer.x} cy={bubble.pointer.y} r="5" className="ai-workspace-pointer-target" />
                <polygon points={arrowHead} className="ai-workspace-pointer-head" />
              </g>
            );
          })}
        </svg>

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

        <button
          ref={orbRef}
          type="button"
          className={`ai-workspace-orb ${isInspectMode ? "is-inspect" : ""} ${isComposerExpanded ? "is-expanded" : ""}`}
          style={{ transform: `translate3d(${composerPosition.x}px, ${composerPosition.y}px, 0)` }}
          onMouseDown={handleOrbDragStart}
          onClick={() => {
            if (dragMovedRef.current) {
              dragMovedRef.current = false;
              return;
            }
            if (orbClickTimerRef.current !== null) {
              window.clearTimeout(orbClickTimerRef.current);
            }
            orbClickTimerRef.current = window.setTimeout(() => {
              setIsComposerExpanded((current) => !current);
              orbClickTimerRef.current = null;
            }, 180);
          }}
          onDoubleClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (orbClickTimerRef.current !== null) {
              window.clearTimeout(orbClickTimerRef.current);
              orbClickTimerRef.current = null;
            }
            setIsInspectMode((current) => !current);
          }}
          title={isInspectMode ? aiCopy.composer.inspectOnTitle : aiCopy.composer.inspectOffTitle}
        >
          <span className="ai-workspace-orb-face">
            <Bot className="w-7 h-7" />
          </span>
          {isInspectMode && <span className="ai-workspace-orb-ring" />}
        </button>

        {isInspectMode && (
          <div
            className="ai-workspace-orb-hint"
            style={{ transform: `translate3d(${composerPosition.x - 112}px, ${composerPosition.y + 12}px, 0)` }}
          >
            <Target className="w-4 h-4" />
            <span>{selectionContext?.text ? aiCopy.composer.selectionReady : aiCopy.composer.inspectHint}</span>
          </div>
        )}

        {isComposerExpanded && (
          <div
            ref={composerRef}
            className="ai-workspace-composer"
            style={{ transform: `translate3d(${composerPanelPosition.x}px, ${composerPanelPosition.y}px, 0)` }}
          >
            <div className="ai-workspace-composer-header" onMouseDown={handleComposerPanelDragStart}>
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
                <button type="button" className="ai-workspace-composer-head-btn" onClick={handleResetStage}>
                  <RotateCcw className="w-3.5 h-3.5" />
                </button>
                <button type="button" className="ai-workspace-composer-head-btn" onClick={() => setIsComposerExpanded(false)}>
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            <div className="ai-workspace-composer-context">
              <div className="ai-workspace-chat-tabs" role="tablist" aria-label="AI chat threads">
                <div className="ai-workspace-chat-tabs-list">
                  {chatThreads.map((thread) => (
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
              <span className="ai-workspace-composer-context-pill">
                {activeProvider?.allow_schema_context ? aiCopy.composer.schemaShared : aiCopy.composer.promptOnly}
              </span>
            </div>

            {conversationBubbles.length > 0 && (
              <div className="ai-workspace-chat-shell">
                <div ref={chatThreadRef} className="ai-workspace-chat-thread">
                  {conversationBubbles.map((bubble) => {
                    const conversationText = getBubbleConversationText(bubble);
                    return (
                      <div key={`chat-${bubble.id}`} className="ai-workspace-chat-pair">
                        <div className="ai-workspace-chat-message ai-workspace-chat-message--user">
                          <span className="ai-workspace-chat-label">{aiCopy.modal.originalRequest}</span>
                          <p className="ai-workspace-chat-text">
                            {bubble.promptSummary || summarizePromptForDisplay(bubble.prompt)}
                          </p>
                        </div>
                        <div className="ai-workspace-chat-message ai-workspace-chat-message--assistant">
                          <div className="ai-workspace-chat-meta">
                            <span className="ai-workspace-chat-label">
                              {bubble.status === "loading" ? aiCopy.bubbleMeta.thinking : aiCopy.modal.assistantExplanation}
                            </span>
                            <span className="ai-workspace-chat-state">{bubble.title}</span>
                          </div>
                          {conversationText && <p className="ai-workspace-chat-text">{conversationText}</p>}
                          {bubble.sql && bubble.status !== "error" && (
                            <pre className="ai-workspace-chat-code">{bubble.sql}</pre>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

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

            <textarea
              ref={composerTextareaRef}
              value={promptDraft}
              onChange={(event) => setPromptDraft(event.target.value)}
              onKeyDown={handleComposerKeyDown}
              className="ai-workspace-composer-textarea"
              placeholder={aiCopy.composer.placeholder}
            />

            <div className="ai-workspace-composer-suggestions">
              {aiCopy.composer.promptIdeas.map((idea) => (
                <button
                  key={idea.title}
                  type="button"
                  className="ai-workspace-suggestion-chip"
                  onClick={() => handleUseSuggestion(idea.prompt)}
                >
                  {idea.title}
                </button>
              ))}
            </div>

            <div className="ai-workspace-composer-footer">
              <div className="ai-workspace-composer-note">
                {aiCopy.composer.note}
              </div>
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
        )}

        {stageBubbles.map((bubble) => (
          <AIWorkspaceBubble
            key={bubble.id}
            bubble={bubble}
            bubbleRef={getBubbleRefCallback(bubble.id)}
            compact={isComposerExpanded}
            isGenerating={isGenerating}
            isRunning={isRunning}
            onOpenDetail={(nextBubble) => setDetailBubbleId(nextBubble.id)}
            onStartDrag={handleBubbleDragStart}
            onStartPointerDrag={handlePointerDragStart}
            onResetPointer={resetPointer}
            onCopy={(nextBubble) => void handleCopyBubble(nextBubble)}
            onInsert={handleInsertBubble}
            onRun={(nextBubble) => void handleRunBubble(nextBubble)}
            onDismiss={handleDismissBubble}
          />
        ))}
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
