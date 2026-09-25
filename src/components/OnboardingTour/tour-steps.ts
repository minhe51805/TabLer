/**
 * Step definitions for the onboarding tour — the task funnel, not a UI tour.
 *
 * `phase` decides which screen the step runs on. `selector` is resolved at
 * step-start via `document.querySelector` so re-renders never go stale; a
 * missing target skips the step silently. `advanceOn` controls whether the
 * user clicks the target themselves (`"click"`) or advances via Next.
 */

export type TourPhase = "launcher" | "workspace";
export type TourAdvance = "next" | "click" | "auto";

export interface TourStep {
  id: string;
  phase: TourPhase;
  /** CSS selector resolved fresh when the step starts. */
  selector?: string;
  /** Preferred popover placement relative to the cutout. */
  placement?: "top" | "bottom" | "left" | "right";
  advanceOn: TourAdvance;
  /** How long to wait for the target before skipping (default 5 s). */
  waitMs?: number;
  /**
   * When this selector already matches a usable element, skip the step
   * instantly (e.g. "expand Tables" is unnecessary when the folder is
   * already open and `customers` is on screen).
   */
  skipIfSelector?: string;
}
export const TOUR_STEPS: TourStep[] = [
  {
    id: "launcher-sample",
    phase: "launcher",
    selector: '[data-tour="startup-sample-db"]',
    placement: "bottom",
    advanceOn: "click",
  },
  {
    id: "launcher-creating",
    phase: "launcher",
    // No spotlight — the sample CTA is already gone/disabled while the
    // connection is being created; center the popover instead. Only entered
    // when the sample click fired (see `samplePending` in OnboardingTour).
    advanceOn: "auto",
  },
  {
    id: "launcher-pick",
    phase: "launcher",
    selector: '[data-tour="connection-list"]',
    placement: "left",
    advanceOn: "auto",
  },
  {
    id: "workspace-sidebar",
    phase: "workspace",
    selector: '[data-tour="sidebar-tree"]',
    placement: "right",
    advanceOn: "next",
    // The sidebar mounts a beat after the workspace shell swaps in — give
    // the first workspace step extra room before counting it missing.
    waitMs: 15000,
  },
  {
    id: "workspace-expand-tables",
    phase: "workspace",
    // Folders render as `folder-{id}` rows; "tables" is the one holding
    // the sample tables. Skips instantly when `customers` is already
    // visible (i.e. the folder arrived expanded).
    selector: '[data-tour="folder-tables"]',
    skipIfSelector: '[data-testid$="-customers"]',
    placement: "right",
    advanceOn: "click",
  },
  {
    id: "workspace-open-table",
    phase: "workspace",
    // Any `customers` row in the tree — schema prefix varies per engine.
    selector: '[data-testid$="-customers"]',
    placement: "right",
    advanceOn: "click",
  },
  {
    id: "workspace-grid",
    phase: "workspace",
    selector: '[data-testid="data-grid"]',
    placement: "top",
    advanceOn: "next",
  },
  {
    id: "workspace-edit",
    phase: "workspace",
    selector: '[data-testid="data-grid"]',
    placement: "top",
    advanceOn: "next",
  },
  {
    id: "workspace-toolbar",
    phase: "workspace",
    selector: '[data-tour="grid-toolbar"]',
    placement: "bottom",
    advanceOn: "next",
  },
  {
    id: "workspace-sql-tab",
    phase: "workspace",
    selector: '[data-tour="new-query"]',
    placement: "bottom",
    advanceOn: "next",
  },
  {
    id: "workspace-ai",
    phase: "workspace",
    selector: '[data-tour="ai-trigger"]',
    placement: "left",
    advanceOn: "click",
  },
];
