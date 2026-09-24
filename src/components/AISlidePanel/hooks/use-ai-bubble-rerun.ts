import { useCallback, type MutableRefObject } from "react";
import { emitAppToast } from "../../../utils/app-toast";
import { invokeMutation } from "../../../utils/tauri-utils";
import type { AppLanguage } from "../../../i18n";
import type { AIConversationMessage } from "../../../types";
import { getAIPanelCopy } from "../ai-panel-copy";
import {
  applyLearningProposal,
  buildLearningSlug,
  type LearningProposal,
} from "../ai-agent-learning";
import { invalidateAgentMemoryIndex } from "./use-agent-memory";
import {
  buildConversationHistoryMessages,
  getBubbleConversationText,
  type HistoryBudget,
} from "../ai-conversation-state";
import type { AIWorkspaceBubbleData, AIWorkspaceBubbleFeedback } from "../ai-workspace-types";
import type { AIAttachmentDraft } from "../../../utils/ai-attachments";
import type { SelectionContextState } from "../ai-panel-selection";
import type { useAIAssistantGeneration } from "./use-ai-assistant-generation";

/** Work captured while a run was in flight. `prompt` items carry the composer
 *  snapshot (draft + attachments + attached selection); `rerun` items are an
 *  edited prompt re-run against an existing bubble's slot. */
export type PendingPrompt =
  | {
      kind: "prompt";
      draft: string;
      attachments: AIAttachmentDraft[];
      selection: SelectionContextState | null;
    }
  | { kind: "rerun"; bubbleId: string; prompt: string };

type CreateAssistantBubble = ReturnType<typeof useAIAssistantGeneration>["createAssistantBubble"];

interface UseAIBubbleRerunOptions {
  bubbles: AIWorkspaceBubbleData[];
  connectionId: string | null;
  currentDatabase: string | null;
  historyBudget: HistoryBudget;
  isGenerating: boolean;
  language: AppLanguage;
  pendingQueueRef: MutableRefObject<PendingPrompt[]>;
  workspaceContextMessages: AIConversationMessage[];
  createAssistantBubble: CreateAssistantBubble;
  loadBubbleAttachmentDrafts: (
    bubble: AIWorkspaceBubbleData,
  ) => Promise<AIAttachmentDraft[] | undefined>;
  runEditedPrompt: (bubble: AIWorkspaceBubbleData, prompt: string) => Promise<void>;
  setActiveThreadId: (id: string) => void;
  setBubbles: (updater: (current: AIWorkspaceBubbleData[]) => AIWorkspaceBubbleData[]) => void;
  setPendingQueue: (queue: PendingPrompt[]) => void;
}

/**
 * Post-answer bubble lifecycle: retry a failed turn as a fresh turn,
 * regenerate an answer into the same chat slot, edit-and-rerun a prompt, and
 * the thumbs feedback writer that mirrors verdicts into agent memory.
 */
export function useAIBubbleRerun({
  bubbles,
  connectionId,
  currentDatabase,
  historyBudget,
  isGenerating,
  language,
  pendingQueueRef,
  workspaceContextMessages,
  createAssistantBubble,
  loadBubbleAttachmentDrafts,
  runEditedPrompt,
  setActiveThreadId,
  setBubbles,
  setPendingQueue,
}: UseAIBubbleRerunOptions) {
  const handleRetryBubble = useCallback(
    async (bubble: AIWorkspaceBubbleData) => {
      if (isGenerating) return;
      const retryHistory = buildConversationHistoryMessages(
        bubbles.filter(
          (currentBubble) =>
            currentBubble.threadId === bubble.threadId &&
            currentBubble.id !== bubble.id &&
            !currentBubble.compactedAt,
        ),
        historyBudget,
      );
      setActiveThreadId(bubble.threadId);
      await createAssistantBubble(bubble.prompt, {
        mode: "compose",
        displayPrompt: bubble.promptSummary,
        userPrompt: bubble.prompt,
        history: [...workspaceContextMessages, ...retryHistory],
        threadId: bubble.threadId,
        workspaceKey: bubble.workspaceKey,
        interactionMode: bubble.interactionMode,
      });
    },
    [
      bubbles,
      createAssistantBubble,
      historyBudget,
      isGenerating,
      setActiveThreadId,
      workspaceContextMessages,
    ],
  );

  // Regenerate: re-run the prompt that produced a finished bubble and swap the
  // new answer into the same chat slot. Unlike Retry (which appends a fresh
  // turn for failed runs), this keeps the conversation shape unchanged — and
  // the generation hook restores the old answer untouched when the run fails.
  const handleRegenerateBubble = useCallback(
    async (bubble: AIWorkspaceBubbleData) => {
      if (isGenerating) {
        pendingQueueRef.current = [
          ...pendingQueueRef.current,
          { kind: "rerun", bubbleId: bubble.id, prompt: bubble.prompt },
        ];
        setPendingQueue(pendingQueueRef.current);
        return;
      }
      const retryHistory = buildConversationHistoryMessages(
        bubbles.filter(
          (currentBubble) =>
            currentBubble.threadId === bubble.threadId &&
            currentBubble.id !== bubble.id &&
            !currentBubble.compactedAt,
        ),
        historyBudget,
      );
      // Re-attach the turn's files: persisted attachments only carry metadata,
      // so the bytes are fetched back into drafts for the model call.
      const regenAttachments = await loadBubbleAttachmentDrafts(bubble);
      setActiveThreadId(bubble.threadId);
      const result = await createAssistantBubble(bubble.prompt, {
        mode: "compose",
        displayPrompt: bubble.promptSummary,
        userPrompt: bubble.prompt,
        history: [...workspaceContextMessages, ...retryHistory],
        threadId: bubble.threadId,
        workspaceKey: bubble.workspaceKey,
        interactionMode: bubble.interactionMode,
        attachments: regenAttachments,
        replaceBubble: bubble,
      });
      if (result && !result.success && !result.cancelled) {
        emitAppToast({
          tone: "error",
          title: getAIPanelCopy(language).responseActions.regenerateFailed,
          durationMs: 4000,
        });
      }
    },
    [
      bubbles,
      createAssistantBubble,
      historyBudget,
      isGenerating,
      language,
      loadBubbleAttachmentDrafts,
      pendingQueueRef,
      setActiveThreadId,
      setPendingQueue,
      workspaceContextMessages,
    ],
  );

  // Edit & re-run entry point from the conversation view: a finished turn's
  // prompt is edited inline, then re-run into the same chat slot. While a run
  // is in flight the edit queues like any other send.
  const handleEditRerun = useCallback(
    (bubble: AIWorkspaceBubbleData, editedPrompt: string) => {
      if (isGenerating) {
        pendingQueueRef.current = [
          ...pendingQueueRef.current,
          { kind: "rerun", bubbleId: bubble.id, prompt: editedPrompt },
        ];
        setPendingQueue(pendingQueueRef.current);
        return;
      }
      void runEditedPrompt(bubble, editedPrompt);
    },
    [isGenerating, pendingQueueRef, runEditedPrompt, setPendingQueue],
  );

  // 👍/👎 on a finished answer: the sentiment is stored on the bubble (so the
  // buttons stay marked across reloads) and mirrored into agent memory through
  // the learning loop's writer, so future runs see the verdict in their index.
  const handleBubbleFeedback = useCallback(
    (bubble: AIWorkspaceBubbleData, feedback: AIWorkspaceBubbleFeedback) => {
      setBubbles((current) =>
        current.map((currentBubble) =>
          currentBubble.id === bubble.id ? { ...currentBubble, feedback } : currentBubble,
        ),
      );
      const panelCopy = getAIPanelCopy(language);
      const answerText = getBubbleConversationText(bubble).trim();
      const proposal: LearningProposal = {
        id: `memory:feedback-${bubble.id}`,
        kind: "memory",
        title:
          feedback.sentiment === "up"
            ? "The user marked this answer helpful"
            : "The user marked this answer unhelpful",
        rationale: "Recorded from the per-response feedback control in the chat panel.",
        memory: {
          name: buildLearningSlug("feedback", bubble.id),
          description:
            feedback.sentiment === "up"
              ? "Positive feedback on an assistant answer"
              : "Negative feedback on an assistant answer",
          body: [
            "# User feedback",
            "",
            `Sentiment: ${feedback.sentiment === "up" ? "helpful" : "not helpful"}`,
            ...(feedback.reasons?.length ? [`Reasons: ${feedback.reasons.join(", ")}`] : []),
            ...(feedback.comment ? [`Comment: ${feedback.comment}`] : []),
            "",
            "## Prompt",
            "",
            bubble.prompt,
            "",
            "## Answer",
            "",
            answerText.length > 1500 ? `${answerText.slice(0, 1500)}…` : answerText,
            ...(bubble.sql ? ["", "## SQL", "", "```sql", bubble.sql, "```"] : []),
          ].join("\n"),
        },
      };
      void applyLearningProposal(
        proposal,
        { connectionId, database: currentDatabase ?? null },
        (command, args) => invokeMutation(command, args),
      )
        .then(() => {
          invalidateAgentMemoryIndex(connectionId ?? undefined);
          if (feedback.sentiment === "down") {
            emitAppToast({
              tone: "success",
              title: panelCopy.responseActions.feedbackSaved,
              durationMs: 3000,
            });
          }
        })
        .catch((errorValue: unknown) => {
          console.warn("[AIWorkspace] feedback memory save failed:", errorValue);
          if (feedback.sentiment === "down") {
            emitAppToast({
              tone: "error",
              title: panelCopy.responseActions.feedbackFailed,
              durationMs: 4000,
            });
          }
        });
    },
    [connectionId, currentDatabase, language, setBubbles],
  );

  return {
    handleBubbleFeedback,
    handleEditRerun,
    handleRegenerateBubble,
    handleRetryBubble,
  };
}
