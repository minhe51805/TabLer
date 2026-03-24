import type { SqlRiskAnalysis } from "./AISlidePanelUtils";

export type AIWorkspaceBubbleKind = "assistant" | "result" | "error";

export type AIWorkspaceBubbleStatus = "loading" | "ready" | "error";

export interface AIWorkspacePointerState {
  x: number;
  y: number;
  visible: boolean;
}

export interface AIWorkspaceBubbleData {
  id: string;
  threadId: string;
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
