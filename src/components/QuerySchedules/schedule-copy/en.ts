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
  loading: "Loading...",
  statusNew: "new",
  every: (label) => `every ${label}`,
  ago: {
    seconds: (n) => `${n}s ago`,
    minutes: (n) => `${n}m ago`,
    hours: (n) => `${n}h ago`,
    days: (n) => `${n}d ago`,
  },
  rowsCount: (count) => `${count} rows`,
  loadFailed: "Could not load schedules",
  sqlRunOk: (name) => `Scheduled query ran: ${name}`,
  sqlRunOkRows: (rows) => `${rows} row(s) returned.`,
  sqlRunFailed: (name) => `Scheduled query failed: ${name}`,
  unknownError: "Unknown error.",
  agentReadOnlyHint:
    "Runs unattended while the app is open, read-only: it never changes data and never asks a question. Row data is only read and sent to the AI provider when the option below is checked — otherwise the task sees schema metadata only.",
  agentDataRead: "Allow this task to read data and send it to the AI provider",
};
