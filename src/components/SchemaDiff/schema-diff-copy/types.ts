export interface SchemaDiffCopy {
  /** Dialog title. */
  title: string;
  /** Close button aria-label. */
  close: string;
  /** Source connection select placeholder / aria-label. */
  sourceConnection: string;
  /** Target connection select placeholder / aria-label. */
  targetConnection: string;
  /** Suffix on the active connection option. */
  activeSuffix: string;
  /** Suffix on connections that are not currently connected. */
  notConnectedSuffix: string;
  /** Source database select placeholder / aria-label (same-connection diff). */
  sourceDatabase: string;
  /** Target database select placeholder / aria-label (same-connection diff). */
  targetDatabase: string;
  /** Compare button label. */
  compare: string;
  /** Summary counts. */
  summaryAdded: (count: number) => string;
  summaryRemoved: (count: number) => string;
  summaryModified: (count: number) => string;
  summaryUnchanged: (count: number) => string;
  /** Badge shown when the backend capped the result set. */
  truncated: string;
  /** Tooltip on the truncated badge. */
  truncatedTitle: string;
  /** Group headers in the result list. */
  groupAdded: (count: number) => string;
  groupRemoved: (count: number) => string;
  groupModified: (count: number) => string;
  /** Empty state when both schemas are identical. */
  noDifferences: string;
  /** Migration dialect select aria-label. */
  dialectLabel: string;
  /** Toggle to include DROP statements in the migration script. */
  includeDrops: string;
  /** Generate migration button label. */
  generateMigration: string;
  /** Copy-script button label / aria-label. */
  copyScript: string;
}
