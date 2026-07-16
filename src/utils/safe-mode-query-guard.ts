import { useSafeModeStore } from "../stores/safeModeStore";
import { isBlockedAtLevel, requiresConfirmationAtLevel } from "../types/safe-mode";

const CONFIRMATION_TIMEOUT_MS = 300_000;

function requestConfirmation(sql: string, connectionId: string, level: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let timeoutId = 0;
    const finish = (approved: boolean) => {
      window.clearTimeout(timeoutId);
      window.removeEventListener("safe-mode-confirm-response", handleResponse);
      resolve(approved);
    };
    const handleResponse = (event: Event) => {
      finish((event as CustomEvent<{ approved: boolean }>).detail.approved);
    };
    window.addEventListener("safe-mode-confirm-response", handleResponse);
    timeoutId = window.setTimeout(() => finish(false), CONFIRMATION_TIMEOUT_MS);
    window.dispatchEvent(
      new CustomEvent("safe-mode-confirm-request", {
        detail: { sql, connectionId, level },
      }),
    );
  });
}

export async function assertQueryAllowed(sql: string, connectionId: string): Promise<void> {
  const safeLevel = useSafeModeStore.getState().getEffectiveLevel(connectionId);
  if (isBlockedAtLevel(safeLevel, sql)) {
    throw new Error(
      `[Safe Mode level ${safeLevel}] This statement is blocked. ` +
        "Upgrade to a lower protection level or disable Safe Mode in settings to proceed.",
    );
  }

  if (safeLevel === 5 || requiresConfirmationAtLevel(safeLevel, sql)) {
    const confirmed = await requestConfirmation(sql, connectionId, safeLevel);
    if (!confirmed) {
      throw new Error("Query cancelled by Safe Mode confirmation.");
    }
  }
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
    safeLevel === 5 || statements.some((statement) => requiresConfirmationAtLevel(safeLevel, statement));
  if (!needsReview) return;

  const preview = statements.join(";\n");
  const confirmed = await requestConfirmation(preview, connectionId, safeLevel);
  if (!confirmed) {
    throw new Error("Restore cancelled by Safe Mode confirmation.");
  }
}
