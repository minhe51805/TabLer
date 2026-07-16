import type { ColumnDetail } from "../../types";

export interface AgentSchemaSearchCandidate {
  identifier: string;
  columns: ColumnDetail[];
}

export interface AgentSchemaSearchMatch {
  table: string;
  columns: Array<{ name: string; dataType: string }>;
  score: number;
}

const SEARCH_STOP_WORDS = new Set([
  "about", "across", "after", "against", "bang", "bangs", "cai", "can", "cua", "data",
  "database", "do", "find", "for", "from", "give", "hay", "hien", "in", "la", "lay", "me",
  "mot", "nay", "of", "on", "record", "row", "search", "show", "table", "the", "tim", "to",
  "trong", "user", "users", "value", "voi", "where", "with",
]);

function normalize(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function isAgentRecordLookupRequest(prompt: string) {
  const normalized = normalize(prompt).replace(/_/g, " ");
  if (/\b[^\s@]+@[^\s@]+\.[^\s@]+\b/.test(prompt)) return true;
  if (/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(prompt)) return true;
  if (/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/i.test(prompt)) return true;

  return [
    "find", "search", "locate", "look up", "lookup", "check", "inspect record", "show record",
    "find user", "which user", "who owns", "event", "incident", "record", "row",
    "tim", "kiem tra", "tra cuu", "tim user", "nguoi dung", "su viec", "ban ghi", "dong du lieu",
  ].some((signal) => normalized.includes(signal));
}

function buildSearchTerms(query: string) {
  const normalized = normalize(query);
  const terms = new Set(
    normalized
      .split("_")
      .filter((term) => term.length >= 3 && !SEARCH_STOP_WORDS.has(term)),
  );

  if (query.includes("@") || /\be[-_ ]?mail\b/i.test(query)) {
    terms.add("email");
  }
  if (/\b(phone|telephone|mobile)\b/i.test(query)) {
    terms.add("phone");
  }
  if (/\b(ip|ip address|dia chi ip)\b/i.test(query)) {
    terms.add("ip");
  }

  return [...terms];
}

export function findAgentSchemaMatches(
  query: string,
  candidates: AgentSchemaSearchCandidate[],
  limit = 12,
): AgentSchemaSearchMatch[] {
  const terms = buildSearchTerms(query);
  if (terms.length === 0) return [];

  return candidates
    .map((candidate) => {
      const tableName = normalize(candidate.identifier);
      const columns = candidate.columns.flatMap((column) => {
        const columnName = normalize(column.name);
        let score = 0;
        for (const term of terms) {
          if (columnName === term) score += 30;
          else if (columnName.includes(term) || term.includes(columnName)) score += 12;
          if (tableName === term || tableName.endsWith(`_${term}`)) score += 4;
        }
        return score > 0 ? [{ name: column.name, dataType: column.data_type, score }] : [];
      });
      const score = columns.reduce((total, column) => total + column.score, 0);
      return {
        table: candidate.identifier,
        columns: columns
          .sort((left, right) => right.score - left.score)
          .slice(0, 8)
          .map(({ name, dataType }) => ({ name, dataType })),
        score,
      };
    })
    .filter((match) => match.score > 0)
    .sort((left, right) => right.score - left.score || left.table.localeCompare(right.table))
    .slice(0, limit);
}
