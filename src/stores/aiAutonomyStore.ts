import { create } from "zustand";
import type { AIWorkspaceAgentAutonomy } from "../components/AISlidePanel/ai-workspace-types";

/**
 * Mirror of the AI panel's per-workspace agent autonomy selection, keyed by
 * the ACTIVE CONNECTION the panel is attached to. The SQL editor lives
 * outside the AI panel, so AI-origin tabs look up their own connectionId to
 * decide whether "full autonomy" (a standing human approval) should let a
 * blocked Safe Mode statement run without the confirmation dialog. Keying by
 * connection keeps one workspace's grant from leaking into tabs on another
 * connection.
 */
interface AIAutonomyState {
  autonomyByConnection: Record<string, AIWorkspaceAgentAutonomy>;
  setAutonomy: (connectionId: string, autonomy: AIWorkspaceAgentAutonomy) => void;
  getAutonomy: (connectionId: string) => AIWorkspaceAgentAutonomy;
}

export const useAIAutonomyStore = create<AIAutonomyState>((set, get) => ({
  autonomyByConnection: {},
  setAutonomy: (connectionId, autonomy) =>
    set((state) => {
      if (state.autonomyByConnection[connectionId] === autonomy) return state;
      return {
        autonomyByConnection: { ...state.autonomyByConnection, [connectionId]: autonomy },
      };
    }),
  getAutonomy: (connectionId) => get().autonomyByConnection[connectionId] ?? "review",
}));