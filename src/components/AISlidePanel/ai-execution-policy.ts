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
 * level. Auto-running blocked SQL is pointless — the run can only fail with a
 * raw Safe Mode error — so the proposal should fall back to the manual
 * approval flow instead. Agent autonomy ("full") intentionally does NOT
 * override Safe Mode: they are independent protection layers.
 */
export function isSqlBlockedBySafeMode(sql: string, safeModeLevel: SafeModeLevel): boolean {
  const trimmed = sql.trim();
  if (!trimmed || safeModeLevel <= 0) return false;
  return splitSqlStatements(trimmed).some((statement) =>
    isBlockedAtLevel(safeModeLevel, statement),
  );
}

export function getAISqlConfirmationRequirement(
  statements: string[],
): AISqlConfirmationRequirement {
  if (statements.some(isHighRiskStatement)) return "high-risk";
  if (statements.some(isMutatingStatement)) return "mutation";
  return null;
}
