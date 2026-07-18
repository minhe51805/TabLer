import { extractReferencedTableNamesFromSql } from "./ai-agent-grounding";
import type { AIWorkspaceAgentStep } from "./ai-workspace-types";

type RecordValue = string | number | boolean | null;

export interface AIAgentRecordLink {
  tableName: string;
  rowKey: Record<string, RecordValue>;
  label: string;
}

function isRecordValue(value: unknown): value is RecordValue {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function getStableRowKey(
  row: Record<string, unknown>,
  identityColumns: string[],
): Record<string, RecordValue> | null {
  if (identityColumns.length === 0) return null;
  const entries = identityColumns.map((column) => [column, row[column]] as const);
  if (entries.some(([, value]) => !isRecordValue(value) || value === null)) return null;
  return Object.fromEntries(entries) as Record<string, RecordValue>;
}

function extractPrimaryTableIdentifier(sql: string) {
  const match = sql.match(/\bfrom\s+([a-z_"`][a-z0-9_$."`]*)/i);
  return match?.[1]?.replace(/["`]/g, "").trim() || null;
}

/** Build links only from a completed, single-table Agent read with a stable ID. */
export function extractAgentRecordLinks(steps: AIWorkspaceAgentStep[] | undefined): AIAgentRecordLink[] {
  if (!steps?.length) return [];

  for (const step of [...steps].reverse()) {
    if (step.action !== "run_readonly_sql" || step.status !== "done" || !step.observation) continue;

    try {
      const observation = JSON.parse(step.observation) as {
        query?: unknown;
        sampleRows?: unknown;
        identityColumns?: unknown;
      };
      if (typeof observation.query !== "string" || !Array.isArray(observation.sampleRows)) continue;
      const identityColumns = Array.isArray(observation.identityColumns)
        ? observation.identityColumns.filter((value): value is string => typeof value === "string")
        : [];
      const tables = extractReferencedTableNamesFromSql(observation.query);
      if (tables.length !== 1) continue;

      const tableName = extractPrimaryTableIdentifier(observation.query) || tables[0];
      const links = observation.sampleRows.flatMap((sampleRow) => {
        if (!sampleRow || typeof sampleRow !== "object" || Array.isArray(sampleRow)) return [];
        const rowKey = getStableRowKey(sampleRow as Record<string, unknown>, identityColumns);
        if (!rowKey) return [];
        const [column, value] = Object.entries(rowKey)[0];
        return [{
          tableName,
          rowKey,
          label: `Open ${tableName} record (${column}: ${String(value)})`,
        }];
      });
      if (links.length > 0) return links.slice(0, 3);
    } catch {
      // Tool observations can be truncated; keep the answer as a summary instead.
    }
  }

  return [];
}
