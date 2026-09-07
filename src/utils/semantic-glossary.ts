import { invokeMutation, invokeWithTimeout } from "./tauri-utils";

export interface SemanticGlossaryEntry {
  id: string;
  connectionId: string | null;
  database: string | null;
  term: string;
  definition: string;
  kind: "term" | "metric" | "relationship" | "alias";
  source: "user" | "agent";
  createdAt: string;
  updatedAt: string;
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { entries: SemanticGlossaryEntry[]; loadedAt: number }>();

function scopeKey(connectionId: string, database?: string) {
  return `${connectionId}::${database ?? ""}`;
}

export function invalidateSemanticGlossary(connectionId?: string) {
  if (!connectionId) {
    cache.clear();
    return;
  }
  for (const key of [...cache.keys()]) {
    if (key.startsWith(`${connectionId}::`)) cache.delete(key);
  }
}

export async function getSemanticGlossary(
  connectionId: string,
  database?: string,
): Promise<SemanticGlossaryEntry[]> {
  const key = scopeKey(connectionId, database);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) return cached.entries;

  const entries = await invokeWithTimeout<SemanticGlossaryEntry[]>(
    "get_semantic_entries",
    { connectionId, database: database || null },
    10_000,
    "Loading semantic glossary",
  );
  cache.set(key, { entries, loadedAt: Date.now() });
  return entries;
}

export async function saveSemanticGlossaryEntry(params: {
  id?: string;
  connectionId: string;
  database?: string;
  term: string;
  definition: string;
  kind?: SemanticGlossaryEntry["kind"];
  source?: SemanticGlossaryEntry["source"];
}): Promise<SemanticGlossaryEntry> {
  const entry = await invokeMutation<SemanticGlossaryEntry>("save_semantic_entry", {
    id: params.id || null,
    connectionId: params.connectionId,
    database: params.database || null,
    term: params.term,
    definition: params.definition,
    kind: params.kind || "term",
    source: params.source || "agent",
  });
  invalidateSemanticGlossary(params.connectionId);
  return entry;
}
