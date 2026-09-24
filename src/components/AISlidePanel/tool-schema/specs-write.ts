import {
  AI_AGENT_PREVIEW_STATEMENT_LIMIT,
  AI_AGENT_SEED_DOCUMENT_LIMIT,
  type AIAgentToolName,
  type AIAgentToolSpec,
} from "./constants";
import { objectSchema, TOOL_ERROR_SHAPE_NOTE } from "./specs-shared";

export const SPECS: Partial<Record<AIAgentToolName, AIAgentToolSpec>> = {
  preview_write: {
    name: "preview_write",
    description:
      "Preview mutating statements inside one transaction that always rolls back. Nothing is persisted; the human applies the final SQL through the approval flow." +
      TOOL_ERROR_SHAPE_NOTE,
    parameters: objectSchema(
      {
        statements: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: AI_AGENT_PREVIEW_STATEMENT_LIMIT,
          description: `INSERT/UPDATE/DELETE/ALTER/CREATE statements (up to ${AI_AGENT_PREVIEW_STATEMENT_LIMIT}).`,
        },
      },
      ["statements"],
    ),
  },

  propose_seed_data: {
    name: "propose_seed_data",
    description:
      "Fill an empty or sparse table or collection with realistic sample data grounded in the fields you verified with describe_table or sample_table_data. On SQL engines this emits INSERT statements; on MongoDB it emits an insertMany script. The script opens in a NEW query tab for the user to review and run — you cannot insert data directly and must never claim data was written.",
    parameters: objectSchema(
      {
        collection: {
          type: "string",
          description:
            "Exact table or collection name to fill (no schema/db prefix, no whitespace or dots).",
        },
        documents: {
          type: "array",
          items: { type: "object", additionalProperties: true },
          minItems: 1,
          maxItems: AI_AGENT_SEED_DOCUMENT_LIMIT,
          description: `Realistic rows (1-${AI_AGENT_SEED_DOCUMENT_LIMIT}), each an object whose fields match the table or collection's verified schema. Never fabricate fields you have not seen.`,
        },
        rationale: {
          type: "string",
          description: "One line explaining the seed shape, shown as the tab title.",
        },
      },
      ["collection", "documents"],
    ),
  },

  edit_query_sql: {
    name: "edit_query_sql",
    description:
      "Propose corrected SQL for a query tab. If an AI Query tab is already open, pick its tabId from the Query tabs list. If none is open, set createIfMissing: true (omit tabId) and a new AI Query tab is created pre-filled with your SQL. Never leave a requested tab fix undone because no tab is open — createIfMissing is the intended path for that case, not a reason to skip. Smoke-test your statement first: run_readonly_sql for SELECTs, preview_write for mutating SQL — a mutating statement that was never previewed this run is rejected. Mutating proposals automatically get a non-executing EXPLAIN dry-run whose plan (or syntax error) is shown on the review card before the user accepts. You cannot execute proposals yourself; the user accepts or runs them.",
    parameters: objectSchema(
      {
        tabId: {
          type: "string",
          description: "Exact tabId of the target query tab from the Query tabs list.",
        },
        sql: {
          type: "string",
          description: "The corrected SQL that will replace the tab content on acceptance.",
        },
        reason: {
          type: "string",
          description: "One short line explaining what was wrong and what the fix does.",
        },
        createIfMissing: {
          type: "boolean",
          description:
            "Set true when no query tab is open: a new AI Query tab is created pre-filled with the SQL (read-only SQL auto-runs; mutating SQL waits for the user to press Run). Never skip a requested tab fix because no tab is open.",
        },
      },
      ["sql"],
    ),
  },

  create_checkpoint: {
    name: "create_checkpoint",
    description:
      "Snapshot the current database (schema + data) into an app-managed checkpoint file — a SQL INSERT dump, so it only exists on engines that can replay SQL (not mongodb/redis/opensearch). Read-only for the database — it only writes a local file the user can restore with the /rollback command. Use it right before proposing a chain of risky mutations, or after the user says a change went wrong.",
    parameters: objectSchema(
      {
        label: {
          type: "string",
          description:
            "Short ASCII label describing the moment (e.g. 'before bulk grade update'). Optional.",
        },
      },
      [],
    ),
  },

  restore_checkpoint: {
    name: "restore_checkpoint",
    description:
      "Open a rollback confirmation for the user: pick a checkpoint, the user confirms, and the database is restored to that moment (schema + data overwritten). Use it when the user says a change went wrong or asks to undo recent writes. The user must click Restore in the dialog — you cannot force it. Optionally pass label_hint to match a checkpoint label.",
    parameters: objectSchema(
      {
        label_hint: {
          type: "string",
          description:
            "Optional substring of the checkpoint label to restore (e.g. 'before bulk grade update'). Omitted = newest checkpoint.",
        },
      },
      [],
    ),
  },
};
