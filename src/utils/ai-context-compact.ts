/**
 * ai-context-compact — /compact for AI chat workspaces.
 *
 * Modeled on Claude Code's `/compact` and opencode's session compaction:
 * the full conversation is summarized once into a durable "context digest"
 * which replaces old bubbles as request history, so long threads keep task
 * context without growing the prompt forever.
 */
import type { AIConversationMessage } from "../types";
import type { AIWorkspaceBubbleData } from "../components/AISlidePanel/ai-workspace-types";
import { buildConversationHistoryMessages, getBubbleConversationText } from "../components/AISlidePanel/ai-conversation-state";

export const COMPACT_COMMAND = "/compact";
/** Bubbles newer than this index are kept verbatim after a compact. */
export const COMPACT_PRESERVE_RECENT_BUBBLES = 4;
/** Approximate character budget of the summarized digest. */
export const COMPACT_DIGEST_CHAR_BUDGET = 2400;
/** Total request-history characters after which sending auto-compacts first. */
export const AUTO_COMPACT_TRIGGER_CHARS = 24_000;
/** Characters of conversation text sampled per bubble when building the prompt. */
const COMPACT_SAMPLE_PER_BUBBLE = 700;

export function isCompactCommand(text: string) {
  return text.trim().toLowerCase() === COMPACT_COMMAND;
}

function formatTurn(timestamp: number) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    }).format(new Date(timestamp));
  } catch {
    return "";
  }
}

/** Flattens bubbles into a readable transcript for the summarizer. */
export function buildCompactTranscript(bubbles: AIWorkspaceBubbleData[]) {
  return [...bubbles]
    .filter((bubble) => bubble.status !== "loading")
    .sort((left, right) => left.createdAt - right.createdAt)
    .map((bubble) => {
      if (bubble.kind !== "assistant") {
        return `[${formatTurn(bubble.createdAt)}] ERROR: ${bubble.title}${bubble.subtitle ? ` — ${bubble.subtitle}` : ""}`.trim();
      }
      const userPrompt = bubble.promptSummary || bubble.prompt;
      const reply = getBubbleConversationText(bubble) || bubble.preview || bubble.detail;
      const replySample = reply.length > COMPACT_SAMPLE_PER_BUBBLE
        ? `${reply.slice(0, COMPACT_SAMPLE_PER_BUBBLE).trimEnd()}…`
        : reply;
      return `[${formatTurn(bubble.createdAt)}] User: ${userPrompt.trim()}\nAssistant: ${replySample.trim()}`;
    })
    .join("\n\n");
}

export function buildCompactUserPrompt(transcript: string, previousDigest: string, workspaceName: string) {
  return [
    "You are compressing a work session transcript into a compact context digest.",
    `Workspace: ${workspaceName}.`,
    "Write the digest in the same language as the conversation.",
    "Structure it as short markdown sections:",
    "- Goal: the user's overarching task",
    "- Done: completed steps with key table/column/SQL names",
    "- Decisions: choices, conventions and constraints agreed during the chat",
    "- Open: unfinished work, pending questions and next steps",
    "Keep concrete identifiers (tables, columns, queries) verbatim. Be dense; no filler.",
    previousDigest.trim()
      ? `\nExisting digest to update (merge, don't lose still-relevant facts):\n${previousDigest.trim()}`
      : "",
    `\nTranscript:\n${transcript}`,
  ].filter(Boolean).join("\n\n");
}

/** Extracts the digest body from the model reply (drops any chatty preamble). */
export function extractDigestFromReply(reply: string) {
  const text = reply.trim();
  const marker = /(?:^|\n)(?:here(?:'s| is)[^\n]*digest[^\n]*\n?|digest:[^\n]*\n?)/i;
  const match = text.match(marker);
  return (match ? text.slice((match.index ?? 0) + match[0].length) : text).trim();
}

/**
 * Digest-only context messages prepended to every request in the workspace,
 * so the model always carries the workspace's durable context.
 */
export function buildWorkspaceContextMessages(digest: string | null | undefined): AIConversationMessage[] {
  const clean = digest?.trim();
  if (!clean) return [];
  return [
    {
      role: "user",
      content: `[Workspace context — keep this in mind for the task]\n${clean}`,
    },
    {
      role: "assistant",
      content: "Understood. I'll keep this workspace context in mind.",
    },
  ];
}

/** History for the next request: digest (as system-style user turn) + recent bubbles verbatim. */
export function buildPostCompactHistory(
  digest: string,
  bubbles: AIWorkspaceBubbleData[],
  maxChars = COMPACT_DIGEST_CHAR_BUDGET,
): AIConversationMessage[] {
  const messages: AIConversationMessage[] = [];
  const trimmedDigest = digest.length > maxChars
    ? `${digest.slice(0, maxChars).trimEnd()}…`
    : digest;
  if (trimmedDigest) {
    messages.push({
      role: "user",
      content: `[Workspace context — keep this in mind for the task]\n${trimmedDigest}`,
    });
    messages.push({
      role: "assistant",
      content: "Understood. I'll keep this workspace context in mind.",
    });
  }
  if (bubbles.length > 0) {
    messages.push(...buildConversationHistoryMessages(bubbles.slice(-COMPACT_PRESERVE_RECENT_BUBBLES)));
  }
  return messages;
}
