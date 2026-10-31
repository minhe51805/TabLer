/**
 * Names of the CustomEvent channels the renderer dispatches to itself across
 * components. One constant per channel because a listener is the one place a
 * typo fails open: the event simply never arrives and nothing errors.
 *
 * Add a channel here when it has more than one independent producer or
 * consumer; a single-site event can stay inline. The ESLint
 * `no-restricted-syntax` rule in eslint.config.js forbids these string
 * literals anywhere outside this file, so a new dispatch site is forced to
 * import the constant.
 */
export const APP_EVENTS = {
  /** Opens/closes the query schedules panel (keyboard, command palette, app menu). */
  toggleQuerySchedulesPalette: "toggle-query-schedules-palette",
} as const;

export type AppEventName = (typeof APP_EVENTS)[keyof typeof APP_EVENTS];
