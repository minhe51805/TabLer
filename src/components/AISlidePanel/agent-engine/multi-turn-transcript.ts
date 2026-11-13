import { AI_MAX_AGENT_TURNS, AI_MAX_AGENT_TURNS_CHARS } from "../../../config/ai-limits";
import type { CanonicalAgentTurn, CanonicalToolCall } from "../../../types";
import {
  appendAgentFacts,
  clampObservationText,
  parseAgentFacts,
  type AgentTraceStep,
} from "../ai-agent-context";
import { AGENT_COMPACTION_KEEP_TAIL, AGENT_COMPACTION_TOKEN_THRESHOLD } from "../ai-agent-cost";

const TRANSCRIPT_OBSERVATION_CHAR_BUDGET = 4_000;

/**
 * Atomic unit of multi-turn history: an `assistant` turn plus all immediately
 * paired `tool_result` turns (or a standalone `user` guidance turn). Compaction
 * and budget trimming operate exclusively on complete groups so a `tool_use`
 * is NEVER separated from its matching `tool_result` (which would hard-fail
 * Anthropic and OpenAI validation with HTTP 400).
 */
export interface AtomicTurnGroup {
  turns: CanonicalAgentTurn[];
  charCount: number;
  lastStepOrdinal: number;
}

function estimateTurnChars(turn: CanonicalAgentTurn): number {
  if (turn.role === "user") {
    return turn.content.length;
  }
  if (turn.role === "tool_result") {
    return turn.call_id.length + turn.tool_name.length + turn.content.length;
  }
  const toolChars = (turn.tool_calls ?? []).reduce(
    (sum, call) => sum + call.id.length + call.name.length + JSON.stringify(call.arguments).length,
    0,
  );
  return (
    (turn.text?.length ?? 0) +
    (turn.reasoning?.length ?? 0) +
    (turn.thought_signature?.length ?? 0) +
    toolChars
  );
}

export function clampTranscriptObservation(
  rawObservation: string,
  budget = TRANSCRIPT_OBSERVATION_CHAR_BUDGET,
): string {
  const { text, facts } = parseAgentFacts(rawObservation ?? "");
  const clamped = clampObservationText(text, budget);
  return facts ? appendAgentFacts(clamped, facts) : clamped;
}

export interface MultiTurnTranscript {
  recordAssistantToolTurn: (params: {
    text?: string;
    reasoning?: string;
    thoughtSignature?: string;
    toolCalls: CanonicalToolCall[];
    stepOrdinalHint: number;
  }) => void;
  recordToolResult: (params: {
    callId: string;
    toolName: string;
    observation: string;
    isError?: boolean;
    stepOrdinal: number;
  }) => void;
  recordUserGuidance: (guidance: string, stepOrdinal: number) => void;
  getTurns: () => CanonicalAgentTurn[];
  getCompactedContext: () => string | undefined;
  getCompactedThroughStep: () => number;
  compactIfNeeded: (params: {
    steps: AgentTraceStep[];
    tokensUsed: number;
    summarize: (foldLines: string, previousSummary?: string) => Promise<string>;
  }) => Promise<void>;
}

export function createMultiTurnTranscript(): MultiTurnTranscript {
  let groups: AtomicTurnGroup[] = [];
  let compactedThroughStep = 0;
  let compactedContext: string | undefined;

  const enforceHardCaps = () => {
    const totalTurns = () => groups.reduce((acc, g) => acc + g.turns.length, 0);
    const totalChars = () => groups.reduce((acc, g) => acc + g.charCount, 0);

    // Reserve head-room below backend validation caps (`AI_MAX_AGENT_TURNS = 64`,
    // `AI_MAX_AGENT_TURNS_CHARS = 160_000`) by dropping complete oldest groups first.
    while (
      groups.length > 1 &&
      (totalTurns() > AI_MAX_AGENT_TURNS - 4 || totalChars() > AI_MAX_AGENT_TURNS_CHARS - 16_000)
    ) {
      const dropped = groups.shift();
      if (dropped && dropped.lastStepOrdinal > compactedThroughStep) {
        compactedThroughStep = dropped.lastStepOrdinal;
      }
    }
  };

  return {
    recordAssistantToolTurn: ({
      text,
      reasoning,
      thoughtSignature,
      toolCalls,
      stepOrdinalHint,
    }) => {
      const turn: CanonicalAgentTurn = {
        role: "assistant",
        ...(text?.trim() ? { text: text.trim() } : {}),
        ...(reasoning?.trim() ? { reasoning: reasoning.trim() } : {}),
        ...(thoughtSignature?.trim() ? { thought_signature: thoughtSignature.trim() } : {}),
        tool_calls: toolCalls.map((call) => ({
          id: call.id,
          name: call.name,
          arguments: call.arguments ?? {},
        })),
      };
      groups.push({
        turns: [turn],
        charCount: estimateTurnChars(turn),
        lastStepOrdinal: stepOrdinalHint,
      });
      enforceHardCaps();
    },

    recordToolResult: ({ callId, toolName, observation, isError, stepOrdinal }) => {
      const clampedContent = clampTranscriptObservation(observation);
      const inferredError =
        isError ??
        (observation.startsWith("Tool error") ||
          observation.startsWith("Tool blocked") ||
          observation.startsWith("Tool skipped"));
      const turn: CanonicalAgentTurn = {
        role: "tool_result",
        call_id: callId,
        tool_name: toolName,
        content: clampedContent,
        ...(inferredError ? { is_error: true } : {}),
      };

      // Attach to the most recent assistant group when it declared this `callId`.
      for (let idx = groups.length - 1; idx >= 0; idx -= 1) {
        const candidate = groups[idx];
        const first = candidate.turns[0];
        if (
          first?.role === "assistant" &&
          (first.tool_calls ?? []).some((call) => call.id === callId)
        ) {
          candidate.turns.push(turn);
          candidate.charCount += estimateTurnChars(turn);
          candidate.lastStepOrdinal = Math.max(candidate.lastStepOrdinal, stepOrdinal);
          enforceHardCaps();
          return;
        }
      }

      // Defensive fallback if no open assistant group matched `callId`.
      groups.push({
        turns: [turn],
        charCount: estimateTurnChars(turn),
        lastStepOrdinal: stepOrdinal,
      });
      enforceHardCaps();
    },

    recordUserGuidance: (guidance, stepOrdinal) => {
      const trimmed = guidance.trim();
      if (!trimmed) return;
      const turn: CanonicalAgentTurn = { role: "user", content: trimmed };
      groups.push({
        turns: [turn],
        charCount: estimateTurnChars(turn),
        lastStepOrdinal: stepOrdinal,
      });
      enforceHardCaps();
    },

    getTurns: () => groups.flatMap((group) => group.turns),

    getCompactedContext: () => compactedContext,

    getCompactedThroughStep: () => compactedThroughStep,

    compactIfNeeded: async ({ steps, tokensUsed, summarize }) => {
      const totalChars = groups.reduce((acc, g) => acc + g.charCount, 0);
      const shouldCompact =
        tokensUsed >= AGENT_COMPACTION_TOKEN_THRESHOLD ||
        totalChars >= Math.floor(AI_MAX_AGENT_TURNS_CHARS * 0.65);
      if (!shouldCompact) return;

      const toolSteps = steps.filter(
        (step) => step.action !== "plan" && step.step > compactedThroughStep,
      );
      const foldableSteps = toolSteps.slice(
        0,
        Math.max(0, toolSteps.length - AGENT_COMPACTION_KEEP_TAIL),
      );
      if (foldableSteps.length < 2) return;

      const foldCutoffStep = foldableSteps[foldableSteps.length - 1].step;
      const foldLines = foldableSteps
        .map((step) =>
          [
            `Step ${step.step}`,
            `Action: ${step.action}`,
            `Message: ${step.message || "No message provided."}`,
            `Observation: ${step.observation || "(none)"}`,
          ].join("\n"),
        )
        .join("\n\n");

      const summary = (await summarize(foldLines, compactedContext)).trim();
      if (!summary) return;

      compactedContext = summary;
      compactedThroughStep = foldCutoffStep;
      // Drop complete atomic turn groups whose steps are now covered by `compactedContext`,
      // always preserving at least the most recent group verbatim.
      if (groups.length > 1) {
        const keptTail = groups.filter(
          (group, index) => group.lastStepOrdinal > foldCutoffStep || index === groups.length - 1,
        );
        groups = keptTail;
      }
    },
  };
}
