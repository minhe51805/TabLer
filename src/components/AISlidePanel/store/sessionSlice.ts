import type { Dispatch, SetStateAction } from "react";
import type { StateCreator } from "zustand";
import type { AIChatThread } from "../ai-conversation-state";
import {
  isAIWorkspaceAgentAutonomy,
  type AIWorkspaceAgentAutonomy,
  type AIWorkspaceBubbleData,
  type AIWorkspaceInteractionMode,
} from "../ai-workspace-types";

export const AI_WORKSPACE_AGENT_AUTONOMY_STORAGE_KEY = "tabler.ai.workspace.agentAutonomy.v1";

function applyUpdater<T>(current: T, updater: SetStateAction<T>): T {
  return typeof updater === "function" ? (updater as (prev: T) => T)(current) : updater;
}

export function loadPersistedWorkspaceAgentAutonomy(): Record<string, AIWorkspaceAgentAutonomy> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(AI_WORKSPACE_AGENT_AUTONOMY_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== "object") return {};
    const result: Record<string, AIWorkspaceAgentAutonomy> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (isAIWorkspaceAgentAutonomy(value)) {
        result[key] = value;
      }
    }
    return result;
  } catch {
    return {};
  }
}

function persistWorkspaceAgentAutonomy(map: Record<string, AIWorkspaceAgentAutonomy>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(AI_WORKSPACE_AGENT_AUTONOMY_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Ignore storage write failures (private mode, quota, etc.).
  }
}

export interface SessionSlice {
  historyHydrated: boolean;
  bubbles: AIWorkspaceBubbleData[];
  chatThreads: AIChatThread[];
  workspaceInteractionModes: Record<string, AIWorkspaceInteractionMode>;
  workspaceAgentAutonomy: Record<string, AIWorkspaceAgentAutonomy>;
  activeThreadIdsByWorkspace: Record<string, string>;
  activeThreadId: string;
  isHistoryOpen: boolean;
  deleteThreadPending: string | null;

  setHistoryHydrated: Dispatch<SetStateAction<boolean>>;
  setBubbles: Dispatch<SetStateAction<AIWorkspaceBubbleData[]>>;
  setChatThreads: Dispatch<SetStateAction<AIChatThread[]>>;
  setWorkspaceInteractionModes: Dispatch<
    SetStateAction<Record<string, AIWorkspaceInteractionMode>>
  >;
  setWorkspaceAgentAutonomy: Dispatch<SetStateAction<Record<string, AIWorkspaceAgentAutonomy>>>;
  setActiveThreadIdsByWorkspace: Dispatch<SetStateAction<Record<string, string>>>;
  setActiveThreadId: Dispatch<SetStateAction<string>>;
  setIsHistoryOpen: Dispatch<SetStateAction<boolean>>;
  setDeleteThreadPending: Dispatch<SetStateAction<string | null>>;
}

export function getInitialSessionState() {
  return {
    historyHydrated: false,
    bubbles: [] as AIWorkspaceBubbleData[],
    chatThreads: [] as AIChatThread[],
    workspaceInteractionModes: {} as Record<string, AIWorkspaceInteractionMode>,
    workspaceAgentAutonomy: loadPersistedWorkspaceAgentAutonomy(),
    activeThreadIdsByWorkspace: {} as Record<string, string>,
    activeThreadId: "",
    isHistoryOpen: false,
    deleteThreadPending: null as string | null,
  };
}

export const createSessionSlice: StateCreator<SessionSlice, [], [], SessionSlice> = (set) => ({
  ...getInitialSessionState(),

  setHistoryHydrated: (updater) =>
    set((state) => {
      const next = applyUpdater(state.historyHydrated, updater);
      return next === state.historyHydrated ? state : { historyHydrated: next };
    }),

  setBubbles: (updater) =>
    set((state) => {
      const next = applyUpdater(state.bubbles, updater);
      return next === state.bubbles ? state : { bubbles: next };
    }),

  setChatThreads: (updater) =>
    set((state) => {
      const next = applyUpdater(state.chatThreads, updater);
      return next === state.chatThreads ? state : { chatThreads: next };
    }),

  setWorkspaceInteractionModes: (updater) =>
    set((state) => {
      const next = applyUpdater(state.workspaceInteractionModes, updater);
      return next === state.workspaceInteractionModes ? state : { workspaceInteractionModes: next };
    }),

  setWorkspaceAgentAutonomy: (updater) =>
    set((state) => {
      const next = applyUpdater(state.workspaceAgentAutonomy, updater);
      if (next === state.workspaceAgentAutonomy) return state;
      persistWorkspaceAgentAutonomy(next);
      return { workspaceAgentAutonomy: next };
    }),

  setActiveThreadIdsByWorkspace: (updater) =>
    set((state) => {
      const next = applyUpdater(state.activeThreadIdsByWorkspace, updater);
      return next === state.activeThreadIdsByWorkspace
        ? state
        : { activeThreadIdsByWorkspace: next };
    }),

  setActiveThreadId: (updater) =>
    set((state) => {
      const next = applyUpdater(state.activeThreadId, updater);
      return next === state.activeThreadId ? state : { activeThreadId: next };
    }),

  setIsHistoryOpen: (updater) =>
    set((state) => {
      const next = applyUpdater(state.isHistoryOpen, updater);
      return next === state.isHistoryOpen ? state : { isHistoryOpen: next };
    }),

  setDeleteThreadPending: (updater) =>
    set((state) => {
      const next = applyUpdater(state.deleteThreadPending, updater);
      return next === state.deleteThreadPending ? state : { deleteThreadPending: next };
    }),
});
