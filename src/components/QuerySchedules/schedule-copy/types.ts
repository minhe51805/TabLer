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
  /** Loading placeholder while the schedule list is being fetched. */
  loading: string;
  /** Status tag on a schedule that has never run. */
  statusNew: string;
  /** Interval tag, e.g. "every 30m". */
  every: (label: string) => string;
  /** Relative "last ran" labels. */
  ago: {
    seconds: (n: number) => string;
    minutes: (n: number) => string;
    hours: (n: number) => string;
    days: (n: number) => string;
  };
  /** Row-count suffix on the last-run line. */
  rowsCount: (count: number) => string;
  /** Toast when the schedule list cannot be loaded. */
  loadFailed: string;
  /** Toast when a scheduled SQL run succeeds; {name} is the schedule name. */
  sqlRunOk: (name: string) => string;
  /** Detail line for the success toast; {rows} is the returned row count. */
  sqlRunOkRows: (rows: number) => string;
  /** Toast when a scheduled SQL run fails; {name} is the schedule name. */
  sqlRunFailed: (name: string) => string;
  /** Fallback detail when a failed run reports no error message. */
  unknownError: string;
  /**
   * Hint under the agent-task prompt: the task runs unattended and read-only;
   * row data only leaves the machine when the opt-in below is checked.
   */
  agentReadOnlyHint: string;
  /** Checkbox label opting the task into reading data for the AI provider. */
  agentDataRead: string;
}
