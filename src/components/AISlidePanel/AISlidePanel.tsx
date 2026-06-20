import {
  Check,
  ChevronDown,
  Database,
  History,
  Loader2,
  MessageSquare,
  PencilLine,
  RotateCcw,
  Settings2,
  Shield,
  ShieldCheck,
  Sparkles,
  Target,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../i18n";
import { useAppStore } from "../../stores/appStore";
import type { AIConversationMessage, AIProviderConfig, DatabaseType, MetricsWidgetType } from "../../types";
import { invokeMutation } from "../../utils/tauri-utils";
import { splitSqlStatements } from "../../utils/sqlStatements";
import { ConfirmDialog } from "../ConfirmDialog";
import { AIWorkspaceMarkdown } from "./AIWorkspaceMarkdown";
import { AIBubbleDetailModal } from "./AIBubbleDetailModal";
import { AIAgentSteps } from "./AIAgentSteps";
import { AI_REQUEST_REPLACED_MESSAGE, isSupersededAIRequestError, useAISlidePanel } from "./hooks/use-ai-slide-panel";
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

const ERROR_BUBBLE_AUTO_DISMISS_MS = 9000;
const MAX_HISTORY_BUBBLES = 4;
const MAX_HISTORY_MESSAGE_CHARS = 1000;
const AI_WORKSPACE_HISTORY_LEGACY_STORAGE_KEY = "tabler.ai.workspace.history.v1";
const AI_WORKSPACE_AGENT_AUTONOMY_STORAGE_KEY = "tabler.ai.workspace.agentAutonomy.v1";

/**
 * Decides whether an agent may run generated SQL without asking, given the
 * current autonomy level and the risk classification of the SQL.
 * - "review": never auto-run; the user approves every statement.
 * - "smart": auto-run only safe read-only SQL; writes/high-risk still need approval.
 * - "full": auto-run everything (writes still pass through the sandbox).
 */
function shouldAgentAutoRunSql(
  autonomy: AIWorkspaceAgentAutonomy,
  riskLevel: "safe" | "review" | "dangerous" | undefined
): boolean {
  if (autonomy === "review") return false;
  if (autonomy === "full") return true;
  // "smart"
  return riskLevel === "safe";
}
const AI_WORKSPACE_HISTORY_VERSION = 1;
const MAX_STORED_THREADS_PER_WORKSPACE = 12;
const MAX_STORED_BUBBLES_PER_THREAD = 24;
const AI_WORKSPACE_HISTORY_SAVE_DEBOUNCE_MS = 300;

interface AIChatThread {
  id: string;
  workspaceKey: string;
  label: string;
  createdAt: number;
  updatedAt: number;
  isAutoLabel: boolean;
}

interface PersistedAIWorkspaceState {
  version: number;
  threads: AIChatThread[];
  bubbles: AIWorkspaceBubbleData[];
  interactionModes: Record<string, AIWorkspaceInteractionMode>;
  activeThreadIds: Record<string, string>;
}

interface SelectionContextState {
  text: string;
  source: string;
  boardId?: string;
  rect: { x: number; y: number; width: number; height: number } | null;
  updatedAt: number;
}

interface VisualizationReadConsentState {
  title: string;
  message: string;
  confirmText: string;
  cancelText: string;
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

function buildExecutionDetail(summary: string, query: string, previousDetail?: string) {
  return [
    previousDetail?.trim() || "",
    "## Execution",
    summary,
    "## Query",
    `\`\`\`sql\n${query}\n\`\`\``,
  ]
    .filter(Boolean)
    .join("\n\n---\n\n");
}

function buildAutoRunFailureDetail(message: string, sql: string, previousDetail?: string) {
  return [
    previousDetail?.trim() || "",
    "## Auto Run Error",
    message,
    "## Proposed SQL",
    `\`\`\`sql\n${sql}\n\`\`\``,
  ]
    .filter(Boolean)
    .join("\n\n---\n\n");
}

function buildThreadLabel(prompt: string, index: number) {
  const summary = summarizePromptForDisplay(prompt);
  if (!summary) return `#${index}`;
  return summary.length > 24 ? `${summary.slice(0, 21).trimEnd()}...` : summary;
}

function buildAIWorkspaceKey(connectionId: string | null, database: string | null) {
  return `${connectionId || "no-connection"}::${database || "no-database"}`;
}

function getHistoryLocale(language: string) {
  if (language === "vi") return "vi-VN";
  if (language === "zh") return "zh-CN";
  return "en-US";
}

function formatThreadTimestamp(timestamp: number, language: string) {
  const locale = getHistoryLocale(language);
  const targetDate = new Date(timestamp);
  const now = new Date();
  const isSameDay =
    targetDate.getFullYear() === now.getFullYear() &&
    targetDate.getMonth() === now.getMonth() &&
    targetDate.getDate() === now.getDate();

  const formatter = new Intl.DateTimeFormat(locale, isSameDay
    ? { hour: "2-digit", minute: "2-digit" }
    : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

  return formatter.format(targetDate);
}

function isAIWorkspaceInteractionMode(value: unknown): value is AIWorkspaceInteractionMode {
  return value === "prompt" || value === "edit" || value === "agent";
}

function createEmptyPersistedAIWorkspaceState(): PersistedAIWorkspaceState {
  return {
    version: AI_WORKSPACE_HISTORY_VERSION,
    threads: [],
    bubbles: [],
    interactionModes: {},
    activeThreadIds: {},
  };
}

function loadLegacyPersistedAIWorkspaceState(): PersistedAIWorkspaceState {
  if (typeof window === "undefined") {
    return createEmptyPersistedAIWorkspaceState();
  }

  try {
    const raw = window.localStorage.getItem(AI_WORKSPACE_HISTORY_LEGACY_STORAGE_KEY);
    if (!raw) return createEmptyPersistedAIWorkspaceState();

    const parsed = JSON.parse(raw) as Partial<PersistedAIWorkspaceState> | null;
    if (!parsed || typeof parsed !== "object") {
      return createEmptyPersistedAIWorkspaceState();
    }

    const threads = Array.isArray(parsed.threads)
      ? parsed.threads
          .filter((thread): thread is AIChatThread => (
            !!thread &&
            typeof thread.id === "string" &&
            typeof thread.workspaceKey === "string" &&
            typeof thread.label === "string" &&
            typeof thread.createdAt === "number"
          ))
          .map((thread) => ({
            ...thread,
            updatedAt: typeof thread.updatedAt === "number" ? thread.updatedAt : thread.createdAt,
            isAutoLabel: Boolean(thread.isAutoLabel),
          }))
      : [];

    const bubbles = Array.isArray(parsed.bubbles)
      ? parsed.bubbles.filter((bubble): bubble is AIWorkspaceBubbleData => (
          !!bubble &&
          typeof bubble.id === "string" &&
          typeof bubble.threadId === "string" &&
          typeof bubble.workspaceKey === "string" &&
          isAIWorkspaceInteractionMode(bubble.interactionMode) &&
          typeof bubble.kind === "string" &&
          typeof bubble.status === "string" &&
          typeof bubble.title === "string" &&
          typeof bubble.subtitle === "string" &&
          typeof bubble.prompt === "string" &&
          typeof bubble.preview === "string" &&
          typeof bubble.detail === "string" &&
          typeof bubble.createdAt === "number" &&
          typeof bubble.x === "number" &&
          typeof bubble.y === "number" &&
          !!bubble.pointer &&
          typeof bubble.pointer.x === "number" &&
          typeof bubble.pointer.y === "number" &&
          typeof bubble.pointer.visible === "boolean"
        ))
      : [];

    const interactionModes = Object.fromEntries(
      Object.entries(parsed.interactionModes || {}).filter((entry): entry is [string, AIWorkspaceInteractionMode] => (
        typeof entry[0] === "string" && isAIWorkspaceInteractionMode(entry[1])
      ))
    );

    const activeThreadIds = Object.fromEntries(
      Object.entries(parsed.activeThreadIds || {}).filter((entry): entry is [string, string] => (
        typeof entry[0] === "string" && typeof entry[1] === "string"
      ))
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

function prunePersistedAIWorkspaceState(state: PersistedAIWorkspaceState): PersistedAIWorkspaceState {
  const threadsByWorkspace = new Map<string, AIChatThread[]>();
  state.threads.forEach((thread) => {
    const collection = threadsByWorkspace.get(thread.workspaceKey) || [];
    collection.push({
      ...thread,
      updatedAt: typeof thread.updatedAt === "number" ? thread.updatedAt : thread.createdAt,
    });
    threadsByWorkspace.set(thread.workspaceKey, collection);
  });

  const keptThreads = [...threadsByWorkspace.entries()].flatMap(([, workspaceThreads]) =>
    [...workspaceThreads]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, MAX_STORED_THREADS_PER_WORKSPACE)
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
        .slice(-MAX_STORED_BUBBLES_PER_THREAD)
    )
    .sort((left, right) => left.createdAt - right.createdAt);

  const interactionModes = Object.fromEntries(
    Object.entries(state.interactionModes).filter(([workspaceKey]) => keptWorkspaceKeys.has(workspaceKey))
  );

  const activeThreadIds = Object.fromEntries(
    Object.entries(state.activeThreadIds).filter(([workspaceKey, threadId]) => (
      keptWorkspaceKeys.has(workspaceKey) && keptThreadIds.has(threadId)
    ))
  );

  return {
    version: AI_WORKSPACE_HISTORY_VERSION,
    threads: keptThreads.sort((left, right) => right.updatedAt - left.updatedAt),
    bubbles: keptBubbles,
    interactionModes,
    activeThreadIds,
  };
}

function hasPersistedAIWorkspaceStateData(state: PersistedAIWorkspaceState) {
  return (
    state.threads.length > 0 ||
    state.bubbles.length > 0 ||
    Object.keys(state.interactionModes).length > 0 ||
    Object.keys(state.activeThreadIds).length > 0
  );
}

function createChatThread(index: number, workspaceKey: string): AIChatThread {
  const now = Date.now();
  return {
    id: createId(),
    workspaceKey,
    label: `#${index}`,
    createdAt: now,
    updatedAt: now,
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

function getInteractionModeHint(
  interactionMode: AIWorkspaceInteractionMode,
  copy: ReturnType<typeof getAIWorkspaceCopy>
) {
  if (interactionMode === "agent") return copy.composer.modeAgentHint;
  if (interactionMode === "edit") return copy.composer.modeEditHint;
  return copy.composer.modePromptHint;
}

function getInteractionModeIcon(interactionMode: AIWorkspaceInteractionMode) {
  if (interactionMode === "agent") return Sparkles;
  if (interactionMode === "edit") return PencilLine;
  return MessageSquare;
}

const AGENT_AUTONOMY_OPTIONS: AIWorkspaceAgentAutonomy[] = ["review", "smart", "full"];

function getAgentAutonomyIcon(autonomy: AIWorkspaceAgentAutonomy) {
  if (autonomy === "full") return Zap;
  if (autonomy === "smart") return ShieldCheck;
  return Shield;
}

function getAgentAutonomyLabel(
  autonomy: AIWorkspaceAgentAutonomy,
  copy: ReturnType<typeof getAIWorkspaceCopy>
) {
  if (autonomy === "full") return copy.composer.agentAutonomyFull;
  if (autonomy === "smart") return copy.composer.agentAutonomySmart;
  return copy.composer.agentAutonomyReview;
}

function getAgentAutonomyHint(
  autonomy: AIWorkspaceAgentAutonomy,
  copy: ReturnType<typeof getAIWorkspaceCopy>
) {
  if (autonomy === "full") return copy.composer.agentAutonomyFullHint;
  if (autonomy === "smart") return copy.composer.agentAutonomySmartHint;
  return copy.composer.agentAutonomyReviewHint;
}

function normalizeAIProviderConfigs(configs: AIProviderConfig[]) {
  const normalized = configs.map((config) => ({
    ...config,
    is_enabled: config.is_enabled ?? true,
    is_primary: config.is_primary ?? false,
    allow_schema_context: config.allow_schema_context ?? false,
    allow_inline_completion: config.allow_inline_completion ?? false,
  }));

  const primaryIndex = normalized.findIndex((config) => config.is_enabled && config.is_primary);
  const enabledIndex = normalized.findIndex((config) => config.is_enabled);
  const activeIndex = primaryIndex >= 0 ? primaryIndex : enabledIndex;

  return normalized.map((config, index) => ({
    ...config,
    is_primary: activeIndex >= 0 ? index === activeIndex : false,
  }));
}

function formatProviderTypeLabel(providerType: AIProviderConfig["provider_type"]) {
  switch (providerType) {
    case "openai":
      return "OpenAI";
    case "anthropic":
      return "Claude";
    case "gemini":
      return "Gemini";
    case "openrouter":
      return "OpenRouter";
    case "ollama":
      return "Ollama";
    case "custom":
      return "Custom";
    default:
      return "AI";
  }
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

function hasMetricsDashboardAttachmentContext(prompt: string) {
  return prompt.includes("Metrics dashboard snapshot:");
}

function isDashboardSelectionSource(source?: string | null) {
  const normalizedSource = source?.trim().toLowerCase() || "";
  return normalizedSource.startsWith("dashboard:");
}

type DashboardSnapshotWidget = {
  type: MetricsWidgetType;
  title: string;
};

type DashboardWidgetEditInstruction = {
  boardId?: string;
  targetTitle: string;
  nextType: MetricsWidgetType;
  nextQuery?: string;
  nextTitle?: string;
};

function extractDashboardSnapshotWidgets(snapshot: string): DashboardSnapshotWidget[] {
  return snapshot
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*\d+\.\s+\[(table|scoreboard|bar|line|pie)\]\s+(.+?)\s*$/i))
    .filter((match): match is RegExpMatchArray => !!match)
    .map((match) => ({
      type: match[1].toLowerCase() as MetricsWidgetType,
      title: match[2].trim(),
    }));
}

function extractDashboardWidgetTitleFromPrompt(prompt: string) {
  const quotedMatch = prompt.match(/["“”']([^"“”']{2,120})["“”']/);
  if (quotedMatch?.[1]?.trim()) {
    return quotedMatch[1].trim();
  }

  const normalizedPrompt = prompt.trim();
  const chartLeadMatch = normalizedPrompt.match(/\bchart\s+([a-z0-9 _-]{2,120})/i);
  if (chartLeadMatch?.[1]) {
    return chartLeadMatch[1]
      .replace(/\b(no|not|khong|ko)\b.*$/i, "")
      .replace(/\b(doi|change|switch)\b.*$/i, "")
      .trim();
  }

  const widgetLeadMatch = normalizedPrompt.match(/\bwidget\s+([a-z0-9 _-]{2,120})/i);
  if (widgetLeadMatch?.[1]) {
    return widgetLeadMatch[1]
      .replace(/\b(no|not|khong|ko)\b.*$/i, "")
      .replace(/\b(doi|change|switch)\b.*$/i, "")
      .trim();
  }

  return "";
}

function inferWidgetTypeFromPrompt(prompt: string): MetricsWidgetType | null {
  const normalized = normalizeVisualizationText(prompt);
  if (!normalized) return null;

  if (normalized.includes("scoreboard") || normalized.includes("kpi")) return "scoreboard";
  if (normalized.includes("line")) return "line";
  if (normalized.includes("pie")) return "pie";
  if (normalized.includes("bar") || normalized.includes("cot")) return "bar";
  if (normalized.includes("table") || normalized.includes("bang")) return "table";
  if (
    normalized.includes("khong co value") ||
    normalized.includes("khong co gia tri") ||
    normalized.includes("empty") ||
    normalized.includes("rong") ||
    normalized.includes("chart khac") ||
    normalized.includes("doi qua chart khac") ||
    normalized.includes("change chart")
  ) {
    return "table";
  }
  return null;
}

function extractDashboardWidgetTitleFromConversationContext(conversationText: string) {
  if (!conversationText.trim()) return "";

  const quotedWidgetMatch = conversationText.match(/widget\s+["“”']([^"“”']{2,120})["“”']/i);
  if (quotedWidgetMatch?.[1]?.trim()) {
    return quotedWidgetMatch[1].trim();
  }

  const recommendationMatch = conversationText.match(/recommended change for widget(?:\s+\d+)?\s*:\s*([^\n]+)/i);
  if (recommendationMatch?.[1]?.trim()) {
    return recommendationMatch[1].trim();
  }

  const vietnameseMatch = conversationText.match(/doi chart cho widget\s+["“”']([^"“”']{2,120})["“”']/i);
  if (vietnameseMatch?.[1]?.trim()) {
    return vietnameseMatch[1].trim();
  }

  return "";
}

function extractDashboardWidgetTargetHint(prompt: string, conversationContext = "") {
  const explicitPromptTitle = extractDashboardWidgetTitleFromPrompt(prompt);
  if (explicitPromptTitle) {
    return explicitPromptTitle;
  }

  const normalizedPrompt = normalizeVisualizationText(prompt);
  const leadMatch = normalizedPrompt.match(
    /\b(?:chart|widget)\s+(.+?)(?=\b(?:no|not|khong|ko|doi|change|switch|thanh|sang|goi y|suggestion|option|phuong an)\b|$)/i,
  );
  if (leadMatch?.[1]?.trim()) {
    return leadMatch[1].trim();
  }

  return extractDashboardWidgetTitleFromConversationContext(conversationContext);
}

function isDashboardWidgetAdjustmentPrompt(prompt: string) {
  const normalized = normalizeVisualizationText(prompt);
  if (!normalized) return false;

  return [
    "doi chart",
    "doi qua",
    "chart khac",
    "widget",
    "khong co value",
    "khong co gia tri",
    "khong co du lieu",
    "empty",
    "rong",
    "goi y 1",
    "goi y 2",
    "goi y 3",
    "suggestion 1",
    "suggestion 2",
    "suggestion 3",
    "option 1",
    "option 2",
    "option 3",
    "phuong an 1",
    "phuong an 2",
    "phuong an 3",
    "doi thanh",
    "change this",
    "switch this",
    "fix chart",
    "sua chart",
  ].some((signal) => normalized.includes(signal));
}

function isDashboardAttachmentReferencePrompt(prompt: string) {
  const normalized = normalizeVisualizationText(prompt);
  if (!normalized) return false;

  const dashboardSignals = [
    "dashboard hien tai",
    "board hien tai",
    "chart o dashboard",
    "chart ở dashboard",
    "chart dashboard",
    "day dashboard",
    "dua cho ban",
    "dang dua cho ban",
    "xem dashboard nay",
    "xem board nay",
    "doc dashboard",
    "review dashboard",
    "this dashboard",
    "current dashboard",
    "current board",
    "this board",
    "attached dashboard",
  ];

  return dashboardSignals.some((signal) => normalized.includes(normalizeVisualizationText(signal)));
}

function inferWidgetTypeFromPromptWithContext(prompt: string, conversationContext = ""): MetricsWidgetType | null {
  const directType = inferWidgetTypeFromPrompt(prompt);
  if (directType) {
    return directType;
  }

  const normalizedPrompt = normalizeVisualizationText(prompt);
  const normalizedConversation = normalizeVisualizationText(conversationContext);

  if (!normalizedPrompt) return null;

  if (/(?:goi y|suggestion|option|phuong an)\s*1/.test(normalizedPrompt)) {
    if (normalizedConversation.includes("kpi") || normalizedConversation.includes("metric")) {
      return "scoreboard";
    }
    if (normalizedConversation.includes("table")) {
      return "table";
    }
  }

  if (/(?:goi y|suggestion|option|phuong an)\s*2/.test(normalizedPrompt) && normalizedConversation.includes("table")) {
    return "table";
  }

  return null;
}

function buildAverageRatingTableQuery() {
  return [
    "SELECT",
    `  COALESCE(NULLIF(TRIM(p."name"::text), ''), 'Product #' || COALESCE(p."id"::text, 'n/a')) AS product,`,
    `  COUNT(r."product_id")::bigint AS review_count,`,
    `  COALESCE(ROUND(AVG(r."rating"::numeric), 2), 0) AS avg_rating`,
    `FROM "public"."products" p`,
    `LEFT JOIN "public"."reviews" r ON p."id"::text = r."product_id"::text`,
    `WHERE p."id" IS NOT NULL`,
    "GROUP BY 1",
    "ORDER BY avg_rating DESC, product ASC",
    "LIMIT 10;",
  ].join("\n");
}

function buildOAuthClientsScoreboardQuery() {
  return [
    "SELECT",
    "  COUNT(*)::bigint AS total_clients,",
    "  'oauth clients' AS label",
    'FROM "auth"."oauth_clients";',
  ].join("\n");
}

function summarizeAttachedDashboardSelection(selection: SelectionContextState) {
  const boardNameMatch = selection.text.match(/^Board:\s+(.+)$/mi);
  const widgetCountMatch = selection.text.match(/^Widget count:\s+(\d+)$/mi);
  const hiddenWidgetCountMatch = selection.text.match(/\.\.\.\s+(\d+)\s+more widget\(s\)/i);
  const widgets = extractDashboardSnapshotWidgets(selection.text);

  return {
    boardName: boardNameMatch?.[1]?.trim() || selection.source.replace(/^dashboard:\s*/i, "").trim() || "Current dashboard",
    widgetCount: Number(widgetCountMatch?.[1] || widgets.length || 0),
    hiddenWidgetCount: Number(hiddenWidgetCountMatch?.[1] || 0),
    widgetTitles: widgets.map((widget) => widget.title),
  };
}

function resolveDashboardWidgetEditInstruction(
  prompt: string,
  selection: SelectionContextState | null,
  conversationContext = "",
): DashboardWidgetEditInstruction | null {
  if (!selection || !isDashboardSelectionSource(selection.source)) return null;

  const normalizedPrompt = normalizeVisualizationText(prompt);
  if (!normalizedPrompt) return null;

  const nextType = inferWidgetTypeFromPromptWithContext(prompt, conversationContext);
  if (!nextType) return null;

  const widgets = extractDashboardSnapshotWidgets(selection.text);
  const explicitTargetTitle = extractDashboardWidgetTargetHint(prompt, conversationContext);
  const normalizedExplicitTargetTitle = normalizeVisualizationText(explicitTargetTitle);

  const matchingWidget =
    widgets.length === 0
      ? null
      : [...widgets]
          .sort((left, right) => right.title.length - left.title.length)
          .find((widget) => {
            const normalizedWidgetTitle = normalizeVisualizationText(widget.title);
            return (
              normalizedPrompt.includes(normalizedWidgetTitle) ||
              (!!normalizedExplicitTargetTitle && (
                normalizedExplicitTargetTitle === normalizedWidgetTitle ||
                normalizedExplicitTargetTitle.includes(normalizedWidgetTitle) ||
                normalizedWidgetTitle.includes(normalizedExplicitTargetTitle)
              ))
            );
          });

  const resolvedTargetTitle = matchingWidget?.title || explicitTargetTitle;
  if (!resolvedTargetTitle) return null;

  const normalizedTitle = normalizeVisualizationText(resolvedTargetTitle);
  const isAverageRatingWidget =
    normalizedTitle === "average rating by product" || normalizedTitle === "reviews by product";
  const isOAuthClientsWidget = normalizedTitle === "oauth clients";

  return {
    boardId: selection.boardId,
    targetTitle: resolvedTargetTitle,
    nextType,
    nextQuery:
      isAverageRatingWidget && nextType === "table"
        ? buildAverageRatingTableQuery()
        : isOAuthClientsWidget
          ? buildOAuthClientsScoreboardQuery()
          : undefined,
  };
}

async function waitForUIPaint() {
  await new Promise<void>((resolve) => {
    if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(() => {
        window.setTimeout(resolve, 0);
      });
      return;
    }

    setTimeout(resolve, 0);
  });
}

function isVisualizationPrompt(prompt: string) {
  const normalized = prompt.trim().toLowerCase();
  if (!normalized) return false;

  return [
    "chart",
    "charts",
    "visual",
    "visual data",
    "viz",
    "graph",
    "plot",
    "dashboard",
    "visualize",
    "visualization",
    "bar chart",
    "line chart",
    "pie chart",
    "bieu do",
    "biểu đồ",
    "ve bieu do",
    "vẽ biểu đồ",
  ].some((signal) => normalized.includes(signal));
}

function normalizeVisualizationText(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .trim();
}

function prefersVietnameseSystemReply(prompt: string, uiLanguage: string) {
  if (uiLanguage === "vi") return true;
  const normalizedPrompt = normalizeVisualizationText(prompt);
  if (!normalizedPrompt) return false;

  return [
    "xem",
    "bieu do",
    "chart",
    "bo sung",
    "them",
    "thieu",
    "day du",
    "giu",
    "doi",
    "hien tai",
    "duoc khong",
    "cho tui",
    "giup tui",
  ].some((signal) => normalizedPrompt.includes(signal));
}

function supportsOverviewMetricsBoard(dbType?: DatabaseType) {
  switch (dbType) {
    case "postgresql":
    case "cockroachdb":
    case "greenplum":
    case "redshift":
    case "mysql":
    case "mariadb":
    case "mssql":
      return true;
    default:
      return false;
  }
}

function isDashboardVisualizationPrompt(prompt: string, intent?: string) {
  const normalizedPrompt = normalizeVisualizationText(prompt);
  if (!normalizedPrompt) return false;

  const dashboardSignals = [
    "dashboard",
    "multi chart",
    "multiple charts",
    "many charts",
    "nhieu bieu do",
    "nhiều biểu đồ",
    "nhieu chart",
    "nhiều chart",
    "metrics board",
  ];

  return (
    isOverviewVisualizationPrompt(prompt, intent) ||
    (isVisualizationPrompt(normalizedPrompt) &&
      dashboardSignals.some((signal) => normalizedPrompt.includes(signal)))
  );
}

function isDashboardAugmentPrompt(prompt: string) {
  const normalizedPrompt = normalizeVisualizationText(prompt);
  if (!normalizedPrompt || !isVisualizationPrompt(normalizedPrompt)) {
    return false;
  }

  const augmentSignals = [
    "add chart",
    "add more chart",
    "add more charts",
    "more chart",
    "more charts",
    "missing chart",
    "missing charts",
    "complete chart",
    "complete dashboard",
    "fill out dashboard",
    "expand dashboard",
    "augment dashboard",
    "bo sung",
    "them bieu do",
    "them chart",
    "thieu",
    "day du",
    "lam day",
    "bo sung them",
    "chi tiet",
    "chi tiet hon",
    "bao quat",
    "bao quat hon",
    "tung bang",
    "moi bang",
    "per table",
    "detail visual",
    "sua chart",
    "refine dashboard",
  ];

  return augmentSignals.some((signal) => normalizedPrompt.includes(signal));
}

function isDashboardRebuildPrompt(prompt: string) {
  const normalizedPrompt = normalizeVisualizationText(prompt);
  if (!normalizedPrompt) return false;

  const rebuildSignals = [
    "doi lai",
    "chua duoc",
    "xem het",
    "xem them",
    "tong hop",
    "tong quat",
    "bao quat",
    "bao quat hon",
    "chi tiet",
    "chi tiet hon",
    "lam lai",
    "sua lai",
    "lam moi",
    "chart thua",
    "bieu do thua",
    "qua nhieu chart",
    "qua nhieu bieu do",
    "xoa bot",
    "bo chart thua",
    "vo nghia",
    "khong co bao cao",
    "khong bao quat",
    "khong co du lieu gi",
    "khong co du lieu",
    "table khac",
    "tables khac",
    "cac bang khac",
    "other tables",
    "all tables",
    "look through",
    "review all",
    "rebuild dashboard",
    "refresh dashboard",
    "summarize all",
    "cover more",
  ];

  return rebuildSignals.some((signal) => normalizedPrompt.includes(signal));
}

function buildWorkspaceOverviewChartSql(dbType?: DatabaseType) {
  switch (dbType) {
    case "postgresql":
    case "cockroachdb":
    case "greenplum":
    case "redshift":
      return [
        "SELECT",
        "  relname AS label,",
        "  COALESCE(n_live_tup, 0)::bigint AS value",
        "FROM pg_stat_user_tables",
        "WHERE schemaname NOT IN ('pg_catalog', 'information_schema')",
        "ORDER BY value DESC NULLS LAST, label ASC",
        "LIMIT 12;",
      ].join("\n");
    case "mysql":
    case "mariadb":
      return [
        "SELECT",
        "  table_name AS label,",
        "  COALESCE(table_rows, 0) AS value",
        "FROM information_schema.tables",
        "WHERE table_schema = DATABASE()",
        "ORDER BY value DESC, label ASC",
        "LIMIT 12;",
      ].join("\n");
    case "mssql":
      return [
        "SELECT TOP (12)",
        "  t.name AS label,",
        "  SUM(p.rows) AS value",
        "FROM sys.tables t",
        "JOIN sys.partitions p",
        "  ON t.object_id = p.object_id",
        " AND p.index_id IN (0, 1)",
        "GROUP BY t.name",
        "ORDER BY value DESC, label ASC;",
      ].join("\n");
    default:
      return null;
  }
}

function isOverviewVisualizationPrompt(prompt: string, intent?: string) {
  const normalizedPrompt = prompt.trim().toLowerCase();
  const overviewSignals = [
    "overview",
    "database overview",
    "schema overview",
    "tong quan",
    "tổng quan",
    "overview db",
    "overview database",
  ];

  const hasOverviewSignal =
    intent === "overview" || overviewSignals.some((signal) => normalizedPrompt.includes(signal));

  return hasOverviewSignal && isVisualizationPrompt(normalizedPrompt);
}

function isSingleSqlStatement(sql: string) {
  try {
    return splitSqlStatements(sql).length === 1;
  } catch {
    return false;
  }
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
  initialAttachment,
  initialAttachmentNonce = 0,
  onClose,
}: Props) {
  const { language } = useI18n();
  const aiCopy = useMemo(() => getAIWorkspaceCopy(language), [language]);
  const aiConfigs = useAppStore((state) => state.aiConfigs);
  const loadAIConfigs = useAppStore((state) => state.loadAIConfigs);
  const saveAIConfigs = useAppStore((state) => state.saveAIConfigs);
  const activeConnectionDbType = useAppStore((state) =>
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
    isRunning,
    generateAssist,
    copyText,
    insertSql,
    runSql,
  } = useAISlidePanel({ isOpen });

  const composerRef = useRef<HTMLDivElement>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement>(null);
  const chatThreadRef = useRef<HTMLDivElement>(null);
  const historyPanelRef = useRef<HTMLDivElement>(null);
  const modeMenuRef = useRef<HTMLDivElement>(null);
  const autonomyMenuRef = useRef<HTMLDivElement>(null);
  const providerMenuRef = useRef<HTMLDivElement>(null);
  const bubbleDismissTimersRef = useRef(new Map<string, number>());
  const historySaveTimerRef = useRef<number | null>(null);
  const openSessionRef = useRef(0);
  const isOpenRef = useRef(isOpen);
  const visualizationConsentResolverRef = useRef<((value: boolean) => void) | null>(null);
  const visualizationApprovalScopeRef = useRef<string | null>(null);
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
  const [isAutonomyMenuOpen, setIsAutonomyMenuOpen] = useState(false);
  const [activeThreadIdsByWorkspace, setActiveThreadIdsByWorkspace] = useState<Record<string, string>>(
    {}
  );
  const [activeThreadId, setActiveThreadId] = useState<string>(initialThreadRef.current!.id);
  const [historyHydrated, setHistoryHydrated] = useState(false);
  const [detailBubbleId, setDetailBubbleId] = useState<string | null>(null);
  const [isInspectMode, setIsInspectMode] = useState(false);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [isModeMenuOpen, setIsModeMenuOpen] = useState(false);
  const [isProviderMenuOpen, setIsProviderMenuOpen] = useState(false);
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
  const ActiveInteractionModeIcon = getInteractionModeIcon(activeInteractionMode);
  const ActiveAgentAutonomyIcon = getAgentAutonomyIcon(activeAgentAutonomy);
  const activeProviderValue = activeProvider?.model?.trim() || activeProvider?.name?.trim() || aiCopy.composer.noProvider;
  const activeProviderCaption = activeProvider
    ? activeProvider.name?.trim() && activeProvider.name.trim() !== activeProviderValue
      ? activeProvider.name.trim()
      : formatProviderTypeLabel(activeProvider.provider_type)
    : aiCopy.composer.openSettings;
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

  const scrollChatToLatest = useCallback(() => {
    window.requestAnimationFrame(() => {
      const thread = chatThreadRef.current;
      if (!thread) return;
      thread.scrollTop = thread.scrollHeight;

      window.requestAnimationFrame(() => {
        const currentThreadElement = chatThreadRef.current;
        if (!currentThreadElement) return;
        currentThreadElement.scrollTop = currentThreadElement.scrollHeight;
      });
    });
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
    if (!connectionId || !isVisualizationPrompt(promptText)) {
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
    const databaseLabel = currentDatabase || "current database";

    return new Promise<boolean>((resolve) => {
      visualizationConsentResolverRef.current = resolve;
      setVisualizationConsentPending({
        title: isVietnamese ? "Cap quyen doc data de ve bieu do?" : "Allow AI to read data for charts?",
        message: isVietnamese
          ? `Model hien da co schema capsule de hieu cau truc DB. Buoc tiep theo can doc du lieu chi-doc trong ${databaseLabel} de tao chart/dashboard. TableR se chi cho phep doc du lieu trong session AI hien tai. Ban co muon tiep tuc khong?`
          : `The model already has a schema capsule for structure. The next step needs read-only access to live data in ${databaseLabel} to build charts or dashboards. TableR will scope this to the current AI session only. Continue?`,
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
          (thread) => thread.workspaceKey === currentWorkspaceKey
        );
        const preferredThreadId = persistedState.activeThreadIds[currentWorkspaceKey];
        const nextThreadId =
          workspaceThreadsForCurrentKey.find((thread) => thread.id === preferredThreadId)?.id ??
          [...workspaceThreadsForCurrentKey].sort((left, right) => right.updatedAt - left.updatedAt)[0]?.id ??
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
    if (!isModeMenuOpen && !isProviderMenuOpen) return;

    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (target && modeMenuRef.current?.contains(target)) return;
      if (target && providerMenuRef.current?.contains(target)) return;
      setIsModeMenuOpen(false);
      setIsProviderMenuOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsModeMenuOpen(false);
        setIsProviderMenuOpen(false);
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
  }, [isModeMenuOpen, isProviderMenuOpen]);

  useEffect(() => {
    if (!isAutonomyMenuOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsAutonomyMenuOpen(false);
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [isAutonomyMenuOpen]);

  useEffect(() => {
    if (!historyHydrated) return;

    if (workspaceThreads.length === 0) {
      const nextThread = createChatThread(1, currentWorkspaceKey);
      setChatThreads((current) => (
        current.some((thread) => thread.workspaceKey === currentWorkspaceKey)
          ? current
          : [...current, nextThread]
      ));
      setActiveThreadId(nextThread.id);
      setActiveThreadIdsByWorkspace((current) => ({
        ...current,
        [currentWorkspaceKey]: nextThread.id,
      }));
      return;
    }

    const preferredThreadId = activeThreadIdsByWorkspace[currentWorkspaceKey];
    const nextActiveThread =
      workspaceThreads.find((thread) => thread.id === preferredThreadId) ??
      recentWorkspaceThreads[0] ??
      workspaceThreads[0] ??
      null;

    if (nextActiveThread && nextActiveThread.id !== activeThreadId) {
      setActiveThreadId(nextActiveThread.id);
    }
  }, [activeThreadId, activeThreadIdsByWorkspace, currentWorkspaceKey, historyHydrated, recentWorkspaceThreads, workspaceThreads]);

  useEffect(() => {
    if (!currentThread?.id) return;
    setActiveThreadIdsByWorkspace((current) => (
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
      if (historySaveTimerRef.current !== null) {
        window.clearTimeout(historySaveTimerRef.current);
        historySaveTimerRef.current = null;
      }
    };
  }, []);

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
      persistHistoryState(nextState).catch((error) => {
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

    const requestId = createId();

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

  const updateBubbleForDashboardNoChange = useCallback((bubbleId: string, promptText: string, addedCount = 0) => {
    const useVietnamese = prefersVietnameseSystemReply(promptText, language);
    const preview = useVietnamese
      ? "Dashboard hien tai chua co widget moi de them tu dong. Mình giu chat mo de ban noi ro muon them hoac doi chart nao."
      : "The current dashboard does not have new widgets to add automatically yet. I kept chat open so you can tell me which charts to add or change.";
    const detail = useVietnamese
      ? [
          "Dashboard hien tai da duoc mo, nhung TableR chua tim thay chart moi de them vao board nay tu template hien co.",
          addedCount > 0 ? `So widget vua them: ${addedCount}.` : "Chua co thay doi chart nao duoc ap dung.",
          "",
          "Hay noi ro hon, vi du:",
          "- them bieu do kich thuoc bang",
          "- doi pie chart nay thanh bar chart",
          "- them widget thong ke tong so cot",
        ].join("\n")
      : [
          "The dashboard is open, but TableR did not find any new template widgets to add to this board.",
          addedCount > 0 ? `Widgets added just now: ${addedCount}.` : "No chart changes were applied.",
          "",
          "Try being more specific, for example:",
          "- add a table size chart",
          "- change this pie chart to a bar chart",
          "- add a total columns scoreboard",
        ].join("\n");

    setBubbles((current) =>
      current.map((bubble) =>
        bubble.id === bubbleId
          ? {
              ...bubble,
              kind: "assistant",
              status: "ready",
              title: useVietnamese ? "Dashboard chua thay doi" : "Dashboard unchanged",
              subtitle: useVietnamese ? "Khong co chart moi duoc ap dung" : "No new chart changes were applied",
              preview,
              detail,
              sql: undefined,
              risk: undefined,
              autoDismissAt: undefined,
            }
          : bubble,
      ),
    );
  }, [language]);

  const updateBubbleForDashboardActionFailed = useCallback((
    bubbleId: string,
    promptText: string,
    reason?: string,
  ) => {
    const useVietnamese = prefersVietnameseSystemReply(promptText, language);
    const fallbackReason = useVietnamese
      ? "TableR khong the hoan tat thao tac dashboard trong lan nay."
      : "TableR could not finish the dashboard action for this request.";
    const resolvedReason = reason?.trim() || fallbackReason;
    const preview = useVietnamese
      ? "Thao tac dashboard da dung lai, chat van mo de ban thu lai hoac doi yeu cau cu the hon."
      : "The dashboard action stopped here. Chat stays open so you can retry or make the request more specific.";
    const detail = useVietnamese
      ? [
          resolvedReason,
          "",
          "Ban co the thu lai voi cac yeu cau ro hon, vi du:",
          "- doi OAuth Clients thanh scoreboard",
          "- lam moi dashboard nay theo schema hien tai",
          "- bo cac chart thua va giu lai chart co y nghia",
        ].join("\n")
      : [
          resolvedReason,
          "",
          "Try again with a more specific request, for example:",
          '- change "OAuth Clients" to a scoreboard',
          "- rebuild this dashboard from the current schema",
          "- remove redundant charts and keep only useful ones",
        ].join("\n");

    setBubbles((current) =>
      current.map((bubble) =>
        bubble.id === bubbleId
          ? {
              ...bubble,
              kind: "assistant",
              status: "error",
              title: useVietnamese ? "Thao tac dashboard khong thanh cong" : "Dashboard action failed",
              subtitle: useVietnamese ? "Khong ap dung thay doi nao" : "No dashboard change was applied",
              preview,
              detail,
              sql: undefined,
              risk: undefined,
              autoDismissAt: undefined,
            }
          : bubble,
      ),
    );
  }, [language]);

  const updateBubbleForDashboardEditNeedsClarification = useCallback((bubbleId: string, promptText: string) => {
    const useVietnamese = prefersVietnameseSystemReply(promptText, language);
    const preview = useVietnamese
      ? "MĂ¬nh giu nguyen thao tac trong dashboard, nhung chua xac dinh chinh xac widget hoac loai chart can doi."
      : "I stayed in dashboard edit mode, but I could not identify the exact widget or replacement chart yet.";
    const detail = useVietnamese
      ? [
          "TableR da giu yeu cau nay trong dashboard hien tai thay vi mo query ben ngoai.",
          "Nhung de sua dung widget, minh can ban noi ro hon mot chut, vi du:",
          "- doi OAuth Clients thanh scoreboard",
          "- doi Average Rating by Product thanh table",
          "- doi pie chart Products by Brand thanh bar chart",
        ].join("\n")
      : [
          "TableR kept this request inside the current dashboard instead of opening an external query tab.",
          "To edit the correct widget, be a bit more specific, for example:",
          '- change "OAuth Clients" to a scoreboard',
          '- change "Average Rating by Product" to a table',
          '- change the pie chart "Products by Brand" to a bar chart',
        ].join("\n");

    setBubbles((current) =>
      current.map((bubble) =>
        bubble.id === bubbleId
          ? {
              ...bubble,
              kind: "assistant",
              status: "ready",
              title: useVietnamese ? "Can noi ro widget can sua" : "Need a clearer widget target",
              subtitle: useVietnamese ? "Chua sua dashboard vi chua map duoc widget" : "Dashboard edit was not applied yet",
              preview,
              detail,
              sql: undefined,
              risk: undefined,
              autoDismissAt: undefined,
            }
          : bubble,
      ),
    );
  }, [language]);

  const updateBubbleForAttachedDashboardSummary = useCallback((
    bubbleId: string,
    promptText: string,
    selection: SelectionContextState,
  ) => {
    const useVietnamese = prefersVietnameseSystemReply(promptText, language);
    const summary = summarizeAttachedDashboardSelection(selection);
    const topTitles = summary.widgetTitles.slice(0, 6);
    const remainingCount = Math.max(0, summary.widgetCount - topTitles.length);

    const preview = useVietnamese
      ? `Minh da doc snapshot cua board "${summary.boardName}" ngay trong app, khong can goi them model hay mo query ben ngoai.`
      : `I read the attached snapshot for "${summary.boardName}" locally, without calling the model or opening an external query.`;

    const detail = useVietnamese
      ? [
          `Board hien tai: ${summary.boardName}`,
          `So widget dang co: ${summary.widgetCount}`,
          topTitles.length > 0 ? `Widget dang hien: ${topTitles.join(", ")}.` : "",
          remainingCount > 0 ? `Con ${remainingCount} widget nua dang co tren board nay.` : "",
          "",
          "Ban co the noi ro tiep, vi du:",
          "- doi OAuth Clients thanh scoreboard",
          "- xoa cac chart thua",
          "- sap xep lai hang dau cho gon hon",
          "- lam moi dashboard nay theo data hien tai",
        ].filter(Boolean).join("\n")
      : [
          `Current board: ${summary.boardName}`,
          `Current widget count: ${summary.widgetCount}`,
          topTitles.length > 0 ? `Visible widgets: ${topTitles.join(", ")}.` : "",
          remainingCount > 0 ? `${remainingCount} more widget(s) are also present on this board.` : "",
          "",
          "You can be more specific next, for example:",
          '- change "OAuth Clients" to a scoreboard',
          "- remove redundant charts",
          "- tighten the first row layout",
          "- rebuild this dashboard from the current data",
        ].filter(Boolean).join("\n");

    setBubbles((current) =>
      current.map((bubble) =>
        bubble.id === bubbleId
          ? {
              ...bubble,
              kind: "assistant",
              status: "ready",
              title: useVietnamese ? "Da doc snapshot dashboard" : "Dashboard snapshot loaded",
              subtitle: useVietnamese ? "San sang sua truc tiep tren board hien tai" : "Ready to edit the current board directly",
              preview,
              detail,
              sql: undefined,
              risk: undefined,
              autoDismissAt: undefined,
            }
          : bubble,
      ),
    );
  }, [language]);

  const updateBubbleForDashboardApplied = useCallback((
    bubbleId: string,
    promptText: string,
    addedCount = 0,
    addedTitles: string[] = [],
  ) => {
    const normalizedCount = Math.max(0, addedCount);
    const useVietnamese = prefersVietnameseSystemReply(promptText, language);
    const summarizedTitles = addedTitles.slice(0, 4);
    const title = useVietnamese
      ? normalizedCount > 0
        ? "Da bo sung dashboard"
        : "Dashboard da duoc dong bo"
      : normalizedCount > 0
        ? "Dashboard updated"
        : "Dashboard synced";
    const subtitle = useVietnamese
      ? normalizedCount > 0
        ? `Da them ${normalizedCount} widget moi vao board hien tai`
        : "Khong can tao board moi"
      : normalizedCount > 0
        ? `Added ${normalizedCount} new widget${normalizedCount === 1 ? "" : "s"} to the current board`
        : "No new board was created";
    const preview = useVietnamese
      ? normalizedCount > 0
        ? `Mình da bo sung ${normalizedCount} widget vao dashboard hien tai va giu chat mo de ban chinh tiep.`
        : "Mình da dong bo dashboard hien tai va giu chat mo de ban chinh tiep."
      : normalizedCount > 0
        ? `I added ${normalizedCount} chart widget${normalizedCount === 1 ? "" : "s"} directly to the current dashboard and kept chat open for follow-up changes.`
        : "I updated the current dashboard and kept chat open for follow-up changes.";
    const detail = useVietnamese
      ? [
          normalizedCount > 0
            ? `Dashboard hien tai da duoc cap nhat voi ${normalizedCount} widget moi.`
            : "Dashboard hien tai da duoc mo va dong bo lai.",
          summarizedTitles.length > 0 ? `Da them: ${summarizedTitles.join(", ")}.` : "",
          "",
          "Ban co the yeu cau tiep, vi du:",
          "- doi pie chart thanh bar chart",
          "- them bieu do kich thuoc bang",
          "- gop bieu do score vao hang dau",
        ].filter(Boolean).join("\n")
      : [
          normalizedCount > 0
            ? `The current dashboard was updated with ${normalizedCount} new widget${normalizedCount === 1 ? "" : "s"}.`
            : "The current dashboard is active and ready for more edits.",
          summarizedTitles.length > 0 ? `Added: ${summarizedTitles.join(", ")}.` : "",
          "",
          "You can keep going, for example:",
          "- change the pie chart to a bar chart",
          "- add a table size chart",
          "- move the score widgets to the first row",
        ].filter(Boolean).join("\n");

    setBubbles((current) =>
      current.map((bubble) =>
        bubble.id === bubbleId
          ? {
              ...bubble,
              kind: "assistant",
              status: "ready",
              title,
              subtitle,
              preview,
              detail,
              sql: undefined,
              risk: undefined,
              autoDismissAt: undefined,
            }
          : bubble,
      ),
    );
  }, [language]);

  const updateBubbleForDashboardEdited = useCallback((
    bubbleId: string,
    promptText: string,
    widgetTitle: string,
    nextType: MetricsWidgetType,
  ) => {
    const useVietnamese = prefersVietnameseSystemReply(promptText, language);
    const chartTypeLabel =
      nextType === "table"
        ? useVietnamese ? "bang du lieu" : "table"
        : nextType === "scoreboard"
          ? useVietnamese ? "scoreboard" : "scoreboard"
          : nextType === "bar"
            ? useVietnamese ? "bar chart" : "bar chart"
            : nextType === "line"
              ? useVietnamese ? "line chart" : "line chart"
              : useVietnamese ? "pie chart" : "pie chart";

    setBubbles((current) =>
      current.map((bubble) =>
        bubble.id === bubbleId
          ? {
              ...bubble,
              kind: "assistant",
              status: "ready",
              title: useVietnamese ? "Da sua widget tren dashboard" : "Dashboard widget updated",
              subtitle: useVietnamese
                ? `Da doi "${widgetTitle}" sang ${chartTypeLabel}`
                : `Changed "${widgetTitle}" to ${chartTypeLabel}`,
              preview: useVietnamese
                ? `MĂ¬nh da sua truc tiep widget "${widgetTitle}" tren dashboard hien tai.`
                : `I updated "${widgetTitle}" directly on the current dashboard.`,
              detail: useVietnamese
                ? [
                    `Widget "${widgetTitle}" da duoc doi sang ${chartTypeLabel} ngay tren board hien tai.`,
                    "",
                    "Ban co the yeu cau tiep, vi du:",
                    "- doi tiep widget nay thanh line chart",
                    "- sua query cua widget nay",
                    "- xoa widget nay neu khong can nua",
                  ].join("\n")
                : [
                    `The widget "${widgetTitle}" was updated to ${chartTypeLabel} on the current board.`,
                    "",
                    "You can keep going, for example:",
                    "- change this widget to a line chart",
                    "- update this widget query",
                    "- remove this widget if it is not useful",
                  ].join("\n"),
              sql: undefined,
              risk: undefined,
              autoDismissAt: undefined,
            }
          : bubble,
      ),
    );
  }, [language]);

  const updateBubbleForDashboardRebuilt = useCallback((
    bubbleId: string,
    promptText: string,
    widgetCount = 0,
    widgetTitles: string[] = [],
  ) => {
    const normalizedCount = Math.max(0, widgetCount);
    const useVietnamese = prefersVietnameseSystemReply(promptText, language);
    const summarizedTitles = widgetTitles.slice(0, 5);
    const title = useVietnamese ? "Da lam moi dashboard" : "Dashboard rebuilt";
    const subtitle = useVietnamese
      ? `Da tao lai ${normalizedCount} widget theo schema hien tai`
      : `Rebuilt ${normalizedCount} widget${normalizedCount === 1 ? "" : "s"} from the current schema`;
    const preview = useVietnamese
      ? `MĂ¬nh da lam moi dashboard hien tai dua tren schema/DB dang mo va giu chat mo de ban chinh tiep.`
      : "I rebuilt the current dashboard from the live schema and kept chat open for follow-up edits.";
    const detail = useVietnamese
      ? [
          `Dashboard hien tai da duoc lam moi lai voi ${normalizedCount} widget bam sat schema hien tai.`,
          summarizedTitles.length > 0 ? `Widget chinh: ${summarizedTitles.join(", ")}.` : "",
          "",
          "Ban co the yeu cau tiep, vi du:",
          "- doi pie chart thanh bar chart",
          "- xoa widget nao chua can",
          "- uu tien chart ve users, orders, auth, hoac messages",
        ].filter(Boolean).join("\n")
      : [
          `The current dashboard was rebuilt with ${normalizedCount} widget${normalizedCount === 1 ? "" : "s"} based on the live schema.`,
          summarizedTitles.length > 0 ? `Main widgets: ${summarizedTitles.join(", ")}.` : "",
          "",
          "You can keep going, for example:",
          "- change the pie chart to a bar chart",
          "- remove widgets you do not need",
          "- focus the board on users, orders, auth, or messaging",
        ].filter(Boolean).join("\n");

    setBubbles((current) =>
      current.map((bubble) =>
        bubble.id === bubbleId
          ? {
              ...bubble,
              kind: "assistant",
              status: "ready",
              title,
              subtitle,
              preview,
              detail,
              sql: undefined,
              risk: undefined,
              autoDismissAt: undefined,
            }
          : bubble,
      ),
    );
  }, [language]);

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

  const createAssistantBubble = useCallback(async (
    prompt: string,
    options?: {
      displayPrompt?: string;
      userPrompt?: string;
      attachmentSource?: string;
      mode?: "compose" | "inspect";
      history?: AIConversationMessage[];
      threadId?: string;
      workspaceKey?: string;
      interactionMode?: AIWorkspaceInteractionMode;
    }
  ) => {
    const normalizedPrompt = prompt.trim();
    if (!normalizedPrompt) return;
    const requestPrompt = options?.userPrompt?.trim() || normalizedPrompt;

    setError(null);
    const targetWorkspaceKey = options?.workspaceKey || currentWorkspaceKey;
    const targetThreadId = options?.threadId || currentThread?.id || workspaceThreads[0]?.id || createId();
    const interactionMode = options?.interactionMode || activeInteractionMode;
    const sessionId = openSessionRef.current;
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
        thread.id === targetThreadId
          ? {
              ...thread,
              updatedAt: loadingBubble.createdAt,
              ...(thread.isAutoLabel
                ? {
                    label: buildThreadLabel(loadingBubble.promptSummary || normalizedPrompt, index + 1),
                    isAutoLabel: false,
                  }
                : {}),
            }
          : thread
      )
    );
    setActiveThreadIdsByWorkspace((current) => ({
      ...current,
      [targetWorkspaceKey]: targetThreadId,
    }));

    await waitForUIPaint();

    const hasAttachedDashboardSelection =
      isDashboardSelectionSource(options?.attachmentSource) ||
      hasMetricsDashboardAttachmentContext(normalizedPrompt);
    const dashboardEditConversationContext =
      latestReadyAssistantBubble?.detail ||
      latestReadyAssistantBubble?.preview ||
      "";
    const directDashboardWidgetEdit =
      hasAttachedDashboardSelection
        ? resolveDashboardWidgetEditInstruction(requestPrompt, attachedSelection, dashboardEditConversationContext)
        : null;
    const shouldStayInDashboardEditContext =
      hasAttachedDashboardSelection &&
      !directDashboardWidgetEdit &&
      isDashboardWidgetAdjustmentPrompt(requestPrompt);
    const shouldHandleDashboardReferenceLocally =
      hasAttachedDashboardSelection &&
      !directDashboardWidgetEdit &&
      !isDashboardRebuildPrompt(requestPrompt) &&
      !isDashboardAugmentPrompt(requestPrompt) &&
      isDashboardAttachmentReferencePrompt(requestPrompt);
    const shouldRebuildDashboardDirectly =
      supportsOverviewMetricsBoard(activeConnectionDbType) &&
      hasAttachedDashboardSelection &&
      isDashboardRebuildPrompt(requestPrompt);
    const shouldAugmentDashboardDirectly =
      supportsOverviewMetricsBoard(activeConnectionDbType) &&
      !directDashboardWidgetEdit &&
      isDashboardAugmentPrompt(requestPrompt);

    if (shouldRebuildDashboardDirectly) {
      const visualizationReadApproved = await requestVisualizationReadConsent(requestPrompt);
      if (!visualizationReadApproved) {
        setError(
          prefersVietnameseSystemReply(requestPrompt, language)
            ? "Ban chua cap quyen doc data trong DB cho yeu cau visualization nay."
            : "Visualization data access was not approved for this request."
        );
        return { success: false, cancelled: true };
      }

      const dashboardResult = await openMetricsBoardInWorkspace({
        template: "database-overview",
        mode: "rebuild",
        focusWorkspace: true,
      });

      if (dashboardResult.success && dashboardResult.didChange) {
        updateBubbleForDashboardRebuilt(
          loadingBubble.id,
          requestPrompt,
          dashboardResult.addedCount,
          dashboardResult.addedTitles,
        );
        return { bubbleId: loadingBubble.id, success: true };
      }
      if (dashboardResult.success) {
        updateBubbleForDashboardNoChange(loadingBubble.id, requestPrompt, dashboardResult.addedCount);
        return { bubbleId: loadingBubble.id, success: true };
      }
      updateBubbleForDashboardActionFailed(loadingBubble.id, requestPrompt, dashboardResult.error);
      return { bubbleId: loadingBubble.id, success: false };
    }

    if (shouldAugmentDashboardDirectly) {
      const visualizationReadApproved = await requestVisualizationReadConsent(requestPrompt);
      if (!visualizationReadApproved) {
        setError(
          prefersVietnameseSystemReply(requestPrompt, language)
            ? "Ban chua cap quyen doc data trong DB cho yeu cau visualization nay."
            : "Visualization data access was not approved for this request."
        );
        return { success: false, cancelled: true };
      }

      const dashboardResult = await openMetricsBoardInWorkspace({
        title: "DB Overview Dashboard",
        template: "database-overview",
        mode: "augment",
        focusWorkspace: true,
      });

        if (dashboardResult.success && dashboardResult.didChange) {
          if (dashboardResult.created) {
            completeWorkspaceRedirect(loadingBubble.id, sessionId);
          } else {
            updateBubbleForDashboardApplied(
              loadingBubble.id,
              requestPrompt,
              dashboardResult.addedCount,
              dashboardResult.addedTitles,
            );
          }
          return { bubbleId: loadingBubble.id, success: true };
        }
        if (dashboardResult.success) {
        updateBubbleForDashboardNoChange(loadingBubble.id, requestPrompt, dashboardResult.addedCount);
          return { bubbleId: loadingBubble.id, success: true };
        }
      updateBubbleForDashboardActionFailed(loadingBubble.id, requestPrompt, dashboardResult.error);
      return { bubbleId: loadingBubble.id, success: false };
    }

    if (directDashboardWidgetEdit) {
      const dashboardResult = await openMetricsBoardInWorkspace({
        mode: "edit",
        boardId: directDashboardWidgetEdit.boardId,
        editTargetTitle: directDashboardWidgetEdit.targetTitle,
        editTargetType: directDashboardWidgetEdit.nextType,
        editQuery: directDashboardWidgetEdit.nextQuery,
        editTitle: directDashboardWidgetEdit.nextTitle,
        focusWorkspace: true,
      });

      if (dashboardResult.success && dashboardResult.didChange) {
        updateBubbleForDashboardEdited(
          loadingBubble.id,
          requestPrompt,
          directDashboardWidgetEdit.targetTitle,
          directDashboardWidgetEdit.nextType,
        );
        return { bubbleId: loadingBubble.id, success: true };
      }
      if (dashboardResult.success) {
        updateBubbleForDashboardNoChange(loadingBubble.id, requestPrompt, dashboardResult.addedCount);
        return { bubbleId: loadingBubble.id, success: true };
      }
      updateBubbleForDashboardActionFailed(loadingBubble.id, requestPrompt, dashboardResult.error);
      return { bubbleId: loadingBubble.id, success: false };
    }

    if (shouldStayInDashboardEditContext) {
      updateBubbleForDashboardEditNeedsClarification(loadingBubble.id, requestPrompt);
      return { bubbleId: loadingBubble.id, success: true };
    }

    if (shouldHandleDashboardReferenceLocally && attachedSelection) {
      updateBubbleForAttachedDashboardSummary(loadingBubble.id, requestPrompt, attachedSelection);
      return { bubbleId: loadingBubble.id, success: true };
    }

    try {
      const result = await generateAssist(normalizedPrompt, options?.history, {
        interactionMode,
        requestDataReadConsent: () => requestVisualizationReadConsent(requestPrompt),
        userPrompt: requestPrompt,
        onAgentProgress: (steps) => {
          if (openSessionRef.current !== sessionId) return;
          setBubbles((current) =>
            current.map((bubble) =>
              bubble.id === loadingBubble.id ? { ...bubble, agentSteps: steps } : bubble
            )
          );
        },
      });
      const readyTitle = options?.mode === "inspect"
        ? aiCopy.bubbleStates.readyInspectTitle
        : result.intent === "optimize"
          ? aiCopy.bubbleStates.readyOptimizeTitle
          : result.intent === "fix-error"
            ? aiCopy.bubbleStates.readyFixErrorTitle
            : result.sql
              ? aiCopy.bubbleStates.readySqlTitle
              : aiCopy.bubbleStates.readyNoteTitle;
      const readySubtitle = options?.mode === "inspect"
        ? result.sql
          ? aiCopy.bubbleStates.readyInspectSqlSubtitle
          : aiCopy.bubbleStates.readyInspectNoteSubtitle
        : result.intent === "optimize"
          ? aiCopy.bubbleStates.readyOptimizeSubtitle
          : result.intent === "fix-error"
            ? aiCopy.bubbleStates.readyFixErrorSubtitle
            : result.sql
              ? result.risk?.level === "safe" ? aiCopy.bubbleStates.readySqlSafeSubtitle : aiCopy.bubbleStates.readySqlReviewSubtitle
              : aiCopy.bubbleStates.readyNoteSubtitle;
      const readyPreview = summarizeResponse(result.rawResponse, result.sql);
      const wantsVisualization = isVisualizationPrompt(requestPrompt);
      const wantsMetricsDashboard =
        isDashboardVisualizationPrompt(requestPrompt, result.intent) &&
        supportsOverviewMetricsBoard(activeConnectionDbType);
      const deterministicOverviewChartSql =
        isOverviewVisualizationPrompt(requestPrompt, result.intent)
          ? buildWorkspaceOverviewChartSql(activeConnectionDbType)
          : null;
      const preferredVisualizationSql =
        deterministicOverviewChartSql ||
        (result.sql && isSingleSqlStatement(result.sql) ? result.sql : null);

      if (wantsMetricsDashboard) {
        const visualizationReadApproved = await requestVisualizationReadConsent(requestPrompt);
        if (!visualizationReadApproved) {
          setError(
            prefersVietnameseSystemReply(requestPrompt, language)
              ? "Ban chua cap quyen doc data trong DB cho yeu cau visualization nay."
              : "Visualization data access was not approved for this request."
          );
          return { bubbleId: loadingBubble.id, success: false, cancelled: true };
        }

        const dashboardOpened = await openMetricsBoardInWorkspace({
          title: "DB Overview Dashboard",
          template: "database-overview",
          focusWorkspace: true,
        });

        if (dashboardOpened.success && dashboardOpened.didChange) {
          if (dashboardOpened.created) {
            completeWorkspaceRedirect(loadingBubble.id, sessionId);
          } else {
            updateBubbleForDashboardApplied(
              loadingBubble.id,
              requestPrompt,
              dashboardOpened.addedCount,
              dashboardOpened.addedTitles,
            );
          }
          return { bubbleId: loadingBubble.id, success: true };
        }
        if (dashboardOpened.success) {
          updateBubbleForDashboardNoChange(loadingBubble.id, requestPrompt, dashboardOpened.addedCount);
          return { bubbleId: loadingBubble.id, success: true };
        }
        updateBubbleForDashboardActionFailed(loadingBubble.id, requestPrompt, dashboardOpened.error);
        return { bubbleId: loadingBubble.id, success: false };
      }

      if (wantsVisualization && preferredVisualizationSql) {
        const autoRunInWorkspace =
          deterministicOverviewChartSql !== null || result.risk?.level === "safe";
        if (autoRunInWorkspace) {
          const visualizationReadApproved = await requestVisualizationReadConsent(requestPrompt);
          if (!visualizationReadApproved) {
            setError(
              prefersVietnameseSystemReply(requestPrompt, language)
                ? "Ban chua cap quyen doc data trong DB cho yeu cau visualization nay."
                : "Visualization data access was not approved for this request."
            );
            return { bubbleId: loadingBubble.id, success: false, cancelled: true };
          }
        }
        const workspaceOpened = openSqlInWorkspace(preferredVisualizationSql, {
          title: deterministicOverviewChartSql ? "DB Overview Chart" : "AI Chart",
          viewMode: "chart",
          autoRun: autoRunInWorkspace,
          focusWorkspace: true,
        });

        if (workspaceOpened) {
          completeWorkspaceRedirect(loadingBubble.id, sessionId);
          return { bubbleId: loadingBubble.id, success: true };
        }
      }

      const agentCanAutoRun =
        interactionMode === "agent" &&
        Boolean(result.sql) &&
        (
          result.intent === "sql" ||
          result.intent === "optimize" ||
          result.intent === "fix-error" ||
          wantsVisualization
        ) &&
        shouldAgentAutoRunSql(activeAgentAutonomy, result.risk?.level);
      if (agentCanAutoRun && result.sql) {
        try {
          const runResult = await runSql(result.sql, {
            skipMutationConfirm: activeAgentAutonomy === "full",
            skipHighRiskConfirm: activeAgentAutonomy === "full",
          });
          setBubbles((current) =>
            current.map((bubble) =>
              bubble.id === loadingBubble.id
                ? {
                    ...bubble,
                    kind: "result",
                    status: "ready",
                    title: aiCopy.bubbleStates.runSuccessTitle,
                    subtitle: runResult.queryResult.sandboxed
                      ? aiCopy.bubbleStates.runSuccessSandboxSubtitle
                      : aiCopy.bubbleStates.runSuccessDirectSubtitle,
                    promptSummary: loadingBubble.promptSummary,
                    preview: runResult.summary,
                    detail: buildExecutionDetail(runResult.summary, runResult.queryResult.query, result.rawResponse),
                    sql: result.sql || undefined,
                    risk: result.risk,
                    reasoning: result.reasoning,
                    agentSteps: result.agentSteps,
                    autoDismissAt: undefined,
                  }
                : bubble
            )
          );
          return { bubbleId: loadingBubble.id, success: true };
        } catch (errorValue) {
          const message = errorValue instanceof Error ? errorValue.message : String(errorValue);
          setBubbles((current) =>
            current.map((bubble) =>
              bubble.id === loadingBubble.id
                ? {
                    ...bubble,
                    kind: "assistant",
                    status: "ready",
                    title: readyTitle,
                    subtitle: aiCopy.bubbleStates.runFailedSubtitle,
                    promptSummary: loadingBubble.promptSummary,
                    preview: message,
                    detail: buildAutoRunFailureDetail(message, result.sql || "", result.rawResponse),
                    sql: result.sql || undefined,
                    risk: result.risk,
                    reasoning: result.reasoning,
                    agentSteps: result.agentSteps,
                    autoDismissAt: undefined,
                  }
                : bubble
            )
          );
          return { bubbleId: loadingBubble.id, success: true };
        }
      }

      setBubbles((current) =>
        current.map((bubble) =>
          bubble.id === loadingBubble.id
            ? {
                ...bubble,
                status: "ready",
                title: readyTitle,
                subtitle: readySubtitle,
                promptSummary: loadingBubble.promptSummary,
                preview: readyPreview,
                detail: result.rawResponse,
                sql: result.sql || undefined,
                risk: result.risk,
                reasoning: result.reasoning,
                agentSteps: result.agentSteps,
              }
            : bubble
        )
      );
      return { bubbleId: loadingBubble.id, success: true };
    } catch (errorValue) {
      if (isSupersededAIRequestError(errorValue)) {
        setBubbles((current) => current.filter((bubble) => bubble.id !== loadingBubble.id));
        return { bubbleId: loadingBubble.id, success: false, cancelled: true };
      }

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
  }, [
    activeAgentAutonomy,
    activeConnectionDbType,
    activeInteractionMode,
    aiCopy,
    attachedSelection,
    buildLoadingBubble,
    currentThread,
    currentWorkspaceKey,
    generateAssist,
    language,
    latestReadyAssistantBubble,
    completeWorkspaceRedirect,
    openMetricsBoardInWorkspace,
    openSqlInWorkspace,
    requestVisualizationReadConsent,
    runSql,
    setError,
    updateBubbleForDashboardApplied,
    updateBubbleForDashboardActionFailed,
    updateBubbleForAttachedDashboardSummary,
    updateBubbleForDashboardEditNeedsClarification,
    updateBubbleForDashboardEdited,
    updateBubbleForDashboardNoChange,
    updateBubbleForDashboardRebuilt,
    workspaceThreads,
  ]);

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
      userPrompt: normalizedPrompt || displayPrompt,
      attachmentSource: attachedSelection?.source,
      history: historyMessages,
      threadId: currentThread?.id,
      interactionMode: activeInteractionMode,
    });

    if (result?.success) {
      setPromptDraft("");
      if (!isDashboardSelectionSource(attachedSelection?.source)) {
        setAttachedSelection(null);
      }
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
      const result = await runSql(bubble.sql, {
        skipMutationConfirm: activeAgentAutonomy === "full" && bubble.interactionMode === "agent",
        skipHighRiskConfirm: activeAgentAutonomy === "full" && bubble.interactionMode === "agent",
      });
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
    setIsModeMenuOpen(false);
    setIsProviderMenuOpen(false);
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
    setActiveThreadId(nextActiveThreadId ?? initialThreadRef.current?.id ?? createId());
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
    setIsModeMenuOpen(false);
    setIsProviderMenuOpen(false);
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

  const handleOpenAISettings = useCallback(() => {
    setIsHistoryOpen(false);
    setIsModeMenuOpen(false);
    setIsProviderMenuOpen(false);
    window.dispatchEvent(new CustomEvent("open-ai-settings"));
  }, []);

  const handleSelectInteractionMode = useCallback((mode: AIWorkspaceInteractionMode) => {
    setWorkspaceInteractionModes((current) => ({
      ...current,
      [currentWorkspaceKey]: mode,
    }));
    setIsModeMenuOpen(false);
  }, [currentWorkspaceKey]);

  const handleSelectAgentAutonomy = useCallback((autonomy: AIWorkspaceAgentAutonomy) => {
    setWorkspaceAgentAutonomy((current) => ({
      ...current,
      [currentWorkspaceKey]: autonomy,
    }));
    setIsAutonomyMenuOpen(false);
  }, [currentWorkspaceKey]);

  const handleActivateProvider = useCallback(async (providerId: string) => {
    const targetProvider = aiConfigs.find((config) => config.id === providerId);
    if (!targetProvider) return;
    if (targetProvider.id === activeProvider?.id && targetProvider.is_enabled && targetProvider.is_primary) {
      setIsProviderMenuOpen(false);
      return;
    }

    const nextConfigs = normalizeAIProviderConfigs(
      aiConfigs.map((config) => (
        config.id === providerId
          ? { ...config, is_enabled: true, is_primary: true }
          : { ...config, is_primary: false }
      ))
    );

    setIsProviderMenuOpen(false);
    setIsModeMenuOpen(false);
    setIsSwitchingProvider(true);
    setError(null);

    try {
      await saveAIConfigs(nextConfigs, {}, []);
    } catch (errorValue) {
      setError(errorValue instanceof Error ? errorValue.message : String(errorValue));
    } finally {
      setIsSwitchingProvider(false);
    }
  }, [activeProvider?.id, aiConfigs, saveAIConfigs, setError]);

  if (!isOpen) return null;

  const visibleError = error && error !== AI_REQUEST_REPLACED_MESSAGE ? error : null;

  return (
    <div className="ai-workspace-overlay">
      {visibleError && (
        <div className="ai-workspace-alert">
          <span>{visibleError}</span>
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
            <div className="ai-workspace-composer-body">
              <div className="ai-workspace-panel-header workspace-toolbar">
                <div className="workspace-toolbar-main ai-workspace-panel-header-main">
                  <div className="workspace-toolbar-topline ai-workspace-panel-header-topline">
                    <span className="workspace-toolbar-kicker">{aiCopy.composer.kicker}</span>
                    {currentDatabase ? (
                      <span className="workspace-toolbar-chip ai-workspace-panel-header-chip">{currentDatabase}</span>
                    ) : null}
                  </div>
                  <div className="workspace-toolbar-title-row ai-workspace-panel-header-row">
                    <span className="workspace-toolbar-title ai-workspace-panel-header-title">
                      {aiCopy.composer.title}
                    </span>
                    <div className="workspace-toolbar-status ai-workspace-panel-header-status">
                      <span className="workspace-toolbar-status-pill">
                        {activeProvider?.name || aiCopy.composer.noProvider}
                      </span>
                      <span className="workspace-toolbar-status-pill">
                        {tableContextCount}{" "}
                        {tableContextCount === 1 ? aiCopy.composer.tableOne : aiCopy.composer.tableOther}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="workspace-toolbar-actions ai-workspace-panel-header-actions">
                  <div className="workspace-toolbar-utility ai-workspace-panel-header-utility">
                    <button
                      type="button"
                      className={`toolbar-btn icon-only ai-workspace-composer-head-btn ${isInspectMode ? "is-active" : ""}`}
                      onClick={() => setIsInspectMode((current) => !current)}
                      title={isInspectMode ? aiCopy.composer.inspectOnTitle : aiCopy.composer.inspectOffTitle}
                      aria-label={isInspectMode ? aiCopy.composer.inspectOnTitle : aiCopy.composer.inspectOffTitle}
                    >
                      <Target className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      className="toolbar-btn icon-only ai-workspace-composer-head-btn"
                      onClick={handleResetStage}
                      title="Reset"
                      aria-label="Reset"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      className="toolbar-btn icon-only ai-workspace-composer-head-btn is-close"
                      onClick={() => {
                        setIsInspectMode(false);
                        onClose();
                      }}
                      title={aiCopy.composer.alertDismiss}
                      aria-label={aiCopy.composer.alertDismiss}
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>

              <div className="ai-workspace-composer-toolbar">
                <div className="ai-workspace-chat-toolbar">
                  <div className="ai-workspace-chat-tabs" aria-label="AI chat threads">
                    <div className="ai-workspace-chat-tabs-list">
                      <span className="ai-workspace-chat-tab ai-workspace-chat-tab-current is-active">
                        {currentThread?.label || "#1"}
                      </span>
                    </div>

                    <div className="ai-workspace-chat-toolbar-actions">
                      <div
                        ref={historyPanelRef}
                        className={`ai-workspace-history-dropdown ${isHistoryOpen ? "is-open" : ""}`}
                      >
                        <button
                          type="button"
                          className={`ai-workspace-history-toggle ${isHistoryOpen ? "is-active" : ""}`}
                          aria-expanded={isHistoryOpen}
                          aria-haspopup="dialog"
                          onClick={() => setIsHistoryOpen((current) => !current)}
                          title={aiCopy.composer.historyTitle}
                        >
                          <History className="w-3.5 h-3.5" />
                          <span>{aiCopy.composer.historyTitle}</span>
                          <span className="ai-workspace-history-toggle-count">{recentWorkspaceThreads.length}</span>
                        </button>

                        {isHistoryOpen && (
                          <div className="ai-workspace-history-popover">
                            <div className="ai-workspace-history-head">
                              <span className="ai-workspace-history-label">{aiCopy.composer.historyTitle}</span>
                              <span className="ai-workspace-history-note">{aiCopy.composer.historyHint}</span>
                            </div>
                            <div className="ai-workspace-history-list">
                              {recentWorkspaceThreads.length > 0 ? (
                                recentWorkspaceThreads.map((thread) => (
                                  <button
                                    key={`history-${thread.id}`}
                                    type="button"
                                    className={`ai-workspace-history-item ${thread.id === currentThread?.id ? "is-active" : ""}`}
                                    onClick={() => handleSelectThread(thread.id)}
                                  >
                                    <span className="ai-workspace-history-item-copy">
                                      <strong className="ai-workspace-history-item-title">{thread.label}</strong>
                                      <span className="ai-workspace-history-item-meta">
                                        {formatThreadTimestamp(thread.updatedAt || thread.createdAt, language)}
                                      </span>
                                    </span>
                                    <span className="ai-workspace-history-item-actions">
                                      <button
                                        type="button"
                                        className="ai-workspace-history-item-delete"
                                        onClick={(e) => handleRequestDeleteThread(thread.id, e)}
                                        title={aiCopy.composer.historyDeleteTitle ?? "Delete conversation"}
                                      >
                                        <Trash2 className="w-3.5 h-3.5" />
                                      </button>
                                      <span className="ai-workspace-history-item-count">
                                        {bubbleCountByThread.get(thread.id) || 0}
                                      </span>
                                    </span>
                                  </button>
                                ))
                              ) : (
                                <div className="ai-workspace-history-empty">{aiCopy.composer.historyEmpty}</div>
                              )}
                            </div>
                          </div>
                        )}
                      </div>

                      <button type="button" className="ai-workspace-chat-tab-add" onClick={handleCreateChatThread}>
                        +
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              <div className="ai-workspace-chat-shell">
                <div className={`ai-workspace-chat-surface ${hasConversation ? "" : "is-empty"}`}>
                  {hasConversation ? (
                    <div ref={chatThreadRef} className="ai-workspace-chat-thread">
                      {conversationBubbles.map((bubble) => {
                        const conversationText = getBubbleConversationText(bubble);
                        const canShowDetail = bubble.status !== "loading" && Boolean(bubble.detail || bubble.preview || bubble.sql);
                        const canInsertBubbleSql = Boolean(bubble.sql) && aiModeAllowsInsert(bubble.interactionMode);
                        const canRunBubbleSql =
                          Boolean(bubble.sql) &&
                          bubble.kind !== "result" &&
                          aiModeAllowsRun(bubble.interactionMode);
                        const hasBubbleActions = canShowDetail || canInsertBubbleSql || canRunBubbleSql;
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
                              {bubble.interactionMode === "agent" && (bubble.agentSteps?.length ?? 0) > 0 && (
                                <AIAgentSteps steps={bubble.agentSteps ?? []} compact />
                              )}
                              {conversationText && <AIWorkspaceMarkdown className="ai-workspace-chat-text" text={conversationText} />}
                              {bubble.sql && bubble.status !== "error" && (
                                <pre className="ai-workspace-chat-code">{bubble.sql}</pre>
                              )}
                              {hasBubbleActions && (
                                <div className="ai-workspace-chat-actions">
                                  {canShowDetail && (
                                    <button
                                      type="button"
                                      className="ai-workspace-mode-action-btn"
                                      onClick={() => setDetailBubbleId(bubble.id)}
                                    >
                                      {aiCopy.bubbleActions.detail}
                                    </button>
                                  )}
                                  {canInsertBubbleSql && (
                                    <button
                                      type="button"
                                      className="ai-workspace-mode-action-btn"
                                      onClick={() => handleInsertBubble(bubble)}
                                    >
                                      {aiCopy.bubbleActions.insert}
                                    </button>
                                  )}
                                  {canRunBubbleSql && (
                                    <button
                                      type="button"
                                      className="ai-workspace-mode-action-btn primary"
                                      onClick={() => void handleRunBubble(bubble)}
                                    >
                                      {aiCopy.bubbleActions.approveRun}
                                    </button>
                                  )}
                                </div>
                              )}
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="ai-workspace-chat-empty">
                      <div className="ai-workspace-chat-empty-illustration">
                        <Sparkles className="w-4 h-4" />
                      </div>
                      <div className="ai-workspace-chat-empty-copy">
                        <strong className="ai-workspace-chat-empty-title">{aiCopy.composer.title}</strong>
                        <p className="ai-workspace-chat-empty-text">{aiCopy.composer.note}</p>
                        <div className="ai-workspace-chat-empty-suggestions">
                          {aiCopy.composer.promptIdeas.slice(0, 3).map((idea) => (
                            <button
                              key={idea.title}
                              type="button"
                              className="ai-workspace-suggestion-chip"
                              onClick={() => {
                                setPromptDraft(idea.prompt);
                                window.requestAnimationFrame(() => composerTextareaRef.current?.focus());
                              }}
                            >
                              {idea.title}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
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
                    <div className="ai-workspace-composer-footer-main">
                      {composerFooterNote ? (
                        <div className="ai-workspace-composer-note">{composerFooterNote}</div>
                      ) : (
                        <div className="ai-workspace-composer-note-spacer" aria-hidden="true" />
                      )}

                      <div className="ai-workspace-commandbar ai-workspace-commandbar--dock">
                        <div
                          ref={modeMenuRef}
                          className={`ai-workspace-command-dropdown ${isModeMenuOpen ? "is-open" : ""}`}
                        >
                          <button
                            type="button"
                            className={`ai-workspace-command-trigger ${isModeMenuOpen ? "is-active" : ""}`}
                            aria-expanded={isModeMenuOpen}
                            aria-haspopup="menu"
                            onClick={() => {
                              setIsHistoryOpen(false);
                              setIsProviderMenuOpen(false);
                              setIsModeMenuOpen((current) => !current);
                            }}
                            title={getInteractionModeLabel(activeInteractionMode, aiCopy)}
                          >
                            <span className="ai-workspace-command-trigger-icon">
                              <ActiveInteractionModeIcon className="w-3.5 h-3.5" />
                            </span>
                            <span className="ai-workspace-command-trigger-copy">
                              <span className="ai-workspace-command-trigger-label">Mode</span>
                              <strong className="ai-workspace-command-trigger-value">
                                {getInteractionModeLabel(activeInteractionMode, aiCopy)}
                              </strong>
                            </span>
                            <ChevronDown className="w-3.5 h-3.5 ai-workspace-command-trigger-caret" />
                          </button>

                          {isModeMenuOpen && (
                            <div className="ai-workspace-command-popover" role="menu" aria-label="Choose chat mode">
                              {(["prompt", "edit", "agent"] as AIWorkspaceInteractionMode[]).map((mode) => {
                                const ModeIcon = getInteractionModeIcon(mode);
                                return (
                                  <button
                                    key={mode}
                                    type="button"
                                    role="menuitemradio"
                                    aria-checked={mode === activeInteractionMode}
                                    className={`ai-workspace-command-item ${mode === activeInteractionMode ? "is-active" : ""}`}
                                    onClick={() => handleSelectInteractionMode(mode)}
                                  >
                                    <span className="ai-workspace-command-item-icon">
                                      <ModeIcon className="w-3.5 h-3.5" />
                                    </span>
                                    <span className="ai-workspace-command-item-copy">
                                      <strong>{getInteractionModeLabel(mode, aiCopy)}</strong>
                                      <span>{getInteractionModeHint(mode, aiCopy)}</span>
                                    </span>
                                    {mode === activeInteractionMode && <Check className="w-3.5 h-3.5 ai-workspace-command-item-check" />}
                                  </button>
                                );
                              })}
                            </div>
                          )}
                        </div>

                        {activeInteractionMode === "agent" && (
                          <div
                            className={`ai-workspace-command-dropdown ai-workspace-command-dropdown--autonomy ${isAutonomyMenuOpen ? "is-open" : ""}`}
                          >
                            <button
                              type="button"
                              className={`ai-workspace-command-trigger ${isAutonomyMenuOpen ? "is-active" : ""}`}
                              aria-expanded={isAutonomyMenuOpen}
                              aria-haspopup="menu"
                              onClick={() => {
                                setIsHistoryOpen(false);
                                setIsModeMenuOpen(false);
                                setIsProviderMenuOpen(false);
                                setIsAutonomyMenuOpen((current) => !current);
                              }}
                              title={getAgentAutonomyLabel(activeAgentAutonomy, aiCopy)}
                            >
                              <span className="ai-workspace-command-trigger-icon">
                                <ActiveAgentAutonomyIcon className="w-3.5 h-3.5" />
                              </span>
                              <span className="ai-workspace-command-trigger-copy">
                                <span className="ai-workspace-command-trigger-label">{aiCopy.composer.agentAutonomyLabel}</span>
                                <strong className="ai-workspace-command-trigger-value">
                                  {getAgentAutonomyLabel(activeAgentAutonomy, aiCopy)}
                                </strong>
                              </span>
                              <ChevronDown className="w-3.5 h-3.5 ai-workspace-command-trigger-caret" />
                            </button>

                          </div>
                        )}

                        <div
                          ref={providerMenuRef}
                          className={`ai-workspace-command-dropdown ai-workspace-command-dropdown--provider ${isProviderMenuOpen ? "is-open" : ""}`}
                        >
                          <button
                            type="button"
                            className={`ai-workspace-command-trigger ai-workspace-command-trigger--provider ${isProviderMenuOpen ? "is-active" : ""}`}
                            aria-expanded={isProviderMenuOpen}
                            aria-haspopup="menu"
                            disabled={isSwitchingProvider}
                            onClick={() => {
                              setIsHistoryOpen(false);
                              setIsModeMenuOpen(false);
                              setIsProviderMenuOpen((current) => !current);
                            }}
                            title={activeProviderValue}
                          >
                            <span className="ai-workspace-command-trigger-icon">
                              {isSwitchingProvider ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <Sparkles className="w-3.5 h-3.5" />
                              )}
                            </span>
                            <span className="ai-workspace-command-trigger-copy">
                              <span className="ai-workspace-command-trigger-label">Model</span>
                              <strong className="ai-workspace-command-trigger-value">{activeProviderValue}</strong>
                              <span className="ai-workspace-command-trigger-note">{activeProviderCaption}</span>
                            </span>
                            <ChevronDown className="w-3.5 h-3.5 ai-workspace-command-trigger-caret" />
                          </button>

                          {isProviderMenuOpen && (
                            <div className="ai-workspace-command-popover ai-workspace-command-popover--provider" role="menu" aria-label="Choose AI model">
                              <div className="ai-workspace-command-popover-head">
                                <strong>Switch model</strong>
                                <span>Switch the active AI provider without leaving the chat panel.</span>
                              </div>
                              <div className="ai-workspace-command-provider-list">
                                {switchableProviders.length > 0 ? (
                                  switchableProviders.map((config) => {
                                    const providerValue = config.model?.trim() || config.name?.trim() || formatProviderTypeLabel(config.provider_type);
                                    const providerCaption =
                                      config.name?.trim() && config.name.trim() !== providerValue
                                        ? `${config.name.trim()} / ${formatProviderTypeLabel(config.provider_type)}`
                                        : formatProviderTypeLabel(config.provider_type);

                                    return (
                                      <button
                                        key={config.id}
                                        type="button"
                                        role="menuitemradio"
                                        aria-checked={config.id === activeProvider?.id}
                                        className={`ai-workspace-command-item ai-workspace-command-item--provider ${config.id === activeProvider?.id ? "is-active" : ""}`}
                                        onClick={() => void handleActivateProvider(config.id)}
                                      >
                                        <span className="ai-workspace-command-item-copy">
                                          <strong>{providerValue}</strong>
                                          <span>{providerCaption}</span>
                                        </span>
                                        <span className="ai-workspace-command-provider-meta">
                                          {!config.is_enabled && (
                                            <span className="ai-workspace-command-provider-tag">Disabled</span>
                                          )}
                                          {config.id === activeProvider?.id && (
                                            <Check className="w-3.5 h-3.5 ai-workspace-command-item-check" />
                                          )}
                                        </span>
                                      </button>
                                    );
                                  })
                                ) : (
                                  <button
                                    type="button"
                                    className="ai-workspace-command-empty"
                                    onClick={handleOpenAISettings}
                                  >
                                    No provider configured yet. Open settings
                                  </button>
                                )}
                              </div>
                              <button
                                type="button"
                                className="ai-workspace-command-settings-link"
                                onClick={handleOpenAISettings}
                              >
                                {aiCopy.composer.openSettings}
                              </button>
                            </div>
                          )}
                        </div>

                        <button
                          type="button"
                          className={`ai-workspace-command-data-toggle ${isSessionDataReadEnabled ? "is-active" : ""}`}
                          onClick={() => setSessionDataReadEnabled(!isSessionDataReadEnabled)}
                          disabled={!connectionId}
                          aria-pressed={isSessionDataReadEnabled}
                          title={sessionDataReadButtonTitle}
                        >
                          <Database className="ai-workspace-command-data-toggle-icon w-3.5 h-3.5" />
                          <span className="ai-workspace-command-data-toggle-copy">{sessionDataReadButtonLabel}</span>
                        </button>

                        <button
                          type="button"
                          className="ai-workspace-command-settings-btn"
                          onClick={handleOpenAISettings}
                          title={aiCopy.composer.openSettings}
                          aria-label={aiCopy.composer.openSettings}
                        >
                          <Settings2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
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

      {isAutonomyMenuOpen && (
        <div
          className="ai-autonomy-modal-overlay"
          role="presentation"
          onClick={() => setIsAutonomyMenuOpen(false)}
        >
          <div
            ref={autonomyMenuRef}
            className="ai-autonomy-modal"
            role="dialog"
            aria-modal="true"
            aria-label={aiCopy.composer.agentAutonomyLabel}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="ai-autonomy-modal-header">
              <div className="ai-autonomy-modal-heading">
                <span className="ai-autonomy-modal-icon">
                  <ActiveAgentAutonomyIcon className="w-4 h-4" />
                </span>
                <strong className="ai-autonomy-modal-title">{aiCopy.composer.agentAutonomyLabel}</strong>
              </div>
              <button
                type="button"
                className="ai-autonomy-modal-close"
                onClick={() => setIsAutonomyMenuOpen(false)}
                aria-label={aiCopy.composer.alertDismiss}
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="ai-autonomy-modal-options" role="radiogroup" aria-label={aiCopy.composer.agentAutonomyLabel}>
              {AGENT_AUTONOMY_OPTIONS.map((autonomy) => {
                const AutonomyIcon = getAgentAutonomyIcon(autonomy);
                const isActive = autonomy === activeAgentAutonomy;
                return (
                  <button
                    key={autonomy}
                    type="button"
                    role="radio"
                    aria-checked={isActive}
                    className={`ai-autonomy-option${isActive ? " is-active" : ""}`}
                    onClick={() => handleSelectAgentAutonomy(autonomy)}
                  >
                    <span className="ai-autonomy-option-icon">
                      <AutonomyIcon className="w-4 h-4" />
                    </span>
                    <span className="ai-autonomy-option-copy">
                      <strong>{getAgentAutonomyLabel(autonomy, aiCopy)}</strong>
                      <span>{getAgentAutonomyHint(autonomy, aiCopy)}</span>
                    </span>
                    {isActive && <Check className="w-4 h-4 ai-autonomy-option-check" />}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        isOpen={visualizationConsentPending !== null}
        title={visualizationConsentPending?.title || "Allow AI data read?"}
        message={visualizationConsentPending?.message || ""}
        confirmText={visualizationConsentPending?.confirmText || "Allow"}
        cancelText={visualizationConsentPending?.cancelText || "Deny"}
        onConfirm={() => resolveVisualizationConsent(true)}
        onCancel={() => resolveVisualizationConsent(false)}
      />

      <ConfirmDialog
        isOpen={deleteThreadPending !== null}
        title={aiCopy.composer.historyDeleteTitle ?? "Delete conversation"}
        message={aiCopy.composer.historyDeleteConfirm ?? "Delete this conversation thread?"}
        confirmText="Delete"
        cancelText="Cancel"
        onConfirm={handleConfirmDeleteThread}
        onCancel={handleCancelDeleteThread}
      />
    </div>
  );
}
