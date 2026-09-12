//! Central tunable constants for the Rust backend.
//!
//! Rationale (tech-debt audit D9): before this module the same knobs lived as
//! scattered `const`s across `query.rs`, `providers.rs`, `execution.rs`,
//! `postgres.rs`, `mysql.rs` and `ai_models.rs`. That made them impossible to
//! audit in one place and easy to drift from their frontend mirrors. Every
//! value below is the single source of truth; call-sites re-export or read
//! from here instead of hard-coding their own literal.
//!
//! Frontend mirror: `src/config/*` and the cross-language contract test
//! `tests/config/backend-contract.test.ts` assert the shared values match.

use std::time::Duration;

// ─────────────────────────────────────────────────────────────────────────
// AI request validation caps (D1)
//
// Mirrored in `src/config/ai-limits.ts`. Exceeding EITHER history cap makes the
// backend reject the whole request, so the frontend clamps to the same numbers.
// Keep these in sync — the contract test fails the build if they drift.
// ─────────────────────────────────────────────────────────────────────────

/// Max characters in a single prompt (agent prompts embed trace + schema).
pub const AI_MAX_PROMPT_CHARS: usize = 80_000;
/// Max characters in the schema/context blob.
pub const AI_MAX_CONTEXT_CHARS: usize = 50_000;
/// Max number of prior conversation messages replayed on a send.
pub const AI_MAX_HISTORY_MESSAGES: usize = 12;
/// Max total characters across all replayed history messages.
pub const AI_MAX_HISTORY_CHARS: usize = 24_000;
/// Max characters in the machine-generated native tool definitions payload.
pub const AI_MAX_TOOLS_CHARS: usize = 20_000;

// ─────────────────────────────────────────────────────────────────────────
// AI provider wire config (D3 + D10)
// ─────────────────────────────────────────────────────────────────────────

/// Anthropic Messages API version header. Bump here only (D3): it used to be
/// repeated as a bare string literal at four call-sites in `execution.rs`.
pub const ANTHROPIC_API_VERSION: &str = "2023-06-01";

/// Default answer-token ceiling for terse inline completions.
pub const AI_INLINE_MAX_OUTPUT_TOKENS: u32 = 256;
/// Default answer-token ceiling for the panel/agent controller (needs room to
/// close the JSON action object plus a markdown explanation).
pub const AI_PANEL_MAX_OUTPUT_TOKENS: u32 = 4_096;
/// Extended-thinking budget added ON TOP of the answer budget for Anthropic
/// panel turns (Anthropic counts thinking tokens against `max_tokens`).
pub const ANTHROPIC_THINKING_BUDGET_TOKENS: u32 = 2_048;
/// Base backoff between provider retries; scaled by attempt number.
pub const AI_RETRY_BACKOFF_BASE_MS: u64 = 800;

// ─────────────────────────────────────────────────────────────────────────
// Query execution (D5 + D10)
// ─────────────────────────────────────────────────────────────────────────

/// Default wall-clock ceiling for a read-only batch.
pub const DEFAULT_READ_ONLY_QUERY_TIMEOUT_SECS: u64 = 180;
/// Default wall-clock ceiling for any mutating/DDL batch (mixed batches too).
pub const DEFAULT_MUTATING_QUERY_TIMEOUT_SECS: u64 = 60;

/// Env override for the read-only timeout (power-user "valve", D5).
pub const READ_TIMEOUT_ENV: &str = "TABLER_READ_TIMEOUT_SECS";
/// Env override for the mutating timeout (power-user "valve", D5).
pub const MUTATING_TIMEOUT_ENV: &str = "TABLER_MUTATING_TIMEOUT_SECS";

/// Pure resolver: parse an override string, ignore blank/zero/garbage, and fall
/// back to `default_secs`. Kept pure so it is unit-testable without touching the
/// process environment.
fn resolve_timeout_secs(raw: Option<&str>, default_secs: u64) -> u64 {
    raw.and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|&secs| secs > 0)
        .unwrap_or(default_secs)
}

/// Read-only query timeout, honouring `TABLER_READ_TIMEOUT_SECS` when set to a
/// positive integer, otherwise the compiled default (behaviour unchanged unless
/// the operator opts in).
pub fn read_only_query_timeout() -> Duration {
    let raw = std::env::var(READ_TIMEOUT_ENV).ok();
    Duration::from_secs(resolve_timeout_secs(
        raw.as_deref(),
        DEFAULT_READ_ONLY_QUERY_TIMEOUT_SECS,
    ))
}

/// Mutating/DDL query timeout, honouring `TABLER_MUTATING_TIMEOUT_SECS`.
pub fn mutating_query_timeout() -> Duration {
    let raw = std::env::var(MUTATING_TIMEOUT_ENV).ok();
    Duration::from_secs(resolve_timeout_secs(
        raw.as_deref(),
        DEFAULT_MUTATING_QUERY_TIMEOUT_SECS,
    ))
}

// ─────────────────────────────────────────────────────────────────────────
// Sandbox result caps for AI-agent reads (D10)
// ─────────────────────────────────────────────────────────────────────────

/// Max rows an AI-agent sandbox read may return before it is truncated.
pub const SANDBOX_AGENT_MAX_ROWS: usize = 5_000;
/// Rough max JSON footprint of an AI-agent sandbox read before truncation.
pub const SANDBOX_AGENT_MAX_RESULT_BYTES: usize = 8 * 1024 * 1024;

// ─────────────────────────────────────────────────────────────────────────
// Connection pool (D10)
// ─────────────────────────────────────────────────────────────────────────

/// Max pooled connections per Postgres/MySQL connection (desktop, single-user).
pub const POOL_MAX_CONNECTIONS: u32 = 8;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timeout_override_prefers_valid_positive_integers() {
        assert_eq!(resolve_timeout_secs(Some("300"), 180), 300);
        assert_eq!(resolve_timeout_secs(Some("  45 "), 60), 45);
    }

    #[test]
    fn timeout_override_falls_back_on_blank_zero_or_garbage() {
        assert_eq!(resolve_timeout_secs(None, 180), 180);
        assert_eq!(resolve_timeout_secs(Some(""), 180), 180);
        assert_eq!(resolve_timeout_secs(Some("0"), 180), 180);
        assert_eq!(resolve_timeout_secs(Some("-5"), 180), 180);
        assert_eq!(resolve_timeout_secs(Some("abc"), 60), 60);
    }

    #[test]
    fn compiled_defaults_are_the_documented_windows() {
        assert_eq!(DEFAULT_READ_ONLY_QUERY_TIMEOUT_SECS, 180);
        assert_eq!(DEFAULT_MUTATING_QUERY_TIMEOUT_SECS, 60);
    }
}
