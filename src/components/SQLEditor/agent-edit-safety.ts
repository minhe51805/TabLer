import type { DatabaseType } from "../../types/database";
import { invokeWithTimeout } from "../../utils/tauri-utils";
import { emitAppToast } from "../../utils/app-toast";

export interface AgentEditCheckpointResult {
  fileName: string;
}

/**
 * Safety snapshot before executing an agent-edited query that mutates data.
 * The proposal itself only changes editor text; its first real execution is
 * the moment the agent's suggestion starts affecting the database, so a
 * rollback point is captured first. Best effort: a failed snapshot is
 * surfaced loudly but never blocks the user's own Run.
 */
export async function captureAgentEditedRunCheckpoint(params: {
  connectionId: string;
  database: string | null;
  dbType: DatabaseType;
}): Promise<AgentEditCheckpointResult | null> {
  try {
    return await invokeWithTimeout<AgentEditCheckpointResult>(
      "create_database_checkpoint",
      {
        connectionId: params.connectionId,
        database: params.database,
        dbType: params.dbType,
        label: "before-agent-edited-run",
      },
      60_000,
      "Safety checkpoint",
    );
  } catch {
    emitAppToast({
      tone: "error",
      title: "Safety checkpoint failed",
      description:
        "Continuing, but /rollback has no new point for this agent-edited query. Create one manually with /backup first.",
      durationMs: 8_000,
    });
    return null;
  }
}
