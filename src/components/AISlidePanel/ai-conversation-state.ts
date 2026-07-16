import type {
  AIWorkspaceBubbleData,
  AIWorkspaceInteractionMode,
} from "./ai-workspace-types";
import type { AIConversationMessage } from "../../types";

export const AI_WORKSPACE_HISTORY_VERSION = 1;
export const AI_WORKSPACE_HISTORY_LEGACY_STORAGE_KEY = "tabler.ai.workspace.history.v1";
export const AI_WORKSPACE_HISTORY_SAVE_DEBOUNCE_MS = 300;

const MAX_STORED_THREADS_PER_WORKSPACE = 12;
const MAX_STORED_BUBBLES_PER_THREAD = 24;
const MAX_HISTORY_BUBBLES = 4;
const MAX_HISTORY_MESSAGE_CHARS = 1000;

export interface AIChatThread {
  id: string;
  workspaceKey: string;
  label: string;
  createdAt: number;
  updatedAt: number;
  isAutoLabel: boolean;
}

export interface PersistedAIWorkspaceState {
  version: number;
  threads: AIChatThread[];
  bubbles: AIWorkspaceBubbleData[];
  interactionModes: Record<string, AIWorkspaceInteractionMode>;
  activeThreadIds: Record<string, string>;
}

function stripCodeFences(text: string) {
  return text.replace(/```sql?/gi, "").replace(/```/g, "").trim();
}

export function summarizePromptForDisplay(text: string) {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > 180 ? `${compact.slice(0, 177)}...` : compact;
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

export function getBubbleConversationText(bubble: AIWorkspaceBubbleData) {
  const fallback = bubble.preview?.trim() || "";
  const normalizedDetail = stripCodeFences(bubble.detail || "").trim();
  const normalizedSql = stripCodeFences(bubble.sql || "").trim();

  if (!normalizedDetail) return fallback;
  if (normalizedSql && normalizedDetail === normalizedSql) return fallback;
  if (normalizedSql && normalizedDetail.includes(normalizedSql)) {
    const withoutSql = normalizedDetail.replace(normalizedSql, "").trim();
    return withoutSql || fallback;
  }

  return normalizedDetail;
}

export function buildConversationHistoryMessages(
  bubbles: AIWorkspaceBubbleData[],
): AIConversationMessage[] {
  return [...bubbles]
    .filter((bubble) => bubble.kind === "assistant" && bubble.status === "ready")
    .sort((left, right) => left.createdAt - right.createdAt)
    .slice(-MAX_HISTORY_BUBBLES)
    .flatMap((bubble) => {
      const userPrompt = extractHistoryPrompt(bubble.prompt);
      const assistantReply = trimHistoryText(
        getBubbleConversationText(bubble) || bubble.preview || bubble.detail || "",
      );
      const messages: AIConversationMessage[] = [];

      if (userPrompt) messages.push({ role: "user", content: userPrompt });
      if (assistantReply) messages.push({ role: "assistant", content: assistantReply });
      return messages;
    });
}

export function createAIWorkspaceId() {
  return globalThis.crypto?.randomUUID?.()
    ?? `bubble-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function buildThreadLabel(prompt: string, index: number) {
  const summary = prompt.replace(/\s+/g, " ").trim();
  if (!summary) return `#${index}`;
  return summary.length > 24 ? `${summary.slice(0, 21).trimEnd()}...` : summary;
}

export function buildAIWorkspaceKey(connectionId: string | null, database: string | null) {
  return `${connectionId || "no-connection"}::${database || "no-database"}`;
}

export function formatThreadTimestamp(timestamp: number, language: string) {
  const locale = language === "vi" ? "vi-VN" : language === "zh" ? "zh-CN" : "en-US";
  const targetDate = new Date(timestamp);
  const now = new Date();
  const isSameDay =
    targetDate.getFullYear() === now.getFullYear()
    && targetDate.getMonth() === now.getMonth()
    && targetDate.getDate() === now.getDate();

  const formatter = new Intl.DateTimeFormat(
    locale,
    isSameDay
      ? { hour: "2-digit", minute: "2-digit" }
      : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" },
  );

  return formatter.format(targetDate);
}

export function isAIWorkspaceInteractionMode(
  value: unknown,
): value is AIWorkspaceInteractionMode {
  return value === "prompt" || value === "edit" || value === "agent";
}

export function createEmptyPersistedAIWorkspaceState(): PersistedAIWorkspaceState {
  return {
    version: AI_WORKSPACE_HISTORY_VERSION,
    threads: [],
    bubbles: [],
    interactionModes: {},
    activeThreadIds: {},
  };
}

export function loadLegacyPersistedAIWorkspaceState(
  storage: Pick<Storage, "getItem"> | null = typeof window === "undefined" ? null : window.localStorage,
): PersistedAIWorkspaceState {
  if (!storage) return createEmptyPersistedAIWorkspaceState();

  try {
    const raw = storage.getItem(AI_WORKSPACE_HISTORY_LEGACY_STORAGE_KEY);
    if (!raw) return createEmptyPersistedAIWorkspaceState();

    const parsed = JSON.parse(raw) as Partial<PersistedAIWorkspaceState> | null;
    if (!parsed || typeof parsed !== "object") {
      return createEmptyPersistedAIWorkspaceState();
    }

    const threads = Array.isArray(parsed.threads)
      ? parsed.threads
          .filter((thread): thread is AIChatThread => (
            !!thread
            && typeof thread.id === "string"
            && typeof thread.workspaceKey === "string"
            && typeof thread.label === "string"
            && typeof thread.createdAt === "number"
          ))
          .map((thread) => ({
            ...thread,
            updatedAt: typeof thread.updatedAt === "number" ? thread.updatedAt : thread.createdAt,
            isAutoLabel: Boolean(thread.isAutoLabel),
          }))
      : [];

    const bubbles = Array.isArray(parsed.bubbles)
      ? parsed.bubbles.filter(isPersistedBubble)
      : [];

    const interactionModes = Object.fromEntries(
      Object.entries(parsed.interactionModes || {}).filter(
        (entry): entry is [string, AIWorkspaceInteractionMode] => (
          typeof entry[0] === "string" && isAIWorkspaceInteractionMode(entry[1])
        ),
      ),
    );

    const activeThreadIds = Object.fromEntries(
      Object.entries(parsed.activeThreadIds || {}).filter(
        (entry): entry is [string, string] => (
          typeof entry[0] === "string" && typeof entry[1] === "string"
        ),
      ),
    );

    return {
      version: AI_WORKSPACE_HISTORY_VERSION,
      threads,
      bubbles,
      interactionModes,
      activeThreadIds,
    };
  } catch {
    return createEmptyPersistedAIWorkspaceState();
  }
}

function isPersistedBubble(bubble: unknown): bubble is AIWorkspaceBubbleData {
  if (!bubble || typeof bubble !== "object") return false;
  const candidate = bubble as Partial<AIWorkspaceBubbleData>;

  return (
    typeof candidate.id === "string"
    && typeof candidate.threadId === "string"
    && typeof candidate.workspaceKey === "string"
    && isAIWorkspaceInteractionMode(candidate.interactionMode)
    && typeof candidate.kind === "string"
    && typeof candidate.status === "string"
    && typeof candidate.title === "string"
    && typeof candidate.subtitle === "string"
    && typeof candidate.prompt === "string"
    && typeof candidate.preview === "string"
    && typeof candidate.detail === "string"
    && typeof candidate.createdAt === "number"
    && typeof candidate.x === "number"
    && typeof candidate.y === "number"
    && !!candidate.pointer
    && typeof candidate.pointer.x === "number"
    && typeof candidate.pointer.y === "number"
    && typeof candidate.pointer.visible === "boolean"
  );
}

export function prunePersistedAIWorkspaceState(
  state: PersistedAIWorkspaceState,
): PersistedAIWorkspaceState {
  const threadsByWorkspace = new Map<string, AIChatThread[]>();
  state.threads.forEach((thread) => {
    const collection = threadsByWorkspace.get(thread.workspaceKey) || [];
    collection.push({
      ...thread,
      updatedAt: typeof thread.updatedAt === "number" ? thread.updatedAt : thread.createdAt,
    });
    threadsByWorkspace.set(thread.workspaceKey, collection);
  });

  const keptThreads = [...threadsByWorkspace.values()].flatMap((workspaceThreads) =>
    [...workspaceThreads]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, MAX_STORED_THREADS_PER_WORKSPACE),
  );

  const keptThreadIds = new Set(keptThreads.map((thread) => thread.id));
  const keptWorkspaceKeys = new Set(keptThreads.map((thread) => thread.workspaceKey));
  const bubblesByThread = new Map<string, AIWorkspaceBubbleData[]>();

  state.bubbles
    .filter((bubble) => keptThreadIds.has(bubble.threadId) && bubble.status !== "loading")
    .forEach((bubble) => {
      const collection = bubblesByThread.get(bubble.threadId) || [];
      collection.push(bubble);
      bubblesByThread.set(bubble.threadId, collection);
    });

  const keptBubbles = [...bubblesByThread.values()]
    .flatMap((threadBubbles) =>
      [...threadBubbles]
        .sort((left, right) => left.createdAt - right.createdAt)
        .slice(-MAX_STORED_BUBBLES_PER_THREAD),
    )
    .sort((left, right) => left.createdAt - right.createdAt);

  const interactionModes = Object.fromEntries(
    Object.entries(state.interactionModes).filter(([workspaceKey]) => keptWorkspaceKeys.has(workspaceKey)),
  );
  const activeThreadIds = Object.fromEntries(
    Object.entries(state.activeThreadIds).filter(([workspaceKey, threadId]) => (
      keptWorkspaceKeys.has(workspaceKey) && keptThreadIds.has(threadId)
    )),
  );

  return {
    version: AI_WORKSPACE_HISTORY_VERSION,
    threads: keptThreads.sort((left, right) => right.updatedAt - left.updatedAt),
    bubbles: keptBubbles,
    interactionModes,
    activeThreadIds,
  };
}

export function hasPersistedAIWorkspaceStateData(state: PersistedAIWorkspaceState) {
  return (
    state.threads.length > 0
    || state.bubbles.length > 0
    || Object.keys(state.interactionModes).length > 0
    || Object.keys(state.activeThreadIds).length > 0
  );
}

export function createChatThread(index: number, workspaceKey: string): AIChatThread {
  const now = Date.now();
  return {
    id: createAIWorkspaceId(),
    workspaceKey,
    label: `#${index}`,
    createdAt: now,
    updatedAt: now,
    isAutoLabel: true,
  };
}
