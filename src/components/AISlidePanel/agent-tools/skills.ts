import { formatExecutionError } from "../../SQLEditor/SQLEditorUtils";
import { isSupersededAIRequestError } from "../ai-agent-action-requestor";
import { AI_AGENT_TOOL_NAMES, type AIAgentToolName } from "../ai-agent-tools";
import { agentToolError, isRetryableAgentToolError } from "../agent-tool-executor-helpers";
import { useSkillUsageStore } from "../../../stores/skillUsageStore";
import { invokeMutation } from "../../../utils/tauri-utils";
import type { AgentToolModule } from "./shared";

// Matches the backend ceiling in ai_skills.rs (MAX_SKILL_BODY_CHARS = 8_000).
// The backend truncates authoritatively; this FE check is a redundant backstop
// so the two layers must not drift apart again.
const AI_SKILL_BODY_MAX_CHARS = 8_000;
// Matches ai_skills.rs (MAX_SKILL_RESOURCE_CHARS = 12_000) — same drift guard.
const AI_SKILL_RESOURCE_MAX_CHARS = 12_000;

export const tools: AgentToolModule[] = [
  {
    name: "skill",
    handler: async (ctx, args) => {
      const skillName = typeof args?.name === "string" ? args.name.trim() : "";
      if (!skillName) {
        return agentToolError("skill requires args.name taken from the <available_skills> list.", {
          hint: "Send args.name exactly as listed in <available_skills>.",
        });
      }
      // Fail-closed: only names injected in this run's catalog may load.
      if (!ctx.allowedSkillNames?.includes(skillName)) {
        return agentToolError(
          `skill "${skillName}" is not in the injected <available_skills> catalog. Pick one of the listed skills.`,
          { hint: `Available skills: ${(ctx.allowedSkillNames ?? []).join(", ") || "none"}.` },
        );
      }
      try {
        const content = await invokeMutation<{
          name: string;
          body: string;
          allowedTools?: string[];
          resources?: string[];
          version?: string | null;
        }>("read_ai_skill", {
          name: skillName,
        });
        const loadedName = content.name || skillName;
        window.dispatchEvent(
          new CustomEvent("workspace-activity", {
            detail: {
              connectionId: ctx.connectionId,
              label: `Skill: ${content.name}`,
              durationMs: 0,
            },
          }),
        );
        useSkillUsageStore.getState().recordSkillRun(loadedName, ctx.connectionId);
        // Register bundled resources so read_skill_resource stays fail-closed:
        // only paths this skill listed may be pulled on demand.
        const resources = Array.isArray(content.resources)
          ? content.resources.filter((entry): entry is string => typeof entry === "string")
          : [];
        ctx.loadedSkillResources.set(loadedName, new Set(resources));
        // allowed-tools: confine the rest of the run to the declared tools that
        // actually exist. An unknown name is ignored so a typo can't brick a run.
        const allowedTools = (
          Array.isArray(content.allowedTools) ? content.allowedTools : []
        ).filter(
          (entry): entry is AIAgentToolName =>
            typeof entry === "string" && (AI_AGENT_TOOL_NAMES as readonly string[]).includes(entry),
        );
        if (allowedTools.length > 0) {
          if (!ctx.skillToolRestriction) ctx.skillToolRestriction = new Set<AIAgentToolName>();
          for (const toolName of allowedTools) ctx.skillToolRestriction.add(toolName);
        }
        // Soft cost ceiling: a huge skill file would otherwise be re-injected
        // into the prompt on every remaining run step.
        const rawBody = content.body ?? "";
        const body =
          rawBody.length > AI_SKILL_BODY_MAX_CHARS
            ? `${rawBody.slice(0, AI_SKILL_BODY_MAX_CHARS)}\n\n[Body cut at ${AI_SKILL_BODY_MAX_CHARS} characters — the skill file is larger. Follow the instructions above; ask the user to trim the skill if a needed section is missing.]`
            : rawBody;
        const resourceNote =
          resources.length > 0
            ? [
                "",
                `Bundled resources — load on demand with read_skill_resource, args {"name":"${loadedName}","path":"<one below>"}:`,
                ...resources.map((entry) => `- ${entry}`),
              ].join("\n")
            : "";
        const restrictionNote =
          allowedTools.length > 0
            ? `\n\n[This skill restricts tools to: ${allowedTools.join(", ")} (plus finish, ask_user, update_plan, read_page, skill, read_skill_resource). Other tools are disabled for the rest of the run.]`
            : "";
        return [
          `Skill "${content.name}" loaded. Follow these instructions for the remainder of the run:`,
          "",
          body,
          resourceNote,
          restrictionNote,
        ]
          .filter((part) => part !== "")
          .join("\n");
      } catch (errorValue) {
        if (isSupersededAIRequestError(errorValue)) throw errorValue;
        return agentToolError(
          `could not load skill "${skillName}": ${formatExecutionError(errorValue)}`,
          {
            retryable: isRetryableAgentToolError(errorValue),
          },
        );
      }
    },
  },
  {
    name: "read_skill_resource",
    handler: async (ctx, args) => {
      const skillName = typeof args?.name === "string" ? args.name.trim() : "";
      const resourcePath = typeof args?.path === "string" ? args.path.trim() : "";
      if (!skillName || !resourcePath) {
        return agentToolError(
          "read_skill_resource requires args.name and args.path taken from a loaded skill's Bundled resources list.",
          {
            hint: "Send args.name (a skill loaded this run) and args.path (one of its listed resources).",
          },
        );
      }
      // Fail-closed: the skill must have been loaded this run and the path must
      // be one it listed — mirrors the skill tool's injected-catalog guarantee.
      const known = ctx.loadedSkillResources.get(skillName);
      if (!known) {
        return agentToolError(
          `skill "${skillName}" is not loaded this run. Call the skill tool first, then read one of its listed resources.`,
          {
            hint: `Loaded skills this run: ${[...ctx.loadedSkillResources.keys()].join(", ") || "none"}.`,
          },
        );
      }
      if (!known.has(resourcePath)) {
        return agentToolError(
          `"${resourcePath}" is not a listed resource of skill "${skillName}". Pick a path from that skill's Bundled resources list.`,
          { hint: `Listed resources: ${[...known].join(", ") || "none"}.` },
        );
      }
      try {
        const resource = await invokeMutation<{
          name: string;
          resource: string;
          content: string;
        }>("read_ai_skill_resource", { name: skillName, resource: resourcePath });
        window.dispatchEvent(
          new CustomEvent("workspace-activity", {
            detail: {
              connectionId: ctx.connectionId,
              label: `Skill resource: ${resource.resource}`,
              durationMs: 0,
            },
          }),
        );
        const rawContent = resource.content ?? "";
        const clipped =
          rawContent.length > AI_SKILL_RESOURCE_MAX_CHARS
            ? `${rawContent.slice(0, AI_SKILL_RESOURCE_MAX_CHARS)}\n\n[Resource cut at ${AI_SKILL_RESOURCE_MAX_CHARS} characters — the file is larger.]`
            : rawContent;
        return [`Resource "${resource.resource}" of skill "${skillName}":`, "", clipped].join("\n");
      } catch (errorValue) {
        if (isSupersededAIRequestError(errorValue)) throw errorValue;
        return agentToolError(
          `could not load resource "${resourcePath}" of skill "${skillName}": ${formatExecutionError(errorValue)}`,
          { retryable: isRetryableAgentToolError(errorValue) },
        );
      }
    },
  },
];
