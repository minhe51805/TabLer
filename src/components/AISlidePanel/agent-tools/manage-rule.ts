import { formatExecutionError } from "../../SQLEditor/SQLEditorUtils";
import {
  AI_REQUEST_REPLACED_MESSAGE,
  isSupersededAIRequestError,
} from "../ai-agent-action-requestor";
import { agentToolError, isRetryableAgentToolError } from "../agent-tool-executor-helpers";
import type { AgentRuleEvaluation } from "../ai-agent-rules";
import { getLinkedWorkspaceDir } from "../../../hooks/useLinkedFolders";
import { invokeMutation } from "../../../utils/tauri-utils";
import type { AgentToolModule } from "./shared";

/** Mirrors `MAX_RULE_NAME_CHARS` in agent_rules.rs (slug, 1-64 chars). */
const RULE_NAME_PATTERN = /^[a-z0-9_-]{1,64}$/;

export const tool: AgentToolModule = {
  name: "manage_rule",
  handler: async (ctx, args) => {
    const action = typeof args?.action === "string" ? args.action.trim() : "";
    if (!["list", "create"].includes(action)) {
      return agentToolError('manage_rule requires args.action: "list" or "create".');
    }
    // A superseded run must not write rule files.
    if (ctx.requestId !== ctx.requestIdRef.current) {
      throw new Error(AI_REQUEST_REPLACED_MESSAGE);
    }
    try {
      const workspaceDir = await getLinkedWorkspaceDir();

      if (action === "list") {
        const evaluation = await invokeMutation<AgentRuleEvaluation>("list_agent_rules", {
          workspaceDir,
        });
        const rules = evaluation.verdict.matched_rules;
        const lines = rules.map(
          (rule) => `- ${rule.name} [${rule.origin}, ${rule.action}]: ${rule.description}`,
        );
        const errors = evaluation.report.errors.map((entry) => `- ${entry.path}: ${entry.reason}`);
        return [
          rules.length > 0 ? `${rules.length} armed rule(s):` : "No guardrail rules are armed.",
          ...lines,
          ...(errors.length > 0 ? ["", "Files that failed to load:", ...errors] : []),
        ].join("\n");
      }

      // create
      const name = typeof args?.name === "string" ? args.name.trim() : "";
      const content = typeof args?.content === "string" ? args.content.trim() : "";
      if (!name || !RULE_NAME_PATTERN.test(name)) {
        return agentToolError(
          'manage_rule "create" requires args.name as a lowercase slug ([a-z0-9_-], 1-64 chars).',
        );
      }
      if (!content) {
        return agentToolError(
          'manage_rule "create" requires args.content — the full rule file (frontmatter + markdown body).',
          {
            hint: "Minimal shape:\n---\nname: <name>\ndescription: <why>\nenabled: true\nevent: pre_write\npattern: <regex>\naction: block\n---\n\n# <name>\n<explanation>",
          },
        );
      }
      // The backend refuses a frontmatter `name:` that disagrees with the file
      // stem — keep them in sync exactly like the rules manager form does. A
      // missing name line is injected after the opening `---` (or a fresh
      // frontmatter block is prepended) so the file always parses.
      let synced = content.replace(/\{name\}/g, name);
      if (/^name:\s*.*$/m.test(synced)) {
        synced = synced.replace(/^name:\s*.*$/m, `name: ${name}`);
      } else if (/^---\s*$/m.test(synced)) {
        synced = synced.replace(/^---\s*$/m, `---\nname: ${name}`);
      } else {
        synced = `---\nname: ${name}\n---\n\n${synced}`;
      }
      const path = await invokeMutation<string>("write_workspace_rule", {
        workspaceDir,
        name,
        content: synced,
      });
      return `Created guardrail rule "${name}" at ${path}. It is armed immediately — the rules engine evaluates it on the next read/write step.`;
    } catch (errorValue) {
      if (isSupersededAIRequestError(errorValue)) throw errorValue;
      return agentToolError(`manage_rule failed. ${formatExecutionError(errorValue)}`, {
        retryable: isRetryableAgentToolError(errorValue),
      });
    }
  },
};
