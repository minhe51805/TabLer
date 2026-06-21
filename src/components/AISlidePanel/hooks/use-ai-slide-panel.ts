import { useCallback, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { getCurrentAppLanguage } from "../../../i18n";
import { useAppStore } from "../../../stores/appStore";
import { getActiveAIProvider, type AIConversationMessage, type AIProviderConfig, type AIRequestIntent, type AIRequestMode, type AIResponseLanguage, type QueryResult, type TableInfo, type TableStructure } from "../../../types";
import { splitSqlStatements } from "../../../utils/sqlStatements";
import {
  formatExecutionError,
  normalizeStatementForGuard,
  extractLeadingUseDirective,
  isSessionSwitchStatement,
  isMutatingStatement,
  isHighRiskStatement,
} from "../../SQLEditor/SQLEditorUtils";
import {
  pickRelevantTables,
  encodeStructureForAI,
  inferAISchemaCodecMode,
  analyzeGeneratedSql,
  type AISchemaCodecMode,
  type SqlRiskAnalysis,
  AI_SCHEMA_CODEC_VERSION,
  MAX_TABLE_NAMES_IN_CONTEXT,
  MAX_AI_SCHEMA_CODEC_CACHE_ENTRIES,
} from "../AISlidePanelUtils";
import { aiModeUsesSchemaContext, type AIWorkspaceAgentStep, type AIWorkspaceInteractionMode } from "../ai-workspace-types";
import type { AIMetricsWidgetSpec } from "../../../utils/metrics-board-templates";

export interface AIGeneratedAssistResult {
  prompt: string;
  rawResponse: string;
  sql: string | null;
  risk?: SqlRiskAnalysis;
  intent: AssistIntent;
  reasoning?: string;
  agentSteps?: AIWorkspaceAgentStep[];
  /** Metrics widgets the agent designed for a dashboard request. */
  agentWidgets?: AIMetricsWidgetSpec[];
}

export interface AIExecutedSqlResult {
  queryResult: QueryResult;
  summary: string;
}

type AssistIntent = "sql" | "explain" | "overview" | "optimize" | "fix-error" | "general";
type AgentToolName = "plan" | "list_tables" | "describe_table" | "run_readonly_sql" | "finish";

interface AgentToolAction {
  action: AgentToolName;
  args?: Record<string, unknown>;
  message?: string;
}

interface AgentTraceStep {
  step: number;
  action: AgentToolName;
  message: string;
  observation: string;
}

const SQL_START_KEYWORDS = ["SELECT", "SHOW", "EXPLAIN", "DESCRIBE", "PRAGMA", "INSERT", "UPDATE", "DELETE", "CREATE", "DROP", "ALTER", "WITH"];
const AI_SCHEMA_CODEC_LEGEND =
  "Legend T=table C=col:type!flags I=index F=fk flags=pk|nn|df|ai";
const MAX_OVERVIEW_SCHEMA_TABLES = 12;
const MAX_SCHEMA_FETCH_CONCURRENCY = 2;
const MAX_AGENT_STEPS = 10;
const MAX_REMOTE_AGENT_STEPS = 6;
const MAX_LOCAL_COMPLEX_AGENT_STEPS = 14;
const MAX_REMOTE_COMPLEX_AGENT_STEPS = 8;
const MAX_AGENT_QUERY_PREVIEW_ROWS = 5;
const MAX_AGENT_QUERY_PREVIEW_COLUMNS = 8;
const MAX_AGENT_TRACE_OBSERVATION_CHARS = 1400;
const MAX_REMOTE_AGENT_SCHEMA_TABLES = 3;
const MAX_REMOTE_AGENT_OVERVIEW_TABLES = 4;
const MAX_LOCAL_AGENT_VISIBLE_TABLES = 24;
const MAX_REMOTE_AGENT_VISIBLE_TABLES = 12;
const MAX_REMOTE_HISTORY_MESSAGES = 4;
const MAX_REMOTE_RECOVERY_PASSES = 1;
const MAX_SCHEMA_CAPSULE_PREVIEW_TABLES = 4;
export const AI_REQUEST_REPLACED_MESSAGE = "This AI request was replaced by a newer one.";

export function isSupersededAIRequestError(errorValue: unknown) {
  if (errorValue instanceof Error) {
    return errorValue.message === AI_REQUEST_REPLACED_MESSAGE;
  }

  return String(errorValue) === AI_REQUEST_REPLACED_MESSAGE;
}

function setAiSchemaCodecCacheEntry(cache: Map<string, string>, key: string, value: string) {
  if (cache.has(key)) {
    cache.delete(key);
  } else if (cache.size >= MAX_AI_SCHEMA_CODEC_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey) {
      cache.delete(oldestKey);
    }
  }

  cache.set(key, value);
}

async function mapWithConcurrency<TInput, TOutput>(
  items: TInput[],
  concurrency: number,
  mapper: (item: TInput, index: number) => Promise<TOutput>
) {
  const normalizedConcurrency = Math.max(1, Math.min(concurrency, items.length || 1));
  const results = new Array<TOutput>(items.length);
  let nextIndex = 0;

  await Promise.all(
    Array.from({ length: normalizedConcurrency }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex++;
        results[currentIndex] = await mapper(items[currentIndex], currentIndex);
      }
    })
  );

  return results;
}

async function yieldToBrowserFrame() {
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

function normalizeIntentText(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d");
}

function isVisualizationRequest(prompt: string) {
  const normalizedPrompt = normalizeIntentText(prompt);
  const visualizationSignals = [
    "chart",
    "charts",
    "visual",
    "visualize",
    "visualization",
    "graph",
    "plot",
    "dashboard",
    "bar chart",
    "line chart",
    "pie chart",
    "scatter",
    "histogram",
    "bieu do",
    "ve bieu do",
    "do thi",
  ];

  return visualizationSignals.some((signal) => normalizedPrompt.includes(signal));
}

function isMetricsBoardRequest(prompt: string) {
  const normalizedPrompt = normalizeIntentText(prompt);
  const boardSignals = [
    "metric",
    "metrics",
    "dashboard",
    "board",
    "scoreboard",
    "widget",
    "tong hop",
    "bang tong hop",
    "bao cao",
    "overview",
    "tong quan",
  ];
  return boardSignals.some((signal) => normalizedPrompt.includes(signal));
}

function stripTableSchemaQualifier(tableName: string) {
  return tableName
    .replace(/["`]/g, "")
    .split(".")
    .filter(Boolean)
    .pop()
    ?.trim() || tableName.trim();
}

function buildKnownTableNameSet(availableTableNames: string[]) {
  const knownNames = new Set<string>();

  for (const tableName of availableTableNames) {
    const normalizedFullName = normalizeIntentText(tableName);
    if (normalizedFullName) {
      knownNames.add(normalizedFullName);
    }

    const bareTableName = stripTableSchemaQualifier(tableName);
    const normalizedBareName = normalizeIntentText(bareTableName);
    if (normalizedBareName) {
      knownNames.add(normalizedBareName);
    }
  }

  return knownNames;
}

function buildWorkspaceTableIdentifier(
  table: Pick<TableInfo, "name" | "schema">,
  currentDatabase: string | null
) {
  const tableName = table.name.trim();
  if (!tableName || tableName.includes(".")) {
    return tableName;
  }

  const schemaName = table.schema?.trim();
  if (!schemaName) {
    return tableName;
  }

  if (currentDatabase && normalizeIntentText(schemaName) === normalizeIntentText(currentDatabase)) {
    return tableName;
  }

  return `${schemaName}.${tableName}`;
}


function shouldUseLightweightAgentFlow(prompt: string, intent: AssistIntent) {
  if (intent !== "explain") return false;

  const normalizedPrompt = normalizeIntentText(prompt).trim();
  if (!normalizedPrompt || normalizedPrompt.length > 80) return false;

  const casualSignals = [
    "hi",
    "hello",
    "hey",
    "xin chao",
    "chao",
    "helo",
    "yo",
    "good morning",
    "good afternoon",
    "good evening",
    "thanks",
    "thank you",
    "cam on",
  ];

  const databaseSignals = [
    "sql",
    "query",
    "database",
    "schema",
    "table",
    "column",
    "index",
    "postgres",
    "mysql",
    "sqlite",
    "duckdb",
    " db ",
    "bang",
    "cot",
    "truong",
    "csdl",
    "truy van",
  ];

  if (databaseSignals.some((signal) => normalizedPrompt.includes(signal))) {
    return false;
  }

  return casualSignals.some((signal) => normalizedPrompt.includes(signal));
}

void shouldUseLightweightAgentFlow;

function buildLightweightLocalAssistantResponse(
  prompt: string,
  language: AIResponseLanguage
) {
  const normalizedPrompt = normalizeIntentText(prompt).trim();
  const isGreeting = ["hi", "hello", "hey", "xin chao", "chao", "yo", "good morning", "good afternoon", "good evening"]
    .some((signal) => normalizedPrompt.includes(signal));
  const isThanks = ["thanks", "thank you", "cam on"].some((signal) => normalizedPrompt.includes(signal));

  if (!isGreeting && !isThanks) return null;

  if (language === "vi") {
    if (isThanks) {
      return "Không có gì. Mình sẵn sàng hỗ trợ nếu bạn muốn viết SQL, giải thích schema, hoặc phân tích dữ liệu trong workspace hiện tại.";
    }
    return "Chào bạn! Mình sẵn sàng hỗ trợ về SQL, schema, query, hoặc dữ liệu trong workspace hiện tại khi bạn cần.";
  }

  if (language === "zh") {
    if (isThanks) {
      return "不客气。如果你想让我帮你写 SQL、解释 schema，或分析当前 workspace 里的数据，我随时可以继续。";
    }
    return "你好。我可以继续帮你处理 SQL、schema 说明，或者当前 workspace 里的数据问题。";
  }

  if (isThanks) {
    return "You're welcome. I can help with SQL, schema explanations, or data analysis in the current workspace whenever you're ready.";
  }

  return "Hello. I can help with SQL, schema explanations, or data analysis in the current workspace whenever you're ready.";
}

void buildLightweightLocalAssistantResponse;

function isWorkspaceScopedIntent(intent: AssistIntent) {
  return intent !== "general";
}

function isLocalProviderEndpoint(endpoint: string) {
  if (!endpoint.trim()) return false;
  try {
    const parsed = new URL(endpoint);
    const host = parsed.hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".local");
  } catch {
    return false;
  }
}

function isLocalAIProvider(config: AIProviderConfig | null | undefined) {
  if (!config) return false;
  return config.provider_type === "ollama" || isLocalProviderEndpoint(config.endpoint);
}

function buildAgentVisibleTableNames(
  allTableNames: string[],
  prioritizedTableNames: string[],
  limit: number
) {
  const combined = [...prioritizedTableNames, ...allTableNames];
  const visibleTableNames: string[] = [];
  const seen = new Set<string>();

  for (const tableName of combined) {
    const normalized = normalizeIntentText(tableName);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    visibleTableNames.push(tableName);
    if (visibleTableNames.length >= limit) {
      break;
    }
  }

  return visibleTableNames;
}

function buildAgentEvidenceSummary(steps: AgentTraceStep[]) {
  if (steps.length === 0) {
    return "No verified tool observations were captured.";
  }

  return steps.map((step) => [
    `Step ${step.step}`,
    `Action: ${step.action}`,
    `Reason: ${step.message || "No message provided."}`,
    "Observation:",
    step.observation,
  ].join("\n")).join("\n\n");
}

function buildSchemaCapsulePreview(tableSchemas: string[], limit = MAX_SCHEMA_CAPSULE_PREVIEW_TABLES) {
  return tableSchemas.slice(0, limit).join("\n");
}

function buildSchemaCapsuleContext(params: {
  currentDatabase: string | null;
  totalTableCount: number;
  visibleTableNames: string[];
  allVisible: boolean;
  tableSchemas: string[];
  schemaCodecMode: AISchemaCodecMode;
  truncatedOverview: boolean;
}) {
  const {
    currentDatabase,
    totalTableCount,
    visibleTableNames,
    allVisible,
    tableSchemas,
    schemaCodecMode,
    truncatedOverview,
  } = params;

  return [
    "Workspace schema capsule:",
    `DB=${currentDatabase || "Default"}`,
    `TC=${totalTableCount}`,
    `TV=${visibleTableNames.join(",")}${allVisible ? "" : ",..."}`,
    `SCHEMA=${AI_SCHEMA_CODEC_VERSION}|mode=${schemaCodecMode}|rowdata=0`,
    AI_SCHEMA_CODEC_LEGEND,
    ...tableSchemas,
    truncatedOverview ? "NOTE=Overview limited to current capsule tables." : "",
    "RULE=Use only tables in TV or capsule lines. Ask if a needed table is missing.",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildAgentRecoveryContext(params: {
  currentDatabase: string | null;
  availableTableNames: string[];
  visibleTableNames: string[];
  schemaCapsulePreview: string;
}) {
  const { currentDatabase, availableTableNames, visibleTableNames, schemaCapsulePreview } = params;
  return [
    `DB=${currentDatabase || "Default"}`,
    `TC=${availableTableNames.length}`,
    `TV=${visibleTableNames.join(",")}${availableTableNames.length > visibleTableNames.length ? ",..." : ""}`,
    schemaCapsulePreview ? `SCHEMA_PREVIEW=\n${schemaCapsulePreview}` : "",
    "RULE=list_tables for full catalog; describe_table before assuming columns; stay inside verified schema.",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildAgentFinalRecoveryPrompt(params: {
  userPrompt: string;
  assistIntent: AssistIntent;
  currentDatabase: string | null;
  availableTableNames: string[];
  evidenceSummary: string;
  wantsVisualization: boolean;
  reason: string;
}) {
  const {
    userPrompt,
    assistIntent,
    currentDatabase,
    availableTableNames,
    evidenceSummary,
    wantsVisualization,
    reason,
  } = params;

  const visibleTables = availableTableNames.slice(0, MAX_TABLE_NAMES_IN_CONTEXT);

  return [
    "Write the final user-facing answer now.",
    "Do not return JSON.",
    "Do not ask for more tool calls.",
    "Use only the verified schema and observations already collected.",
    `Current database: ${currentDatabase || "Default"}.`,
    visibleTables.length > 0
      ? `Allowed tables: ${visibleTables.join(", ")}${availableTableNames.length > visibleTables.length ? ", ..." : ""}.`
      : "Allowed tables: use only the verified evidence already captured.",
    `Recovery reason: ${reason}.`,
    assistIntent === "overview"
      ? "Provide a grounded database overview."
      : "Answer the user's request directly and concisely.",
    wantsVisualization
      ? "The user wants a chart or visualization. Recommend one chart type and, when enough evidence exists, include one chart-friendly SQL query that returns a label column plus one or more numeric metric columns. Mention that after running the SQL the user can switch the result to Chart view."
      : "",
    "If you include SQL, put it in a single ```sql fenced block.",
    "",
    "User request:",
    userPrompt,
    "",
    "Verified observations:",
    evidenceSummary,
  ]
    .filter(Boolean)
    .join("\n");
}

function buildLocalAgentFallbackResponse(params: {
  language: AIResponseLanguage;
  currentDatabase: string | null;
  availableTableNames: string[];
  wantsVisualization: boolean;
  steps: AgentTraceStep[];
}) {
  const {
    language,
    currentDatabase,
    availableTableNames,
    wantsVisualization,
    steps,
  } = params;

  const tablePreview = availableTableNames.slice(0, 8).join(", ");
  const lastStep = steps[steps.length - 1];
  const lastStepLabel = lastStep ? `${lastStep.action}` : "";
  const hasMoreTables = availableTableNames.length > 8;

  if (language === "vi") {
    return [
      `Mình đã thu thập được evidence có kiểm chứng từ DB "${currentDatabase || "Default"}", nhưng agent chưa kịp tự chốt câu trả lời cuối.`,
      tablePreview ? `Các bảng đã xác minh: ${tablePreview}${hasMoreTables ? ", ..." : ""}.` : "",
      lastStepLabel ? `Bước gần nhất của agent: ${lastStepLabel}.` : "",
      wantsVisualization
        ? "Thử lại một lần nữa là được; mình sẽ ưu tiên câu trả lời có kèm SQL dạng chart-friendly để bạn chạy xong chuyển sang Chart view."
        : "Thử lại một lần nữa là được; agent sẽ tổng hợp nốt câu trả lời từ evidence hiện có.",
    ].filter(Boolean).join("\n\n");
  }

  if (language === "zh") {
    return [
      `我已经从数据库“${currentDatabase || "Default"}”收集到经过验证的证据，但 agent 还没来得及整理成最终答复。`,
      tablePreview ? `已验证的表：${tablePreview}${hasMoreTables ? ", ..." : ""}。` : "",
      lastStepLabel ? `agent 最近一步：${lastStepLabel}。` : "",
      wantsVisualization
        ? "再试一次即可；我会优先返回适合切换到 Chart view 的图表型 SQL。"
        : "再试一次即可；agent 会基于这些证据完成最终总结。",
    ].filter(Boolean).join("\n\n");
  }

  return [
    `The agent gathered verified evidence from database "${currentDatabase || "Default"}" but did not finish composing the final answer in time.`,
    tablePreview ? `Verified tables: ${tablePreview}${hasMoreTables ? ", ..." : ""}.` : "",
    lastStepLabel ? `Last agent step: ${lastStepLabel}.` : "",
    wantsVisualization
      ? "Try again and the agent will prioritize a chart-friendly SQL result that can be switched into Chart view."
      : "Try again so the agent can synthesize the verified evidence into a final response.",
  ].filter(Boolean).join("\n\n");
}

function joinAgentInstructions(...parts: Array<string | undefined>) {
  return parts
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join(" ");
}

function inferAssistIntent(prompt: string, interactionMode: AIWorkspaceInteractionMode): AssistIntent {
  const normalizedPrompt = normalizeIntentText(prompt);

  const overviewSignals = [
    "overview",
    "database overview",
    "schema overview",
    "review the database",
    "review database",
    "read the database",
    "read database",
    "read db",
    "review db",
    "summarize the database",
    "summarise the database",
    "understand the database",
    "walk me through the database",
    "scan the database",
    "what tables are here",
    "doc lai db",
    "\u0111oc lai db",
    "doc qua db",
    "\u0111oc qua db",
    "doc db",
    "\u0111oc db",
    "doc lai csdl",
    "\u0111oc lai csdl",
    "xem lai db",
    "tong quan db",
    "tong quan csdl",
    "nhin tong quan",
    "ban doc qua db chua",
    "概览数据库",
    "数据库概览",
    "读一下数据库",
    "看看当前数据库",
    "梳理数据库",
    "总结数据库",
    "过一遍数据库",
  ];

  const sqlSignals = [
    "sql",
    "query",
    "command",
    "statement",
    "show me",
    "list ",
    "find ",
    "top ",
    "count ",
    "group by",
    "join ",
    "lọc",
    "tìm ",
    "liệt kê",
    "hiển thị",
    "select ",
    "insert ",
    "update ",
    "delete ",
    "create table",
    "alter table",
    "migration",
    "alter schema",
    "change schema",
    "rewrite query",
    "write query",
    "generate query",
    "generate sql",
    "run this",
    "give me sql",
    "give me query",
    "sample query",
    "sample sql",
    "example query",
    "example sql",
    "test query",
    "test sql",
    "try query",
    "try sql",
    "ra lenh",
    "cau lenh",
    "lenh sql",
    "cho tui lenh",
    "cho toi lenh",
    "viet cau lenh",
    "mau chay",
    "mau chay thu",
    "chay thu",
    "viet query",
    "viet sql",
    "tao bang",
    "sua schema",
    "cau lenh",
    "truy van",
    "写sql",
    "查询语句",
    "viết query",
    "viết sql",
    "tạo bảng",
    "sửa schema",
    "câu lệnh",
    "truy vấn",
  ];

  const relationSqlSignals = [
    "related tables",
    "common key",
    "shared key",
    "join key",
    "foreign key",
    "bang nao co lien quan",
    "bang nao lien quan",
    "cac bang lien quan",
    "key chung",
    "khoa chung",
  ];

  const explainSignals = [
    "explain",
    "what does",
    "what is",
    "why",
    "how does",
    "meaning",
    "purpose",
    "use for",
    "used for",
    "giai thich",
    "la gi",
    "lam gi",
    "tac dung",
    "de lam gi",
    "\u0111e lam gi",
    "nghia la gi",
    "dung de",
    "\u0111ung de",
    "vi sao",
    "tai sao",
    "sao lai",
    "解释",
    "什么意思",
    "作用",
    "用途",
    "为什么",
    "giải thích",
    "là gì",
    "làm gì",
    "tác dụng",
    "để làm gì",
    "nghĩa là gì",
    "dùng để",
    "vì sao",
    "tại sao",
    "sao lại",
  ];

  const hasOverviewSignal = overviewSignals.some((signal) => normalizedPrompt.includes(signal));
  const optimizeSignals = [
    "optimize",
    "toi uu",
    "tối ưu",
    "cải thiện",
    "improve",
    "faster",
    "performance",
    "lam nhanh hon",
    "nhanh hon",
    "优化",
    "提升性能",
    "make it faster",
    "speed up",
  ];
  const fixErrorSignals = [
    "fix",
    "error",
    "bug",
    "sua loi",
    "sửa lỗi",
    "khắc phuc",
    "khắc phục",
    "loi",
    "lỗi",
    "exception",
    "failed",
    "failed to",
    "does not work",
    "not working",
    "修复",
    "错误",
    "修复错误",
    "报错了",
    "出错",
  ];

  const hasOptimizeSignal = optimizeSignals.some((signal) => normalizedPrompt.includes(signal));
  const hasFixErrorSignal = fixErrorSignals.some((signal) => normalizedPrompt.includes(signal));
  let sqlScore = sqlSignals.reduce((score, signal) => score + (normalizedPrompt.includes(signal) ? 1 : 0), 0);
  const explainScore = explainSignals.reduce((score, signal) => score + (normalizedPrompt.includes(signal) ? 1 : 0), 0);
  const workspaceSignals = [
    "database",
    " db ",
    "schema",
    "table",
    "tables",
    "column",
    "columns",
    "row",
    "rows",
    "record",
    "records",
    "sql",
    "query",
    "join",
    "foreign key",
    "index",
    "postgres",
    "mysql",
    "sqlite",
    "duckdb",
    "snowflake",
    "oracle",
    "mongodb",
    "redis",
    "bang",
    "cot",
    "csdl",
    "du lieu",
    "co so du lieu",
    "truy van",
  ];

  if (
    interactionMode !== "prompt" &&
    (
      normalizedPrompt.includes("ra lenh") ||
      normalizedPrompt.includes("chay thu") ||
      normalizedPrompt.includes("mau chay") ||
      normalizedPrompt.includes("give me sql") ||
      normalizedPrompt.includes("sample query")
    )
  ) {
    sqlScore += 2;
  }

  if (
    interactionMode !== "prompt" &&
    relationSqlSignals.some((signal) => normalizedPrompt.includes(signal)) &&
    (
      normalizedPrompt.includes("sql") ||
      normalizedPrompt.includes("query") ||
      normalizedPrompt.includes("cau lenh") ||
      normalizedPrompt.includes("viet") ||
      normalizedPrompt.includes("mau chay") ||
      normalizedPrompt.includes("chay thu") ||
      normalizedPrompt.includes("run this")
    )
  ) {
      sqlScore += 2;
  }

  const hasWorkspaceSignal =
    hasOverviewSignal ||
    hasOptimizeSignal ||
    hasFixErrorSignal ||
    sqlScore > 0 ||
    relationSqlSignals.some((signal) => normalizedPrompt.includes(signal)) ||
    workspaceSignals.some((signal) => normalizedPrompt.includes(signal));

  if (hasOverviewSignal && sqlScore === 0) {
    return "overview";
  }

  if (hasFixErrorSignal && (normalizedPrompt.includes("fix") || normalizedPrompt.includes("error") || normalizedPrompt.includes("sua") || normalizedPrompt.includes("loi") || normalizedPrompt.includes("lỗi") || normalizedPrompt.includes("修复") || normalizedPrompt.includes("错误"))) {
    return "fix-error";
  }

  if (hasOptimizeSignal) {
    return "optimize";
  }

  if (!hasWorkspaceSignal) {
    return "general";
  }

  if (sqlScore === 0 && (explainScore > 0 || normalizedPrompt.includes("?"))) {
    return "explain";
  }

  return sqlScore > explainScore ? "sql" : "explain";
}

function buildAssistPrompt(prompt: string, intent: AssistIntent, interactionMode: AIWorkspaceInteractionMode) {
  const schemaCapsuleInstruction =
    "When database context is attached, it may arrive as a compact schema capsule / codec. Treat that capsule as the source of truth.";
  const interactionInstruction =
    interactionMode === "agent"
      ? intent === "general"
        ? "Interaction mode: agent. Act like a capable general-purpose assistant. Answer directly unless the user explicitly needs grounded workspace evidence or SQL."
        : "Interaction mode: agent. Prefer execution-ready SQL when the user asks for SQL, but never assume it will run without explicit approval."
      : interactionMode === "edit"
        ? intent === "general"
          ? "Interaction mode: edit. Prefer structured drafts, rewrites, and reviewable changes that a human can inspect."
          : "Interaction mode: edit. Prefer reviewable SQL, safer rewrites, and change plans that a human can inspect before running."
        : intent === "general"
          ? "Interaction mode: prompt-only. Answer directly from the user's words. You can help with writing, planning, coding, and general reasoning."
          : "Interaction mode: prompt-only. Work from the user's words only and treat any SQL as draft guidance instead of an autonomous action.";

  if (intent === "general") {
    return [
      interactionInstruction,
      "User intent: help with a general-purpose request.",
      "You are a capable assistant inside a database workspace, but you are not limited to database-only tasks.",
      "Help with writing, planning, coding, summarization, translation, brainstorming, and everyday questions naturally.",
      "Use the provided workspace or database context only when it is relevant to the user's request.",
      "Do not pretend the request is about SQL or schema when it is broader than that.",
      "",
      prompt,
    ].join("\n");
  }

  if (intent === "overview") {
    return [
      interactionInstruction,
      "User intent: review the current database and provide a grounded overview of the actual schema context.",
      schemaCapsuleInstruction,
      "Read the provided database context first.",
      "Summarize the actual tables, their likely roles, and the key relationships you can infer.",
      "Do not explain generic database theory unless the user explicitly asks for theory.",
      "Do not generate SQL unless the user explicitly asks for SQL.",
      "If the schema context is incomplete, say what is missing instead of guessing.",
      "",
      prompt,
    ].join("\n");
  }

  if (intent === "explain") {
    return [
      interactionInstruction,
      "User intent: explain the schema, columns, or behavior in plain language.",
      schemaCapsuleInstruction,
      "Ground the answer in the provided database context when it exists.",
      "Avoid generic textbook definitions if the schema context already shows the concrete tables or columns being discussed.",
      "Do not generate SQL unless the user explicitly asks for a query, statement, or schema change.",
      "Prefer explanation, examples, tradeoffs, and suggestions over code.",
      "",
      prompt,
    ].join("\n");
  }

  if (intent === "optimize") {
    return [
      interactionInstruction,
      "User intent: optimize the given SQL query for better performance.",
      schemaCapsuleInstruction,
      "Analyze the query for potential performance issues: missing indexes, inefficient joins, full table scans, unnecessary subqueries, etc.",
      "Ground the answer in the provided database context (schema, indexes, foreign keys) when available.",
      "Return the optimized SQL inside a single ```sql fenced block.",
      "Outside the code block, briefly explain: what changed, why it is faster, and any tradeoffs or risks.",
      "Do not change the query semantics — the result must be functionally identical.",
      "If the query is already optimal, say so and explain why.",
      "",
      prompt,
    ].join("\n");
  }

  if (intent === "fix-error") {
    return [
      interactionInstruction,
      "User intent: fix the SQL error or bug in the provided query.",
      schemaCapsuleInstruction,
      "If the user provides an error message, diagnose it and rewrite the corrected SQL.",
      "If no explicit error is given, look for common SQL mistakes: syntax errors, type mismatches, invalid column references, NULL handling issues, etc.",
      "Ground the fix in the provided database schema context when available.",
      "Return the corrected SQL inside a single ```sql fenced block.",
      "Outside the code block, briefly explain: what was wrong and what was changed.",
      "Do not change the query semantics unless the original was incorrect.",
      "",
      prompt,
    ].join("\n");
  }

  return [
    interactionInstruction,
    "User intent: produce runnable SQL grounded in the provided database context.",
    schemaCapsuleInstruction,
    "Use only tables and columns that exist in the provided schema context.",
    "Do not invent tables, columns, keys, or relationships.",
    "Prefer safe read-only SELECT statements unless the user explicitly asks for data changes or schema changes.",
    "If the user asks which tables are related, what key they share, or asks for a sample to run, infer that only from visible foreign keys, indexes, and matching *_id columns that actually exist in the provided schema context.",
    "If one statement is not enough, you may return a short sequence of runnable SQL statements separated by semicolons.",
    "Return the runnable SQL inside a single ```sql fenced block and keep any explanation outside that block.",
    "",
    prompt,
  ].join("\n");
}

function buildAgentPlanPrompt(params: {
  userPrompt: string;
  assistIntent: AssistIntent;
  currentDatabase: string | null;
  availableTableNames: string[];
  appLanguage: string;
}) {
  const { userPrompt, assistIntent, currentDatabase, availableTableNames, appLanguage } = params;
  const visibleTables = availableTableNames.slice(0, MAX_TABLE_NAMES_IN_CONTEXT);
  const languageRule = appLanguage === "vi"
    ? "Reply in Vietnamese."
    : appLanguage === "zh"
      ? "Reply in Chinese."
      : appLanguage === "ko"
        ? "Reply in Korean."
        : appLanguage === "tr"
          ? "Reply in Turkish."
          : "Reply in English.";
  return [
    "You are an autonomous database agent about to work on a request.",
    "Briefly acknowledge what the user wants and state the plan you will execute now.",
    "Speak in the first person, warm and concise, like a senior engineer thinking out loud (max 3 short sentences).",
    "You will inspect the schema and run read-only queries yourself in the next steps, so commit to a concrete plan.",
    "Do NOT ask the user for clarification, do NOT ask which metrics/tables they want, and do NOT offer to help ? you already have the schema and must proceed. If the request is broad, pick the most relevant tables yourself and say which ones you will start with.",
    "Mention which tables you expect to inspect, but do NOT write SQL in this step.",
    "Do not use bullet lists or headings; write 2-3 natural sentences.",
    languageRule,
    "",
    `Goal type: ${assistIntent}.`,
    `Current database: ${currentDatabase || "Default"}.`,
    visibleTables.length > 0 ? `Known tables: ${visibleTables.join(", ")}${availableTableNames.length > visibleTables.length ? ", ..." : ""}` : "No table list available yet.",
    "",
    "User request:",
    userPrompt,
  ]
    .filter(Boolean)
    .join("\n");
}

function buildAgentControllerPrompt(params: {
  userPrompt: string;
  assistIntent: AssistIntent;
  currentDatabase: string | null;
  availableTableNames: string[];
  steps: AgentTraceStep[];
  workspaceToolsEnabled: boolean;
  workspaceToolStatus?: string;
  forceFinish?: boolean;
  extraInstruction?: string;
}) {
  const {
    userPrompt,
    assistIntent,
    currentDatabase,
    availableTableNames,
    steps,
    workspaceToolsEnabled,
    workspaceToolStatus,
    forceFinish,
    extraInstruction,
  } = params;
  const visibleTables = availableTableNames.slice(0, MAX_TABLE_NAMES_IN_CONTEXT);
  // Bound the trace embedded in each controller prompt so it never exceeds the
  // backend prompt cap. The "plan" step is narration for the user and is not
  // needed as controller context, and only the most recent tool observations
  // are kept in full while older ones are reduced to their action + reason.
  const toolSteps = steps.filter((step) => step.action !== "plan");
  const RECENT_FULL_OBSERVATIONS = 4;
  const priorSteps = toolSteps.length === 0
    ? "No tool actions have run yet."
    : toolSteps.map((step, index) => {
        const isRecent = index >= toolSteps.length - RECENT_FULL_OBSERVATIONS;
        const lines = [
          `Step ${step.step}`,
          `Action: ${step.action}`,
          `Message: ${step.message || "No message provided."}`,
        ];
        if (isRecent) {
          lines.push("Observation:", step.observation);
        } else {
          lines.push("Observation: (older step, omitted to save space)");
        }
        return lines.join("\n");
      }).join("\n\n");
  const availableActions = workspaceToolsEnabled
    ? [
        '1. {"action":"list_tables","message":"short reason","args":{}}',
        '2. {"action":"describe_table","message":"short reason","args":{"table":"exact_table_name"}}',
        '3. {"action":"run_readonly_sql","message":"short reason","args":{"sql":"SELECT ..."}}',
        '4. {"action":"finish","message":"short reason","args":{"response":"markdown for the user","sql":"optional grounded SQL for later human approval","metricsWidgets":[{"title":"Widget title","type":"bar|horizontal-bar|line|area|pie|donut|radial|table|scoreboard","query":"SELECT ..."}]}}',
      ]
    : [
        '1. {"action":"finish","message":"short reason","args":{"response":"markdown for the user","sql":"optional grounded SQL for later human approval"}}',
      ];

  const assembled = [
    "Work as an autonomous workspace agent.",
    `Goal type: ${assistIntent}.`,
    `Current database: ${currentDatabase || "Default"}.`,
    workspaceToolsEnabled
      ? `Known tables: ${visibleTables.join(", ")}${availableTableNames.length > visibleTables.length ? ", ..." : ""}`
      : "Known tables: unavailable for this turn unless the user explicitly provides them.",
    workspaceToolStatus ? `Workspace tools status: ${workspaceToolStatus}` : "",
    "",
    "Available actions:",
    ...availableActions,
    "",
    "Rules:",
    "- Return exactly one JSON object and nothing else.",
    "- Write the \"message\" field as a short first-person thought that narrates your reasoning, e.g. \"Let me check which tables hold order data first\" or \"I have the schema, now I'll count rows per status\". Keep it natural and conversational like you are thinking out loud.",
    "- Use only the action names above.",
    "- If the request is general conversation, writing, planning, coding advice, translation, brainstorming, or reasoning, answer directly with action=finish.",
    "- Never claim that you are limited to database-only tasks.",
    workspaceToolsEnabled
      ? "- Use database tools only when the user asks about the current workspace schema/data or when you need direct evidence from the workspace."
      : "- Database tools are not available for this turn, so respond with action=finish.",
    workspaceToolsEnabled
      ? "- Use run_readonly_sql only for read-only statements such as SELECT, SHOW, EXPLAIN, DESCRIBE, or read-only PRAGMA."
      : "",
    workspaceToolsEnabled
      ? "- Never use tool calls for INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, TRUNCATE, USE, ATTACH, DETACH, SET search_path, GRANT, or REVOKE."
      : "",
    "- If you include final SQL in finish.args.sql, it must be grounded in verified context and ready to execute.",
    workspaceToolsEnabled
      ? "- Do NOT finish by only listing query ideas or asking the user which one to run. If data would answer the request, run run_readonly_sql first, then finish with that query in finish.args.sql."
      : "",
    workspaceToolsEnabled
      ? "- Never finish by asking the user for clarification, scope, or which tables/metrics they want. You already have the schema ? choose the most relevant tables yourself, inspect them, run the query, and deliver a concrete result."
      : "",
    "- If the user asks for a chart or visualization, run a chart-friendly aggregate query and return that exact SQL in finish.args.sql; do not ask the UI to draw the chart for you.",
    forceFinish
      ? "- You must finish now. Return action=finish."
      : workspaceToolsEnabled
        ? "- Prefer taking another tool step when you still need schema or data evidence."
        : "- Finish directly unless the user explicitly needs missing workspace data.",
    extraInstruction ? `- Extra instruction: ${extraInstruction}` : "",
    "",
    "User request:",
    userPrompt,
    "",
    "Tool observations so far:",
    priorSteps,
  ]
    .filter(Boolean)
    .join("\n");

  return clampAgentPrompt(assembled);
}

// Hard safety cap so the controller prompt never trips the backend prompt limit
// even if schema/observations are unusually large. Keeps the head (instructions
// + request) and trims the trailing trace, which is the least critical part.
const MAX_AGENT_PROMPT_CHARS = 48_000;
function clampAgentPrompt(prompt: string): string {
  if (prompt.length <= MAX_AGENT_PROMPT_CHARS) return prompt;
  const head = prompt.slice(0, MAX_AGENT_PROMPT_CHARS - 400);
  return `${head}\n\n[Trace truncated to fit the prompt budget. Finish using the evidence gathered so far.]`;
}

function stripOptionalCodeFence(text: string) {
  const trimmed = text.trim();
  const fencedMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fencedMatch?.[1]?.trim() || trimmed;
}

function extractJsonObjectCandidate(text: string) {
  const stripped = stripOptionalCodeFence(text);
  const startIndex = stripped.indexOf("{");
  if (startIndex === -1) {
    return stripped;
  }

  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let index = startIndex; index < stripped.length; index += 1) {
    const char = stripped[index];

    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (char === "\\") {
        escaping = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return stripped.slice(startIndex, index + 1);
      }
    }
  }

  return stripped;
}

function sanitizeJsonStringLiterals(candidate: string) {
  let result = "";
  let inString = false;
  let escaping = false;

  for (let index = 0; index < candidate.length; index += 1) {
    const char = candidate[index];

    if (inString) {
      if (escaping) {
        result += char;
        escaping = false;
        continue;
      }

      if (char === "\\") {
        result += char;
        escaping = true;
        continue;
      }

      if (char === "\"") {
        result += char;
        inString = false;
        continue;
      }

      if (char === "\n") {
        result += "\\n";
        continue;
      }

      if (char === "\r") {
        result += "\\r";
        continue;
      }

      if (char === "\t") {
        result += "\\t";
        continue;
      }

      const codePoint = char.charCodeAt(0);
      if (codePoint < 0x20) {
        result += `\\u${codePoint.toString(16).padStart(4, "0")}`;
        continue;
      }

      result += char;
      continue;
    }

    if (char === "\"") {
      inString = true;
    }

    result += char;
  }

  return result;
}

function isAgentToolName(value: unknown): value is AgentToolName {
  return value === "list_tables" || value === "describe_table" || value === "run_readonly_sql" || value === "finish";
}

// Repairs a JSON object string that was cut off mid-output (e.g. the model hit
// its token limit). Closes an unterminated string literal, drops a dangling
// trailing comma/escape, and appends the missing closing brackets so the
// already-produced fields (action/message/partial args) can still be parsed.
function repairTruncatedJson(candidate: string): string {
  let inString = false;
  let escaping = false;
  const stack: string[] = [];

  for (let index = 0; index < candidate.length; index += 1) {
    const char = candidate[index];
    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (char === "\\") {
        escaping = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
    } else if (char === "{" || char === "[") {
      stack.push(char);
    } else if (char === "}" || char === "]") {
      stack.pop();
    }
  }

  let repaired = candidate;
  // A trailing lone backslash would invalidate the closing quote we add.
  if (inString && escaping) {
    repaired += "\\";
  }
  if (inString) {
    repaired += "\"";
  }
  // Remove a dangling comma before closing (",}" / ",]" are invalid).
  repaired = repaired.replace(/,\s*$/, "");
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    repaired += stack[index] === "{" ? "}" : "]";
  }
  return repaired;
}

function parseAgentActionResponse(rawResponse: string): AgentToolAction {
  const candidate = extractJsonObjectCandidate(rawResponse);
  let parsed: {
    action?: unknown;
    args?: unknown;
    message?: unknown;
  } | null = null;
  let parseError: unknown = null;

  for (const parseCandidate of [
    candidate,
    sanitizeJsonStringLiterals(candidate),
    repairTruncatedJson(sanitizeJsonStringLiterals(candidate)),
  ]) {
    try {
      parsed = JSON.parse(parseCandidate) as {
        action?: unknown;
        args?: unknown;
        message?: unknown;
      };
      parseError = null;
      break;
    } catch (errorValue) {
      parseError = errorValue;
    }
  }

  if (!parsed) {
    const message = parseError instanceof Error ? parseError.message : String(parseError ?? "Unknown JSON parse error");
    throw new Error(`The agent returned malformed JSON: ${message}`);
  }

  if (!isAgentToolName(parsed.action)) {
    throw new Error("The agent returned an unsupported action.");
  }

  if (parsed.args !== undefined && (parsed.args === null || Array.isArray(parsed.args) || typeof parsed.args !== "object")) {
    throw new Error("The agent returned invalid tool arguments.");
  }

  return {
    action: parsed.action,
    args: (parsed.args as Record<string, unknown> | undefined) || {},
    message: typeof parsed.message === "string" ? parsed.message.trim() : "",
  };
}

function truncateAgentObservation(text: string) {
  if (text.length <= MAX_AGENT_TRACE_OBSERVATION_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_AGENT_TRACE_OBSERVATION_CHARS - 3)}...`;
}

function sanitizeAgentObservationValue(value: string | number | boolean | null) {
  if (typeof value !== "string") return value;
  return value.length > 120 ? `${value.slice(0, 117)}...` : value;
}

function stringifyAgentObservation(data: unknown) {
  const content = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return truncateAgentObservation(content);
}

function findMatchingTableName(tableName: string, availableTableNames: string[]) {
  const normalizedTarget = normalizeIntentText(tableName);
  return availableTableNames.find((candidate) => normalizeIntentText(candidate) === normalizedTarget)
    || availableTableNames.find((candidate) => normalizeIntentText(candidate).includes(normalizedTarget))
    || availableTableNames.find((candidate) => normalizedTarget.includes(normalizeIntentText(candidate)))
    || null;
}

function validateAgentReadonlySql(sql: string) {
  const statements = splitSqlStatements(sql);
  if (statements.length === 0) {
    throw new Error("The agent tool requires at least one SQL statement.");
  }

  const allowedPrefixes = ["SELECT", "SHOW", "EXPLAIN", "DESCRIBE", "WITH", "PRAGMA"];

  for (const statement of statements) {
    const normalized = normalizeStatementForGuard(statement);
    if (!normalized) {
      continue;
    }

    if (isSessionSwitchStatement(statement) || isMutatingStatement(statement) || isHighRiskStatement(statement)) {
      throw new Error("The agent tool only allows read-only SQL observations.");
    }

    if (normalized.startsWith("PRAGMA") && normalized.includes("=")) {
      throw new Error("The agent tool only allows read-only PRAGMA statements.");
    }

    if (!allowedPrefixes.some((prefix) => normalized.startsWith(prefix))) {
      throw new Error("The agent tool only allows SELECT, SHOW, EXPLAIN, DESCRIBE, WITH, or read-only PRAGMA statements.");
    }
  }

  return statements;
}

function summarizeAgentQueryObservation(result: QueryResult) {
  const previewColumns = result.columns.slice(0, MAX_AGENT_QUERY_PREVIEW_COLUMNS);
  const sampleRows = result.rows
    .slice(0, MAX_AGENT_QUERY_PREVIEW_ROWS)
    .map((row) => Object.fromEntries(
      previewColumns.map((column, index) => [column.name, sanitizeAgentObservationValue(row[index] ?? null)])
    ));

  return stringifyAgentObservation({
    query: result.query,
    executionTimeMs: result.execution_time_ms,
    rowCount: result.rows.length,
    affectedRows: result.affected_rows,
    truncated: result.truncated,
    sandboxed: result.sandboxed,
    columns: previewColumns.map((column) => `${column.name}:${column.data_type}`),
    sampleRows,
  });
}

function summarizeAgentStructureObservation(
  tableName: string,
  structure: Pick<TableStructure, "columns" | "indexes" | "foreign_keys">
) {
  return truncateAgentObservation([
    `TABLE=${tableName}`,
    `SCHEMA=${encodeStructureForAI(tableName, structure, { mode: "relational" })}`,
    `COUNTS=cols:${structure.columns.length},idx:${structure.indexes.length},fk:${structure.foreign_keys.length}`,
  ].join("\n"));
}

function summarizeAgentSchemaSummaryObservation(tableName: string, summary: string) {
  return truncateAgentObservation([
    `TABLE=${tableName}`,
    `SCHEMA=${summary}`,
  ].join("\n"));
}

function buildAgentTraceMarkdown(steps: AgentTraceStep[]) {
  if (steps.length === 0) {
    return "";
  }

  return [
    "## Agent Trace",
    ...steps.map((step) => [
      `### Step ${step.step}: \`${step.action}\``,
      step.message || "No message provided.",
      "```text",
      step.observation,
      "```",
    ].join("\n")),
  ].join("\n\n");
}

function extractReferencedTableNamesFromSql(sql: string) {
  const candidates = new Set<string>();
  const patterns = [
    /\bfrom\s+([a-z_][a-z0-9_$."]*)/gi,
    /\bjoin\s+([a-z_][a-z0-9_$."]*)/gi,
    /\bupdate\s+([a-z_][a-z0-9_$."]*)/gi,
    /\binsert\s+into\s+([a-z_][a-z0-9_$."]*)/gi,
    /\bdelete\s+from\s+([a-z_][a-z0-9_$."]*)/gi,
    /\balter\s+table\s+([a-z_][a-z0-9_$."]*)/gi,
    /\bcreate\s+table\s+([a-z_][a-z0-9_$."]*)/gi,
    /\bdrop\s+table\s+([a-z_][a-z0-9_$."]*)/gi,
  ];

  for (const pattern of patterns) {
    for (const match of sql.matchAll(pattern)) {
      const raw = match[1];
      if (!raw) continue;
      const normalized = raw
        .replace(/["`]/g, "")
        .split(".")
        .filter(Boolean)
        .pop()
        ?.trim()
        .toLowerCase();
      if (normalized) {
        candidates.add(normalized);
      }
    }
  }

  return [...candidates];
}

function sqlResponseConflictsWithSchema(sql: string, availableTableNames: string[]) {
  if (!sql.trim() || availableTableNames.length === 0) return false;

  const knownNames = buildKnownTableNameSet(availableTableNames);
  const allowedSystemTables = new Set([
    "information_schema",
    "tables",
    "columns",
    "key_column_usage",
    "table_constraints",
    "constraint_column_usage",
    "pg_catalog",
    "pg_class",
    "pg_attribute",
    "pg_constraint",
    "pg_namespace",
    "sqlite_master",
    "pragma_table_info",
  ]);

  return extractReferencedTableNamesFromSql(sql).some((tableName) => {
    const normalized = normalizeIntentText(tableName);
    return !knownNames.has(normalized) && !allowedSystemTables.has(normalized);
  });
}

function buildSqlRegroundingPrompt(
  databaseName: string | null,
  availableTableNames: string[],
  originalPrompt: string,
  interactionMode: AIWorkspaceInteractionMode
) {
  const databaseLabel = databaseName || "current database";
  const modeLabel = interactionMode === "agent" ? "agent" : interactionMode === "edit" ? "edit" : "prompt-only";

  return [
    `Return SQL again from scratch for the CURRENT database "${databaseLabel}".`,
    `Interaction mode is ${modeLabel}.`,
    `Allowed tables only: ${availableTableNames.join(", ")}.`,
    "Use only verified tables and columns from the attached schema context.",
    "If the user asks which tables are related, what key they share, or asks for a sample to run, infer that from the attached foreign keys, indexes, and matching *_id columns only.",
    "Prefer safe read-only SQL unless the user explicitly asked to mutate data or schema.",
    "Do not invent any table, column, key, or relationship.",
    "Return only runnable SQL in a single ```sql fenced block.",
    "",
    originalPrompt,
  ].join("\n");
}

function mentionsUnknownSchemaNames(response: string, availableTableNames: string[]) {
  const normalizedResponse = normalizeIntentText(response);
  const knownNames = buildKnownTableNameSet(availableTableNames);
  const reserved = new Set([
    "table",
    "tables",
    "bang",
    "database",
    "schema",
    "context",
    "column",
    "columns",
    "relationship",
    "relationships",
    "overview",
    "current",
    "assistant",
    "sql",
    "ai",
  ]);

  const candidates = new Set<string>();
  const patterns = [
    /[`"'*]{1,2}([a-z_][a-z0-9_]*)[`"'*]{1,2}\s*:/g,
    /(?:table|tables|bang)\s+([a-z_][a-z0-9_]*)/g,
  ];

  for (const pattern of patterns) {
    for (const match of normalizedResponse.matchAll(pattern)) {
      const candidate = match[1];
      if (!candidate || reserved.has(candidate) || candidate.length < 2) continue;
      candidates.add(candidate);
    }
  }

  return [...candidates].some((candidate) => !knownNames.has(candidate));
}

function isOverviewContextMissingResponse(response: string) {
  const normalizedResponse = normalizeIntentText(response);
  const weakSignals = [
    "khong co thong tin",
    "khong co du lieu",
    "khong co ngu canh",
    "chua co thong tin",
    "vui long cung cap",
    "hay chia se",
    "khong duoc cung cap",
    "khong co database",
    "khong co co so du lieu",
    "no information",
    "not enough context",
    "not enough information",
    "database was not provided",
    "schema was not provided",
    "please provide",
    "share details",
    "share the tables",
    "share the columns",
    "no database context",
    "no schema context",
    "没有提供",
    "没有数据库",
    "没有上下文",
    "请提供",
    "提供更多信息",
    "分享表",
    "分享字段",
  ];

  return weakSignals.some((signal) => normalizedResponse.includes(signal));
}

function responseConflictsWithSchema(
  response: string,
  availableTableNames: string[]
) {
  if (availableTableNames.length === 0) return false;
  if (mentionsUnknownSchemaNames(response, availableTableNames)) return true;
  return false;
}

function buildSchemaGroundingFallback(
  language: AIResponseLanguage,
  databaseName: string | null,
  availableTableNames: string[]
) {
  const tableList = availableTableNames.join(", ");
  const databaseLabel = databaseName || "current database";

  if (language === "vi") {
    return `Mình chưa thể neo câu trả lời trước đó vào đúng DB hiện tại một cách đáng tin cậy. DB "${databaseLabel}" hiện có các bảng: ${tableList}. Hãy chỉ rõ bảng hoặc cột bạn muốn hỏi, hoặc dùng câu như "đọc lại toàn bộ DB hiện tại".`;
  }

  if (language === "zh") {
    return `我还不能把刚才的回答可靠地绑定到当前数据库。当前数据库“${databaseLabel}”包含这些表：${tableList}。请明确指出你要问的表或字段，或者直接说“重新概览当前数据库”。`;
  }

  return `I could not reliably ground the previous answer in the current database. The current database "${databaseLabel}" contains these tables: ${tableList}. Point me to a specific table or column, or ask me to review the current database again.`;
}

function buildSchemaRegroundingPrompt(
  language: AIResponseLanguage,
  databaseName: string | null,
  availableTableNames: string[],
  assistIntent: AssistIntent,
  originalPrompt: string
) {
  const databaseLabel = databaseName || "current database";
  const tableList = availableTableNames.join(", ");

  if (language === "vi") {
    return [
      `Hãy trả lời lại từ đầu bằng cách bám CHẶT vào DB hiện tại "${databaseLabel}".`,
      `Chỉ được dùng các bảng đã xác minh này: ${tableList}.`,
      "Bỏ qua hoàn toàn mọi giả định hoặc câu trả lời trước đó không khớp với schema hiện tại.",
      assistIntent === "overview"
        ? "Đây là yêu cầu đọc lại DB. Hãy tóm tắt overview, các bảng chính, quan hệ hoặc join path có thể suy ra, và ghi chú ngắn. Không được nói là thiếu schema nếu schema đã được cung cấp."
        : "Hãy trả lời câu hỏi của user chỉ dựa trên schema hiện tại. Nếu schema chưa đủ để khẳng định chi tiết, hãy nói rõ giới hạn đó nhưng vẫn phải bám đúng các bảng hiện có.",
      "Không được bịa domain, bảng, cột, hoặc quan hệ không có trong schema hiện tại.",
      "",
      originalPrompt,
    ].join("\n");
  }

  if (language === "zh") {
    return [
      `请从头开始回答，并且严格依据当前数据库“${databaseLabel}”。`,
      `只能使用这些已经验证存在的表：${tableList}。`,
      "忽略任何与当前 schema 不一致的旧假设或旧回答。",
      assistIntent === "overview"
        ? "这是一次重新阅读当前数据库的请求。请给出 overview、主要表、可推断的关系或 join path，以及简短备注。既然 schema 已提供，就不要再说缺少 schema。"
        : "请只依据当前 schema 回答用户问题。如果 schema 不足以确认细节，可以说明限制，但仍然必须严格基于当前可见表。",
      "不要编造 schema 中不存在的业务域、表、字段或关系。",
      "",
      originalPrompt,
    ].join("\n");
  }

  return [
    `Answer again from scratch and stay strictly inside the current database "${databaseLabel}".`,
    `You may only use these verified tables: ${tableList}.`,
    "Ignore any earlier assistant assumptions that do not match the current schema.",
    assistIntent === "overview"
      ? "This is a database review request. Provide an overview, the main tables, likely relationships or join paths, and short notes. Do not say the schema is missing because it is already attached."
      : "Answer the user's question using only the current schema. If the schema is not enough to confirm a detail, state that limit clearly while staying grounded in the visible tables.",
    "Do not invent any domain, table, column, or relationship that is not present in the current schema.",
    "",
    originalPrompt,
  ].join("\n");
}

void buildSchemaGroundingFallback;

function buildSchemaContextRequiredMessage(
  language: AIResponseLanguage,
  databaseName: string | null,
  providerName: string,
  interactionMode: AIWorkspaceInteractionMode,
  providerAllowsSchemaContext: boolean
) {
  const databaseLabel = databaseName || "current database";
  const modeLabel =
    interactionMode === "agent"
      ? language === "vi"
        ? "Agent"
        : language === "zh"
          ? "Agent"
          : "Agent"
      : interactionMode === "edit"
        ? language === "vi"
          ? "Chỉnh sửa"
          : language === "zh"
            ? "编辑"
            : "Edit"
        : language === "vi"
          ? "Chỉ prompt"
          : language === "zh"
            ? "仅提示词"
            : "Prompt only";

  if (language === "vi") {
    if (!providerAllowsSchemaContext) {
      return `Mình chưa thể đọc lại DB "${databaseLabel}" vì provider "${providerName}" đang chặn chia sẻ schema cho AI. Schema dành cho AI vẫn đang được tạo, nhưng để chế độ "${modeLabel}" đọc đúng DB hiện tại bạn cần bật "Allow schema context sharing" trong AI Provider Settings.`;
    }

    return `Mình chưa thể đọc lại DB "${databaseLabel}" vì chat AI đang ở chế độ "${modeLabel}". Ở chế độ này app sẽ không gửi schema dành cho AI vào model. Hãy chuyển sang "Chỉnh sửa" hoặc "Agent" nếu bạn muốn AI đọc đúng DB hiện tại trong workspace.`;
  }

  if (language === "zh") {
    if (!providerAllowsSchemaContext) {
      return `我现在还不能重新读取数据库“${databaseLabel}”，因为 provider“${providerName}”当前阻止了 schema sharing。AI 专用 schema 仍然会正常生成，但如果你希望“${modeLabel}”模式正确读取当前 workspace 的数据库，需要先在 AI Provider Settings 中开启“Allow schema context sharing”。`;
    }

    return `我现在还不能重新读取数据库“${databaseLabel}”，因为当前聊天处于“${modeLabel}”模式。在这个模式下，应用不会把 AI schema 上下文发送给模型。若要让 AI 正确读取当前 workspace 的数据库，请切换到“编辑”或“Agent”模式。`;
  }

  if (!providerAllowsSchemaContext) {
    return `I cannot review the database "${databaseLabel}" right now because provider "${providerName}" is blocking schema sharing. The AI-ready schema is still being generated, but to let "${modeLabel}" mode read the current workspace database you need to enable "Allow schema context sharing" in AI Provider Settings.`;
  }

  return `I cannot review the database "${databaseLabel}" right now because this chat is in "${modeLabel}" mode. In that mode the AI-ready schema is not sent to the model. Switch to "Edit" or "Agent" if you want the assistant to read the current workspace database.`;
}

function isLikelySqlOnlyResponse(aiResponse: string) {
  const extractedSql = extractSqlFromResponse(aiResponse);
  if (!extractedSql) return false;

  const normalizedResponse = aiResponse.replace(/```sql?/gi, "").replace(/```/g, "").trim();
  if (!normalizedResponse) return false;

  const remainder = normalizedResponse.replace(extractedSql, "").replace(/\s+/g, " ").trim();
  return remainder.length < 40;
}

function stripLeadingSqlComments(sql: string) {
  let remaining = sql.trimStart();

  while (remaining.length > 0) {
    if (remaining.startsWith("--") || remaining.startsWith("#")) {
      const nextNewline = remaining.indexOf("\n");
      remaining = nextNewline >= 0 ? remaining.slice(nextNewline + 1).trimStart() : "";
      continue;
    }

    if (remaining.startsWith("/*")) {
      const commentEnd = remaining.indexOf("*/");
      if (commentEnd < 0) {
        return "";
      }
      remaining = remaining.slice(commentEnd + 2).trimStart();
      continue;
    }

    break;
  }

  return remaining.trimStart();
}

function hasSqlStartKeyword(sql: string) {
  const normalized = stripLeadingSqlComments(sql).toUpperCase().trim();
  return normalized.length > 0 && SQL_START_KEYWORDS.some((keyword) => normalized.startsWith(keyword));
}

function extractSqlFromResponse(aiResponse: string) {
  let sqlResult = aiResponse.trim();
  const codeBlock = aiResponse.match(/```sql?([\s\S]*?)```/i);
  if (codeBlock && codeBlock[1]) {
    sqlResult = codeBlock[1].trim();
  } else {
    if (hasSqlStartKeyword(sqlResult)) {
      return sqlResult;
    }

    const lines = aiResponse
      .split("\n")
      .map((line) => line.trimEnd());
    const sqlStartIndex = lines.findIndex((line) => hasSqlStartKeyword(line));
    if (sqlStartIndex < 0) {
      return "";
    }

    let startIndex = sqlStartIndex;
    while (startIndex > 0) {
      const previousLine = lines[startIndex - 1]?.trim() || "";
      if (
        previousLine === "" ||
        previousLine.startsWith("--") ||
        previousLine.startsWith("#") ||
        previousLine.startsWith("/*") ||
        previousLine.startsWith("*") ||
        previousLine.startsWith("*/")
      ) {
        startIndex -= 1;
        continue;
      }
      break;
    }

    sqlResult = lines.slice(startIndex).join("\n").trim();
  }
  return sqlResult;
}

function stripSqlCodeBlocksFromResponse(aiResponse: string) {
  return aiResponse.replace(/```sql[\s\S]*?```/gi, "").trim();
}

function summarizeRunResult(result: QueryResult) {
  if (result.rows.length > 0) {
    return `Returned ${result.rows.length} row${result.rows.length === 1 ? "" : "s"} in ${result.execution_time_ms} ms${result.truncated ? " with a truncated preview." : "."}`;
  }
  if (result.affected_rows > 0) {
    return `Applied changes to ${result.affected_rows} row${result.affected_rows === 1 ? "" : "s"} in ${result.execution_time_ms} ms.`;
  }
  return `Execution completed in ${result.execution_time_ms} ms.`;
}

export function useAISlidePanel({ isOpen }: { isOpen: boolean }) {
  const {
    askAIWithReasoning,
    aiConfigs,
    saveAIConfigs,
    tables,
    getTableStructure,
    getTableColumnsPreview,
    fetchTables,
    executeSandboxQuery,
    switchDatabase,
    activeConnectionId: connectionId,
    currentDatabase,
  } = useAppStore(
    useShallow((state) => ({
      askAIWithReasoning: state.askAIWithReasoning,
      aiConfigs: state.aiConfigs,
      saveAIConfigs: state.saveAIConfigs,
      tables: state.tables,
      getTableStructure: state.getTableStructure,
      getTableColumnsPreview: state.getTableColumnsPreview,
      fetchTables: state.fetchTables,
      executeSandboxQuery: state.executeSandboxQuery,
      switchDatabase: state.switchDatabase,
      activeConnectionId: state.activeConnectionId,
      currentDatabase: state.currentDatabase,
    }))
  );

  const [isGenerating, setIsGenerating] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const aiSchemaCodecCacheRef = useRef(new Map<string, string>());
  const requestIdRef = useRef(0);
  // Captures the model's real reasoning from the most recent askAI call so the
  // final assistant bubble can show genuine thinking instead of fabricated steps.
  const lastReasoningRef = useRef<string | undefined>(undefined);

  const askAI = useCallback(
    async (
      prompt: string,
      context: string,
      mode: AIRequestMode = "panel",
      intent: AIRequestIntent = "sql",
      history: AIConversationMessage[] = [],
    ): Promise<string> => {
      const { text, reasoning } = await askAIWithReasoning(prompt, context, mode, intent, history);
      if (reasoning && reasoning.trim()) {
        lastReasoningRef.current = reasoning.trim();
      }
      return text;
    },
    [askAIWithReasoning],
  );

  const activeProvider = getActiveAIProvider(aiConfigs);
  const isLocalProvider = isLocalAIProvider(activeProvider);
  const tableContextCount = tables?.length || 0;

  useEffect(() => {
    aiSchemaCodecCacheRef.current.clear();
  }, [connectionId, currentDatabase]);

  useEffect(() => {
    const handleTableDataUpdated = (
      event: Event
    ) => {
      const detail = (event as CustomEvent<{
        connectionId?: string;
        database?: string;
        invalidateStructure?: boolean;
      }>).detail;

      if (!detail?.invalidateStructure) return;
      if (detail.connectionId !== connectionId) return;

      const detailDatabase = detail.database || "";
      const activeDatabaseName = currentDatabase || "";
      if (detailDatabase && activeDatabaseName && detailDatabase !== activeDatabaseName) return;

      aiSchemaCodecCacheRef.current.clear();
    };

    window.addEventListener("table-data-updated", handleTableDataUpdated);
    return () => window.removeEventListener("table-data-updated", handleTableDataUpdated);
  }, [connectionId, currentDatabase]);

  useEffect(() => {
    if (isOpen) {
      setError(null);
    } else {
      requestIdRef.current += 1;
    }
  }, [isOpen]);

  const generateAssist = useCallback(async (
    prompt: string,
    history: AIConversationMessage[] = [],
    options?: {
      interactionMode?: AIWorkspaceInteractionMode;
      requestDataReadConsent?: () => Promise<boolean>;
      userPrompt?: string;
      onAgentProgress?: (steps: AIWorkspaceAgentStep[]) => void;
    }
  ): Promise<AIGeneratedAssistResult> => {
    const normalizedPrompt = prompt.trim();
    if (!normalizedPrompt) {
      const message = "Write a request first.";
      setError(message);
      throw new Error(message);
    }
    if (!activeProvider) {
      const message = "No AI provider is enabled yet. Configure one in Settings first.";
      setError(message);
      throw new Error(message);
    }

    setIsGenerating(true);
    setError(null);
    const requestId = ++requestIdRef.current;
    lastReasoningRef.current = undefined;
    const requestedInteractionMode = options?.interactionMode ?? "prompt";
    const requestDataReadConsent = options?.requestDataReadConsent;
    const onAgentProgress = options?.onAgentProgress;
    const requestIntentPrompt = options?.userPrompt?.trim() || normalizedPrompt;
    const assistIntent: AssistIntent = inferAssistIntent(requestIntentPrompt, requestedInteractionMode);
    const wantsVisualization = isVisualizationRequest(requestIntentPrompt);
    const wantsMetricsBoard = isMetricsBoardRequest(requestIntentPrompt);
    const interactionMode = requestedInteractionMode;
    // In agent mode, as long as there is a live connection we let the agent reach
    // for workspace tools even when the intent looks general ? that is what makes
    // it behave like a real autonomous agent instead of a plain chat reply.
    const agentCanUseWorkspace = requestedInteractionMode === "agent" && Boolean(connectionId);
    const needsWorkspaceContext = isWorkspaceScopedIntent(assistIntent) || agentCanUseWorkspace;
    const appLanguage = getCurrentAppLanguage();
    const modeUsesSchemaContext = aiModeUsesSchemaContext(interactionMode);
    const aiPrompt = buildAssistPrompt(normalizedPrompt, assistIntent, interactionMode);
    const requestHistory =
      assistIntent === "overview"
        ? []
        : isLocalProvider
          ? history
          : history.slice(-MAX_REMOTE_HISTORY_MESSAGES);
    const fastRemoteRecovery = !isLocalProvider && interactionMode !== "agent";
    const relationalSchemaSummaryByTable = new Map<string, string>();

    try {
      await yieldToBrowserFrame();

      if (needsWorkspaceContext && !connectionId) {
        const message = "Connect to a database first if you want grounded workspace help.";
        setError(message);
        throw new Error(message);
      }

      let effectiveProvider = activeProvider;
      let schemaSharingEnabled = effectiveProvider.allow_schema_context;

      if (needsWorkspaceContext && modeUsesSchemaContext && !schemaSharingEnabled) {
        const nextConfigs = aiConfigs.map((config) => (
          config.id === effectiveProvider.id
            ? { ...config, allow_schema_context: true }
            : config
        ));

        const { aiConfigs: savedConfigs } = await saveAIConfigs(nextConfigs, {}, []);
        effectiveProvider = getActiveAIProvider(savedConfigs) ?? { ...effectiveProvider, allow_schema_context: true };
        schemaSharingEnabled = effectiveProvider.allow_schema_context;
      }

      const schemaContextEnabled =
        needsWorkspaceContext &&
        schemaSharingEnabled &&
        modeUsesSchemaContext;
      const requiresSchemaCatalog = schemaContextEnabled;

      let latestTables = useAppStore.getState().tables ?? [];

      if (requiresSchemaCatalog && latestTables.length === 0) {
        if (connectionId && currentDatabase) {
          await fetchTables(connectionId, currentDatabase);
        }
        if (requestId !== requestIdRef.current) {
          throw new Error(AI_REQUEST_REPLACED_MESSAGE);
        }
        await yieldToBrowserFrame();
        latestTables = useAppStore.getState().tables ?? [];
        if (latestTables.length === 0) {
          throw new Error("No tables were found in the current database.");
        }
      }

      if (needsWorkspaceContext && modeUsesSchemaContext && !schemaSharingEnabled) {
        return {
          prompt: normalizedPrompt,
          rawResponse: buildSchemaContextRequiredMessage(
            appLanguage,
            currentDatabase,
            effectiveProvider.name || "AI provider",
            interactionMode,
            schemaSharingEnabled
          ),
          sql: null,
          intent: assistIntent,
        };
      }

      if (assistIntent === "overview" && !schemaContextEnabled) {
        return {
          prompt: normalizedPrompt,
          rawResponse: buildSchemaContextRequiredMessage(
            appLanguage,
            currentDatabase,
            effectiveProvider.name || "AI provider",
            interactionMode,
            schemaSharingEnabled
          ),
          sql: null,
          intent: assistIntent,
        };
      }

      let context = connectionId
        ? [
            "Workspace metadata:",
            `Current database: ${currentDatabase || "Default"}`,
            `Schema sharing enabled: ${schemaSharingEnabled ? "yes" : "no"}`,
          ].join("\n")
        : [
            "Workspace metadata:",
            "No active database connection is selected for this turn.",
          ].join("\n");
      let availableSchemaTables: string[] = [];
      let schemaCapsulePreview = "";
      let strictRecoveryContext = "";
      let agentPromptTableNames: string[] = [];
      let contextVisibleTableNames: string[] = [];
      if (schemaContextEnabled) {
        availableSchemaTables = latestTables
          .map((table) => buildWorkspaceTableIdentifier(table, currentDatabase))
          .filter(Boolean);
        const tablesToFetch =
          assistIntent === "overview"
            ? latestTables.slice(0, !isLocalProvider ? MAX_REMOTE_AGENT_OVERVIEW_TABLES : MAX_OVERVIEW_SCHEMA_TABLES)
            : !isLocalProvider
              ? pickRelevantTables(normalizedPrompt, latestTables).slice(0, MAX_REMOTE_AGENT_SCHEMA_TABLES)
              : pickRelevantTables(normalizedPrompt, latestTables);
        const schemaCodecMode = assistIntent === "overview" ? "relational" : inferAISchemaCodecMode(normalizedPrompt);
        await yieldToBrowserFrame();
        const tableSchemaEntries = await mapWithConcurrency(
          tablesToFetch,
          schemaCodecMode === "relational" ? MAX_SCHEMA_FETCH_CONCURRENCY : tablesToFetch.length,
          async (table) => {
            const tableIdentifier = buildWorkspaceTableIdentifier(table, currentDatabase) || table.name;
            const cacheKey = `${connectionId}:${currentDatabase || "default"}:${schemaCodecMode}:${tableIdentifier}`;
            const cachedSummary = aiSchemaCodecCacheRef.current.get(cacheKey);
            if (cachedSummary) {
              if (schemaCodecMode === "relational") {
                relationalSchemaSummaryByTable.set(tableIdentifier, cachedSummary);
              }
              return {
                tableName: tableIdentifier,
                summary: cachedSummary,
              };
            }
            try {
              const structure =
                schemaCodecMode === "core"
                  ? {
                      columns: await getTableColumnsPreview(connectionId!, tableIdentifier, currentDatabase || undefined),
                      indexes: [],
                      foreign_keys: [],
                    }
                  : await getTableStructure(connectionId!, tableIdentifier, currentDatabase || undefined);
              const summary = encodeStructureForAI(tableIdentifier, structure, { mode: schemaCodecMode });
              setAiSchemaCodecCacheEntry(aiSchemaCodecCacheRef.current, cacheKey, summary);
              if (schemaCodecMode === "relational") {
                relationalSchemaSummaryByTable.set(tableIdentifier, summary);
              }
              return {
                tableName: tableIdentifier,
                summary,
              };
            } catch {
              const fallbackSummary = `T:${tableIdentifier}|C:[]`;
              setAiSchemaCodecCacheEntry(aiSchemaCodecCacheRef.current, cacheKey, fallbackSummary);
              if (schemaCodecMode === "relational") {
                relationalSchemaSummaryByTable.set(tableIdentifier, fallbackSummary);
              }
              return {
                tableName: tableIdentifier,
                summary: fallbackSummary,
              };
            }
          }
        );
        if (requestId !== requestIdRef.current) {
          throw new Error(AI_REQUEST_REPLACED_MESSAGE);
        }
        await yieldToBrowserFrame();

        const tableSchemas = tableSchemaEntries.map((entry) => entry.summary);
        schemaCapsulePreview = buildSchemaCapsulePreview(tableSchemas);
        const prioritizedAgentTableNames = tableSchemaEntries.map((entry) => entry.tableName);
        contextVisibleTableNames = buildAgentVisibleTableNames(
          availableSchemaTables,
          prioritizedAgentTableNames,
          isLocalProvider ? MAX_TABLE_NAMES_IN_CONTEXT : MAX_REMOTE_AGENT_VISIBLE_TABLES
        );
        agentPromptTableNames = interactionMode === "agent"
          ? buildAgentVisibleTableNames(
              availableSchemaTables,
              prioritizedAgentTableNames,
              isLocalProvider ? MAX_LOCAL_AGENT_VISIBLE_TABLES : MAX_REMOTE_AGENT_VISIBLE_TABLES
            )
          : [];

        context = buildSchemaCapsuleContext({
          currentDatabase,
          totalTableCount: latestTables.length,
          visibleTableNames: contextVisibleTableNames,
          allVisible: latestTables.length <= contextVisibleTableNames.length,
          tableSchemas,
          schemaCodecMode,
          truncatedOverview: assistIntent === "overview" && latestTables.length > tablesToFetch.length,
        });

        strictRecoveryContext = interactionMode === "agent"
          ? buildAgentRecoveryContext({
              currentDatabase,
              availableTableNames: availableSchemaTables,
              visibleTableNames: agentPromptTableNames,
              schemaCapsulePreview,
            })
          : [
              `DB=${currentDatabase || "Default"}`,
              `TV=${(isLocalProvider ? availableSchemaTables : contextVisibleTableNames).join(",")}${!isLocalProvider && availableSchemaTables.length > contextVisibleTableNames.length ? ",..." : ""}`,
              schemaCapsulePreview ? `SCHEMA_PREVIEW=\n${schemaCapsulePreview}` : "",
              "RULE=Stay strictly inside the verified schema capsule.",
            ]
              .filter(Boolean)
              .join("\n");
      }

      if (interactionMode === "agent") {
        const agentTraceSteps: AgentTraceStep[] = [];
        // Snapshot completed steps plus an optional in-flight step, then stream
        // them to the UI so the bubble can show the agent working live.
        const publishAgentProgress = (pending?: { action: AgentToolName; message: string }) => {
          if (!onAgentProgress) return;
          const completed: AIWorkspaceAgentStep[] = agentTraceSteps.map((step) => ({
            step: step.step,
            action: step.action,
            message: step.message,
            observation: step.observation,
            status: step.observation.startsWith("Tool error") || step.observation.startsWith("Tool blocked")
              ? "error"
              : "done",
          }));
          if (pending) {
            completed.push({
              step: agentTraceSteps.length + 1,
              action: pending.action,
              message: pending.message,
              status: "running",
            });
          }
          onAgentProgress(completed);
        };
        const needsExtendedAgentBudget = wantsVisualization || assistIntent === "overview";
        const agentStepBudget = isLocalProvider
          ? (needsExtendedAgentBudget ? MAX_LOCAL_COMPLEX_AGENT_STEPS : MAX_AGENT_STEPS)
          : (needsExtendedAgentBudget ? MAX_REMOTE_COMPLEX_AGENT_STEPS : MAX_REMOTE_AGENT_STEPS);
        const workspaceToolsEnabled =
          schemaContextEnabled &&
          availableSchemaTables.length > 0 &&
          Boolean(connectionId);
        const workspaceToolStatus = workspaceToolsEnabled
              ? "Database tools are available if grounded workspace evidence is needed."
          : !connectionId
            ? "No active database connection is selected, so respond without workspace tools."
            : !needsWorkspaceContext
              ? "This request is broader than database work, so answer directly unless the user explicitly asks for workspace data."
              : !schemaSharingEnabled
                ? "Schema sharing is disabled for the current provider, so workspace tools are unavailable for this turn."
                : "No verified schema snapshot is available for tool use on this turn.";
        const sharedAgentInstruction = joinAgentInstructions(
          "You are an autonomous agent that takes action, not a consultant. Decide your own steps: inspect the schema with list_tables/describe_table, then ACTUALLY run run_readonly_sql to gather the data needed to answer. Do not just suggest queries and do not ask the user which query to run first ? pick the most relevant one and run it yourself.",
          "When the user asks to see data, charts, counts, samples, distributions, or 'show me' anything, you MUST run at least one run_readonly_sql before finishing. Finishing with only suggestions and no executed query is a failure.",
          "When you finish, put the single best runnable query in finish.args.sql (a real SELECT grounded in the verified schema) so it can be executed and shown to the user automatically.",
          !isLocalProvider
            ? "Be efficient: a few targeted tool calls are better than exploring every table, but never skip running the query that produces the answer."
            : undefined,
          wantsVisualization
            ? "For a chart or visualization request, run a chart-friendly aggregate query (e.g. GROUP BY ... COUNT(*)) and return that exact SQL in finish.args.sql plus a short chart recommendation."
            : undefined,
          wantsMetricsBoard
            ? "This is a metrics/dashboard/summary request. Inspect the relevant tables, then in finish.args.metricsWidgets return 3-6 widgets that form a useful board. Each widget needs a clear title, a type (scoreboard for single totals, bar/pie/line for grouped aggregates, table for detailed breakdowns), and a runnable read-only query grounded in the verified schema. Build the board yourself; do not ask the user which widgets they want."
            : undefined
        );
        const buildControllerPrompt = (forceFinish: boolean, extraInstruction?: string) =>
          buildAgentControllerPrompt({
            userPrompt: normalizedPrompt,
            assistIntent,
            currentDatabase,
            availableTableNames: agentPromptTableNames.length > 0 ? agentPromptTableNames : availableSchemaTables,
            steps: agentTraceSteps,
            workspaceToolsEnabled,
            workspaceToolStatus,
            forceFinish,
            extraInstruction,
          });

        const requestAgentAction = async (controllerPrompt: string, includeHistory: boolean, extraInstruction?: string) => {
          let rawAgentResponse = await askAI(
            extraInstruction
              ? `${controllerPrompt}\n\nRepair note:\n${extraInstruction}`
              : controllerPrompt,
            strictRecoveryContext || context,
            "panel",
            "agent",
            includeHistory ? requestHistory : []
          );
          if (requestId !== requestIdRef.current) {
            throw new Error(AI_REQUEST_REPLACED_MESSAGE);
          }

          try {
            return parseAgentActionResponse(rawAgentResponse);
          } catch {
            rawAgentResponse = await askAI(
              [
                controllerPrompt,
                "",
                "The previous reply was not valid. Return the same next action again as valid JSON only.",
                'Example shape: {"action":"describe_table","message":"Need the schema first.","args":{"table":"users"}}',
              ].join("\n"),
              strictRecoveryContext || context,
              "panel",
              "agent",
              []
            );
            if (requestId !== requestIdRef.current) {
              throw new Error(AI_REQUEST_REPLACED_MESSAGE);
            }
            return parseAgentActionResponse(rawAgentResponse);
          }
        };

        const runAgentTool = async (action: AgentToolAction) => {
          try {
            if (action.action === "list_tables") {
              return stringifyAgentObservation({
                database: currentDatabase || "Default",
                tableCount: latestTables.length,
                tables: latestTables.slice(0, MAX_TABLE_NAMES_IN_CONTEXT).map((table) => ({
                  name: table.name,
                  schema: table.schema ?? null,
                  identifier: buildWorkspaceTableIdentifier(table, currentDatabase),
                  type: table.table_type,
                  rowCount: table.row_count ?? null,
                })),
              });
            }

            if (action.action === "describe_table") {
              const requestedTable = typeof action.args?.table === "string" ? action.args.table.trim() : "";
              if (!requestedTable) {
                return "Tool error: describe_table requires args.table.";
              }

              const matchedTable = findMatchingTableName(requestedTable, availableSchemaTables);
              if (!matchedTable) {
                return `Tool error: Table "${requestedTable}" is not present in the current workspace schema.`;
              }

              const cachedSummary = relationalSchemaSummaryByTable.get(matchedTable);
              if (cachedSummary) {
                return summarizeAgentSchemaSummaryObservation(matchedTable, cachedSummary);
              }

              const structure = await getTableStructure(connectionId!, matchedTable, currentDatabase || undefined);
              if (requestId !== requestIdRef.current) {
                throw new Error(AI_REQUEST_REPLACED_MESSAGE);
              }

              return summarizeAgentStructureObservation(matchedTable, structure);
            }

            if (action.action === "run_readonly_sql") {
              const sql = typeof action.args?.sql === "string" ? action.args.sql.trim() : "";
              if (!sql) {
                return "Tool error: run_readonly_sql requires args.sql.";
              }

              if (wantsVisualization && requestDataReadConsent) {
                const approved = await requestDataReadConsent();
                if (!approved) {
                  return "Tool blocked: The user did not grant permission to read live database rows for this visualization request.";
                }
              }

              const statements = validateAgentReadonlySql(sql);
              const queryResult = await executeSandboxQuery(connectionId!, statements);
              if (requestId !== requestIdRef.current) {
                throw new Error(AI_REQUEST_REPLACED_MESSAGE);
              }

              return summarizeAgentQueryObservation(queryResult);
            }

            return "Tool error: finish does not execute a tool observation.";
          } catch (errorValue) {
            if (isSupersededAIRequestError(errorValue)) {
              throw errorValue;
            }
            return `Tool error: ${formatExecutionError(errorValue)}`;
          }
        };

        const recoverAgentFinishAction = async (reason: string): Promise<AgentToolAction> => {
          const allowedTables = agentPromptTableNames.length > 0 ? agentPromptTableNames : availableSchemaTables;
          const fallbackResponse = buildLocalAgentFallbackResponse({
            language: appLanguage,
            currentDatabase,
            availableTableNames: allowedTables,
            wantsVisualization,
            steps: agentTraceSteps,
          });

          try {
            const recoveredResponse = await askAI(
              buildAgentFinalRecoveryPrompt({
                userPrompt: normalizedPrompt,
                assistIntent,
                currentDatabase,
                availableTableNames: allowedTables,
                evidenceSummary: buildAgentEvidenceSummary(agentTraceSteps),
                wantsVisualization,
                reason,
              }),
              strictRecoveryContext || context,
              "panel",
              assistIntent === "overview" ? "overview" : "explain",
              []
            );
            if (requestId !== requestIdRef.current) {
              throw new Error(AI_REQUEST_REPLACED_MESSAGE);
            }

            const trimmedResponse = recoveredResponse.trim() || fallbackResponse;
            const recoveredSql = extractSqlFromResponse(trimmedResponse);

            return {
              action: "finish",
              message: reason,
              args: {
                response: trimmedResponse,
                ...(recoveredSql ? { sql: recoveredSql } : {}),
              },
            };
          } catch (errorValue) {
            if (isSupersededAIRequestError(errorValue)) {
              throw errorValue;
            }

            return {
              action: "finish",
              message: reason,
              args: {
                response: fallbackResponse,
              },
            };
          }
        };

        // Opening acknowledgement: let the model restate what it understood and
        // sketch a short plan before any tool runs, so the user sees it "get it"
        // the way Claude's agent does, instead of silently working.
        if (workspaceToolsEnabled) {
          publishAgentProgress({ action: "plan", message: "" });
          try {
            const planText = await askAI(
              buildAgentPlanPrompt({
                userPrompt: normalizedPrompt,
                assistIntent,
                currentDatabase,
                availableTableNames: agentPromptTableNames.length > 0 ? agentPromptTableNames : availableSchemaTables,
                appLanguage,
              }),
              strictRecoveryContext || context,
              "panel",
              "explain",
              []
            );
            if (requestId !== requestIdRef.current) {
              throw new Error(AI_REQUEST_REPLACED_MESSAGE);
            }
            const cleanedPlan = stripSqlCodeBlocksFromResponse(planText).trim() || planText.trim();
            if (cleanedPlan) {
              agentTraceSteps.push({
                step: agentTraceSteps.length + 1,
                action: "plan",
                message: cleanedPlan,
                observation: "",
              });
              publishAgentProgress();
            }
          } catch (planError) {
            if (isSupersededAIRequestError(planError)) {
              throw planError;
            }
            // A failed plan turn is non-fatal; carry on with the tool loop.
          }
        }

        let finalAgentAction: AgentToolAction | null = null;

        if (!workspaceToolsEnabled) {
          finalAgentAction = await requestAgentAction(
            buildControllerPrompt(
              true,
              joinAgentInstructions(
                sharedAgentInstruction,
                "Respond as a general-purpose assistant unless the user explicitly needs current workspace evidence."
              )
            ),
            true
          );
        } else {
          for (let stepIndex = 0; stepIndex < agentStepBudget; stepIndex += 1) {
            const forceFinish = stepIndex === agentStepBudget - 1;
            const action = await requestAgentAction(
              buildControllerPrompt(forceFinish, sharedAgentInstruction),
              stepIndex === 0
            );

            if (action.action === "finish") {
              finalAgentAction = action;
              break;
            }

            publishAgentProgress({
              action: action.action,
              message: action.message || "No message provided.",
            });

            const observation = await runAgentTool(action);
            agentTraceSteps.push({
              step: agentTraceSteps.length + 1,
              action: action.action,
              message: action.message || "No message provided.",
              observation,
            });
            publishAgentProgress();
          }

          if (!finalAgentAction) {
            finalAgentAction = await requestAgentAction(
              buildControllerPrompt(
                true,
                joinAgentInstructions(
                  sharedAgentInstruction,
                  "You have reached the tool budget. Finish with the best grounded answer you can."
                )
              ),
              false
            );
          }
        }

        if (finalAgentAction.action !== "finish") {
          finalAgentAction = await recoverAgentFinishAction(
            "The agent exhausted its tool budget without returning a final answer."
          );
        }

        const finalArgs = finalAgentAction.args || {};
        let finalSql = typeof finalArgs.sql === "string" ? finalArgs.sql.trim() : "";
        if (finalSql) {
          finalSql = extractSqlFromResponse(finalSql) || finalSql;
        }

        if (finalSql && availableSchemaTables.length > 0 && sqlResponseConflictsWithSchema(finalSql, availableSchemaTables)) {
          agentTraceSteps.push({
            step: agentTraceSteps.length + 1,
            action: "finish",
            message: finalAgentAction.message || "Final answer rejected.",
            observation: "Tool error: The proposed final SQL referenced tables outside the current workspace schema.",
          });

          finalAgentAction = await requestAgentAction(
            buildControllerPrompt(
              true,
              joinAgentInstructions(
                sharedAgentInstruction,
                "Your previous finish action referenced tables outside the current schema. Return a corrected finish action now."
              )
            ),
            false
          );

          if (finalAgentAction.action !== "finish") {
            finalAgentAction = await recoverAgentFinishAction(
              "The agent failed to repair its final answer after SQL validation."
            );
          }

          const repairedArgs = finalAgentAction.args || {};
          finalSql = typeof repairedArgs.sql === "string" ? repairedArgs.sql.trim() : "";
          if (finalSql) {
            finalSql = extractSqlFromResponse(finalSql) || finalSql;
          }
        }

        const resolvedFinalArgs = finalAgentAction.args || {};
        // If the agent didn't put SQL in args.sql but embedded a runnable query in
        // its response markdown, lift the first statement out so it can auto-run.
        if (!finalSql && typeof resolvedFinalArgs.response === "string") {
          const sqlFromBody = extractSqlFromResponse(resolvedFinalArgs.response);
          if (sqlFromBody && hasSqlStartKeyword(sqlFromBody) &&
              !(availableSchemaTables.length > 0 && sqlResponseConflictsWithSchema(sqlFromBody, availableSchemaTables))) {
            finalSql = sqlFromBody;
          }
        }
        // In agent mode any grounded, schema-valid SQL is worth surfacing/running ?
        // the autonomy level + risk gate decide whether it actually executes.
        const shouldExposeAgentSql = hasSqlStartKeyword(finalSql);
        if (!shouldExposeAgentSql) {
          finalSql = "";
        }
        const rawFinalResponseBody =
          typeof resolvedFinalArgs.response === "string" && resolvedFinalArgs.response.trim()
            ? resolvedFinalArgs.response.trim()
            : finalAgentAction.message?.trim()
              ? finalAgentAction.message.trim()
              : finalSql
                ? "The agent prepared grounded SQL for your review."
                : "The agent finished its inspection but did not produce a usable final answer.";
        const finalResponseBody = shouldExposeAgentSql
          ? rawFinalResponseBody
          : stripSqlCodeBlocksFromResponse(rawFinalResponseBody) || rawFinalResponseBody;

        const finalDetail = [finalResponseBody, buildAgentTraceMarkdown(agentTraceSteps)].filter(Boolean).join("\n\n---\n\n");
        const hasValidSql = hasSqlStartKeyword(finalSql);
        const finalAgentSteps: AIWorkspaceAgentStep[] = agentTraceSteps.map((step) => ({
          step: step.step,
          action: step.action,
          message: step.message,
          observation: step.observation,
          status: step.observation.startsWith("Tool error") || step.observation.startsWith("Tool blocked")
            ? "error"
            : "done",
        }));

        // Lift any AI-designed metrics widgets out of the finish action so the
        // dashboard path can build a custom board from them.
        const rawAgentWidgets = Array.isArray((resolvedFinalArgs as { metricsWidgets?: unknown }).metricsWidgets)
          ? ((resolvedFinalArgs as { metricsWidgets?: unknown[] }).metricsWidgets ?? [])
          : [];
        const agentWidgets: AIMetricsWidgetSpec[] = rawAgentWidgets
          .map((widget) => {
            const record = (widget && typeof widget === "object") ? widget as Record<string, unknown> : {};
            const title = typeof record.title === "string" ? record.title.trim() : "";
            const query = typeof record.query === "string" ? record.query.trim()
              : typeof record.sql === "string" ? record.sql.trim() : "";
            const typeValue = typeof record.type === "string" ? record.type.trim().toLowerCase() : "table";
            const type = (["table", "scoreboard", "bar", "horizontal-bar", "line", "area", "pie", "donut", "radial"].includes(typeValue) ? typeValue : "table") as AIMetricsWidgetSpec["type"];
            return { title, type, query };
          })
          .filter((widget) => widget.title.length > 0 && widget.query.length > 0)
          .slice(0, 12);

        return {
          prompt: normalizedPrompt,
          rawResponse: finalDetail,
          sql: hasValidSql ? finalSql : null,
          risk: hasValidSql ? analyzeGeneratedSql(finalSql) : undefined,
          intent: assistIntent,
          reasoning: lastReasoningRef.current,
          agentSteps: finalAgentSteps.length > 0 ? finalAgentSteps : undefined,
          agentWidgets: agentWidgets.length > 0 ? agentWidgets : undefined,
        };
      }

      let rawResponse = await askAI(aiPrompt, context, "panel", assistIntent, requestHistory);
      if (requestId !== requestIdRef.current) {
        throw new Error(AI_REQUEST_REPLACED_MESSAGE);
      }
      let recoveryPasses = 0;
      const canRunRecoveryPass = () => !fastRemoteRecovery || recoveryPasses < MAX_REMOTE_RECOVERY_PASSES;
      const runRecoveryPass = async (
        repairPrompt: string,
        repairContext: string,
        repairIntent: AssistIntent,
        repairHistory: AIConversationMessage[]
      ) => {
        recoveryPasses += 1;
        rawResponse = await askAI(repairPrompt, repairContext, "panel", repairIntent, repairHistory);
        if (requestId !== requestIdRef.current) {
          throw new Error(AI_REQUEST_REPLACED_MESSAGE);
        }
      };

      if (schemaContextEnabled && (assistIntent === "sql" || assistIntent === "optimize" || assistIntent === "fix-error")) {
        let extractedSql = extractSqlFromResponse(rawResponse);
        let hasSqlConflict = extractedSql ? sqlResponseConflictsWithSchema(extractedSql, availableSchemaTables) : false;

        if ((!extractedSql || hasSqlConflict) && canRunRecoveryPass()) {
          await runRecoveryPass(
            buildSqlRegroundingPrompt(
              currentDatabase,
              availableSchemaTables,
              normalizedPrompt,
              interactionMode
            ),
            strictRecoveryContext || context,
            assistIntent,
            []
          );

          extractedSql = extractSqlFromResponse(rawResponse);
          hasSqlConflict = extractedSql ? sqlResponseConflictsWithSchema(extractedSql, availableSchemaTables) : false;
        }

        if (extractedSql && hasSqlConflict && canRunRecoveryPass()) {
          await runRecoveryPass(
            [
              "Return SQL again using only the verified current schema.",
              `Current database: ${currentDatabase || "Default"}.`,
              `Allowed tables only: ${availableSchemaTables.join(", ")}.`,
              "Do not mention or query any other table.",
              "Return only runnable SQL in a single ```sql fenced block.",
              "",
              normalizedPrompt,
            ].join("\n"),
            strictRecoveryContext || context,
            assistIntent,
            []
          );
        }
      }

      if (
        (assistIntent === "explain" || assistIntent === "overview") &&
        isLikelySqlOnlyResponse(rawResponse) &&
        !wantsVisualization &&
        canRunRecoveryPass()
      ) {
        await runRecoveryPass(
          [
            assistIntent === "overview"
              ? "The previous reply returned SQL, but the user is asking for a database overview."
              : "The previous reply returned SQL, but the user is asking for an explanation.",
            assistIntent === "overview"
              ? "Read the provided database context and summarize the actual database, main tables, and relationships in plain language."
              : "Explain the meaning, purpose, or role of the referenced table, columns, or values in plain language.",
            "Do not output SQL, code blocks, or query snippets.",
            "",
            normalizedPrompt,
          ].join("\n"),
          context,
          assistIntent,
          requestHistory
        );
      }

      if (
        schemaContextEnabled &&
        assistIntent !== "sql" && assistIntent !== "optimize" && assistIntent !== "fix-error" &&
        canRunRecoveryPass() &&
        (
          responseConflictsWithSchema(rawResponse, availableSchemaTables) ||
          (assistIntent === "overview" && isOverviewContextMissingResponse(rawResponse))
        )
      ) {
        await runRecoveryPass(
          [
            "Your previous answer was not grounded in the current database context.",
            `You must stay strictly within these tables: ${availableSchemaTables.join(", ")}.`,
            "Ignore any earlier assistant guesses that mention tables or columns outside the current database context.",
            assistIntent === "overview"
              ? [
                  "Write a grounded overview of the CURRENT database only.",
                  "Do not say the database context is missing or ask the user to provide tables or columns.",
                  "Format the answer with short markdown sections and flat bullets.",
                  "Mention the actual tables from the current database context.",
                ].join(" ")
              : "Answer the user's question using ONLY the current database context, or say clearly that the current context is not enough.",
            "Do not invent example domains, tables, or columns.",
            "",
            normalizedPrompt,
          ].join("\n"),
          context,
          assistIntent,
          requestHistory
        );
      }

      if (schemaContextEnabled && assistIntent === "overview" && isOverviewContextMissingResponse(rawResponse) && canRunRecoveryPass()) {
        await runRecoveryPass(
          [
            "The current database context is already attached below and must be used.",
            `The exact current tables are: ${availableSchemaTables.join(", ")}.`,
            "Never say that the database, schema, tables, or columns were not provided.",
            "Return a compact markdown answer in the user's language with exactly these sections:",
            "## Overview",
            "## Main Tables",
            "## Relationships",
            "## Notes",
            "If the domain is uncertain, say that briefly, but still summarize the visible tables and likely relationship paths.",
            "",
            normalizedPrompt,
          ].join("\n"),
          context,
          assistIntent,
          []
        );
      }

      let hasSchemaConflict = responseConflictsWithSchema(rawResponse, availableSchemaTables);
      if (
        schemaContextEnabled &&
        assistIntent !== "sql" &&
        assistIntent !== "optimize" &&
        assistIntent !== "fix-error" &&
        hasSchemaConflict &&
        canRunRecoveryPass()
      ) {
        await runRecoveryPass(
          buildSchemaRegroundingPrompt(
            appLanguage,
            currentDatabase,
            availableSchemaTables,
            assistIntent,
            normalizedPrompt
          ),
          strictRecoveryContext || context,
          assistIntent,
          []
        );
        hasSchemaConflict = responseConflictsWithSchema(rawResponse, availableSchemaTables);
      }

      if (schemaContextEnabled && assistIntent === "overview" && hasSchemaConflict && canRunRecoveryPass()) {
        await runRecoveryPass(
          [
            "Return a fresh database overview from the verified schema only.",
            `Current database: ${currentDatabase || "Default"}.`,
            `Allowed tables only: ${availableSchemaTables.join(", ")}.`,
            "Do not mention any other tables.",
            "Do not ask for more schema details because they are already attached.",
            "Format the answer as short markdown with sections:",
            "## Overview",
            "## Main Tables",
            "## Relationships",
            "## Notes",
            "",
            normalizedPrompt,
          ].join("\n"),
          strictRecoveryContext || context,
          assistIntent,
          []
        );
      }

      const finalResponse =
        (assistIntent === "explain" || assistIntent === "overview") && isLikelySqlOnlyResponse(rawResponse) && !wantsVisualization
          ? assistIntent === "overview"
            ? "The current model kept returning SQL instead of a database overview. Try again with more schema context or switch to a stronger model."
            : "The current model kept returning SQL instead of an explanation. Try again with more context or switch to a stronger model for schema explanations."
          : rawResponse;

      const extractedSql = extractSqlFromResponse(finalResponse);
      const hasValidSql = hasSqlStartKeyword(extractedSql);
      const shouldAttachSql =
        hasValidSql &&
        (
          assistIntent === "sql" ||
          assistIntent === "optimize" ||
          assistIntent === "fix-error" ||
          wantsVisualization
        );

      return {
        prompt: normalizedPrompt,
        rawResponse: finalResponse,
        sql: shouldAttachSql ? extractedSql : null,
        risk: hasValidSql ? analyzeGeneratedSql(extractedSql) : undefined,
        intent: assistIntent,
        reasoning: lastReasoningRef.current,
      };
    } catch (errorValue) {
      if (isSupersededAIRequestError(errorValue)) {
        throw (errorValue instanceof Error ? errorValue : new Error(AI_REQUEST_REPLACED_MESSAGE));
      }

      const message = errorValue instanceof Error ? errorValue.message : String(errorValue);
      setError(message);
      throw new Error(message);
    } finally {
      if (requestId === requestIdRef.current) {
        setIsGenerating(false);
      }
    }
  }, [activeProvider, aiConfigs, askAI, connectionId, currentDatabase, fetchTables, getTableColumnsPreview, getTableStructure, isLocalProvider, saveAIConfigs]);

  const copyText = useCallback(async (text: string) => {
    await navigator.clipboard.writeText(text);
  }, []);

  const insertSql = useCallback((sql: string, risk?: SqlRiskAnalysis) => {
    const computedRisk = risk ?? analyzeGeneratedSql(sql);
    if (computedRisk.level === "dangerous") {
      const message = computedRisk.reason || "Potentially destructive SQL cannot be inserted directly.";
      setError(message);
      return false;
    }
    window.dispatchEvent(new CustomEvent("insert-sql-from-ai", { detail: { sql } }));
    return true;
  }, []);

  const runSql = useCallback(async (
    sql: string,
    options?: { skipMutationConfirm?: boolean; skipHighRiskConfirm?: boolean },
  ): Promise<AIExecutedSqlResult> => {
    if (!connectionId) {
      const message = "Please connect to a database before running SQL from AI.";
      setError(message);
      throw new Error(message);
    }

    let sqlToExecute = sql.trim();
    if (!sqlToExecute) {
      const message = "There is no SQL to run for this bubble.";
      setError(message);
      throw new Error(message);
    }

    let targetDatabaseFromUse: string | null = null;
    const leadingUseDirective = extractLeadingUseDirective(sqlToExecute);

    if (leadingUseDirective) {
      if ("error" in leadingUseDirective) {
        setError(leadingUseDirective.error);
        throw new Error(leadingUseDirective.error);
      }
      targetDatabaseFromUse = leadingUseDirective.database;
      sqlToExecute = leadingUseDirective.remainingSql;
    }

    const statements = splitSqlStatements(sqlToExecute);
    if (statements.length === 0) {
      if (targetDatabaseFromUse) {
        const activeDatabase = useAppStore.getState().currentDatabase;
        if (activeDatabase !== targetDatabaseFromUse) {
          await switchDatabase(connectionId, targetDatabaseFromUse);
        }
        const message = `Active database is now ${targetDatabaseFromUse}. Add a statement after USE if you want the AI bubble to run something.`;
        setError(message);
        throw new Error(message);
      }
      const message = "The SQL bubble did not contain any executable statements.";
      setError(message);
      throw new Error(message);
    }

    if (statements.some(isSessionSwitchStatement)) {
      const message =
        "Sandbox execution does not allow USE, ATTACH, or search_path statements in the same run. Choose the database from the app UI first.";
      setError(message);
      throw new Error(message);
    }

    const hasMutatingStatements = statements.some(isMutatingStatement);
    const hasHighRiskStatements = statements.some(isHighRiskStatement);

    setIsRunning(true);
    setError(null);
    try {
      const activeDatabase = useAppStore.getState().currentDatabase;
      if (targetDatabaseFromUse && activeDatabase !== targetDatabaseFromUse) {
        await switchDatabase(connectionId, targetDatabaseFromUse);
      }

      if (hasHighRiskStatements && !options?.skipHighRiskConfirm) {
        const confirmed = window.confirm(
          "The AI agent wants to run a high-risk SQL statement through the protected sandbox. It can apply real database changes. Approve this run?"
        );
        if (!confirmed) {
          throw new Error("Execution cancelled.");
        }
      } else if (hasMutatingStatements && !options?.skipMutationConfirm) {
        const confirmed = window.confirm(
          "The AI agent wants to run a write or schema-changing SQL statement through the sandbox. Approve this run?"
        );
        if (!confirmed) {
          throw new Error("Execution cancelled.");
        }
      }

      const queryResult = await executeSandboxQuery(connectionId, statements);

      if (hasMutatingStatements) {
        const invalidateStructure = statements.some((statement) => {
          const normalized = normalizeStatementForGuard(statement);
          return (
            normalized.startsWith("CREATE ") ||
            normalized.startsWith("ALTER ") ||
            normalized.startsWith("DROP ") ||
            normalized.startsWith("TRUNCATE ") ||
            normalized.startsWith("RENAME ")
          );
        });
        window.dispatchEvent(
          new CustomEvent("table-data-updated", {
            detail: { connectionId, database: useAppStore.getState().currentDatabase || undefined, invalidateStructure },
          })
        );
      }

      if (queryResult.execution_time_ms >= 0) {
        const activityLabel = queryResult.rows.length > 0
          ? "Query"
          : queryResult.affected_rows > 0
            ? queryResult.sandboxed ? "Sandbox" : "Write"
            : "Run";
        window.dispatchEvent(
          new CustomEvent("workspace-activity", {
            detail: { connectionId, label: activityLabel, durationMs: queryResult.execution_time_ms },
          })
        );
      }

      return {
        queryResult,
        summary: summarizeRunResult(queryResult),
      };
    } catch (errorValue) {
      const message = formatExecutionError(errorValue);
      setError(message);
      throw new Error(message);
    } finally {
      setIsRunning(false);
    }
  }, [connectionId, executeSandboxQuery, switchDatabase]);

  return {
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
  };
}
