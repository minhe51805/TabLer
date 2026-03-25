import { useCallback, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { getCurrentAppLanguage } from "../../../i18n";
import { useAppStore } from "../../../stores/appStore";
import { getActiveAIProvider, type AIConversationMessage, type AIRequestIntent, type AIResponseLanguage, type QueryResult, type TableStructure } from "../../../types";
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
  summarizeStructure,
  type SqlRiskAnalysis,
  AI_SCHEMA_CODEC_VERSION,
  MAX_TABLE_NAMES_IN_CONTEXT,
  MAX_AI_SCHEMA_CODEC_CACHE_ENTRIES,
} from "../AISlidePanelUtils";
import { aiModeUsesSchemaContext, type AIWorkspaceInteractionMode } from "../ai-workspace-types";

export interface AIGeneratedAssistResult {
  prompt: string;
  rawResponse: string;
  sql: string | null;
  risk?: SqlRiskAnalysis;
}

export interface AIExecutedSqlResult {
  queryResult: QueryResult;
  summary: string;
}

type AssistIntent = "sql" | "explain" | "overview";

const SQL_START_KEYWORDS = ["SELECT", "INSERT", "UPDATE", "DELETE", "CREATE", "DROP", "ALTER", "WITH"];
const AI_SCHEMA_CODEC_LEGEND =
  "Codec legend: T=table, C=columns name:type!flags, I=indexes, F=foreign keys. Flags: pk primary key, nn not null, df default, ai auto increment.";
const MAX_OVERVIEW_SCHEMA_TABLES = 12;
const MAX_SCHEMA_FETCH_CONCURRENCY = 4;

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

function normalizeIntentText(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d");
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
  let sqlScore = sqlSignals.reduce((score, signal) => score + (normalizedPrompt.includes(signal) ? 1 : 0), 0);
  const explainScore = explainSignals.reduce((score, signal) => score + (normalizedPrompt.includes(signal) ? 1 : 0), 0);

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

  if (hasOverviewSignal && sqlScore === 0) {
    return "overview";
  }

  if (sqlScore === 0 && (explainScore > 0 || normalizedPrompt.includes("?"))) {
    return "explain";
  }

  return sqlScore > explainScore ? "sql" : "explain";
}

function buildAssistPrompt(prompt: string, intent: AssistIntent, interactionMode: AIWorkspaceInteractionMode) {
  const interactionInstruction =
    interactionMode === "agent"
      ? "Interaction mode: agent. Prefer execution-ready SQL when the user asks for SQL, but never assume it will run without explicit approval."
      : interactionMode === "edit"
        ? "Interaction mode: edit. Prefer reviewable SQL, safer rewrites, and change plans that a human can inspect before running."
        : "Interaction mode: prompt-only. Work from the user's words only and treat any SQL as draft guidance instead of an autonomous action.";

  if (intent === "overview") {
    return [
      interactionInstruction,
      "User intent: review the current database and provide a grounded overview of the actual schema context.",
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
      "Ground the answer in the provided database context when it exists.",
      "Avoid generic textbook definitions if the schema context already shows the concrete tables or columns being discussed.",
      "Do not generate SQL unless the user explicitly asks for a query, statement, or schema change.",
      "Prefer explanation, examples, tradeoffs, and suggestions over code.",
      "",
      prompt,
    ].join("\n");
  }

  return [
    interactionInstruction,
    "User intent: produce runnable SQL grounded in the provided database context.",
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

  const knownNames = new Set(availableTableNames.map((tableName) => normalizeIntentText(tableName)));
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
  const knownNames = new Set(availableTableNames.map((tableName) => normalizeIntentText(tableName)));
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

function extractSqlFromResponse(aiResponse: string) {
  let sqlResult = aiResponse.trim();
  const codeBlock = aiResponse.match(/```sql?([\s\S]*?)```/i);
  if (codeBlock && codeBlock[1]) {
    sqlResult = codeBlock[1].trim();
  } else {
    const validContinuations = [
      "SELECT", "FROM", "WHERE", "AND", "OR", "JOIN", "LEFT", "RIGHT", "INNER", "OUTER",
      "ON", "SET", "VALUES", "ORDER", "GROUP", "HAVING", "LIMIT", "OFFSET", "UNION",
      "INSERT", "UPDATE", "DELETE", "CREATE", "DROP", "ALTER", "WITH", "AS", "INTO",
      "TABLE", "INDEX", "VIEW", "NULL", "NOT", "EXISTS", "LIKE", "BETWEEN", "IN", "IS",
    ];
    const lines = sqlResult
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length > 0);
    const firstMeaningfulLine = lines.find((line) => line.trim().length > 0)?.trim().toUpperCase() || "";

    if (!SQL_START_KEYWORDS.some((keyword) => firstMeaningfulLine.startsWith(keyword))) {
      return "";
    }

    const cleanedLines: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim().toUpperCase();
      if (validContinuations.some((value) => trimmed.startsWith(value))) {
        cleanedLines.push(line);
      } else if (cleanedLines.length > 0) {
        if (trimmed === "" || /^[A-Z_]+$/.test(trimmed)) continue;
        break;
      }
    }
    sqlResult = cleanedLines.join("\n").trim();
  }
  return sqlResult;
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

function buildOverviewDigestEntry(
  tableName: string,
  structure: Pick<TableStructure, "columns" | "indexes" | "foreign_keys">
) {
  const readableSummary = summarizeStructure(tableName, structure.columns);
  const foreignKeyPreview = structure.foreign_keys
    .slice(0, 4)
    .map((foreignKey) => `${foreignKey.column} -> ${foreignKey.referenced_table}.${foreignKey.referenced_column}`)
    .join("; ");
  const indexPreview = structure.indexes
    .slice(0, 3)
    .map((index) => `${index.is_unique ? "unique" : "index"} ${index.name}(${index.columns.join(", ")})`)
    .join("; ");

  const parts = [readableSummary];
  if (foreignKeyPreview) {
    parts.push(`FKs: ${foreignKeyPreview}`);
  }
  if (indexPreview) {
    parts.push(`Indexes: ${indexPreview}`);
  }
  return `- ${parts.join(" | ")}`;
}

export function useAISlidePanel({ isOpen }: { isOpen: boolean }) {
  const {
    askAI,
    aiConfigs,
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
      askAI: state.askAI,
      aiConfigs: state.aiConfigs,
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
  const aiSchemaOverviewDigestCacheRef = useRef(new Map<string, string>());
  const requestIdRef = useRef(0);

  const activeProvider = getActiveAIProvider(aiConfigs);
  const tableContextCount = tables?.length || 0;

  useEffect(() => {
    aiSchemaCodecCacheRef.current.clear();
    aiSchemaOverviewDigestCacheRef.current.clear();
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
      aiSchemaOverviewDigestCacheRef.current.clear();
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
    }
  ): Promise<AIGeneratedAssistResult> => {
    const normalizedPrompt = prompt.trim();
    if (!normalizedPrompt || !connectionId) {
      const message = "Please connect to a database and write a request first.";
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
    const interactionMode = options?.interactionMode ?? "prompt";
    const assistIntent: AIRequestIntent = inferAssistIntent(normalizedPrompt, interactionMode);
    const appLanguage = getCurrentAppLanguage();
    const schemaContextEnabled = activeProvider.allow_schema_context && aiModeUsesSchemaContext(interactionMode);
    const aiPrompt = buildAssistPrompt(normalizedPrompt, assistIntent, interactionMode);
    const requestHistory = assistIntent === "overview" ? [] : history;

    try {
      let latestTables = useAppStore.getState().tables;

      if (!latestTables || latestTables.length === 0) {
        if (connectionId && currentDatabase) {
          await fetchTables(connectionId, currentDatabase);
        }
        if (requestId !== requestIdRef.current) {
          throw new Error("This AI request was replaced by a newer one.");
        }
        latestTables = useAppStore.getState().tables;
        if (!latestTables || latestTables.length === 0) {
          throw new Error("No tables were found in the current database.");
        }
      }

      if (aiModeUsesSchemaContext(interactionMode) && !activeProvider.allow_schema_context) {
        return {
          prompt: normalizedPrompt,
          rawResponse: buildSchemaContextRequiredMessage(
            appLanguage,
            currentDatabase,
            activeProvider.name || "AI provider",
            interactionMode,
            activeProvider.allow_schema_context
          ),
          sql: null,
        };
      }

      if (assistIntent === "overview" && !schemaContextEnabled) {
        return {
          prompt: normalizedPrompt,
          rawResponse: buildSchemaContextRequiredMessage(
            appLanguage,
            currentDatabase,
            activeProvider.name || "AI provider",
            interactionMode,
            activeProvider.allow_schema_context
          ),
          sql: null,
        };
      }

      let context = "";
      let availableSchemaTables: string[] = [];
      let overviewDigest = "";
      let strictRecoveryContext = "";
      if (schemaContextEnabled) {
        availableSchemaTables = latestTables.map((table) => table.name);
        const availableTableNames = latestTables.map((table) => table.name).slice(0, MAX_TABLE_NAMES_IN_CONTEXT);
        const tablesToFetch =
          assistIntent === "overview"
            ? latestTables.slice(0, MAX_OVERVIEW_SCHEMA_TABLES)
            : pickRelevantTables(normalizedPrompt, latestTables);
        const schemaCodecMode = assistIntent === "overview" ? "relational" : inferAISchemaCodecMode(normalizedPrompt);
        const needsReadableDigest = assistIntent === "overview" || (assistIntent === "sql" && schemaCodecMode === "relational");
        const tableSchemaEntries = await mapWithConcurrency(
          tablesToFetch,
          needsReadableDigest ? MAX_SCHEMA_FETCH_CONCURRENCY : tablesToFetch.length,
          async (table) => {
            const cacheKey = `${connectionId}:${currentDatabase || "default"}:${schemaCodecMode}:${table.name}`;
            const cachedSummary = aiSchemaCodecCacheRef.current.get(cacheKey);
            const cachedOverviewDigest = needsReadableDigest
              ? aiSchemaOverviewDigestCacheRef.current.get(cacheKey)
              : "";
            if (cachedSummary) {
              return {
                tableName: table.name,
                summary: cachedSummary,
                overviewDigest: needsReadableDigest ? cachedOverviewDigest || "" : "",
              };
            }
            try {
              const structure =
                schemaCodecMode === "core"
                  ? {
                      columns: await getTableColumnsPreview(connectionId, table.name, currentDatabase || undefined),
                      indexes: [],
                      foreign_keys: [],
                    }
                  : await getTableStructure(connectionId, table.name, currentDatabase || undefined);
              const summary = encodeStructureForAI(table.name, structure, { mode: schemaCodecMode });
              const nextOverviewDigest = needsReadableDigest ? buildOverviewDigestEntry(table.name, structure) : "";
              setAiSchemaCodecCacheEntry(aiSchemaCodecCacheRef.current, cacheKey, summary);
              if (needsReadableDigest && nextOverviewDigest) {
                setAiSchemaCodecCacheEntry(aiSchemaOverviewDigestCacheRef.current, cacheKey, nextOverviewDigest);
              }
              return {
                tableName: table.name,
                summary,
                overviewDigest: nextOverviewDigest,
              };
            } catch {
              const fallbackSummary = `T:${table.name}|C:[]`;
              const fallbackOverviewDigest = needsReadableDigest
                ? `- Table ${table.name}: structure preview unavailable, but the table exists in the current workspace database.`
                : "";
              setAiSchemaCodecCacheEntry(aiSchemaCodecCacheRef.current, cacheKey, fallbackSummary);
              if (needsReadableDigest && fallbackOverviewDigest) {
                setAiSchemaCodecCacheEntry(aiSchemaOverviewDigestCacheRef.current, cacheKey, fallbackOverviewDigest);
              }
              return {
                tableName: table.name,
                summary: fallbackSummary,
                overviewDigest: fallbackOverviewDigest,
              };
            }
          }
        );
        if (requestId !== requestIdRef.current) {
          throw new Error("This AI request was replaced by a newer one.");
        }

        const tableSchemas = tableSchemaEntries.map((entry) => entry.summary);
        overviewDigest = tableSchemaEntries.map((entry) => entry.overviewDigest).join("\n");

        context = [
          "Workspace scope: answer only from the CURRENT workspace connection and database.",
          `Database: ${currentDatabase || "Default"}`,
          "",
          `Available tables (${latestTables.length}): ${availableTableNames.join(", ")}${latestTables.length > MAX_TABLE_NAMES_IN_CONTEXT ? ", ..." : ""}`,
          "",
          assistIntent === "overview"
            ? [
                "Readable overview digest for small/local models:",
                overviewDigest,
                "",
              ].join("\n")
            : assistIntent === "sql" && schemaCodecMode === "relational"
              ? [
                  "Readable relationship digest for SQL generation:",
                  overviewDigest,
                  "",
                ].join("\n")
            : "",
          `AI schema codec ${AI_SCHEMA_CODEC_VERSION} (mode=${schemaCodecMode}, compact structural metadata only, no row data):`,
          AI_SCHEMA_CODEC_LEGEND,
          tableSchemas.join("\n"),
          "",
          assistIntent === "overview" && latestTables.length > MAX_OVERVIEW_SCHEMA_TABLES
            ? `The overview schema snapshot below is limited to the first ${MAX_OVERVIEW_SCHEMA_TABLES} tables from the current workspace database.`
            : "The schema snapshot above belongs only to the current workspace database.",
          "",
          "Only use tables from the available list above. If a needed table is missing, ask the user to create it first.",
        ].join("\n");

        strictRecoveryContext = [
          `Current database: ${currentDatabase || "Default"}`,
          `Allowed tables: ${availableSchemaTables.join(", ")}`,
          "",
          overviewDigest ? ["Verified readable schema digest:", overviewDigest, ""].join("\n") : "",
          "Stay strictly inside the verified schema above.",
        ]
          .filter(Boolean)
          .join("\n");
      }

      let rawResponse = await askAI(aiPrompt, context, "panel", assistIntent, requestHistory);
      if (requestId !== requestIdRef.current) {
        throw new Error("This AI request was replaced by a newer one.");
      }

      if (schemaContextEnabled && assistIntent === "sql") {
        let extractedSql = extractSqlFromResponse(rawResponse);
        let hasSqlConflict = extractedSql ? sqlResponseConflictsWithSchema(extractedSql, availableSchemaTables) : false;

        if (!extractedSql || hasSqlConflict) {
          rawResponse = await askAI(
            buildSqlRegroundingPrompt(
              currentDatabase,
              availableSchemaTables,
              normalizedPrompt,
              interactionMode
            ),
            strictRecoveryContext || context,
            "panel",
            assistIntent,
            []
          );
          if (requestId !== requestIdRef.current) {
            throw new Error("This AI request was replaced by a newer one.");
          }

          extractedSql = extractSqlFromResponse(rawResponse);
          hasSqlConflict = extractedSql ? sqlResponseConflictsWithSchema(extractedSql, availableSchemaTables) : false;
        }

        if (extractedSql && hasSqlConflict) {
          rawResponse = await askAI(
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
            "panel",
            assistIntent,
            []
          );
          if (requestId !== requestIdRef.current) {
            throw new Error("This AI request was replaced by a newer one.");
          }
        }
      }

      if ((assistIntent === "explain" || assistIntent === "overview") && isLikelySqlOnlyResponse(rawResponse)) {
        rawResponse = await askAI(
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
          "panel",
          assistIntent,
          requestHistory
        );
        if (requestId !== requestIdRef.current) {
          throw new Error("This AI request was replaced by a newer one.");
        }
      }

      if (
        schemaContextEnabled &&
        assistIntent !== "sql" &&
        (
          responseConflictsWithSchema(rawResponse, availableSchemaTables) ||
          (assistIntent === "overview" && isOverviewContextMissingResponse(rawResponse))
        )
      ) {
        rawResponse = await askAI(
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
          "panel",
          assistIntent,
          requestHistory
        );
        if (requestId !== requestIdRef.current) {
          throw new Error("This AI request was replaced by a newer one.");
        }
      }

      if (schemaContextEnabled && assistIntent === "overview" && isOverviewContextMissingResponse(rawResponse)) {
        rawResponse = await askAI(
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
          "panel",
          assistIntent,
          []
        );
        if (requestId !== requestIdRef.current) {
          throw new Error("This AI request was replaced by a newer one.");
        }
      }

      let hasSchemaConflict = responseConflictsWithSchema(rawResponse, availableSchemaTables);
      if (schemaContextEnabled && assistIntent !== "sql" && hasSchemaConflict) {
        rawResponse = await askAI(
          buildSchemaRegroundingPrompt(
            appLanguage,
            currentDatabase,
            availableSchemaTables,
            assistIntent,
            normalizedPrompt
          ),
          strictRecoveryContext || context,
          "panel",
          assistIntent,
          []
        );
        if (requestId !== requestIdRef.current) {
          throw new Error("This AI request was replaced by a newer one.");
        }
        hasSchemaConflict = responseConflictsWithSchema(rawResponse, availableSchemaTables);
      }

      if (schemaContextEnabled && assistIntent === "overview" && hasSchemaConflict) {
        rawResponse = await askAI(
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
          "panel",
          assistIntent,
          []
        );
        if (requestId !== requestIdRef.current) {
          throw new Error("This AI request was replaced by a newer one.");
        }
      }

      const finalResponse =
        (assistIntent === "explain" || assistIntent === "overview") && isLikelySqlOnlyResponse(rawResponse)
          ? assistIntent === "overview"
            ? "The current model kept returning SQL instead of a database overview. Try again with more schema context or switch to a stronger model."
            : "The current model kept returning SQL instead of an explanation. Try again with more context or switch to a stronger model for schema explanations."
          : rawResponse;

      const extractedSql = assistIntent === "sql" ? extractSqlFromResponse(finalResponse) : "";
      const normalizedSql = extractedSql.toUpperCase().trim();
      const hasValidSql = normalizedSql.length > 0 && SQL_START_KEYWORDS.some((statement) => normalizedSql.startsWith(statement));

      return {
        prompt: normalizedPrompt,
        rawResponse: finalResponse,
        sql: hasValidSql ? extractedSql : null,
        risk: hasValidSql ? analyzeGeneratedSql(extractedSql) : undefined,
      };
    } catch (errorValue) {
      const message = errorValue instanceof Error ? errorValue.message : String(errorValue);
      setError(message);
      throw new Error(message);
    } finally {
      if (requestId === requestIdRef.current) {
        setIsGenerating(false);
      }
    }
  }, [activeProvider, askAI, connectionId, currentDatabase, fetchTables, getTableColumnsPreview, getTableStructure]);

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

  const runSql = useCallback(async (sql: string): Promise<AIExecutedSqlResult> => {
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

      if (hasHighRiskStatements) {
        const confirmed = window.confirm(
          "The AI agent wants to run a high-risk SQL statement through the protected sandbox. It can apply real database changes. Approve this run?"
        );
        if (!confirmed) {
          throw new Error("Execution cancelled.");
        }
      } else if (hasMutatingStatements) {
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
