/**
 * Frontend mirror of the backend AI request validation caps.
 *
 * Single source of truth on the frontend (tech-debt audit D1): before this file
 * the numbers lived as loose literals in `ai-conversation-state.ts`. The backend
 * copy lives in `src-tauri/src/config.rs`; exceeding EITHER history cap makes the
 * backend reject the whole request, so the frontend clamps to the same values.
 *
 * The cross-language contract test `tests/config/backend-contract.test.ts` reads
 * `config.rs` and fails the build if these ever drift from Rust.
 */

/** Max characters in a single prompt. */
export const AI_MAX_PROMPT_CHARS = 80_000;
/** Max characters in the schema/context blob. */
export const AI_MAX_CONTEXT_CHARS = 50_000;
/** Max number of prior conversation messages replayed on a send. */
export const AI_MAX_HISTORY_MESSAGES = 12;
/** Max total characters across all replayed history messages. */
export const AI_MAX_HISTORY_CHARS = 24_000;
/** Max characters in the machine-generated native tool definitions payload. */
export const AI_MAX_TOOLS_CHARS = 20_000;
