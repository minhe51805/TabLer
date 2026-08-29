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
      const turns = [`[${formatTurn(bubble.createdAt)}] User: ${userPrompt.trim()}`, `Assistant: ${replySample.trim()}`];
      // Agent tool observations are the bulk of any transcript (opencode
      // truncates them to 2k chars) — keep just enough to preserve facts.
      if (bubble.agentSteps?.length) {
        const observations = bubble.agentSteps
          .filter((step) => step.observation?.trim())
          .map((step) => truncateText(step.observation!, COMPACT_TOOL_OUTPUT_MAX_CHARS).trim());
        if (observations.length > 0) {
          turns.push(`Tool observations: ${observations.join(" | ")}`);
        }
      }
      return turns.join("\n");
    })
    .join("\n\n");
}

/** opencode caps tool output at 2000 chars before summarizing. */
export const COMPACT_TOOL_OUTPUT_MAX_CHARS = 2_000;

export function truncateText(text: string, maxChars: number) {
  return text.length > maxChars ? `${text.slice(0, maxChars).trimEnd()}…` : text;
}

/**
 * opencode's anchored summary template — another agent can resume the task
 * from this digest alone. Section headers stay canonical (English) while the
 * content is written in the conversation's language.
 */
export const COMPACT_SUMMARY_TEMPLATE = `Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response. Write the content in the same language as the conversation.
<template>
## Objective
- [one or two brief sentences describing what the user is trying to accomplish]

## Important Details
- [constraints/preferences, decisions and why, important facts/assumptions, exact identifiers (tables, columns, queries) needed to continue, or "(none)"]

## Work State
### Completed
- [finished work, verified facts, or changes made; otherwise "(none)"]

### Active
- [current work, partial changes, or investigation state; otherwise "(none)"]

### Open
- [next steps, unanswered questions; otherwise "(none)"]
</template>`;

const SUMMARY_UPDATE_INSTRUCTIONS = `Here is the summary of the conversation before the <conversation> above. Update it so it still holds everything relevant from BOTH the prior summary and the new conversation turns. Do not lose still-relevant facts, decisions or identifiers; drop anything that became obsolete.`;

export function buildCompactUserPrompt(transcript: string, previousDigest: string, workspaceName: string) {
  const conversation = `Here is the conversation so far:\n\n<conversation>\n${transcript}\n</conversation>`;
  const workspace = `Target workspace: ${workspaceName}.`;

  if (!previousDigest.trim()) {
    return [
      "You are compressing a work session transcript into a durable context digest so another assistant instance can continue the task without the original messages.",
      workspace,
      conversation,
      COMPACT_SUMMARY_TEMPLATE,
    ].join("\n\n");
  }

  return [
    "You are re-anchoring an existing context digest with newer conversation turns.",
    workspace,
    `Here is the summary of the conversation before the <conversation> above:\n\n<prior-summary>\n${previousDigest.trim()}\n</prior-summary>`,
    conversation,
    SUMMARY_UPDATE_INSTRUCTIONS,
    COMPACT_SUMMARY_TEMPLATE,
  ].join("\n\n");
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

const MEMORY_STOP_WORDS = new Set([
  "none", "with", "this", "that", "from", "have", "been", "were", "their", "which",
  "about", "into", "select", "where", "table", "update", "during", "these", "those",
  "while", "there", "then", "them", "they", "your", "yours", "keep", "mind", "task",
  "when", "what", "need", "some", "will", "would", "should", "could", "make", "made",
]);

/**
 * Codex-style keyword extraction for a memory entry: qualified identifiers
 * (`dbo.taikhoan`) rank highest, then snake_case tokens — those are the
 * searchable handles for finding related context later.
 */
export function extractMemoryKeywords(text: string, maxKeywords = 12): string[] {
  const scores = new Map<string, number>();
  const bump = (token: string, weight: number) => {
    const clean = token.trim().toLowerCase();
    if (clean.length < 3 || clean.length > 64 || MEMORY_STOP_WORDS.has(clean)) return;
    scores.set(clean, (scores.get(clean) ?? 0) + weight);
  };

  for (const match of text.matchAll(/\b[a-zA-Z][a-zA-Z0-9_]*\.[a-zA-Z][a-zA-Z0-9_]*\b/g)) {
    bump(match[0], 3);
  }
  for (const match of text.matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g)) {
    bump(match[0], 2);
  }

  return [...scores.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, maxKeywords)
    .map(([token]) => token);
}

/** Names a memory from the digest's Objective bullet, falling back cleanly. */
export function deriveMemoryTitle(digest: string, fallback: string): string {
  const objective = digest.match(/##\s*Objective\s*\n+-\s*([^\n]+)/i);
  const candidate = (
    objective?.[1]
    ?? digest.split("\n").find((line) => line.trim() && !line.trim().startsWith("#"))
    ?? ""
  )
    .replace(/^[-*\s]+/, "")
    .replace(/^(mình|tôi|goal|the user)\s*[:\-–]?\s*/i, "")
    .trim();

  const title = candidate || fallback;
  return title.length > 72 ? `${title.slice(0, 69).trimEnd()}...` : title;
}
