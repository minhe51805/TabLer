/**
 * First-run onboarding state — one flag the tour reads once, plus the
 * step/phase the tour needs to resume after a reload mid-walkthrough.
 *
 * Storage key is versioned (`v1`) — if the shape ever changes, bump the
 * suffix rather than migrate; a stale flag just replays the tour once.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";

export type TourPhase = "launcher" | "workspace" | "done";

interface OnboardingState {
  /** True once the tour finished or was skipped — gates the first mount. */
  hasCompletedTour: boolean;
  /** Which screen the tour is on (connection launcher vs workspace). */
  tourPhase: TourPhase;
  /** Index into the phase's step list — survives a reload mid-tour. */
  tourStepIndex: number;
  /** Mark done (either finished or skipped — same outcome for the user). */
  completeTour: () => void;
  /** Move to the next screen's step list. */
  setTourPhase: (phase: TourPhase) => void;
  setTourStepIndex: (index: number) => void;
  /** Reset for Help → "Restart tour". */
  restartTour: () => void;
}

export const useOnboardingStore = create<OnboardingState>()(
  persist(
    (set) => ({
      hasCompletedTour: false,
      tourPhase: "launcher",
      tourStepIndex: 0,
      completeTour: () => set({ hasCompletedTour: true, tourPhase: "done", tourStepIndex: 0 }),
      setTourPhase: (tourPhase) => set({ tourPhase, tourStepIndex: 0 }),
      setTourStepIndex: (tourStepIndex) => set({ tourStepIndex }),
      restartTour: () => set({ hasCompletedTour: false, tourPhase: "launcher", tourStepIndex: 0 }),
    }),
    {
      name: "tabler.onboarding.v1",
      // Persist the flag + phase only. `tourStepIndex` resets on reload —
      // resuming inside the transient "creating" step would otherwise
      // dead-end (no connection is actually in flight after a restart).
      partialize: (state) => ({
        hasCompletedTour: state.hasCompletedTour,
        tourPhase: state.tourPhase === "done" ? "done" : "launcher",
      }),
    },
  ),
);
