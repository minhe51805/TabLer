import type { AIWorkspaceInteractionMode } from "./ai-workspace-types";
import type { AssistIntent } from "./ai-agent-context";

export function normalizeIntentText(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d");
}

export function isVisualizationRequest(prompt: string) {
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

export function isMetricsBoardRequest(prompt: string) {
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

export function stripTableSchemaQualifier(tableName: string) {
  return tableName
    .replace(/["`]/g, "")
    .split(".")
    .filter(Boolean)
    .pop()
    ?.trim() || tableName.trim();
}

export function buildKnownTableNameSet(availableTableNames: string[]) {
  const knownNames = new Set<string>();

  for (const tableName of availableTableNames) {
    const normalizedFullName = normalizeIntentText(tableName.replace(/["`]/g, ""));
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

export function isWorkspaceScopedIntent(intent: AssistIntent) {
  return intent !== "general";
}

export function inferAssistIntent(prompt: string, interactionMode: AIWorkspaceInteractionMode): AssistIntent {
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
