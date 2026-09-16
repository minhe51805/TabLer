/**
 * Central frontend tunables (tech-debt audit D9).
 *
 * Barrel for the frontend "config" surface. Today it re-exports the AI request
 * caps that must stay in lock-step with the Rust backend (`src-tauri/src/config.rs`).
 * New frontend-only tunables that deserve a single, auditable home (poll
 * intervals, cache TTLs, agent budgets) can be centralized here over time
 * instead of scattering fresh literals across components.
 */
export * from "./ai-limits";
