import type { ScheduleCopy } from "./types";

export const EN_COPY: ScheduleCopy = {
  missedBanner: (count) => `${count} run${count === 1 ? "" : "s"} missed while the app was closed`,
  missedDismiss: "Dismiss",
  statusMissed: "missed",
  catchUp: "When the app was closed",
  catchUpSkip: "Skip missed runs",
  catchUpRunOnce: "Run once on next launch",
  missedToast: (count) =>
    `${count} scheduled run${count === 1 ? "" : "s"} missed while the app was closed`,
};
