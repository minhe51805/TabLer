export interface DataGridChartCopy {
  chart: {
    /** Toolbar button + modal title. */
    title: string;
    /** Toolbar button tooltip/aria-label (distinct from the view toggle). */
    buttonTitle: string;
    /** Chart-type picker group label. */
    type: string;
    /** X axis select label. */
    xAxis: string;
    /** Y axis multi-select label. */
    yAxis: string;
    /** Pie chart value select label. */
    value: string;
    /** Close button aria-label. */
    close: string;
    /** Empty state when the result has no rows. */
    noRows: string;
    /** Empty state when no numeric column exists. */
    noNumeric: string;
  };
  autoRefresh: {
    /** Dropdown button tooltip. */
    title: string;
    /** "Off" menu item. */
    off: string;
    /** Menu item for an interval, e.g. "Every 5 seconds". */
    everySeconds: (seconds: number) => string;
    /** Button label while active, e.g. "12s". */
    countdown: (seconds: number) => string;
    /** Toast when auto-refresh is stopped because editing started. */
    stoppedForEdit: string;
  };
}
