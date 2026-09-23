import { invokeMutation } from "../../../utils/tauri-utils";

export interface AgentMemoryIndexEntry {
  name: string;
  description: string;
  updatedAt: string;
}

// Agent-memory index cache: memory reads must be scope-faithful, so the cache
// key carries the (connection, database) pair instead of a global slot.
let memoryIndexCache: {
  at: number;
  key: string;
  entries: AgentMemoryIndexEntry[];
} | null = null;

const MEMORY_INDEX_TTL_MS = 60_000;

export function invalidateAgentMemoryIndex(connectionId?: string) {
  if (!connectionId) {
    memoryIndexCache = null;
    return;
  }
  if (memoryIndexCache?.key.startsWith(`${connectionId}::`)) {
    memoryIndexCache = null;
  }
}

/**
 * Frontmatter-only memory index for THIS (connection, database) scope — same
 * progressive-disclosure contract as skills. Bodies load through read_memory;
 * new durable facts are saved via save_memory.
 *
 * Three distinct results, because the prompt must not confuse them:
 *  - `undefined`: workspace tools are off — inject nothing at all.
 *  - `null`: the backend read FAILED — the store may hold memories the agent
 *    cannot see, so the prompt must say "unavailable", never "no memories
 *    exist" (which would invite save_memory over an unread store).
 *  - an array (possibly empty): the real index for this scope.
 */
export async function getAgentMemoryIndex(params: {
  workspaceToolsEnabled: boolean;
  connectionId: string | null;
  database: string | null;
}): Promise<AgentMemoryIndexEntry[] | null | undefined> {
  if (!params.workspaceToolsEnabled) return undefined;
  const scopeKey = `${params.connectionId ?? "global"}::${params.database ?? "default"}`;
  if (
    memoryIndexCache &&
    memoryIndexCache.key === scopeKey &&
    Date.now() - memoryIndexCache.at < MEMORY_INDEX_TTL_MS
  ) {
    return memoryIndexCache.entries;
  }
  try {
    const entries = await invokeMutation<AgentMemoryIndexEntry[]>("list_agent_memory", {
      connectionId: params.connectionId,
      database: params.database,
    });
    memoryIndexCache = { at: Date.now(), key: scopeKey, entries };
    return entries;
  } catch (error) {
    console.warn("[AIWorkspace] memory index unavailable:", error);
    // Not cached: the next run retries the backend instead of pinning the
    // failure for the whole TTL window.
    return null;
  }
}
