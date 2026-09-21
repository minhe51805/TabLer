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

/// Anthropic Context Editing beta header value. Sent as `anthropic-beta`
/// alongside `ANTHROPIC_API_VERSION` on Anthropic tool/agent requests so the
/// server can prune stale `tool_use`/`tool_result` pairs itself (see
/// `providers::anthropic_context_management`). Bump here only, like D3.
pub const ANTHROPIC_CONTEXT_MANAGEMENT_BETA: &str = "context-management-2025-06-27";
/// Prompt input-token threshold at which the server starts clearing old tool
/// results (`clear_tool_uses_20250919.trigger`). Set high enough that short
/// agent runs are untouched, but below the compact/token budgets so it relieves
/// pressure before those fire.
pub const ANTHROPIC_CONTEXT_CLEAR_TRIGGER_TOKENS: u32 = 100_000;
/// How many of the most recent tool_use/result pairs the server keeps when it
/// clears (`clear_tool_uses_20250919.keep`).
pub const ANTHROPIC_CONTEXT_KEEP_TOOL_USES: u32 = 3;
/// Minimum tokens the server must reclaim per clear, so a clear is worth moving
/// the prompt-cache breakpoint (`clear_tool_uses_20250919.clear_at_least`).
pub const ANTHROPIC_CONTEXT_CLEAR_AT_LEAST_TOKENS: u32 = 10_000;

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

/// Lower bound for a per-query `timeout_ms` override (1 second). A caller can
/// never pick a window too small to ever finish a real statement: sub-second
/// values are clamped up to this floor.
pub const MIN_QUERY_TIMEOUT_MS: u64 = 1_000;
/// Upper bound for a per-query `timeout_ms` override (10 minutes). A runaway or
/// typo can never disable the safety net: larger values are clamped down here.
pub const MAX_QUERY_TIMEOUT_MS: u64 = 600_000;

/// Pure resolver for a per-query timeout override (roadmap Phase 3D backend
/// perf): when the caller supplies a positive `timeout_ms`, clamp it to
/// `[MIN_QUERY_TIMEOUT_MS, MAX_QUERY_TIMEOUT_MS]`; otherwise fall back to the
/// classified `default_window` (read-only vs mutating). `None`/`Some(0)` leave
/// behaviour unchanged. Kept pure so it is unit-testable without a live driver.
pub fn resolve_query_timeout(timeout_ms: Option<u64>, default_window: Duration) -> Duration {
    match timeout_ms.filter(|&ms| ms > 0) {
        Some(ms) => Duration::from_millis(ms.clamp(MIN_QUERY_TIMEOUT_MS, MAX_QUERY_TIMEOUT_MS)),
        None => default_window,
    }
}

/// Pure resolver for a per-connection query timeout (the `query_timeout_seconds`
/// field on `ConnectionConfig`): when the connection supplies a positive number
/// of seconds, clamp it to the same `[MIN_QUERY_TIMEOUT_MS, MAX_QUERY_TIMEOUT_MS]`
/// window a per-query override gets; otherwise fall back to the classified
/// `default_window`. `None`/`Some(0)` leave behaviour unchanged.
pub fn resolve_connection_query_timeout(
    timeout_seconds: Option<u64>,
    default_window: Duration,
) -> Duration {
    match timeout_seconds.filter(|&secs| secs > 0) {
        Some(secs) => Duration::from_millis(
            secs.saturating_mul(1_000)
                .clamp(MIN_QUERY_TIMEOUT_MS, MAX_QUERY_TIMEOUT_MS),
        ),
        None => default_window,
    }
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
/// Used as the fallback when a connection does not set its own override.
pub const POOL_MAX_CONNECTIONS: u32 = 8;

/// Lower bound for a per-connection pool-size override. A pool must keep at
/// least one usable connection (the drivers set `min_connections(1)`), so any
/// smaller positive value clamps up to this floor.
pub const MIN_POOL_MAX_CONNECTIONS: u32 = 1;
/// Upper bound for a per-connection pool-size override. A typo can never
/// exhaust the server's connection budget: larger values clamp down here.
pub const MAX_POOL_MAX_CONNECTIONS: u32 = 64;

/// Pure resolver for a per-connection pool-size override (roadmap Phase 3D
/// backend perf): when the caller supplies a positive `max_connections`, clamp
/// it to `[MIN_POOL_MAX_CONNECTIONS, MAX_POOL_MAX_CONNECTIONS]`; otherwise fall
/// back to the compiled `POOL_MAX_CONNECTIONS` default. `None`/`Some(0)` leave
/// behaviour unchanged. Kept pure so it is unit-testable without a live driver.
pub fn resolve_pool_max_connections(max_connections: Option<u32>) -> u32 {
    match max_connections.filter(|&n| n > 0) {
        Some(n) => n.clamp(MIN_POOL_MAX_CONNECTIONS, MAX_POOL_MAX_CONNECTIONS),
        None => POOL_MAX_CONNECTIONS,
    }
}

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

    #[test]
    fn query_timeout_override_falls_back_when_absent_or_zero() {
        let default = Duration::from_secs(180);
        assert_eq!(resolve_query_timeout(None, default), default);
        assert_eq!(resolve_query_timeout(Some(0), default), default);
    }

    #[test]
    fn query_timeout_override_uses_valid_positive_millis() {
        let default = Duration::from_secs(180);
        assert_eq!(
            resolve_query_timeout(Some(30_000), default),
            Duration::from_millis(30_000)
        );
    }

    #[test]
    fn query_timeout_override_clamps_to_the_documented_bounds() {
        let default = Duration::from_secs(180);
        // Below the 1s floor clamps up; above the 10min ceiling clamps down.
        assert_eq!(
            resolve_query_timeout(Some(1), default),
            Duration::from_millis(MIN_QUERY_TIMEOUT_MS)
        );
        assert_eq!(
            resolve_query_timeout(Some(u64::MAX), default),
            Duration::from_millis(MAX_QUERY_TIMEOUT_MS)
        );
        assert_eq!(MIN_QUERY_TIMEOUT_MS, 1_000);
        assert_eq!(MAX_QUERY_TIMEOUT_MS, 600_000);
    }

    #[test]
    fn connection_query_timeout_falls_back_when_absent_or_zero() {
        let default = Duration::from_secs(180);
        assert_eq!(resolve_connection_query_timeout(None, default), default);
        assert_eq!(resolve_connection_query_timeout(Some(0), default), default);
    }

    #[test]
    fn connection_query_timeout_uses_seconds_and_clamps_to_bounds() {
        let default = Duration::from_secs(180);
        assert_eq!(
            resolve_connection_query_timeout(Some(5), default),
            Duration::from_secs(5)
        );
        // Above the 10-minute ceiling clamps down; a saturating multiply keeps
        // u64::MAX from overflowing.
        assert_eq!(
            resolve_connection_query_timeout(Some(u64::MAX), default),
            Duration::from_millis(MAX_QUERY_TIMEOUT_MS)
        );
    }

    #[test]
    fn pool_max_connections_falls_back_when_absent_or_zero() {
        assert_eq!(POOL_MAX_CONNECTIONS, 8);
        assert_eq!(resolve_pool_max_connections(None), POOL_MAX_CONNECTIONS);
        assert_eq!(resolve_pool_max_connections(Some(0)), POOL_MAX_CONNECTIONS);
    }

    #[test]
    fn pool_max_connections_uses_valid_positive_overrides() {
        assert_eq!(resolve_pool_max_connections(Some(4)), 4);
        assert_eq!(resolve_pool_max_connections(Some(20)), 20);
    }

    #[test]
    fn pool_max_connections_clamps_to_the_documented_bounds() {
        // A positive value at the floor is preserved; a huge value clamps down
        // to the ceiling so a typo can never exhaust the server's budget.
        assert_eq!(
            resolve_pool_max_connections(Some(1)),
            MIN_POOL_MAX_CONNECTIONS
        );
        assert_eq!(
            resolve_pool_max_connections(Some(u32::MAX)),
            MAX_POOL_MAX_CONNECTIONS
        );
        assert_eq!(MIN_POOL_MAX_CONNECTIONS, 1);
        assert_eq!(MAX_POOL_MAX_CONNECTIONS, 64);
    }
}
