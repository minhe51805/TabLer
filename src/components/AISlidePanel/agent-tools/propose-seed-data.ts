import { AI_AGENT_SEED_DOCUMENT_LIMIT } from "../ai-agent-tools";
import { agentSqlToolBlockedMessage } from "../ai-agent-engine-gates";
import { agentToolError } from "../agent-tool-executor-helpers";
import { generateInsertSql } from "../../../utils/sql-generator";
import { stringifyAgentObservation, type AgentToolModule } from "./shared";

export const tool: AgentToolModule = {
  name: "propose_seed_data",
  handler: async (ctx, args, frame) => {
    // Cross-engine seed proposals. The agent NEVER writes data itself: this
    // tool only lands a reviewable seed script in a NEW query tab with
    // autoRun disabled, so the human applies the write (Safe Mode still
    // confirms). SQL engines get INSERT statements; document engines get an
    // insertMany script.
    const isDocument = ctx.toolAvailability?.documentPropose ?? false;
    if (ctx.toolAvailability && !ctx.toolAvailability.seedPropose) {
      return agentSqlToolBlockedMessage("propose_seed_data", ctx.toolAvailability);
    }
    const collection = typeof args?.collection === "string" ? args.collection.trim() : "";
    if (!collection) {
      return agentToolError(
        "propose_seed_data requires args.collection — the exact table or collection name to fill.",
        {
          hint: 'Send args.collection like "products" plus args.documents (array of objects).',
        },
      );
    }
    // Keep the name one bare identifier so it rides db.<name> shell syntax and
    // quoted SQL identifiers safely — no schema/db prefix, whitespace or dots.
    if (/[\s.$"']/.test(collection) || collection.startsWith("system.")) {
      return agentToolError(
        "args.collection must be a plain table or collection name (no schema/db prefix, no whitespace, dots, quotes, or $ signs).",
      );
    }
    const rawDocuments = args?.documents;
    if (!Array.isArray(rawDocuments) || rawDocuments.length === 0) {
      return agentToolError(
        "propose_seed_data requires a non-empty args.documents array of objects.",
        {
          hint: 'Send args.documents like [{"name":"A","price":9.99}].',
        },
      );
    }
    if (rawDocuments.length > AI_AGENT_SEED_DOCUMENT_LIMIT) {
      return agentToolError(
        `args.documents exceeds the ${AI_AGENT_SEED_DOCUMENT_LIMIT}-document cap. Send the most representative documents.`,
      );
    }
    const documents: Array<Record<string, unknown>> = [];
    for (const entry of rawDocuments) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return agentToolError(
          "every args.documents entry must be an object ({field: value}). Strings and arrays are not valid documents.",
        );
      }
      const record = entry as Record<string, unknown>;
      if (Object.keys(record).length === 0) {
        return agentToolError("every args.documents entry must contain at least one field.");
      }
      documents.push(record);
    }

    let seedScript: string;
    let seedKind: string;
    if (isDocument) {
      const docLines = documents.map((document) => `  ${JSON.stringify(document)}`).join(",\n");
      seedScript = [
        ...(documents.some((document) => "_id" in document)
          ? [
              "// NOTE: documents with an explicit _id will be rejected as duplicates if those _ids already exist.",
            ]
          : []),
        `db.${collection}.insertMany([`,
        docLines,
        "]);",
      ].join("\n");
      seedKind = `db.${collection}.insertMany`;
    } else {
      // Union the field names across documents (ordered by first appearance)
      // so every row lists the same columns; a document missing a field gets
      // NULL for it. generateInsertSql handles dialect quoting and escaping.
      const columns: string[] = [];
      const seenColumns = new Set<string>();
      for (const document of documents) {
        for (const key of Object.keys(document)) {
          if (!seenColumns.has(key)) {
            seenColumns.add(key);
            columns.push(key);
          }
        }
      }
      const rows = documents.map((document) =>
        columns.map((column) => {
          const value = document[column];
          if (value === null || value === undefined) return null;
          if (
            typeof value === "string" ||
            typeof value === "number" ||
            typeof value === "boolean"
          ) {
            return value;
          }
          // Arrays/objects have no scalar SQL literal — store the JSON text.
          return JSON.stringify(value);
        }),
      );
      const insertSql = generateInsertSql(collection, columns, rows, ctx.dbType);
      // SQL Server resolves an unqualified table name against the session's
      // current database. A fresh AI Query tab can open on master, so prepend
      // a USE for the database the user is working in — otherwise Run fails
      // with "Invalid object name". The USE and the INSERTs execute on the
      // same pooled connection, so the database context carries over.
      const usePrefix =
        ctx.dbType === "mssql" && ctx.currentDatabase
          ? `USE [${ctx.currentDatabase.replace(/]/g, "]]")}];\n`
          : "";
      seedScript = `${usePrefix}${insertSql}`;
      seedKind = `INSERT INTO ${collection}`;
    }
    // Keep the generated tab title short: it is a scratch query the user
    // reviews and runs. Echoing the agent rationale produced long, noisy
    // titles, so use a plain "Query <collection>" (aligned with the app's
    // default "Query" tab naming).
    const title = `Query ${collection}`;
    const created = ctx.openQueryTab?.({ sql: seedScript, title, autoRun: false });
    if (!created) {
      return agentToolError("could not open a new AI Query tab (no active connection?).", {
        retryable: true,
      });
    }
    return stringifyAgentObservation(frame, {
      collection,
      documentCount: documents.length,
      tabTitle: title,
      note: `Created a NEW AI Query tab pre-filled with the ${seedKind} seed script. It is NOT auto-run: the user must review the tab and press Run (Safe Mode confirms). Never claim the data was inserted — you cannot run writes yourself. Call finish with a short summary of the proposal instead.`,
    });
  },
};
