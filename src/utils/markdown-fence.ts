/**
 * Unwraps the first ``` fenced code block from a markdown paste
 * (e.g. "```sql\nSELECT ...\n```" copied out of an AI answer).
 *
 * Anything outside the first block is dropped — a trailing resolved-example
 * block must not be executed. Input that does not start with a fence, or
 * whose fence never closes, is returned untouched.
 */
export function stripMarkdownFence(input: string): string {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith("```")) return input;
  // Opening fence: ``` plus an optional language tag, ending at the newline.
  const openEnd = trimmed.indexOf("\n");
  if (openEnd === -1) return input;
  const body = trimmed.slice(openEnd + 1);
  const close = body.indexOf("```");
  if (close === -1) return input;
  return body.slice(0, close).trim();
}
