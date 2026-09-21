export interface ScheduleCopy {
  /** Banner above the schedule list: "N runs missed while the app was closed". */
  missedBanner: (count: number) => string;
  /** Dismiss button on the missed-runs banner. */
  missedDismiss: string;
  /** Status tag on a schedule whose last occurrence(s) were missed. */
  statusMissed: string;
  /** Label for the catch-up policy select in the editor. */
  catchUp: string;
  /** Policy: skip missed occurrences, resume on the next boundary. */
  catchUpSkip: string;
  /** Policy: run a single catch-up run on the next launch. */
  catchUpRunOnce: string;
  /** Toast shown at boot when missed runs were recorded. */
  missedToast: (count: number) => string;
}
