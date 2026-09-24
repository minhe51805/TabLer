import { type AIAgentToolName, type AIAgentToolSpec } from "./constants";
import { objectSchema, TOOL_ERROR_SHAPE_NOTE } from "./specs-shared";

export const SPECS: Partial<Record<AIAgentToolName, AIAgentToolSpec>> = {
  remember_term: {
    name: "remember_term",
    description:
      "Persist a business term/metric/relationship/alias to the glossary so future runs on this database see it automatically.",
    parameters: objectSchema(
      {
        term: { type: "string", description: "The term being defined." },
        definition: { type: "string", description: "Its verified definition." },
        kind: {
          type: "string",
          enum: ["term", "metric", "relationship", "alias"],
          description: "Category of the entry.",
        },
      },
      ["term", "definition"],
    ),
  },

  read_memory: {
    name: "read_memory",
    description:
      "Load the full text of one entry from the <agent_memory> index (saved observations for this connection/database). Use it when an index entry looks relevant before acting on it.",
    parameters: objectSchema(
      {
        name: {
          type: "string",
          description: "Entry name exactly as listed in <agent_memory>.",
        },
      },
      ["name"],
    ),
  },

  save_memory: {
    name: "save_memory",
    description:
      "Persist one durable, non-obvious fact for this connection/database (conventions, verified quirks, table roles, user-stated preferences). Overwrites an entry with the same name. NEVER store credentials or secrets. Keep it under 8000 characters.",
    parameters: objectSchema(
      {
        name: {
          type: "string",
          description: "Short slug for the fact (letters, digits, '-', '_', '.').",
        },
        description: {
          type: "string",
          description: "One-line summary shown in the index (max 200 chars).",
        },
        body: {
          type: "string",
          description: "The fact itself, in full sentences a future run can act on.",
        },
      },
      ["name", "body"],
    ),
  },

  delete_memory: {
    name: "delete_memory",
    description:
      "Permanently delete ONE memory entry by its exact name — use when the index is full and an entry is obsolete, or when the user asks to forget something. This cannot be undone. Confirm with the user before deleting an entry you did not write this run.",
    parameters: objectSchema(
      {
        name: {
          type: "string",
          description: "Entry name exactly as listed in <agent_memory>.",
        },
      },
      ["name"],
    ),
  },

  manage_metrics_widget: {
    name: "manage_metrics_widget",
    description:
      "Manage widgets on the open metrics board (the dashboard the user is looking at). list shows every widget with its title, type, span and query; add appends a new widget (title + read-only SELECT query required, type/span optional); update changes a widget's title, query, chart type or grid span; delete removes one; refresh re-runs a widget's query and reports the fresh row count. Target a widget by widgetId (from list) or widgetTitle." +
      TOOL_ERROR_SHAPE_NOTE,
    parameters: objectSchema(
      {
        action: {
          type: "string",
          enum: ["list", "add", "update", "delete", "refresh"],
          description: "Which board operation to perform.",
        },
        boardId: {
          type: "string",
          description: "Board id; omit to use the board open in the workspace.",
        },
        widgetId: {
          type: "string",
          description: "Exact widget id from a list call (preferred over widgetTitle).",
        },
        widgetTitle: {
          type: "string",
          description: "Widget title to match when widgetId is unknown.",
        },
        title: { type: "string", description: "add/update: widget title (required for add)." },
        query: {
          type: "string",
          description: "add/update: read-only SELECT feeding the widget (required for add).",
        },
        type: {
          type: "string",
          enum: [
            "table",
            "scoreboard",
            "bar",
            "horizontal-bar",
            "stacked-bar",
            "line",
            "area",
            "pie",
            "donut",
            "radial",
            "funnel",
            "delta",
            "markdown",
          ],
          description:
            "add/update: chart type (defaults to scoreboard for single-value queries, table otherwise).",
        },
        colSpan: {
          type: "integer",
          minimum: 3,
          maximum: 6,
          description: "update: grid column span (3-6).",
        },
        rowSpan: {
          type: "integer",
          minimum: 2,
          maximum: 6,
          description: "update: grid row span (2-6).",
        },
      },
      ["action"],
    ),
  },

  manage_schedule: {
    name: "manage_schedule",
    description:
      "Create, list, or delete scheduled tasks. kind 'agent' schedules a recurring read-only agent run of `prompt`; kind 'sql' runs `sql` on the interval. database is REQUIRED on create — a schedule without one fires against whatever database happens to be active, which is a bug, so always pass the database the task is about (default to the current one)." +
      TOOL_ERROR_SHAPE_NOTE,
    parameters: objectSchema(
      {
        action: {
          type: "string",
          enum: ["list", "create", "delete"],
          description: "Which schedule operation to perform.",
        },
        id: {
          type: "string",
          description: "delete: schedule id from a list call (preferred over name).",
        },
        name: {
          type: "string",
          description: "create: schedule name; delete: name to match when id is unknown.",
        },
        kind: {
          type: "string",
          enum: ["agent", "sql"],
          description: "create: 'agent' (default) runs prompt read-only; 'sql' runs sql.",
        },
        prompt: {
          type: "string",
          description: "create (kind agent): the recurring task the agent performs each run.",
        },
        sql: {
          type: "string",
          description: "create (kind sql): the statement run on the interval.",
        },
        database: {
          type: "string",
          description: "create: REQUIRED database the schedule runs against.",
        },
        intervalSeconds: {
          type: "integer",
          minimum: 60,
          description: "create: seconds between runs (minimum 60).",
        },
        disabled: {
          type: "boolean",
          description: "create: set true to create the schedule paused (default: enabled).",
        },
      },
      ["action"],
    ),
  },
};
