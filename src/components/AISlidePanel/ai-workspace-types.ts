import type { SqlRiskAnalysis } from "./AISlidePanelUtils";
import type { AIRequestErrorCode } from "../../utils/ai-request-errors";

export type AIWorkspaceBubbleKind = "assistant" | "result" | "error";

export type AIWorkspaceBubbleStatus = "loading" | "ready" | "partial" | "cancelled" | "error";
export type AIWorkspaceInteractionMode = "prompt" | "edit" | "agent";

export interface AIWorkspacePointerState {
  x: number;
  y: number;
  visible: boolean;
}

export function aiModeUsesSchemaContext(mode: AIWorkspaceInteractionMode) {
  return mode !== "prompt";
}

export function aiModeAllowsInsert(mode: AIWorkspaceInteractionMode) {
  return mode !== "prompt";
}

export function aiModeAllowsRun(mode: AIWorkspaceInteractionMode) {
  return mode === "agent";
}

export function getDefaultAIWorkspaceInteractionMode(schemaContextAllowed?: boolean | null): AIWorkspaceInteractionMode {
  return schemaContextAllowed ? "edit" : "prompt";
}

/**
 * Controls how eagerly an autonomous agent starts generated SQL.
 * - "review": always pause for approval before any execution.
 * - "smart": auto-run safe read-only SQL, ask only for writes/high-risk SQL (default).
 * - "full": auto-start every proposal, but writes and schema changes still require confirmation.
 */
export type AIWorkspaceAgentAutonomy = "review" | "smart" | "full";

export const DEFAULT_AI_WORKSPACE_AGENT_AUTONOMY: AIWorkspaceAgentAutonomy = "smart";

export function isAIWorkspaceAgentAutonomy(value: unknown): value is AIWorkspaceAgentAutonomy {
  return value === "review" || value === "smart" || value === "full";
}

export type AIWorkspaceAgentActionName =
  | "plan"
  | "list_tables"
  | "describe_table"
  | "run_readonly_sql"
  | "finish";

export type AIWorkspaceAgentStepStatus = "running" | "done" | "error";

export interface AIWorkspaceAgentStep {
  /** 1-based ordinal of the step within the run. */
  step: number;
  action: AIWorkspaceAgentActionName;
  /** The model's short rationale for taking this action. */
  message: string;
  /** Tool result; empty while the step is still running. */
  observation?: string;
  status: AIWorkspaceAgentStepStatus;
}

export interface AIWorkspaceBubbleData {
  id: string;
  threadId: string;
  workspaceKey: string;
  interactionMode: AIWorkspaceInteractionMode;
  kind: AIWorkspaceBubbleKind;
  status: AIWorkspaceBubbleStatus;
  title: string;
  subtitle: string;
  prompt: string;
  promptSummary?: string;
  preview: string;
  detail: string;
  sql?: string;
  risk?: SqlRiskAnalysis;
  x: number;
  y: number;
  pointer: AIWorkspacePointerState;
  createdAt: number;
  autoDismissAt?: number;
  /** Real model reasoning text; undefined when the model returns none. */
  reasoning?: string;
  /** Live trace of autonomous agent tool steps; undefined outside agent mode. */
  agentSteps?: AIWorkspaceAgentStep[];
  /** Stable request failure category used for retry and status presentation. */
  requestErrorCode?: AIRequestErrorCode;
  retryable?: boolean;
}
