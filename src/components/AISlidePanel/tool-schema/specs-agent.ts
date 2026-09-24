import {
  AI_AGENT_ASK_USER_OPTIONS_LIMIT,
  AI_AGENT_BATCH_CALL_LIMIT,
  AI_AGENT_DELEGATE_FOCUS_TABLES_LIMIT,
  AI_AGENT_PLAN_STEP_LIMIT,
  type AIAgentToolName,
  type AIAgentToolSpec,
} from "./constants";
import { objectSchema, TOOL_ERROR_SHAPE_NOTE } from "./specs-shared";

export const SPECS: Partial<Record<AIAgentToolName, AIAgentToolSpec>> = {
  ask_user: {
    name: "ask_user",
    description:
      "Ask the user one concise clarifying question when the request is genuinely ambiguous and the answer changes what you would do.",
    parameters: objectSchema(
      {
        question: { type: "string", description: "One concise question." },
        options: {
          type: "array",
          items: { type: "string" },
          uniqueItems: true,
          maxItems: AI_AGENT_ASK_USER_OPTIONS_LIMIT,
          description:
            "Selectable answers rendered as quick-reply buttons. ALWAYS pass 2-4 short options as this array — never write the option list inside the question text.",
        },
        multiple: {
          type: "boolean",
          description: "Set true when the user may pick more than one option.",
        },
      },
      ["question"],
    ),
  },

  update_plan: {
    name: "update_plan",
    description:
      "Maintain a visible step checklist for multi-part requests. Post the full list once you know the shape of the work, then re-post it marking steps done/in_progress as you progress.",
    parameters: objectSchema(
      {
        steps: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "Short imperative step title." },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "done"],
                description: "Defaults to pending.",
              },
            },
            required: ["title"],
            additionalProperties: false,
          },
          minItems: 1,
          maxItems: AI_AGENT_PLAN_STEP_LIMIT,
          description: `The complete checklist, in order (up to ${AI_AGENT_PLAN_STEP_LIMIT} steps). Always send the FULL list — statuses replace the previous plan.`,
        },
      },
      ["steps"],
    ),
  },

  delegate: {
    name: "delegate",
    description:
      "Hand one focused, self-contained side question (a definition to recall, a formula to sanity-check, an interpretation to word) to a helper analysis and get a short text answer as your observation. The helper sees the schema context but runs NO tools — keep the instruction self-contained and never delegate data fetching you can do with your own tools.",
    parameters: objectSchema(
      {
        instruction: {
          type: "string",
          description: "The complete side question, answerable from the schema context alone.",
        },
        focusTables: {
          type: "array",
          items: { type: "string" },
          uniqueItems: true,
          maxItems: AI_AGENT_DELEGATE_FOCUS_TABLES_LIMIT,
          description: "Optional verified tables the question is about.",
        },
      },
      ["instruction"],
    ),
  },

  skill: {
    name: "skill",
    description:
      "Load the full instructions of an available Agent Skill. Pick the name from the <available_skills> list when the task matches a skill's description, then follow the returned instructions before continuing.",
    parameters: objectSchema(
      {
        name: {
          type: "string",
          description: "Skill name exactly as listed in <available_skills>.",
        },
      },
      ["name"],
    ),
  },

  read_skill_resource: {
    name: "read_skill_resource",
    description:
      "Load one bundled reference file of a skill you have already loaded (progressive disclosure). Pick a path from that skill's 'Bundled resources' list — only references/ and scripts/ files are readable, and only for a skill loaded this run. Use this to pull detailed schemas, docs, or scripts on demand instead of re-deriving them.",
    parameters: objectSchema(
      {
        name: {
          type: "string",
          description:
            "Skill name whose resource to read (must be loaded via the skill tool first).",
        },
        path: {
          type: "string",
          description: "Relative resource path exactly as listed, e.g. references/schema.md.",
        },
      },
      ["name", "path"],
    ),
  },

  manage_skill: {
    name: "manage_skill",
    description:
      "Manage Agent Skills: list the catalog, update a global skill's description/body/version/allowedTools, or enable/disable a skill for future runs. Only global skills are editable — workspace skills live in the user's repository and are read-only by design. There is no delete: the backend has no delete command, so tell the user to remove the skill folder manually if they ask." +
      TOOL_ERROR_SHAPE_NOTE,
    parameters: objectSchema(
      {
        action: {
          type: "string",
          enum: ["list", "update", "enable", "disable"],
          description: "Which skill operation to perform.",
        },
        name: {
          type: "string",
          description: "Skill name exactly as listed (required for update/enable/disable).",
        },
        description: {
          type: "string",
          description: "update: new one-line description.",
        },
        body: {
          type: "string",
          description: "update: new SKILL.md body (the instructions).",
        },
        version: {
          type: "string",
          description: "update: new version string.",
        },
        allowedTools: {
          type: "array",
          items: { type: "string" },
          description:
            "update: replacement allowed-tools list (tool names the skill may use). Omit to keep the stored list.",
        },
      },
      ["action"],
    ),
  },

  manage_rule: {
    name: "manage_rule",
    description:
      "Manage guardrail rules that evaluate agent SQL before it runs. list shows the armed rules (name, action, origin) and any files that failed to load; create writes a new rule file into the linked workspace folder's rules/ directory (or the global rules root when no folder is linked). content must be a complete rule file: frontmatter (name, description, event, pattern, action) plus a markdown body. create refuses to overwrite an existing rule — there is no update or delete; the user edits rule files manually." +
      TOOL_ERROR_SHAPE_NOTE,
    parameters: objectSchema(
      {
        action: {
          type: "string",
          enum: ["list", "create"],
          description: "Which rule operation to perform.",
        },
        name: {
          type: "string",
          description:
            "create: rule file name — lowercase slug [a-z0-9_-], 1-64 chars; must match the frontmatter name.",
        },
        content: {
          type: "string",
          description:
            "create: full rule file text (frontmatter + body). The frontmatter name is synced to args.name automatically.",
        },
      },
      ["action"],
    ),
  },

  batch: {
    name: "batch",
    description:
      `Run several independent tool calls in ONE step (up to ${AI_AGENT_BATCH_CALL_LIMIT}). Read-only calls (list_tables, search_schema, list_schema_objects, describe_table, sample_table_data, run_readonly_sql, run_parameterized_sql, find_value, check_sql, run_preset, read_memory, read_skill_resource) execute in parallel; write/proposal calls (preview_write, edit_query_sql, propose_seed_data, create_checkpoint, restore_checkpoint, remember_term, save_memory, delete_memory) run one at a time in array order. Results come back in the same order as args.calls. finish, ask_user, update_plan, delegate, skill and nested batch are not allowed inside a batch.` +
      TOOL_ERROR_SHAPE_NOTE,
    parameters: objectSchema(
      {
        calls: {
          type: "array",
          minItems: 2,
          maxItems: AI_AGENT_BATCH_CALL_LIMIT,
          items: { type: "object" },
          description:
            'Tool calls as {"action":"<tool name>","args":{…}} objects — same names and args as calling the tools directly.',
        },
      },
      ["calls"],
    ),
  },

  finish: {
    name: "finish",
    description:
      "End the run with the final answer for the user. args.response is REQUIRED: it must contain the complete user-facing answer (a full markdown table when a report, bảng, tổng hợp, or list was requested) built from verified observations — never an empty string or a one-line placeholder. Put the single best runnable SELECT in sql, and the dashboard widgets in metricsWidgets when the request is a metrics board — exactly the cards the user asked for, never padded with extras.",
    parameters: {
      type: "object",
      properties: {
        response: {
          type: "string",
          description:
            "REQUIRED. Complete markdown answer for the user, grounded in the observations collected this run.",
        },
        sql: { type: "string", description: "Optional grounded SQL for later human approval." },
        metricsWidgets: {
          type: "array",
          minItems: 1,
          maxItems: 6,
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "Widget heading." },
              type: {
                type: "string",
                enum: [
                  "table",
                  "scoreboard",
                  "bar",
                  "horizontal-bar",
                  "line",
                  "area",
                  "pie",
                  "donut",
                  "radial",
                ],
                description: "Widget kind; unknown kinds fall back to table.",
              },
              query: { type: "string", description: "Grounded SELECT feeding this widget." },
              dimension: { type: "string", description: "Label column returned by the query." },
              measures: {
                type: "array",
                items: { type: "string" },
                description: "Numeric value columns or aliases from the query.",
              },
              transforms: {
                type: "array",
                items: { type: "string" },
                description: "Group/sort operations.",
              },
              limit: { type: "integer", minimum: 1, description: "Max rows for the widget." },
            },
            required: ["title", "type", "query"],
            additionalProperties: false,
          },
          description:
            "Optional dashboard widgets. Match the user's request exactly — same count, same cards; pick a sensible set only when the request leaves the contents open.",
        },
      },
      // finish carries a flexible payload consumed by the finalizer, so extra
      // keys are permitted rather than rejected.
      additionalProperties: true,
    },
  },
};
