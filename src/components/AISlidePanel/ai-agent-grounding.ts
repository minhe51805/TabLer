import type { AIResponseLanguage, DatabaseType, QueryResult, TableStructure } from "../../types";
import { encodeStructureForAI } from "./AISlidePanelUtils";
import type { AIWorkspaceInteractionMode } from "./ai-workspace-types";
import type { AssistIntent } from "./ai-agent-context";
import { buildKnownTableNameSet, normalizeIntentText } from "./ai-assist-intent";
import { getExplainHotspots, parseExplainOutput } from "../../utils/explain-parser";

const MAX_AGENT_QUERY_PREVIEW_ROWS = 5;
const MAX_AGENT_QUERY_PREVIEW_COLUMNS = 8;
const MAX_AGENT_TRACE_OBSERVATION_CHARS = 1400;
const MAX_AGENT_OBSERVATION_VALUE_CHARS = 120;

const SENSITIVE_COLUMN_PATTERN = /(?:^|[_-])(?:password|passwd|pwd|secret|token|api[_-]?key|credential|private[_-]?key|access[_-]?key|refresh[_-]?token)(?:$|[_-])/i;

const MAX_AGENT_MEMORY_OBSERVATION_CHARS = 8000;

export function truncateAgentObservation(text: string) {
  // Memory reads are the payload the agent explicitly asked for — cutting
  // them at 1400 chars made round-trip verification impossible (memory
  // bodies run up to the backend 8k cap).
  const cap = text.startsWith("Memory \"")
    ? MAX_AGENT_MEMORY_OBSERVATION_CHARS
    : MAX_AGENT_TRACE_OBSERVATION_CHARS;
  if (text.length <= cap) {
    return text;
  }
  return `${text.slice(0, cap - 3)}...`;
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

/** Full (untruncated) observation text — the read_page tool archives this so
 *  truncated trace output can always be re-read page by page. */
export function stringifyAgentObservationFull(data: unknown) {
  return typeof data === "string" ? data : JSON.stringify(data, null, 2);
}

export function stringifyAgentObservation(data: unknown) {
  return truncateAgentObservation(stringifyAgentObservationFull(data));
}

export function findMatchingTableName(tableName: string, availableTableNames: string[]) {
  const normalizedTarget = normalizeIntentText(tableName);
  return availableTableNames.find((candidate) => normalizeIntentText(candidate) === normalizedTarget)
    || availableTableNames.find((candidate) => normalizeIntentText(candidate).includes(normalizedTarget))
    || availableTableNames.find((candidate) => normalizedTarget.includes(normalizeIntentText(candidate)))
    || null;
}

const MAX_EXPLAIN_PLAN_CHARS = 800;
const MAX_EXPLAIN_SUMMARY_CHARS = 2400;

/** Condenses an EXPLAIN result into a bounded plan preview for observations. */
export function summarizeAgentExplainPlan(result: QueryResult) {
  const text = result.rows
    .map((row) => (row.length > 0 ? String(row[0] ?? "") : ""))
    .filter(Boolean)
    .join("\n");
  if (!text.trim()) return "";
  return text.length <= MAX_EXPLAIN_PLAN_CHARS
    ? text
    : `${text.slice(0, MAX_EXPLAIN_PLAN_CHARS)}\n[plan truncated]`;
}

/**
 * Structured EXPLAIN summary: parses the raw plan with the same engine the
 * ExplainVisualizer uses and emits cost totals plus the hottest operations,
 * falling back to the bounded raw text when a plan cannot be parsed.
 */
export function summarizeAgentExplainPlanStructured(
  result: QueryResult,
  dbType: DatabaseType | undefined,
) {
  const rawText = summarizeAgentExplainPlan(result);
  if (!rawText) return "";
  try {
    const plan = parseExplainOutput(dbType ?? "postgresql", rawText.replace("\n[plan truncated]", ""));
    if (plan.nodes.length === 0 && plan.warnings.length === 0) return rawText;
    const hotspots = getExplainHotspots(plan, 3);
    const summary = {
      engine: plan.dbType,
      analyzed: plan.analyzed,
      totalCost: plan.totalCost,
      warnings: plan.warnings.length > 0 ? plan.warnings : undefined,
      hotspots: hotspots.map((hotspot) => ({
        operation: hotspot.node.operation,
        cost: hotspot.node.cost,
        estimatedRows: hotspot.node.estimatedRows,
        actualRows: hotspot.node.actualRows,
        actualTimeMs: hotspot.node.actualTimeMs,
        reasons: hotspot.reasons,
      })),
      rawPlan: rawText,
    };
    const content = JSON.stringify(summary, null, 2);
    return content.length <= MAX_EXPLAIN_SUMMARY_CHARS
      ? content
      : `${content.slice(0, MAX_EXPLAIN_SUMMARY_CHARS)}\n[plan summary truncated]`;
  } catch {
    return rawText;
  }
}

export function summarizeAgentQueryObservation(result: QueryResult) {
  const identityColumns = result.columns
    .filter((column) => column.is_primary_key)
    .map((column) => column.name);
  const previewColumns = result.columns
    .map((column, index) => ({ column, index }))
    .sort((left, right) => {
      const leftStable = left.column.is_primary_key
        || left.column.name.toLowerCase() === "id"
        || left.column.name.toLowerCase().endsWith("_id");
      const rightStable = right.column.is_primary_key
        || right.column.name.toLowerCase() === "id"
        || right.column.name.toLowerCase().endsWith("_id");
      return Number(rightStable) - Number(leftStable) || left.index - right.index;
    })
    .slice(0, MAX_AGENT_QUERY_PREVIEW_COLUMNS);
  const sampleRows = result.rows
    .slice(0, MAX_AGENT_QUERY_PREVIEW_ROWS)
    .map((row) => Object.fromEntries(
      previewColumns.map(({ column, index }) => [
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
    columns: previewColumns.map(({ column }) => `${column.name}:${column.data_type}`),
    identityColumns,
    navigation: identityColumns.length > 0
      ? "stable-primary-key"
      : "non-navigable: query metadata did not verify a primary key",
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
  // CTE aliases defined in this statement are not workspace tables.
  const cteNames = extractCteNamesFromSql(sql);
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

  for (const [patternIndex, pattern] of patterns.entries()) {
    // Indexes 0-1 are the FROM/JOIN row-source patterns: the only places a
    // set-returning function call (`generate_series(...)`) can appear as the
    // captured identifier, where a trailing "(" means a call, not grammar
    // like `INSERT INTO t(...)`.
    const isRowSource = patternIndex <= 1;
    for (const match of sql.matchAll(pattern)) {
      const raw = match[1];
      if (!raw) continue;
      // In a FROM/JOIN clause, `generate_series(...)` / `unnest(...)` are
      // set-returning function calls, not tables: the captured identifier is
      // immediately followed by an argument list. (Elsewhere — e.g.
      // `INSERT INTO t(...)` — a trailing "(" is normal grammar.)
      const afterIdentifier = sql.slice((match.index ?? 0) + match[0].length);
      if (isRowSource && afterIdentifier.trimStart().startsWith("(")) continue;
      const normalized = raw
        .replace(/["`]/g, "")
        .split(".")
        .filter(Boolean)
        .pop()
        ?.trim()
        .toLowerCase();
      if (normalized && !cteNames.has(normalized)) {
        candidates.add(normalized);
      }
    }
  }

  return [...candidates];
}

/**
 * CTE aliases defined in the same statement (`WITH x AS (…), y AS (…)`).
 * Referencing them is legitimate SQL — they must not count as unknown tables.
 */
export function extractCteNamesFromSql(sql: string): Set<string> {
  const names = new Set<string>();
  for (const match of sql.matchAll(/\b(?:with|,)\s*([a-z_][a-z0-9_]*)\s+as\s*\(/gi)) {
    names.add(match[1].toLowerCase());
  }
  return names;
}

const SYSTEM_BARE_NAME_PATTERN =
  /^(?:sqlite_master|sqlite_schema|sqlite_sequence|sqlite_temp_master|pg_class|pg_attribute|pg_constraint|pg_namespace|pg_index|pg_indexes|pg_stat_\w+)$/i;
const QUALIFIED_CATALOG_REF_PATTERN =
  /\b(?:from|join)\s+"?(?:information_schema|pg_catalog|pg_temp_\d+)"?\s*\.\s*"?[a-z_]\w*"?/gi;

/**
 * Returns the system-catalog references embedded in a SQL string, if any.
 * Works on the raw SQL because dotted catalog refs lose their schema prefix
 * once table names are extracted.
 */
export function findSystemCatalogReferences(sql: string): string[] {
  const refs = new Set<string>();
  for (const match of sql.matchAll(QUALIFIED_CATALOG_REF_PATTERN)) {
    refs.add(match[0].replace(/^\s*(?:from|join)\s+/i, "").toLowerCase());
  }
  for (const raw of extractReferencedTableNamesFromSql(sql)) {
    if (SYSTEM_BARE_NAME_PATTERN.test(raw)) {
      refs.add(raw.toLowerCase());
    }
  }
  return [...refs];
}

export function getAgentSqlSchemaRequirements(
  sql: string,
  availableTableNames: string[],
  inspectedTableNames: Iterable<string>,
) {
  const inspected = new Set(
    [...inspectedTableNames].map((tableName) => normalizeIntentText(tableName)),
  );
  const unknown: string[] = [];
  const uninspected: string[] = [];

  // System catalog refs (information_schema.tables, pg_catalog.pg_class, …)
  // are engine internals, not workspace tables: swap them for a sentinel so
  // the schema requirement ignores them. The dedicated catalog guard in the
  // run_readonly_sql tool decides whether they are allowed.
  const sanitizedSql = sql.replace(QUALIFIED_CATALOG_REF_PATTERN, " catalog_ref");
  const cteNames = extractCteNamesFromSql(sanitizedSql);

  for (const referencedTable of extractReferencedTableNamesFromSql(sanitizedSql)) {
    if (referencedTable === "catalog_ref" || SYSTEM_BARE_NAME_PATTERN.test(referencedTable)) {
      continue;
    }
    // A CTE alias defined in this statement (or a set-returning function) is
    // not a workspace table — never block on it.
    if (cteNames.has(referencedTable)) {
      continue;
    }
    const matchedTable = findMatchingTableName(referencedTable, availableTableNames);
    if (!matchedTable) {
      unknown.push(referencedTable);
    } else if (!inspected.has(normalizeIntentText(matchedTable))) {
      uninspected.push(matchedTable);
    }
  }

  return {
    unknown: [...new Set(unknown)],
    uninspected: [...new Set(uninspected)],
  };
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
    // Korean weak signals (audit fix: ko/tr previously fell through silently).
    "정보가 없", "데이터가 없", "컨텍스트가 없", "제공해 주세요", "제공해주세요",
    "제공되지 않았", "데이터베이스가 제공", "스키마가 제공", "테이블을 알려",
    // Turkish weak signals, written post-NFD (ğ→g, ü→u; dotless ı avoided).
    "bilgi yok", "veri yok", "baglam yok", "saglay", "veritaban verildi", "sema saglandi",
    "tablo veya sutun", "alan veya tablo",
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

  if (language === "ko") {
    return [
      `현재 데이터베이스 "${databaseLabel}"을(를) 기준으로 처음부터 다시 답변해 주세요.`,
      `검증된 다음 테이블만 사용할 수 있습니다: ${tableList}.`,
      "현재 스키마와 일치하지 않는 이전 가정이나 이전 답변은 모두 무시하세요.",
      assistIntent === "overview"
        ? "현재 데이터베이스를 다시 읽는 요청입니다. 개요, 주요 테이블, 추론 가능한 관계나 조인 경로, 그리고 짧은 메모를 제공해 주세요. 스키마가 이미 제공되었으므로 스키마가 없다고 말하지 마세요."
        : "사용자의 질문에 현재 스키마만 근거로 답변해 주세요. 스키마만으로 세부 사항을 확인할 수 없다면 그 한계를 명확히 말하되, 보이는 테이블 범위 안에서 답변해야 합니다.",
      "현재 스키마에 없는 도메인, 테이블, 컬럼, 관계를 지어내지 마세요.",
      "", originalPrompt,
    ].join("\n");
  }

  if (language === "tr") {
    return [
      `Baştan yanıt verin ve yalnızca "${databaseLabel}" veritabanına sıkı sıkıya bağlı kalın.`,
      `Yalnızca şu doğrulanmış tabloları kullanabilirsiniz: ${tableList}.`,
      "Geçerli şemayla uyuşmayan eski varsayım ve yanıtları tamamen yok sayın.",
      assistIntent === "overview"
        ? "Bu, mevcut veritabanını yeniden okuma isteğidir. Genel bakış, ana tablolar, çıkarılabilecek ilişkiler veya join yolları ve kısa notlar sunun. Şema zaten eklendiği için şemanın eksik olduğunu söylemeyin."
        : "Kullanıcının sorusunu yalnızca mevcut şemayı temel alarak yanıtlayın. Şema bir ayrıntıyı doğrulamaya yetmiyorsa bu sınırı açıkça belirtin ama görünür tablolara bağlı kalın.",
      "Geçerli şemada olmayan hiçbir alan, tablo, sütun veya ilişki uydurmayın.",
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
