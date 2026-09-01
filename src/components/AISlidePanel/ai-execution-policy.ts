import {
  isHighRiskStatement,
  isMutatingStatement,
} from "../SQLEditor/SQLEditorUtils";
import { isBlockedAtLevel, type SafeModeLevel } from "../../types/safe-mode";
import { splitSqlStatements } from "../../utils/sqlStatements";
import type { AIWorkspaceAgentAutonomy } from "./ai-workspace-types";

export type AISqlRiskLevel = "safe" | "review" | "dangerous" | undefined;
export type AISqlConfirmationRequirement = "mutation" | "high-risk" | null;

export function shouldAgentAutoRunSql(
  autonomy: AIWorkspaceAgentAutonomy,
  riskLevel: AISqlRiskLevel,
) {
  if (autonomy === "review") return false;
  if (autonomy === "full") return true;
  return riskLevel === "safe";
}

/**
 * True when any statement would be hard-blocked by the current Safe Mode
 * level. Auto-running blocked SQL is pointless — unless the autonomy is
 * "full", whose standing human approval lets Safe Mode levels <= 3 run the
 * SQL through pre-approved (see the guard's `preApproved` option) — so the
 * proposal should fall back to the manual approval flow instead. Levels 4-5
 * (strict/production) stay independent from agent autonomy for everyone.
 */
export function isSqlBlockedBySafeMode(sql: string, safeModeLevel: SafeModeLevel): boolean {
  const trimmed = sql.trim();
  if (!trimmed || safeModeLevel <= 0) return false;
  return splitSqlStatements(trimmed).some((statement) =>
    isBlockedAtLevel(safeModeLevel, statement),
  );
}

/**
 * What the AI bubble must confirm with the user before running. `null` means
 * the run needs no dialog: either the SQL is read-only, or the user granted
 * the standing "full autonomy" permission ("Toàn quyền") which replaces the
 * per-run dialog.
 */
export function getAISqlConfirmationRequirement(
  statements: string[],
  autonomy?: AIWorkspaceAgentAutonomy,
): AISqlConfirmationRequirement {
  if (autonomy === "full") return null;
  if (statements.some(isHighRiskStatement)) return "high-risk";
  if (statements.some(isMutatingStatement)) return "mutation";
  return null;
}
