import { useSafeModeStore } from "../stores/safeModeStore";
import { useConnectionStore } from "../stores/connectionStore";
import { isBlockedAtLevel, requiresConfirmationAtLevel } from "../types/safe-mode";
import { classifySqlSafety, type SqlSafetyDecision } from "./sql-safety";

const CONFIRMATION_TIMEOUT_MS = 300_000;

/**
 * Thrown when the human declines a Safe Mode confirmation dialog. Callers
 * distinguish this from a real failure and render a neutral "cancelled"
 * state instead of a red error.
 */
export class SafeModeCancelledError extends Error {
  constructor(message = "Query cancelled by Safe Mode confirmation.") {
    super(message);
    this.name = "SafeModeCancelledError";
  }
}

let confirmationSequence = 0;

function requestConfirmation(sql: string, connectionId: string, level: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    // Unique per request so a response can only resolve the dialog that
    // produced it — two stacked confirmations (e.g. two concurrent runs)
    // must not consume each other's answer and leave a promise hanging
    // until the timeout.
    const requestId = ++confirmationSequence;
    let timeoutId = 0;
    const finish = (approved: boolean) => {
      window.clearTimeout(timeoutId);
      window.removeEventListener("safe-mode-confirm-response", handleResponse);
      resolve(approved);
    };
    const handleResponse = (event: Event) => {
      const detail = (event as CustomEvent<{ id?: number; approved: boolean }>).detail;
      // Requests without an id (legacy callers) still resolve; responses
      // carrying an id only resolve their own request.
      if (typeof detail.id === "number" && detail.id !== requestId) return;
      finish(detail.approved);
    };
    window.addEventListener("safe-mode-confirm-response", handleResponse);
    timeoutId = window.setTimeout(() => finish(false), CONFIRMATION_TIMEOUT_MS);
    window.dispatchEvent(
      new CustomEvent("safe-mode-confirm-request", {
        detail: { id: requestId, sql, connectionId, level },
      }),
    );
  });
}

export async function assertQueryAllowed(
  sql: string,
  connectionId: string,
  options?: { userInitiated?: boolean; preApproved?: boolean },
): Promise<SqlSafetyDecision> {
  const safeLevel = useSafeModeStore.getState().getEffectiveLevel(connectionId);
  // Pass the connection's engine so dialect-specific server commands
  // (MySQL SHOW/DESCRIBE presets) classify under the right grammar.
  const databaseType =
    useConnectionStore.getState().connections.find((connection) => connection.id === connectionId)
      ?.db_type ?? null;
  const decision = await classifySqlSafety(sql, databaseType);
  if (decision.statements.length === 0) {
    throw new Error(decision.parseError || "SQL contains no executable statements.");
  }
  if (decision.parseError && safeLevel > 0) {
    throw new Error(`Safe Mode could not classify this SQL reliably: ${decision.parseError}`);
  }

  // `preApproved` marks runs where the human already granted approval for
  // this exact SQL — the AI review dialog they just clicked, or the standing
  // "full autonomy" grant. At levels <= 3 such runs pass without another
  // dialog; levels 4-5 (strict/production) keep their confirmations.
  const preApproved = options?.preApproved === true && safeLevel <= 3;
  const blocked = decision.statements.find(
    (statement) =>
      (statement.kind === "unknown" && safeLevel > 0) || isBlockedAtLevel(safeLevel, statement.sql),
  );
  // Track whether the human explicitly approved this exact run so the
  // backend can relax its own level 1-3 block for it (see
  // `safeModeApprovedByUser` on the execute commands).
  let userConfirmed = false;
  if (blocked) {
    // A blocked statement only becomes an interactive confirmation when a
    // HUMAN initiated this exact run (query editor Run button). Autonomous
    // paths (agent tools, sandbox calls) keep the hard block — they must
    // never pop dialogs or write through a guard tier. Levels 4-5
    // (strict/production) also keep the hard block for everyone.
    if (preApproved) {
      // Standing/explicit human approval: run through without another dialog.
      userConfirmed = true;
    } else if (options?.userInitiated && safeLevel <= 3) {
      const confirmed = await requestConfirmation(sql, connectionId, safeLevel);
      if (!confirmed) {
        throw new SafeModeCancelledError();
      }
      userConfirmed = true;
    } else {
      throw new Error(
        `[Safe Mode level ${safeLevel}] This statement is blocked. ` +
          "Upgrade to a lower protection level or disable Safe Mode in settings to proceed.",
      );
    }
  }

  // The classifier flags statements that reach outside the database — local
  // filesystem, network, or OS commands (`pg_read_file`, `INTO OUTFILE`,
  // `COPY ... TO PROGRAM`, DuckDB `read_csv`). The sandbox boundary always
  // rejects these; on the direct path a human may still approve the exact
  // run, but autonomous callers never get a dialog.
  if (decision.filesystemAccess && !userConfirmed) {
    if (options?.userInitiated) {
      const confirmed = await requestConfirmation(sql, connectionId, safeLevel);
      if (!confirmed) {
        throw new SafeModeCancelledError();
      }
      userConfirmed = true;
    } else {
      throw new Error(
        "This statement reaches outside the database (filesystem, network, or OS command). " +
          "The sandbox gateway always rejects it; run it from the query editor to approve it explicitly.",
      );
    }
  }

  const needsConfirmation =
    safeLevel === 5 ||
    decision.statements.some((statement) => requiresConfirmationAtLevel(safeLevel, statement.sql));
  if (needsConfirmation && !preApproved && !userConfirmed) {
    const confirmed = await requestConfirmation(sql, connectionId, safeLevel);
    if (!confirmed) {
      throw new SafeModeCancelledError();
    }
    userConfirmed = true;
  }
  return { ...decision, userConfirmed };
}

/** Guard a reviewed multi-statement operation, such as a database restore, with one confirmation. */
export async function assertStatementsAllowed(
  statements: string[],
  connectionId: string,
): Promise<void> {
  const safeLevel = useSafeModeStore.getState().getEffectiveLevel(connectionId);
  const blocked = statements.find((statement) => isBlockedAtLevel(safeLevel, statement));
  if (blocked) {
    throw new Error(
      `[Safe Mode level ${safeLevel}] The restore contains a blocked statement: ${blocked.slice(0, 120)}`,
    );
  }

  const needsReview =
    safeLevel === 5 ||
    statements.some((statement) => requiresConfirmationAtLevel(safeLevel, statement));
  if (!needsReview) return;

  const preview = statements.join(";\n");
  const confirmed = await requestConfirmation(preview, connectionId, safeLevel);
  if (!confirmed) {
    throw new SafeModeCancelledError("Restore cancelled by Safe Mode confirmation.");
  }
}
