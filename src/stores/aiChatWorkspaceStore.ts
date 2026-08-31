import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * User-managed AI chat workspace ("player bao bên ngoài").
 * A workspace groups chat threads and carries its own durable context digest,
 * so conversations for one database/task never leak context into another.
 */
export interface AIChatWorkspace {
  id: string;
  name: string;
  /** Connection this workspace was created for; informational binding. */
  connectionId: string | null;
  /**
   * Database this workspace was created on. Selecting the workspace switches
   * the active connection to this database so the AI schema context (tables,
   * schema objects, live reads) always follows the workspace — like separate
   * SSMS windows, one per database.
   */
  database: string | null;
  createdAt: number;
  updatedAt: number;
  /** Durable summary produced by /compact — injected into every request. */
  contextDigest: string;
  contextUpdatedAt: number | null;
}

export const AI_CHAT_WORKSPACE_STORAGE_KEY = "tabler.ai.chat-workspaces.v1";

export function createAIChatWorkspaceId() {
  return globalThis.crypto?.randomUUID?.()
    ?? `ws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

interface AIChatWorkspaceState {
  workspaces: AIChatWorkspace[];
  /** null = auto mode: threads follow the active connection + database key. */
  activeWorkspaceId: string | null;
  createWorkspace: (name: string, connectionId?: string | null, database?: string | null) => string;
  renameWorkspace: (id: string, name: string) => void;
  deleteWorkspace: (id: string) => void;
  setActiveWorkspace: (id: string | null) => void;
  /** Pins a database to a workspace (also used to backfill legacy workspaces). */
  bindWorkspaceDatabase: (id: string, database: string) => void;
  saveContextDigest: (id: string, digest: string) => void;
  /**
   * Merges digests persisted in the SQLite cache back into the store after a
   * restart. Only applies entries newer than what the store already holds.
   */
  hydrateDigests: (entries: { workspaceId: string; digest: string; updatedAt: number }[]) => void;
}

export const useAIChatWorkspaceStore = create<AIChatWorkspaceState>()(
  persist(
    (set) => ({
      workspaces: [],
      activeWorkspaceId: null,

      createWorkspace: (name, connectionId = null, database = null) => {
        const id = createAIChatWorkspaceId();
        const now = Date.now();
        set((state) => ({
          workspaces: [
            ...state.workspaces,
            {
              id,
              name: name.trim() || `Workspace ${state.workspaces.length + 1}`,
              connectionId: connectionId ?? null,
              database: database ?? null,
              createdAt: now,
              updatedAt: now,
              contextDigest: "",
              contextUpdatedAt: null,
            },
          ],
          activeWorkspaceId: id,
        }));
        return id;
      },

      renameWorkspace: (id, name) => {
        const trimmed = name.trim();
        if (!trimmed) return;
        set((state) => ({
          workspaces: state.workspaces.map((workspace) => (
            workspace.id === id
              ? { ...workspace, name: trimmed, updatedAt: Date.now() }
              : workspace
          )),
        }));
      },

      deleteWorkspace: (id) => {
        set((state) => {
          const remaining = state.workspaces.filter((workspace) => workspace.id !== id);
          return {
            workspaces: remaining,
            activeWorkspaceId: state.activeWorkspaceId === id
              ? (remaining[0]?.id ?? null)
              : state.activeWorkspaceId,
          };
        });
      },

      setActiveWorkspace: (id) => {
        set({ activeWorkspaceId: id });
      },

      /** Pin a workspace to a database; empty string = unbind (auto mode). */
      bindWorkspaceDatabase: (id, database) => {
        const clean = database.trim();
        const nextDatabase = clean || null;
        set((state) => {
          const changed = state.workspaces.some(
            (workspace) => workspace.id === id && workspace.database !== nextDatabase,
          );
          if (!changed) return state;
          return {
            workspaces: state.workspaces.map((workspace) => {
              if (workspace.id !== id) return workspace;
              const rebound = workspace.database !== nextDatabase;
              return {
                ...workspace,
                database: nextDatabase,
                updatedAt: Date.now(),
                // A stale digest summarises the OLD database's context; keeping
                // it after a rebind would poison every future request with
                // schema facts from a database this workspace no longer owns.
                ...(rebound ? { contextDigest: "", contextUpdatedAt: null } : {}),
              };
            }),
          };
        });
      },

      saveContextDigest: (id, digest) => {
        const clean = digest.trim();
        if (!clean) return;
        set((state) => ({
          workspaces: state.workspaces.map((workspace) => (
            workspace.id === id
              ? { ...workspace, contextDigest: clean, contextUpdatedAt: Date.now(), updatedAt: Date.now() }
              : workspace
          )),
        }));
      },

      hydrateDigests: (entries) => {
        set((state) => {
          let changed = false;
          const workspaces = state.workspaces.map((workspace) => {
            const entry = entries.find((candidate) => candidate.workspaceId === workspace.id);
            if (!entry) return workspace;
            const currentUpdatedAt = workspace.contextUpdatedAt ?? 0;
            const digest = entry.digest.trim();
            if (!digest || entry.updatedAt <= currentUpdatedAt) return workspace;
            if (workspace.contextDigest === digest) {
              return workspace.contextUpdatedAt === entry.updatedAt
                ? workspace
                : { ...workspace, contextUpdatedAt: entry.updatedAt };
            }
            changed = true;
            return { ...workspace, contextDigest: digest, contextUpdatedAt: entry.updatedAt };
          });
          return changed ? { workspaces } : state;
        });
      },
    }),
    {
      name: AI_CHAT_WORKSPACE_STORAGE_KEY,
    },
  ),
);

/** Convenience selector: the active workspace object (or null in auto mode). */
export function selectActiveAIChatWorkspace(state: Pick<AIChatWorkspaceState, "workspaces" | "activeWorkspaceId">): AIChatWorkspace | null {
  if (!state.activeWorkspaceId) return null;
  return state.workspaces.find((workspace) => workspace.id === state.activeWorkspaceId) ?? null;
}

/**
 * Legacy workspaces were created before database binding existed; users named
 * them after their database (e.g. "db QL_BAN_HANG"). Match the name against
 * the connection's database catalog so switching those workspaces still
 * re-scopes the AI context to the right database.
 */
export function inferDatabaseFromWorkspaceName(
  name: string,
  availableDatabases: readonly { name: string }[],
): string | null {
  const cleaned = name.trim().toLowerCase();
  if (!cleaned || availableDatabases.length === 0) return null;
  const stripped = cleaned.replace(/^db\s+/, "");
  const exact = availableDatabases.find(
    (database) => database.name.toLowerCase() === stripped,
  );
  if (exact) return exact.name;
  const containing = availableDatabases.filter(
    (database) => cleaned.includes(database.name.toLowerCase()),
  );
  return containing.length === 1 ? containing[0].name : null;
}

/** Test/export helper mirroring the store's default naming. */
export function defaultWorkspaceName(existingCount: number) {
  return `Workspace ${existingCount + 1}`;
}
