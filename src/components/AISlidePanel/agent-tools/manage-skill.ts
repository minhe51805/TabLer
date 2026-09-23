import { formatExecutionError } from "../../SQLEditor/SQLEditorUtils";
import {
  AI_REQUEST_REPLACED_MESSAGE,
  isSupersededAIRequestError,
} from "../ai-agent-action-requestor";
import { agentToolError, isRetryableAgentToolError } from "../agent-tool-executor-helpers";
import { useSkillPrefsStore } from "../../../stores/skillPrefsStore";
import { getLinkedWorkspaceDir } from "../../../hooks/useLinkedFolders";
import { invokeMutation } from "../../../utils/tauri-utils";
import type { AgentToolModule } from "./shared";

/** What `read_ai_skill` returns (camelCase over the wire). */
interface AgentSkillContent {
  name: string;
  description: string;
  source: string;
  body: string;
  version: string | null;
  allowedTools: string[];
  updatedAt: number | null;
}

export const tool: AgentToolModule = {
  name: "manage_skill",
  handler: async (ctx, args) => {
    const action = typeof args?.action === "string" ? args.action.trim() : "";
    if (!["list", "update", "enable", "disable"].includes(action)) {
      return agentToolError(
        'manage_skill requires args.action: "list", "update", "enable", or "disable".',
      );
    }
    const name = typeof args?.name === "string" ? args.name.trim() : "";
    if (action !== "list" && !name) {
      return agentToolError(`manage_skill "${action}" requires args.name — the exact skill name.`);
    }
    // A superseded run must not write skill files or prefs.
    if (ctx.requestId !== ctx.requestIdRef.current) {
      throw new Error(AI_REQUEST_REPLACED_MESSAGE);
    }
    try {
      const workspaceDir = await getLinkedWorkspaceDir();

      if (action === "list") {
        const report = await invokeMutation<{
          skills: Array<{
            name: string;
            description: string;
            source: string;
            version: string | null;
          }>;
          errors?: { path: string; reason: string }[];
        }>("list_ai_skills", { workspaceDir });
        const entries = report.skills ?? [];
        if (!entries.length) {
          return "No Agent Skills are installed.";
        }
        const prefs = useSkillPrefsStore.getState();
        const lines = entries.map(
          (entry) =>
            `- ${entry.name} [${entry.source}${prefs.isEnabled(entry.name) ? "" : ", disabled"}]${entry.version ? ` v${entry.version}` : ""}: ${entry.description}`,
        );
        const errorLines = (report.errors ?? []).map((entry) => `- ${entry.path}: ${entry.reason}`);
        return [
          `${entries.length} skill(s):`,
          ...lines,
          ...(errorLines.length > 0 ? ["", "Failed to load:", ...errorLines] : []),
        ].join("\n");
      }

      // Resolve the skill first so enable/disable/update fail on typos and so
      // update can enforce the global-only write contract.
      const content = await invokeMutation<AgentSkillContent>("read_ai_skill", {
        workspaceDir,
        name,
      });

      if (action === "enable" || action === "disable") {
        const enabled = action === "enable";
        useSkillPrefsStore.getState().setEnabled(content.name, enabled);
        return `Skill "${content.name}" ${enabled ? "enabled" : "disabled"}. ${enabled ? "It is eligible for future runs again." : "Future runs will not see it in the skills catalog."}`;
      }

      // update — global skills only: workspace skills are files inside the
      // user's own repository and the app must not rewrite them (the backend
      // command only writes the global root anyway).
      if (content.source !== "global") {
        return agentToolError(
          `Skill "${content.name}" is a ${content.source} skill — only global skills are editable. Workspace skills live in the user's repository; edit the file there directly.`,
        );
      }
      const description = typeof args?.description === "string" ? args.description.trim() : "";
      const body = typeof args?.body === "string" ? args.body.trim() : "";
      const version = typeof args?.version === "string" ? args.version.trim() : "";
      const allowedTools = Array.isArray(args?.allowedTools)
        ? args.allowedTools.filter((entry): entry is string => typeof entry === "string")
        : null;
      if (!description && !body && !version && allowedTools === null) {
        return agentToolError(
          'manage_skill "update" needs at least one field to change: description, body, version, or allowedTools.',
        );
      }
      const path = await invokeMutation<string>("update_ai_skill", {
        name: content.name,
        description: description || null,
        body: body || null,
        version: version || null,
        // null keeps the stored list (backend treats absent as unchanged).
        allowedTools,
        // Metadata the tool does not own: null round-trips to "keep stored".
        license: null,
        model: null,
        effort: null,
        // Optimistic concurrency: refuse the save when the file changed since
        // this read instead of clobbering an external edit.
        expectedUpdatedAt: content.updatedAt,
      });
      return `Updated skill "${content.name}" at ${path}.`;
    } catch (errorValue) {
      if (isSupersededAIRequestError(errorValue)) throw errorValue;
      return agentToolError(`manage_skill failed. ${formatExecutionError(errorValue)}`, {
        retryable: isRetryableAgentToolError(errorValue),
      });
    }
  },
};
