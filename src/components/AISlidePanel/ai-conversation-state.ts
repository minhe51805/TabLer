import type {
  AIWorkspaceAttachment,
  AIWorkspaceBubbleData,
  AIWorkspaceInteractionMode,
} from "./ai-workspace-types";
import type { AIConversationMessage } from "../../types";

export const AI_WORKSPACE_HISTORY_VERSION = 1;
export const AI_WORKSPACE_HISTORY_LEGACY_STORAGE_KEY = "tabler.ai.workspace.history.v1";
export const AI_WORKSPACE_HISTORY_SAVE_DEBOUNCE_MS = 1_200;

const MAX_STORED_THREADS_PER_WORKSPACE = 12;
const MAX_STORED_BUBBLES_PER_THREAD = 24;
const MAX_HISTORY_BUBBLES = 4;
const MAX_HISTORY_MESSAGE_CHARS = 1000;

/**
 * How much verbatim conversation to replay on each send: the `maxBubbles` most
 * recent ready turns, each user/assistant message trimmed to `maxMessageChars`.
 * Tuned per model by `resolveHistoryBudget`.
 */
export interface HistoryBudget {
  maxBubbles: number;
  maxMessageChars: number;
}

/** Conservative window used when the model's context window is unknown. */
export const DEFAULT_HISTORY_BUDGET: HistoryBudget = {
  maxBubbles: MAX_HISTORY_BUBBLES,
  maxMessageChars: MAX_HISTORY_MESSAGE_CHARS,
};

// Mirror of the backend AIRequest::validate() caps (src-tauri/.../ai_models.rs):
// exceed EITHER and the whole request is rejected, so every budget is clamped
// to stay under them — a generous window can never break a send.
export const BACKEND_MAX_HISTORY_MESSAGES = 12;
export const BACKEND_MAX_HISTORY_CHARS = 24_000;
// The workspace digest rides along as a user/assistant pair on every send;
// reserve its two slots + char budget so history windowing never crowds it out.
const DIGEST_RESERVE_MESSAGES = 2;
const DIGEST_RESERVE_CHARS = 2_600;

/**
 * Clamps a desired history budget to the backend's hard caps, accounting for
 * the always-prepended workspace-digest pair. Guarantees that
 * `digest + maxBubbles * (user + assistant)` can never exceed the message or
 * character caps, whatever tier values `resolveHistoryBudget` proposes.
 */
export function clampHistoryBudget(budget: HistoryBudget): HistoryBudget {
  const bubbleSlots = Math.floor((BACKEND_MAX_HISTORY_MESSAGES - DIGEST_RESERVE_MESSAGES) / 2);
  const maxBubbles = Math.max(1, Math.min(Math.floor(budget.maxBubbles), bubbleSlots));
  const charsForHistory = BACKEND_MAX_HISTORY_CHARS - DIGEST_RESERVE_CHARS;
  const charCeiling = Math.floor(charsForHistory / (maxBubbles * 2));
  const maxMessageChars = Math.max(200, Math.min(Math.floor(budget.maxMessageChars), charCeiling));
  return { maxBubbles, maxMessageChars };
}

/**
 * Picks how much verbatim conversation to replay from the active model's
 * context window (in tokens), then clamps to the backend caps. Small/unknown
 * models stay at the conservative default; large-context models keep more turns
 * and fuller text so long chats "remember" more — without ever risking a
 * rejected request or overflowing a small model's window.
 */
export function resolveHistoryBudget(contextWindowTokens?: number | null): HistoryBudget {
  const tokens = typeof contextWindowTokens === "number" && contextWindowTokens > 0
    ? contextWindowTokens
    : 0;
  let budget = DEFAULT_HISTORY_BUDGET;
  if (tokens >= 200_000) {
    budget = { maxBubbles: 5, maxMessageChars: 2_000 };
  } else if (tokens >= 32_000) {
    budget = { maxBubbles: 4, maxMessageChars: 2_000 };
  }
  return clampHistoryBudget(budget);
}

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

function extractHistoryPrompt(prompt: string, maxChars = MAX_HISTORY_MESSAGE_CHARS) {
  const normalized = prompt.trim();
  if (!normalized) return "";

  const userRequestMarker = "User request:\n";
  const selectedContentMarker = "\n\nSelected content:";
  if (normalized.includes(userRequestMarker)) {
    const requestPart = normalized.split(userRequestMarker)[1] ?? "";
    const userOnly = requestPart.split(selectedContentMarker)[0] ?? requestPart;
    return trimHistoryText(userOnly, maxChars);
  }

  const [firstBlock] = normalized.split(/\n\s*\n/);
  return trimHistoryText(firstBlock || normalized, maxChars);
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

/**
 * Full conversation footprint: every visible (non-compacted) bubble counted
 * UNTRIMMED. The context meter shows this so /compact has a visible effect —
 * folding old bubbles into the workspace digest is exactly what shrinks it.
 * (Each request actually sends much less: the digest + last messages only.)
 */
export function estimateConversationFootprint(bubbles: AIWorkspaceBubbleData[]): number {
  return bubbles
    .filter((bubble) => bubble.status !== "loading" && !bubble.compactedAt)
    .reduce(
      (sum, bubble) => sum + (bubble.prompt?.length ?? 0) + getBubbleConversationText(bubble).length,
      0,
    );
}

export function buildConversationHistoryMessages(
  bubbles: AIWorkspaceBubbleData[],
  budget: HistoryBudget = DEFAULT_HISTORY_BUDGET,
): AIConversationMessage[] {
  return [...bubbles]
    .filter((bubble) => bubble.kind === "assistant" && bubble.status === "ready")
    .sort((left, right) => left.createdAt - right.createdAt)
    .slice(-budget.maxBubbles)
    .flatMap((bubble) => {
      const userPrompt = extractHistoryPrompt(bubble.prompt, budget.maxMessageChars);
      const assistantReply = trimHistoryText(
        getBubbleConversationText(bubble) || bubble.preview || bubble.detail || "",
        budget.maxMessageChars,
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

export function buildAIWorkspaceKey(connectionId: string | null, database: string | null, userWorkspaceId?: string | null) {
  // An explicit user workspace ("player bao bên ngoài") fully scopes threads:
  // context lives with the workspace, not the raw connection/database pair.
  if (userWorkspaceId) return `uw:${userWorkspaceId}`;
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

    return sanitizePersistedAIWorkspaceState({
      version: AI_WORKSPACE_HISTORY_VERSION,
      threads,
      bubbles,
      interactionModes,
      activeThreadIds,
    });
  } catch {
    return createEmptyPersistedAIWorkspaceState();
  }
}

/** Normalizes a bubble's `attachments` metadata array from untrusted persisted
 *  JSON: keeps only well-formed entries and returns `undefined` when nothing
 *  valid remains, matching the shape of bubbles created in-session. */
export function sanitizeAIWorkspaceAttachments(
  value: unknown,
): AIWorkspaceAttachment[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const attachments = value.filter((entry): entry is AIWorkspaceAttachment => {
    if (!entry || typeof entry !== "object") return false;
    const candidate = entry as Partial<AIWorkspaceAttachment>;
    return (
      typeof candidate.id === "string"
      && (candidate.kind === "image" || candidate.kind === "text")
      && typeof candidate.name === "string"
      && typeof candidate.mimeType === "string"
      && typeof candidate.size === "number"
      && typeof candidate.createdAt === "number"
    );
  });
  return attachments.length > 0 ? attachments : undefined;
}

/**
 * Hardens a state object loaded from the SQLite workspace cache
 * (`get_ai_workspace_history` returns the persisted payload as raw JSON, so
 * corrupted or hand-edited rows can carry null threads/bubbles/attachments).
 * Dereferencing any of those nulls throws "Cannot read properties of null
 * (reading 'id')" during hydration or render, which the ErrorBoundary turns
 * into a full-workspace crash. Drops invalid entries instead of trusting the
 * persisted shape — mirrors what `isPersistedBubble` already enforces for the
 * legacy localStorage path and extends it to attachment metadata.
 */
export function sanitizePersistedAIWorkspaceState(
  state: PersistedAIWorkspaceState | null | undefined,
): PersistedAIWorkspaceState {
  const sanitized = createEmptyPersistedAIWorkspaceState();
  if (!state || typeof state !== "object") return sanitized;

  sanitized.version = typeof state.version === "number"
    ? state.version
    : AI_WORKSPACE_HISTORY_VERSION;
  sanitized.threads = (Array.isArray(state.threads) ? state.threads : [])
    .filter((thread): thread is AIChatThread =>
      !!thread
      && typeof thread.id === "string"
      && typeof thread.workspaceKey === "string"
      && typeof thread.label === "string"
      && typeof thread.createdAt === "number")
    .map((thread) => ({
      ...thread,
      updatedAt: typeof thread.updatedAt === "number" ? thread.updatedAt : thread.createdAt,
      isAutoLabel: Boolean(thread.isAutoLabel),
    }));
  sanitized.bubbles = (Array.isArray(state.bubbles) ? state.bubbles : [])
    .filter(isPersistedBubble)
    .map((bubble) => ({
      ...bubble,
      attachments: sanitizeAIWorkspaceAttachments(bubble.attachments),
    }));
  sanitized.interactionModes = state.interactionModes && typeof state.interactionModes === "object"
    ? Object.fromEntries(
        Object.entries(state.interactionModes).filter(
          (entry): entry is [string, AIWorkspaceInteractionMode] => (
            typeof entry[0] === "string" && isAIWorkspaceInteractionMode(entry[1])
          ),
        ),
      )
    : {};
  sanitized.activeThreadIds = state.activeThreadIds && typeof state.activeThreadIds === "object"
    ? Object.fromEntries(
        Object.entries(state.activeThreadIds).filter(
          (entry): entry is [string, string] => (
            typeof entry[0] === "string" && typeof entry[1] === "string"
          ),
        ),
      )
    : {};

  return sanitized;
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

/** Strips the numbered ask_user option list and the italic reply hint from
 *  an answer text so the conversation view can render them as one-click
 *  buttons instead of duplicated plain-text lines. Only called when the
 *  bubble carries askUserOptions. */
export function stripAskUserTrailingOptions(answer: string): string {
  const trimmed = answer.trimEnd();
  const optionsStart = trimmed.search(/\n\n\d+\.\s/u);
  if (optionsStart === -1) {
    return trimmed.replace(/\n\n_\([^)]*\)_\s*$/u, "").trimEnd();
  }
  return trimmed.slice(0, optionsStart).trimEnd();
}

/** Recovers a choice list the model wrote into an ask_user question instead
 *  of passing it via the options argument. The last consecutive run of
 *  numbered ("1. x") or bulleted ("- x", "* x", "• x") lines counts as the
 *  option menu when it has at least two entries; the block is removed from
 *  the returned question so the list is not rendered twice (once as buttons,
 *  once as plain text). */
export function extractAskUserOptionsFromQuestion(
  question: string,
): { question: string; options: string[] } {
  const lines = question.replace(/\r\n/g, "\n").trimEnd().split("\n");
  const options: string[] = [];
  let blockStart = lines.length;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = lines[index].match(/^\s*(?:\d{1,2}[.)]\s+|[-*•]\s+)(.+)$/u);
    if (!match) break;
    const item = match[1].trim();
    if (!item) break;
    options.unshift(item);
    blockStart = index;
  }
  if (options.length < 2) {
    return { question, options: [] };
  }
  return {
    question: lines.slice(0, blockStart).join("\n").trimEnd(),
    options: options.slice(0, 8),
  };
}
