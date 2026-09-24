import { useCallback, useState } from "react";
import { emitAppToast } from "../../../utils/app-toast";
import { invokeMutation } from "../../../utils/tauri-utils";
import { useAIStore } from "../../../stores/aiStore";
import type { AppLanguage } from "../../../i18n";
import type { AIConversationMessage } from "../../../types";
import {
  COMPACT_COMMAND,
  buildCompactTranscript,
  buildCompactUserPrompt,
  buildPostCompactHistory,
  deriveMemoryTitle,
  extractDigestFromReply,
  extractMemoryKeywords,
  estimateTokensFromChars,
  formatTokensCompact,
} from "../../../utils/ai-context-compact";
import {
  createAIWorkspaceId,
  estimateConversationFootprint,
  summarizePromptForDisplay,
} from "../ai-conversation-state";
import type { AIWorkspaceBubbleData, AIWorkspaceInteractionMode } from "../ai-workspace-types";
import type { getAIWorkspaceCopy } from "../ai-workspace-copy";
import type { ThreadMemoryEntry } from "./use-ai-chat-workspaces";

interface CompactWorkspace {
  id: string;
  name: string;
  contextDigest: string;
}

interface CompactThread {
  id: string;
  label?: string;
}

interface UseAICompactContextOptions {
  activeChatWorkspace: CompactWorkspace | null;
  activeInteractionMode: AIWorkspaceInteractionMode;
  activeThreadBubbles: AIWorkspaceBubbleData[];
  aiCopy: ReturnType<typeof getAIWorkspaceCopy>;
  currentThread: CompactThread | undefined;
  currentWorkspaceKey: string;
  language: AppLanguage;
  saveChatContextDigest: (workspaceId: string, digest: string) => void;
  setBubbles: (updater: (current: AIWorkspaceBubbleData[]) => AIWorkspaceBubbleData[]) => void;
  setError: (message: string | null) => void;
  setThreadMemories: (
    updater: (current: Record<string, ThreadMemoryEntry>) => Record<string, ThreadMemoryEntry>,
  ) => void;
}

/**
 * `/compact` implementation: summarize the whole thread into a workspace
 * digest (Claude Code / opencode semantics — every ready bubble folds in, no
 * verbatim scrollback survives), archive the full transcript in the SQLite
 * cache, persist a named thread memory, and drop a marker bubble showing the
 * token/message delta.
 */
export function useAICompactContext({
  activeChatWorkspace,
  activeInteractionMode,
  activeThreadBubbles,
  aiCopy,
  currentThread,
  currentWorkspaceKey,
  language,
  saveChatContextDigest,
  setBubbles,
  setError,
  setThreadMemories,
}: UseAICompactContextOptions) {
  const [isCompacting, setIsCompacting] = useState(false);

  const handleCompactContext = useCallback(
    async (
      silent = false,
    ): Promise<{ digest: string; recentHistory: AIConversationMessage[] } | null> => {
      if (isCompacting) return null;
      if (!activeChatWorkspace) {
        if (!silent) setError(aiCopy.workspace.compactNeedsWorkspace);
        return null;
      }
      const readyBubbles = activeThreadBubbles.filter(
        (bubble) => bubble.kind === "assistant" && bubble.status === "ready",
      );
      if (readyBubbles.length === 0) {
        if (!silent) setError(aiCopy.workspace.compactEmpty);
        return null;
      }

      setIsCompacting(true);
      try {
        const transcript = buildCompactTranscript(activeThreadBubbles);
        const reply = await useAIStore
          .getState()
          .askAI(
            buildCompactUserPrompt(
              transcript,
              activeChatWorkspace.contextDigest,
              activeChatWorkspace.name,
            ),
            "",
            "panel",
            "general",
            [],
          );
        const digest = extractDigestFromReply(reply);
        if (digest.trim()) {
          saveChatContextDigest(activeChatWorkspace.id, digest);
          try {
            await invokeMutation("save_workspace_context_snapshot", {
              workspaceId: activeChatWorkspace.id,
              kind: "digest",
              threadId: null,
              payload: { digest },
            });
          } catch (digestCacheError) {
            console.error("[AIWorkspace] Failed to cache digest:", digestCacheError);
          }
        }
        // Claude Code / opencode semantics: the digest is the essence of the
        // WHOLE conversation up to this point — every ready bubble is folded in
        // (the summarizer sees them all via buildCompactTranscript) and no
        // verbatim scrollback survives beside the digest afterwards.
        const sortedReady = [...readyBubbles].sort(
          (left, right) => left.createdAt - right.createdAt,
        );
        const removedIds = sortedReady.map((bubble) => bubble.id);

        // Archive the FULL thread transcript in the SQLite cache before touching
        // anything — compacting never destroys the original conversation (same
        // contract as opencode's pruned-but-stored entries / Claude Code's
        // pre-compaction scrollback).
        const beforeBubbles = activeThreadBubbles.filter(
          (bubble) => bubble.status !== "loading" && !bubble.compactedAt,
        );
        const beforeTokens = estimateTokensFromChars(estimateConversationFootprint(beforeBubbles));
        const beforeMessages = beforeBubbles.length;
        const compactedAt = Date.now();
        const archivedBubbles = activeThreadBubbles.filter((bubble) => bubble.status !== "loading");
        try {
          await invokeMutation("save_workspace_context_snapshot", {
            workspaceId: activeChatWorkspace.id,
            kind: "transcript",
            threadId: currentThread?.id ?? null,
            payload: { compactedAt, bubbles: archivedBubbles },
          });
        } catch (archiveError) {
          console.error("[AIWorkspace] Failed to archive transcript:", archiveError);
        }

        if (removedIds.length > 0) {
          setBubbles((current) =>
            current.map((bubble) =>
              removedIds.includes(bubble.id) ? { ...bubble, compactedAt } : bubble,
            ),
          );
        }

        const effectiveDigest = digest.trim() || activeChatWorkspace.contextDigest;

        // Codex-style memory: name this thread's digest and tag it with
        // keywords so related context can be found and re-imported later.
        if (currentThread?.id && effectiveDigest.trim()) {
          const memoryTitle = deriveMemoryTitle(
            effectiveDigest,
            currentThread.label || activeChatWorkspace.name,
          );
          const memoryKeywords = extractMemoryKeywords(effectiveDigest);
          try {
            await invokeMutation("upsert_thread_memory", {
              workspaceId: activeChatWorkspace.id,
              threadId: currentThread.id,
              title: memoryTitle,
              summary: effectiveDigest,
              keywords: memoryKeywords,
            });
            setThreadMemories((current) => ({
              ...current,
              [currentThread.id]: {
                title: memoryTitle,
                keywords: memoryKeywords,
                summary: effectiveDigest,
              },
            }));
          } catch (memoryError) {
            console.error("[AIWorkspace] Failed to persist thread memory:", memoryError);
            emitAppToast({
              tone: "error",
              title:
                language === "vi" ? "Không lưu được ghi nhớ thread" : "Thread memory not saved",
              description:
                language === "vi"
                  ? "Tóm tắt ngữ cảnh của thread này sẽ không khả dụng cho các lượt sau."
                  : "This thread's context summary will not be available to future runs.",
              durationMs: 5000,
            });
          }
        }
        if (currentThread?.id) {
          const markerBubble: AIWorkspaceBubbleData = {
            id: createAIWorkspaceId(),
            threadId: currentThread.id,
            workspaceKey: currentWorkspaceKey,
            interactionMode: activeInteractionMode,
            kind: "assistant",
            status: "ready",
            title: aiCopy.workspace.compactDoneTitle,
            subtitle: aiCopy.workspace.compactDoneSubtitle,
            prompt: COMPACT_COMMAND,
            promptSummary: COMPACT_COMMAND,
            preview: summarizePromptForDisplay(effectiveDigest),
            detail: effectiveDigest,
            x: 0,
            y: 0,
            pointer: { x: 0, y: 0, visible: false },
            createdAt: Date.now(),
          };
          const afterTokens = estimateTokensFromChars(
            estimateConversationFootprint([markerBubble]),
          );
          const afterMessages = 1;
          markerBubble.subtitle = `${formatTokensCompact(beforeTokens)} → ${formatTokensCompact(afterTokens)} tokens · ${beforeMessages} → ${afterMessages} messages`;
          setBubbles((current) => [...current, markerBubble]);
        }
        return { digest: effectiveDigest, recentHistory: buildPostCompactHistory(effectiveDigest) };
      } catch (compactError) {
        setError(compactError instanceof Error ? compactError.message : String(compactError));
        return null;
      } finally {
        setIsCompacting(false);
      }
    },
    [
      activeChatWorkspace,
      activeInteractionMode,
      activeThreadBubbles,
      aiCopy.workspace.compactDoneSubtitle,
      aiCopy.workspace.compactDoneTitle,
      aiCopy.workspace.compactEmpty,
      aiCopy.workspace.compactNeedsWorkspace,
      currentThread?.id,
      currentThread?.label,
      currentWorkspaceKey,
      isCompacting,
      language,
      saveChatContextDigest,
      setBubbles,
      setError,
      setThreadMemories,
    ],
  );

  return { handleCompactContext, isCompacting };
}
