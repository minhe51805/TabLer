import type { SqlRiskAnalysis } from "./AISlidePanelUtils";

export type AIWorkspaceBubbleKind = "assistant" | "result" | "error";

export type AIWorkspaceBubbleStatus = "loading" | "ready" | "error";
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
}
