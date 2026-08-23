import type { AIMetricsSchemaTableHint } from "./shared";
import {
  RECRUITMENT_LAYOUT_SLOTS,
  type MetricsWidgetSeed,
  type MetricsWidgetSeedDraft,
} from "./shared";

export function normalizeIdentifier(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function escapeSqlLiteral(value: string) {
  return value.replace(/'/g, "''");
}

export function quotePgIdentifier(value: string) {
  return `"${value.replace(/"/g, "\"\"")}"`;
}

export function qualifyPgTable(table: AIMetricsSchemaTableHint) {
  return table.schema
    ? `${quotePgIdentifier(table.schema)}.${quotePgIdentifier(table.name)}`
    : quotePgIdentifier(table.name);
}

export function findSchemaTable(
  schemaHints: AIMetricsSchemaTableHint[] | undefined,
  candidates: string[],
) {
  if (!schemaHints?.length) return null;
  const normalizedCandidates = new Set(candidates.map(normalizeIdentifier));
  return (
    schemaHints.find((table) => normalizedCandidates.has(normalizeIdentifier(table.name))) ?? null
  );
}

export function findTableColumn(
  table: AIMetricsSchemaTableHint | null | undefined,
  candidates: string[],
) {
  if (!table?.columns?.length) return null;
  const normalizedColumns = new Map(
    table.columns.map((column) => [normalizeIdentifier(column), column]),
  );
  for (const candidate of candidates) {
    const match = normalizedColumns.get(normalizeIdentifier(candidate));
    if (match) return match;
  }
  return null;
}

export function buildPgTextExpr(alias: string, column: string, fallback: string) {
  return `COALESCE(NULLIF(TRIM(${alias}.${quotePgIdentifier(column)}::text), ''), '${escapeSqlLiteral(fallback)}')`;
}

export function buildPgLooseEquality(leftAlias: string, leftColumn: string, rightAlias: string, rightColumn: string) {
  return `${leftAlias}.${quotePgIdentifier(leftColumn)}::text = ${rightAlias}.${quotePgIdentifier(rightColumn)}::text`;
}

export function buildPgEntityLabelExpr(args: {
  alias: string;
  titleColumn?: string | null;
  idColumn?: string | null;
  fallbackPrefix: string;
}) {
  const { alias, titleColumn, idColumn, fallbackPrefix } = args;
  if (titleColumn) {
    if (idColumn) {
      return `COALESCE(NULLIF(TRIM(${alias}.${quotePgIdentifier(titleColumn)}::text), ''), '${escapeSqlLiteral(fallbackPrefix)} #' || COALESCE(${alias}.${quotePgIdentifier(idColumn)}::text, 'n/a'))`;
    }
    return `COALESCE(NULLIF(TRIM(${alias}.${quotePgIdentifier(titleColumn)}::text), ''), '${escapeSqlLiteral(fallbackPrefix)} unknown')`;
  }
  if (idColumn) {
    return `'${escapeSqlLiteral(fallbackPrefix)} #' || COALESCE(${alias}.${quotePgIdentifier(idColumn)}::text, 'n/a')`;
  }
  return `'${escapeSqlLiteral(fallbackPrefix)}'`;
}

export function withRecruitmentLayout(
  index: number,
  seed: MetricsWidgetSeedDraft,
): MetricsWidgetSeed {
  const slot =
    RECRUITMENT_LAYOUT_SLOTS[index] ?? {
      colSpan: 7,
      rowSpan: 4,
      gridX: index % 2 === 0 ? 0 : 7,
      gridY: 12 + Math.floor(Math.max(0, index - RECRUITMENT_LAYOUT_SLOTS.length) / 2) * 4,
    };

  return {
    ...seed,
    refreshSeconds: seed.refreshSeconds ?? 30,
    ...slot,
  };
}
