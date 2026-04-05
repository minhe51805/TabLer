/**
 * EXPLAIN output parser for various database types.
 * Converts raw EXPLAIN output into a normalized tree structure
 * that the ExplainVisualizer can render.
 */

import type { DatabaseType } from "../types";

/** A single node in the query plan tree */
export interface ExplainNode {
  id: string;
  /** Human-readable operation name */
  operation: string;
  /** Parent node id (null for root) */
  parentId: string | null;
  /** Child node ids */
  children: string[];
  /** Estimated cost (total for this node) */
  cost?: number;
  /** Estimated startup cost */
  startupCost?: number;
  /** Estimated number of rows output */
  estimatedRows?: number;
  /** Actual rows output (only when ANALYZE is used) */
  actualRows?: number;
  /** Estimated row width in bytes */
  estimatedRowWidth?: number;
  /** Full detail object (raw parsed data) */
  detail: Record<string, unknown>;
  /** Node-specific info (e.g. table name, index name, join type) */
  extras: Record<string, string | number | boolean | null>;
}

/** Complete parsed explain plan */
export interface ExplainPlan {
  /** Whether this plan used ANALYZE (includes actual vs estimated) */
  analyzed: boolean;
  /** Total estimated cost */
  totalCost?: number;
  /** Root node(s) of the plan tree */
  roots: ExplainNode[];
  /** All nodes indexed by id */
  nodes: Map<string, ExplainNode>;
  /** Raw text output (for unsupported formats) */
  rawText: string;
  /** Database type that produced this plan */
  dbType: DatabaseType;
  /** Any warnings or notes */
  warnings: string[];
}

/** Parsed plan used by the ExplainVisualizer component */
export interface ParsedExplainPlan {
  dbType: DatabaseType;
  analyzed: boolean;
  totalCost?: number;
  rawText: string;
  warnings: string[];
  /** Flat list of all nodes (for rendering) */
  nodes: ExplainNode[];
  /** Root node ids (usually one) */
  rootIds: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let nodeCounter = 0;
function newId(): string {
  return `expl-node-${++nodeCounter}`;
}

function resetNodeCounter(): void {
  nodeCounter = 0;
}

function makeNode(
  operation: string,
  detail: Record<string, unknown>,
  extras: Record<string, string | number | boolean | null> = {},
  parentId: string | null = null,
): ExplainNode {
  const cost = detail.total_cost ?? detail.Total_Cost;
  const startupCost = detail.startup_cost ?? detail.Startup_Cost;
  const rows = detail.plan_rows ?? detail.Plan_Rows ?? detail.estimated_rows ?? detail.EstimatedRows;
  const actualRows = detail.actual_rows ?? detail.Actual_Rows ?? detail.actualRows;
  const rowWidth = detail.plan_width ?? detail.Plan_Width;

  return {
    id: newId(),
    operation,
    parentId,
    children: [],
    cost: typeof cost === "number" ? cost : undefined,
    startupCost: typeof startupCost === "number" ? startupCost : undefined,
    estimatedRows: typeof rows === "number" ? rows : undefined,
    actualRows: typeof actualRows === "number" ? actualRows : undefined,
    estimatedRowWidth: typeof rowWidth === "number" ? rowWidth : undefined,
    detail,
    extras,
  };
}

function insertNode(
  nodes: Map<string, ExplainNode>,
  roots: ExplainNode[],
  child: ExplainNode,
  parentId: string | null,
): ExplainNode {
  if (parentId && nodes.has(parentId)) {
    const parent = nodes.get(parentId)!;
    parent.children.push(child.id);
  } else {
    roots.push(child);
  }
  nodes.set(child.id, child);
  return child;
}

/** Extract a clean string label from a detail object */
function getOpName(detail: Record<string, unknown>): string {
  const n = detail.Node_Type ?? detail.node_type ?? detail.Operation ?? detail.operation ?? "Operation";
  return String(n);
}

/** Extract table/index/join info from detail */
function getExtras(detail: Record<string, unknown>): Record<string, string | number | boolean | null> {
  const extras: Record<string, string | number | boolean | null> = {};
  const aliases: [string, string][] = [
    ["Relation_Name", "table"],
    ["relation name", "table"],
    ["Table", "table"],
    ["Index_Name", "index"],
    ["index name", "index"],
    ["Index", "index"],
    ["Parent Relationship", "join"],
    ["parent_relationship", "join"],
    ["Join Type", "joinType"],
    ["join_type", "joinType"],
    ["JoinFilter", "joinFilter"],
    ["join_filter", "joinFilter"],
    ["Filter", "filter"],
    ["filter", "filter"],
    ["CTE Name", "cte"],
    ["CTE", "cte"],
    ["Subplan Name", "subplan"],
    ["Schema", "schema"],
    ["schema", "schema"],
    ["Async", "async"],
    ["Async", "async"],
    ["Workers", "workers"],
    ["workers", "workers"],
    ["Buffers", "buffers"],
    ["buffers", "buffers"],
    ["Actual Rows", "actualRows"],
    ["actual rows", "actualRows"],
    ["Actual Loops", "actualLoops"],
    ["actual loops", "actualLoops"],
    ["Total Cost", "totalCost"],
    ["total_cost", "totalCost"],
    ["Startup Cost", "startupCost"],
    ["startup_cost", "startupCost"],
  ];

  for (const [key, label] of aliases) {
    if (key in detail) {
      const v = detail[key];
      if (v !== null && v !== undefined) {
        extras[label] = v as string | number | boolean | null;
      }
    }
  }

  return extras;
}

// ---------------------------------------------------------------------------
// PostgreSQL / CockroachDB / DuckDB (JSON format)
// ---------------------------------------------------------------------------

function parsePostgresJson(raw: unknown, nodes: Map<string, ExplainNode>, roots: ExplainNode[]): void {
  if (!raw || typeof raw !== "object") return;

  const obj = raw as Record<string, unknown>;

  function walk(
    plan: Record<string, unknown>,
    parentId: string | null,
  ): void {
    if (!plan || typeof plan !== "object") return;
    const p = plan as Record<string, unknown>;
    const op = getOpName(p);
    const extras = getExtras(p);
    const node = makeNode(op, p, extras, parentId);
    insertNode(nodes, roots, node, parentId);

    // Children in PostgreSQL JSON format
    const children = p.Plans ?? p.plans ?? p.Children ?? p.children;
    if (Array.isArray(children)) {
      for (const child of children) {
        walk(child as Record<string, unknown>, node.id);
      }
    }
  }

  // PostgreSQL wraps the plan in { "Plan": { ... } }
  const planObj = obj.Plan ?? obj.plan ?? obj;
  walk(planObj as Record<string, unknown>, null);
}

// ---------------------------------------------------------------------------
// MySQL / MariaDB (JSON format via EXPLAIN FORMAT=JSON)
// ---------------------------------------------------------------------------

function parseMySQLJson(raw: unknown, nodes: Map<string, ExplainNode>, roots: ExplainNode[]): void {
  if (!raw || typeof raw !== "object") return;

  const obj = raw as Record<string, unknown>;
  const planObj = obj.explain ?? obj.EXPLAIN ?? obj;

  function walk(
    plan: Record<string, unknown>,
    parentId: string | null,
  ): void {
    if (!plan || typeof plan !== "object") return;
    const p = plan as Record<string, unknown>;
    const op = String(p.operation ?? p.access_type ?? p.type ?? "Unknown");
    const extras: Record<string, string | number | boolean | null> = {
      table: (p.table as string | null) ?? null,
      type: (p.access_type as string | null) ?? null,
      possible_keys: (p.possible_keys as string | null) ?? null,
      key: (p.key as string | null) ?? null,
      rows_examined: (p.rows_examined as number | null) ?? null,
      filtered: (p.filtered as number | null) ?? null,
      using_index: ((p.extra as string | null) ?? "").includes("Using index") || null,
    };
    const node = makeNode(op, p, extras, parentId);
    insertNode(nodes, roots, node, parentId);

    const children = p.used_exec_engine ?? p.nested_loop ?? p.children;
    if (Array.isArray(children)) {
      for (const child of children) {
        walk(child as Record<string, unknown>, node.id);
      }
    }
  }

  walk(planObj as Record<string, unknown>, null);
}

// ---------------------------------------------------------------------------
// ClickHouse (JSON format)
// ---------------------------------------------------------------------------

function parseClickHouseJson(raw: unknown, nodes: Map<string, ExplainNode>, roots: ExplainNode[]): void {
  if (!raw || typeof raw !== "object") return;

  const obj = raw as Record<string, unknown>;

  function walk(
    plan: Record<string, unknown>,
    parentId: string | null,
  ): void {
    if (!plan || typeof plan !== "object") return;
    const p = plan as Record<string, unknown>;
    const op = String(p.name ?? p.Name ?? p.operator ?? p.Operator ?? "Step");
    const extras: Record<string, string | number | boolean | null> = {
      description: (p.description ?? p.Description ?? null) as string | null,
      streams: (p.streams ?? p.Streams ?? null) as number | null,
    };
    const node = makeNode(op, p, extras, parentId);
    insertNode(nodes, roots, node, parentId);

    const children = p.children ?? p.Children ?? p.plans ?? p.Plans;
    if (Array.isArray(children)) {
      for (const child of children) {
        walk(child as Record<string, unknown>, node.id);
      }
    }
  }

  if (Array.isArray(obj)) {
    for (const item of obj) {
      walk(item as Record<string, unknown>, null);
    }
  } else {
    walk(obj, null);
  }
}

// ---------------------------------------------------------------------------
// SQLite (text format — parse line by line)
// ---------------------------------------------------------------------------

function parseSQLiteText(raw: string, nodes: Map<string, ExplainNode>, roots: ExplainNode[]): void {
  if (!raw) return;

  const lines = raw.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const stack: ExplainNode[] = [];

  for (const line of lines) {
    // Detect indentation level (each "|--" or "`--" adds one level)
    const indentMatch = line.match(/^(\|?[-`]\s*)+/);
    const indent = indentMatch ? (indentMatch[0].replace(/[|`-]/g, "").length * 2 + indentMatch[0].length) : 0;
    const depth = Math.floor(indent / 2);

    // Extract operation text
    const opMatch = line.match(/^(?:(\d+)\s+)?(.+)/);
    const opText = opMatch ? opMatch[2].trim() : line;

    // Extract cost if present: e.g. "0.00..1234.56"
    let cost: number | undefined;
    let rows: number | undefined;
    const costMatch = opText.match(/(\d+(?:\.\d+)?\.\.\d+(?:\.\d+)?)/);
    if (costMatch) {
      const parts = costMatch[1].split("..");
      cost = parseFloat(parts[1]) || undefined;
    }
    const rowsMatch = opText.match(/\((\d+)\s+rows?\)/);
    if (rowsMatch) {
      rows = parseInt(rowsMatch[1], 10) || undefined;
    }

    const extras: Record<string, string | number | boolean | null> = {};
    const detail: Record<string, unknown> = { cost, estimated_rows: rows };
    if (cost) detail.total_cost = cost;
    if (rows) detail.plan_rows = rows;

    const node: ExplainNode = {
      id: newId(),
      operation: opText,
      parentId: null,
      children: [],
      cost,
      estimatedRows: rows,
      detail,
      extras,
    };

    // Pop stack to correct depth
    while (stack.length > depth) {
      stack.pop();
    }

    const parentId = stack.length > 0 ? stack[stack.length - 1].id : null;
    if (parentId) {
      const parent = nodes.get(parentId)!;
      parent.children.push(node.id);
    } else {
      roots.push(node);
    }

    nodes.set(node.id, node);
    stack.push(node);
  }
}

// ---------------------------------------------------------------------------
// MSSQL (text/SHOWPLAN format — basic line parse)
// ---------------------------------------------------------------------------

function parseMSSQLText(raw: string, nodes: Map<string, ExplainNode>, roots: ExplainNode[]): void {
  if (!raw) return;

  const lines = raw.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);

  for (const line of lines) {
    // Skip header/blank lines
    if (line.startsWith("===") || line.startsWith("--") || line.length < 3) continue;

    const detail: Record<string, unknown> = {};
    const extras: Record<string, string | number | boolean | null> = {};

    // Try to extract cost and row estimates
    const costMatch = line.match(/(?:cost\s*[=:]?\s*[\d.]+)/i);
    const rowsMatch = line.match(/(?:rows\s*[=:]?\s*\d+)/i);

    if (costMatch) extras.cost_text = costMatch[0];
    if (rowsMatch) extras.rows_text = rowsMatch[0];

    const node = makeNode(line, detail, extras, null);
    roots.push(node);
    nodes.set(node.id, node);
  }
}

// ---------------------------------------------------------------------------
// Generic text fallback
// ---------------------------------------------------------------------------

function parseTextFallback(raw: string, nodes: Map<string, ExplainNode>, roots: ExplainNode[]): void {
  if (!raw) return;

  const lines = raw.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);

  for (const line of lines) {
    if (line.startsWith("===") || line.startsWith("--") || line.length < 3) continue;

    const detail: Record<string, unknown> = {};
    const extras: Record<string, string | number | boolean | null> = {};
    const node = makeNode(line, detail, extras, null);
    roots.push(node);
    nodes.set(node.id, node);
  }
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

/**
 * Parse EXPLAIN output from any supported database type.
 *
 * @param dbType - The database type (postgresql, mysql, sqlite, etc.)
 * @param output - Raw output from EXPLAIN query (usually JSON or text)
 * @returns Normalized ParsedExplainPlan
 */
export function parseExplainOutput(
  dbType: DatabaseType,
  output: unknown,
): ParsedExplainPlan {
  resetNodeCounter();
  const nodes = new Map<string, ExplainNode>();
  const roots: ExplainNode[] = [];
  const warnings: string[] = [];
  let rawText = "";
  let analyzed = false;
  let totalCost: number | undefined;

  // Try to extract raw text first (for all formats)
  if (typeof output === "string") {
    rawText = output;
  } else if (output && typeof output === "object") {
    // For JSON output, extract the raw string if present
    const obj = output as Record<string, unknown>;
    if (typeof obj.raw === "string") rawText = obj.raw;
    else if (typeof obj.text === "string") rawText = obj.text;
    else rawText = JSON.stringify(output, null, 2);
  }

  const isJson = output !== null && (typeof output === "object" || typeof output === "string");

  try {
    if (isJson && typeof output === "object") {
      const obj = output as Record<string, unknown>;

      // Detect ANALYZE mode
      analyzed =
        "actual_time" in obj ||
        "Actual Rows" in obj ||
        "ActualLoops" in obj ||
        "actual_loops" in obj ||
        "Runtime" in obj;

      // Extract total cost if present
      if ("Total Cost" in obj) totalCost = Number(obj["Total Cost"]);
      else if ("total_cost" in obj) totalCost = Number(obj.total_cost);
      else if ("Plan" in obj && typeof obj.Plan === "object") {
        const plan = obj.Plan as Record<string, unknown>;
        if ("Total Cost" in plan) totalCost = Number(plan["Total Cost"]);
        else if ("total_cost" in plan) totalCost = Number(plan.total_cost);
      }

      switch (dbType) {
        case "postgresql":
        case "cockroachdb":
        case "duckdb":
        case "greenplum":
        case "redshift":
        case "snowflake":
        case "bigquery":
        case "vertica":
        case "libsql":
        case "cloudflare_d1":
          parsePostgresJson(obj, nodes, roots);
          break;

        case "mysql":
        case "mariadb":
          parseMySQLJson(obj, nodes, roots);
          break;

        case "clickhouse":
          parseClickHouseJson(obj, nodes, roots);
          break;

        default:
          // Unknown JSON — try as generic
          parsePostgresJson(obj, nodes, roots);
      }
    } else if (typeof output === "string") {
      // Text format
      switch (dbType) {
        case "sqlite":
          parseSQLiteText(output, nodes, roots);
          break;

        case "mssql":
          parseMSSQLText(output, nodes, roots);
          break;

        default:
          parseTextFallback(output, nodes, roots);
      }
    }
  } catch (err) {
    warnings.push(`Parse error: ${err instanceof Error ? err.message : String(err)}`);
    parseTextFallback(rawText, nodes, roots);
  }

  // Fallback: if no nodes parsed, show raw text as single node
  if (nodes.size === 0 && rawText) {
    const node = makeNode(rawText.split("\n")[0] || "Plan", {}, {}, null);
    roots.push(node);
    nodes.set(node.id, node);
    if (rawText.includes("\n")) {
      node.extras["full_text"] = rawText;
    }
  }

  return {
    dbType,
    analyzed,
    totalCost,
    rawText,
    warnings,
    nodes: Array.from(nodes.values()),
    rootIds: roots.map((r) => r.id),
  };
}

/** Build an EXPLAIN query for a given database type */
export function buildExplainQuery(sql: string, dbType: DatabaseType, analyze = false): string {
  switch (dbType) {
    case "postgresql":
    case "cockroachdb":
    case "greenplum":
    case "redshift":
    case "vertica":
      return analyze
        ? `EXPLAIN (ANALYZE, COSTS, VERBOSE, BUFFERS, FORMAT JSON) ${sql}`
        : `EXPLAIN (COSTS, VERBOSE, FORMAT JSON) ${sql}`;

    case "duckdb":
      return analyze
        ? `EXPLAIN ANALYZE ${sql}`
        : `EXPLAIN ${sql}`;

    case "mysql":
    case "mariadb":
      if (analyze) {
        return `EXPLAIN ANALYZE ${sql}`;
      }
      return `EXPLAIN FORMAT=JSON ${sql}`;

    case "sqlite":
      return analyze
        ? `EXPLAIN QUERY PLAN ${sql}`
        : `EXPLAIN QUERY PLAN ${sql}`;

    case "mssql":
      return analyze
        ? `SET SHOWPLAN_XML ON; ${sql}`
        : `SET SHOWPLAN_TEXT ON; ${sql}`;

    case "snowflake":
    case "bigquery":
      return analyze
        ? `EXPLAIN ${sql}`
        : `EXPLAIN ${sql}`;

    case "clickhouse":
      return analyze
        ? `EXPLAIN ${sql}`
        : `EXPLAIN ${sql}`;

    case "libsql":
    case "cloudflare_d1":
      return `EXPLAIN QUERY PLAN ${sql}`;

    default:
      return `EXPLAIN ${sql}`;
  }
}

/** Determine the operation category for color coding */
export function getNodeCategory(operation: string): "scan" | "join" | "sort" | "index" | "aggregate" | "other" {
  const op = operation.toLowerCase();
  if (op.includes("scan") || op.includes("seq") || op.includes("index scan") || op.includes("table scan") || op.includes("full scan")) {
    return "scan";
  }
  if (op.includes("join") || op.includes("nestloop") || op.includes("hash join") || op.includes("merge join") || op.includes("nested loop")) {
    return "join";
  }
  if (op.includes("sort") || op.includes("order") || op.includes("top") || op.includes("limit")) {
    return "sort";
  }
  if (op.includes("index") || op.includes("bitmap") || op.includes("seek")) {
    return "index";
  }
  if (op.includes("agg") || op.includes("group") || op.includes("hash") || op.includes("window") || op.includes("count")) {
    return "aggregate";
  }
  return "other";
}
