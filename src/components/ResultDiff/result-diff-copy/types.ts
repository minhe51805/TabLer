export interface ResultDiffCopy {
  /** Dialog title. */
  title: string;
  /** Close button aria-label. */
  close: string;
  /** Toolbar button: pin the current result. */
  pin: string;
  /** Toolbar button tooltip when nothing is pinned yet. */
  pinTitle: string;
  /** Toolbar button: this grid is the pinned result; click to unpin. */
  unpin: string;
  /** Toolbar button: compare the current result against the pinned one. */
  compare: string;
  /** Tooltip on the compare button; `label` is the pinned result label. */
  compareTitle: (label: string) => string;
  /** Toast shown after pinning. */
  pinnedToast: string;
  /** Modal header labels for the two sides. */
  pinnedSide: string;
  currentSide: string;
  /** How rows were matched. */
  matchByPk: (columns: string) => string;
  matchByIndex: string;
  /** Summary counts. */
  summaryAdded: (count: number) => string;
  summaryRemoved: (count: number) => string;
  summaryChanged: (count: number) => string;
  summaryUnchanged: (count: number) => string;
  /** Group headers in the result list. */
  groupAdded: (count: number) => string;
  groupRemoved: (count: number) => string;
  groupChanged: (count: number) => string;
  /** Column-set notes. */
  columnsOnlyInPinned: (columns: string) => string;
  columnsOnlyInCurrent: (columns: string) => string;
  /** Empty state when both results are identical. */
  noDifferences: string;
  /** Badge when the pinned snapshot was capped. */
  pinnedTruncated: (limit: number) => string;
  /** Row cap note when a group renders only the first N rows. */
  showingFirst: (shown: number, total: number) => string;
}
