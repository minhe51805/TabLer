/**
 * Index Advisor — turns EXPLAIN plan scan/filter signals into ready-to-review
 * CREATE INDEX proposals (Group-2 Feature 6).
 *
 * Pure planning: input is a parsed EXPLAIN plan plus the SQL text; output is
 * a list of proposals. No DDL is ever executed here — the UI layer decides
 * what to do with the generated statement (copy / run via the existing
 * review-before-run pipeline).
 */

import type { ExplainNode, ParsedExplainPlan } from "./explain-parser";

export interface IndexProposal {
  id: string;
  /** Table the index targets (qualified names are kept verbatim). */
  tableName: string;
  /** Column order matters — leading column first. */
  columns: string[];
  /** Generated CREATE INDEX statement, ready for review. */
  sql: string;
  /** Scan nodes this proposal is derived from. */
  reasons: string[];
  /** Higher = more confident (cost share × scan severity). */
  score: number;
}

const MAX_PROPOSALS = 3;
/** Cost share a scan node must reach before it is considered a candidate. */
const MIN_COST_SHARE = 0.05;

/** Seq/full scan families across engines (PG/MySQL/MSSQL/SQLite/DuckDB...). */
const FULL_SCAN_PATTERN = /seq scan|sequential scan|table scan|full table scan|full scan|all\s*\(|access:\s*all/i;
/** Row-count share a scan must output before it is worth indexing. */
const MIN_SCAN_ROWS = 500;

function nodeTableName(node: ExplainNode): string | null {
  const raw = node.extras.table;
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  return null;
}

/**
 * Node cost, with a fallback to the extras copy — several parser paths only
 * surface "Total Cost" through extras (node.cost stays undefined there).
 */
function nodeCost(node: ExplainNode): number {
  if (typeof node.cost === "number" && node.cost > 0) return node.cost;
  const fromExtras = Number(node.extras.totalCost);
  return Number.isFinite(fromExtras) && fromExtras > 0 ? fromExtras : 0;
}

/** Pull column names out of a Filter / join-condition text blob. */
function extractFilterColumns(filterText: string): string[] {
  const found: string[] = [];
  // Symbol operators need no word boundary (a trailing \b would fail when the
  // operator is followed by a space); word operators are \b-wrapped instead.
  const pattern = /([A-Za-z_][A-Za-z0-9_$]*)\s*(?:<=|>=|<>|!=|=|<|>|\bLIKE\b|\bILIKE\b|\bBETWEEN\b|\bIN\b)/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(filterText)) !== null) {
    const column = match[1];
    if (/^(and|or|not|is|null|true|false)$/i.test(column)) continue;
    if (!found.includes(column)) found.push(column);
  }
  return found;
}

/**
 * Propose indexes for full-scan nodes that filter large row volumes.
 * Deterministic: same plan + same SQL → same proposals, in the same order.
 */
export function getIndexProposals(
  plan: ParsedExplainPlan,
  sql: string,
  existingIndexesByTable: ReadonlyMap<string, readonly string[]> = new Map(),
): IndexProposal[] {
  const planCost = Math.max(plan.totalCost ?? 0, ...plan.nodes.map(nodeCost), 1);
  const scanNodes = plan.nodes.filter(
    (node) =>
      FULL_SCAN_PATTERN.test(node.operation)
      && nodeCost(node) / planCost >= MIN_COST_SHARE,
  );
  if (scanNodes.length === 0) return [];

  // Table usage counts from the statement itself — a table referenced in a
  // JOIN or WHERE is a much stronger indexing candidate than a drive-by scan.
  const fromMatches = [...sql.matchAll(/\b(?:from|join)\s+([A-Za-z_][\w$.]*)/gi)];
  const referencedTables = new Set(fromMatches.map((match) => match[1].replace(/["`]/g, "")));

  const proposals = new Map<string, IndexProposal>();

  for (const node of scanNodes) {
    const tableName = nodeTableName(node);
    if (!tableName) continue;
    if (!referencedTables.has(tableName) && !referencedTables.has(tableName.split(".").pop() ?? "")) {
      continue;
    }

    const rows = node.actualRows ?? node.estimatedRows ?? 0;
    if (rows > 0 && rows < MIN_SCAN_ROWS) continue;

    const filterText = [node.extras.filter, node.extras.joinFilter, node.extras.joinCond]
      .filter((value): value is string => typeof value === "string")
      .join(" ");
    const columns = extractFilterColumns(filterText).slice(0, 3);
    if (columns.length === 0) continue;

    // Skip proposals duplicating an existing index (prefix match).
    const existing = existingIndexesByTable.get(tableName) ?? [];
    if (existing.some((indexColumns) => indexColumns.startsWith(columns[0]))) continue;

    const key = `${tableName}|${columns.join(",")}`;
    const costShare = nodeCost(node) / planCost;
    const reasons = [
      `${node.operation} on ${tableName}`,
      `filter: ${filterText.slice(0, 80)}`,
      `${rows.toLocaleString()} rows at ${(costShare * 100).toFixed(0)}% of plan cost`,
    ];
    const score = costShare * 100 + Math.min(rows / 10_000, 25);

    const current = proposals.get(key);
    if (current) {
      current.score = Math.max(current.score, score);
      current.reasons.push(...reasons);
    } else {
      const columnList = columns.join(", ");
      proposals.set(key, {
        id: key,
        tableName,
        columns,
        sql: `CREATE INDEX idx_${tableName.split(".").pop()}_${columns.join("_").replace(/\W/g, "")} ON ${tableName} (${columnList});`,
        reasons,
        score,
      });
    }
  }

  return [...proposals.values()].sort((left, right) => right.score - left.score).slice(0, MAX_PROPOSALS);
}
