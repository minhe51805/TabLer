/**
 * Central, tunable configuration for the Profiler.
 *
 * Everything here used to be a magic number scattered across the profiler
 * components (poll cadence, retained-event cap, copy-feedback timing, severity
 * thresholds, the disconnect sentinel). Keeping the knobs in one documented
 * place means they can be tuned — or later made user-configurable — without
 * hunting through the UI, and the Live Trace and Top Queries tabs stay
 * consistent instead of drifting apart with duplicated literals.
 */

/** Poll cadences (ms) the Live Trace offers in its "Every" selector. */
export const POLL_INTERVAL_CHOICES = [500, 1000, 2000, 5000] as const;

/**
 * Default poll cadence and the UI's hard floor: the trace never polls faster
 * than this, even if the backend advertises a smaller `minIntervalMs`.
 */
export const DEFAULT_POLL_INTERVAL_MS = 1000;

/**
 * Upper bound on retained trace events. Caps memory and keeps the table's
 * render cost bounded during a long capture; the oldest events roll off first.
 */
export const MAX_TRACE_EVENTS = 500;

/** How long the "Copied" confirmation stays lit after copying SQL (ms). */
export const COPY_FEEDBACK_MS = 1200;

/** Live Trace per-statement duration severity thresholds (ms). */
export const LIVE_DURATION_WARN_MS = 1000;
export const LIVE_DURATION_CRIT_MS = 5000;

/** Top Queries mean-time severity thresholds (ms). */
export const TOP_MEAN_WARN_MS = 100;
export const TOP_MEAN_CRIT_MS = 1000;

/**
 * Substring the backend emits when a connection's session no longer exists
 * (see `src-tauri/src/database/manager.rs`). The detached profiler window's
 * auto-close *safety net* matches on it; the primary close path is the
 * `PROFILER_CONNECTION_CLOSED_EVENT` broadcast. Kept here so the coupling to
 * the backend wording lives in exactly one documented place instead of being
 * buried inline in an effect.
 */
export const CONNECTION_GONE_MARKER = "not found. Please connect first.";
