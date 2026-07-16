import type { AIResponseLanguage, QueryResult, TableStructure } from "../../types";
import { encodeStructureForAI } from "./AISlidePanelUtils";
import type { AIWorkspaceInteractionMode } from "./ai-workspace-types";
import type { AssistIntent } from "./ai-agent-context";
import { buildKnownTableNameSet, normalizeIntentText } from "./ai-assist-intent";

const MAX_AGENT_QUERY_PREVIEW_ROWS = 5;
const MAX_AGENT_QUERY_PREVIEW_COLUMNS = 8;
const MAX_AGENT_TRACE_OBSERVATION_CHARS = 1400;
const MAX_AGENT_OBSERVATION_VALUE_CHARS = 120;

const SENSITIVE_COLUMN_PATTERN = /(?:^|[_-])(?:password|passwd|pwd|secret|token|api[_-]?key|credential|private[_-]?key|access[_-]?key|refresh[_-]?token)(?:$|[_-])/i;

export function truncateAgentObservation(text: string) {
  if (text.length <= MAX_AGENT_TRACE_OBSERVATION_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_AGENT_TRACE_OBSERVATION_CHARS - 3)}...`;
}

export function sanitizeAgentObservationValue(
  value: string | number | boolean | null,
  columnName?: string
) {
  if (columnName && SENSITIVE_COLUMN_PATTERN.test(columnName)) {
    return "[REDACTED]";
  }
  if (typeof value !== "string") return value;
  return value.length > MAX_AGENT_OBSERVATION_VALUE_CHARS
    ? `${value.slice(0, MAX_AGENT_OBSERVATION_VALUE_CHARS - 3)}...`
    : value;
}

export function redactAgentSqlLiterals(sql: string) {
  return sql.replace(/'(?:''|[^'])*'/g, "'[REDACTED]'");
}

export function stringifyAgentObservation(data: unknown) {
  const content = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return truncateAgentObservation(content);
}

export function findMatchingTableName(tableName: string, availableTableNames: string[]) {
  const normalizedTarget = normalizeIntentText(tableName);
  return availableTableNames.find((candidate) => normalizeIntentText(candidate) === normalizedTarget)
    || availableTableNames.find((candidate) => normalizeIntentText(candidate).includes(normalizedTarget))
    || availableTableNames.find((candidate) => normalizedTarget.includes(normalizeIntentText(candidate)))
    || null;
}

export function summarizeAgentQueryObservation(result: QueryResult) {
  const previewColumns = result.columns.slice(0, MAX_AGENT_QUERY_PREVIEW_COLUMNS);
  const sampleRows = result.rows
    .slice(0, MAX_AGENT_QUERY_PREVIEW_ROWS)
    .map((row) => Object.fromEntries(
      previewColumns.map((column, index) => [
        column.name,
        sanitizeAgentObservationValue(row[index] ?? null, column.name),
      ])
    ));

  return stringifyAgentObservation({
    query: redactAgentSqlLiterals(result.query),
    executionTimeMs: result.execution_time_ms,
    rowCount: result.rows.length,
    affectedRows: result.affected_rows,
    truncated: result.truncated,
    sandboxed: result.sandboxed,
    columns: previewColumns.map((column) => `${column.name}:${column.data_type}`),
    sampleRows,
  });
}

export function summarizeAgentStructureObservation(
  tableName: string,
  structure: Pick<TableStructure, "columns" | "indexes" | "foreign_keys">
) {
  return truncateAgentObservation([
    `TABLE=${tableName}`,
    `SCHEMA=${encodeStructureForAI(tableName, structure, { mode: "relational" })}`,
    `COUNTS=cols:${structure.columns.length},idx:${structure.indexes.length},fk:${structure.foreign_keys.length}`,
  ].join("\n"));
}

export function summarizeAgentSchemaSummaryObservation(tableName: string, summary: string) {
  return truncateAgentObservation([
    `TABLE=${tableName}`,
    `SCHEMA=${summary}`,
  ].join("\n"));
}

export function extractReferencedTableNamesFromSql(sql: string) {
  const candidates = new Set<string>();
  const patterns = [
    /\bfrom\s+([a-z_"`][a-z0-9_$."`]*)/gi,
    /\bjoin\s+([a-z_"`][a-z0-9_$."`]*)/gi,
    /\bupdate\s+([a-z_"`][a-z0-9_$."`]*)/gi,
    /\binsert\s+into\s+([a-z_"`][a-z0-9_$."`]*)/gi,
    /\bdelete\s+from\s+([a-z_"`][a-z0-9_$."`]*)/gi,
    /\balter\s+table\s+([a-z_"`][a-z0-9_$."`]*)/gi,
    /\bcreate\s+table\s+([a-z_"`][a-z0-9_$."`]*)/gi,
    /\bdrop\s+table\s+([a-z_"`][a-z0-9_$."`]*)/gi,
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

export function sqlResponseConflictsWithSchema(sql: string, availableTableNames: string[]) {
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

export function buildSqlRegroundingPrompt(
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

export function mentionsUnknownSchemaNames(response: string, availableTableNames: string[]) {
  const normalizedResponse = normalizeIntentText(response);
  const knownNames = buildKnownTableNameSet(availableTableNames);
  const reserved = new Set([
    "table", "tables", "bang", "database", "schema", "context", "column", "columns",
    "relationship", "relationships", "overview", "current", "assistant", "sql", "ai",
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

export function isOverviewContextMissingResponse(response: string) {
  const normalizedResponse = normalizeIntentText(response);
  const weakSignals = [
    "khong co thong tin", "khong co du lieu", "khong co ngu canh", "chua co thong tin",
    "vui long cung cap", "hay chia se", "khong duoc cung cap", "khong co database",
    "khong co co so du lieu", "no information", "not enough context", "not enough information",
    "database was not provided", "schema was not provided", "please provide", "share details",
    "share the tables", "share the columns", "no database context", "no schema context",
    "没有提供", "没有数据库", "没有上下文", "请提供", "提供更多信息", "分享表", "分享字段",
  ];

  return weakSignals.some((signal) => normalizedResponse.includes(signal));
}

export function responseConflictsWithSchema(response: string, availableTableNames: string[]) {
  return availableTableNames.length > 0 && mentionsUnknownSchemaNames(response, availableTableNames);
}

export function buildSchemaRegroundingPrompt(
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
      "", originalPrompt,
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
      "", originalPrompt,
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
    "", originalPrompt,
  ].join("\n");
}

export function buildSchemaContextRequiredMessage(
  language: AIResponseLanguage,
  databaseName: string | null,
  providerName: string,
  interactionMode: AIWorkspaceInteractionMode,
  providerAllowsSchemaContext: boolean
) {
  const databaseLabel = databaseName || "current database";
  const modeLabel = interactionMode === "agent"
    ? "Agent"
    : interactionMode === "edit"
      ? language === "vi" ? "Chỉnh sửa" : language === "zh" ? "编辑" : "Edit"
      : language === "vi" ? "Chỉ prompt" : language === "zh" ? "仅提示词" : "Prompt only";

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
