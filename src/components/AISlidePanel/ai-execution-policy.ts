import {
  isHighRiskStatement,
  isMutatingStatement,
} from "../SQLEditor/SQLEditorUtils";
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

export function getAISqlConfirmationRequirement(
  statements: string[],
): AISqlConfirmationRequirement {
  if (statements.some(isHighRiskStatement)) return "high-risk";
  if (statements.some(isMutatingStatement)) return "mutation";
  return null;
}
