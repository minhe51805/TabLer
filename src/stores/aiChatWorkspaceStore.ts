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
  createWorkspace: (name: string, connectionId?: string | null) => string;
  renameWorkspace: (id: string, name: string) => void;
  deleteWorkspace: (id: string) => void;
  setActiveWorkspace: (id: string | null) => void;
  saveContextDigest: (id: string, digest: string) => void;
}

export const useAIChatWorkspaceStore = create<AIChatWorkspaceState>()(
  persist(
    (set) => ({
      workspaces: [],
      activeWorkspaceId: null,

      createWorkspace: (name, connectionId = null) => {
        const id = createAIChatWorkspaceId();
        const now = Date.now();
        set((state) => ({
          workspaces: [
            ...state.workspaces,
            {
              id,
              name: name.trim() || `Workspace ${state.workspaces.length + 1}`,
              connectionId: connectionId ?? null,
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

/** Test/export helper mirroring the store's default naming. */
export function defaultWorkspaceName(existingCount: number) {
  return `Workspace ${existingCount + 1}`;
}
