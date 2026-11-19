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
  tableDataUpdated: "table-data-updated",
  tableStructureUpdated: "table-structure-updated",
  workspaceActivity: "workspace-activity",
  schemaCacheInvalidated: "schema-cache-invalidated",
  metricsBoardsUpdated: "metrics-boards-updated",
  focusMetricsWidget: "focus-metrics-widget",
  openAISlidePanel: "open-ai-slide-panel",
  openAIWorkspaceQuery: "open-ai-workspace-query",
  openAIMetricsBoard: "open-ai-metrics-board",
  openAIMetricsBoardComplete: "open-ai-metrics-board-complete",
  openAISettings: "open-ai-settings",
  openLeftSidebarPanel: "open-left-sidebar-panel",
  insertSqlFromAI: "insert-sql-from-ai",
  toggleQueryResultsPane: "toggle-query-results-pane",
  focusExplorerSearch: "focus-explorer-search",
  openLiveProfiler: "open-live-profiler",
  openKeyboardShortcutsPalette: "open-keyboard-shortcuts-palette",
  datagridUndo: "datagrid-undo",
  datagridRedo: "datagrid-redo",
  datagridDuplicateRow: "datagrid-duplicate-row",
  datagridFkPreview: "datagrid-fk-preview",
  formatSqlPalette: "format-sql-palette",
  focusSqlEditorPalette: "focus-sql-editor-palette",
  focusResultsPalette: "focus-results-palette",
  openSqlFilePalette: "open-sql-file-palette",
  importSqlFilePalette: "import-sql-file-palette",
  clearAiHistoryPalette: "clear-ai-history-palette",
  fontScaleChanged: "font-scale-changed",
  openConnectionFormPalette: "open-connection-form-palette",
  openDataImportPalette: "open-data-import-palette",
  openSchemaDiffPalette: "open-schema-diff-palette",
  launcherFocusConnection: "launcher-focus-connection",
} as const;

export type AppEventName = (typeof APP_EVENTS)[keyof typeof APP_EVENTS];
