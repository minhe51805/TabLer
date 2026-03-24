import { useCallback, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../../stores/appStore";
import type { AIConversationMessage, AIRequestIntent } from "../../../types";
import type { QueryResult } from "../../../types";
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
  type SqlRiskAnalysis,
  AI_SCHEMA_CODEC_VERSION,
  MAX_TABLE_NAMES_IN_CONTEXT,
  MAX_AI_SCHEMA_CODEC_CACHE_ENTRIES,
} from "../AISlidePanelUtils";

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

function normalizeIntentText(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d");
}

function inferAssistIntent(prompt: string): AssistIntent {
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
  const sqlScore = sqlSignals.reduce((score, signal) => score + (normalizedPrompt.includes(signal) ? 1 : 0), 0);
  const explainScore = explainSignals.reduce((score, signal) => score + (normalizedPrompt.includes(signal) ? 1 : 0), 0);

  if (hasOverviewSignal && sqlScore === 0) {
    return "overview";
  }

  if (sqlScore === 0 && (explainScore > 0 || normalizedPrompt.includes("?"))) {
    return "explain";
  }

  return sqlScore > explainScore ? "sql" : "explain";
}

function buildAssistPrompt(prompt: string, intent: AssistIntent) {
  if (intent === "overview") {
    return [
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
    "If SQL is needed, return the runnable SQL inside a single ```sql fenced block.",
    "Keep any explanation outside the SQL block.",
    "",
    prompt,
  ].join("\n");
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
  const requestIdRef = useRef(0);

  const activeProvider = aiConfigs.find((config) => config.is_enabled);
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
    history: AIConversationMessage[] = []
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
    const assistIntent: AIRequestIntent = inferAssistIntent(normalizedPrompt);
    const aiPrompt = buildAssistPrompt(normalizedPrompt, assistIntent);

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

      let context = "";
      if (activeProvider.allow_schema_context) {
        const availableTableNames = latestTables.map((table) => table.name).slice(0, MAX_TABLE_NAMES_IN_CONTEXT);
        const tablesToFetch = pickRelevantTables(normalizedPrompt, latestTables);
        const schemaCodecMode = assistIntent === "overview" ? "relational" : inferAISchemaCodecMode(normalizedPrompt);
        const tableSchemas = await Promise.all(
          tablesToFetch.map(async (table) => {
            const cacheKey = `${connectionId}:${currentDatabase || "default"}:${schemaCodecMode}:${table.name}`;
            const cachedSummary = aiSchemaCodecCacheRef.current.get(cacheKey);
            if (cachedSummary) return cachedSummary;
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
              setAiSchemaCodecCacheEntry(aiSchemaCodecCacheRef.current, cacheKey, summary);
              return summary;
            } catch {
              const fallbackSummary = `T:${table.name}|C:[]`;
              setAiSchemaCodecCacheEntry(aiSchemaCodecCacheRef.current, cacheKey, fallbackSummary);
              return fallbackSummary;
            }
          })
        );
        if (requestId !== requestIdRef.current) {
          throw new Error("This AI request was replaced by a newer one.");
        }

        context = [
          `Database: ${currentDatabase || "Default"}`,
          "",
          `Available tables (${latestTables.length}): ${availableTableNames.join(", ")}${latestTables.length > MAX_TABLE_NAMES_IN_CONTEXT ? ", ..." : ""}`,
          "",
          `AI schema codec ${AI_SCHEMA_CODEC_VERSION} (mode=${schemaCodecMode}, compact structural metadata only, no row data):`,
          AI_SCHEMA_CODEC_LEGEND,
          tableSchemas.join("\n"),
          "",
          "Only use tables from the available list above. If a needed table is missing, ask the user to create it first.",
        ].join("\n");
      }

      let rawResponse = await askAI(aiPrompt, context, "panel", assistIntent, history);
      if (requestId !== requestIdRef.current) {
        throw new Error("This AI request was replaced by a newer one.");
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
          history
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
