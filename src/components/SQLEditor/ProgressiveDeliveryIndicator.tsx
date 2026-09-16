import { memo } from "react";
import { Loader2 } from "lucide-react";

import { useI18n } from "../../i18n";
import { useQueryStore } from "../../stores/queryStore";

/**
 * Live progressive-delivery indicator (roadmap Phase 3B surfaced via Phase 3C).
 *
 * Subscribes to ONLY `progressiveRowCount` so the high-frequency
 * `query-row-batch` store updates re-render just this small, memoized node
 * instead of the whole results pane. Renders nothing while idle
 * (`progressiveRowCount === null`), i.e. when no query is streaming rows.
 */
function ProgressiveDeliveryIndicatorImpl() {
  const { t } = useI18n();
  const rowCount = useQueryStore((state) => state.progressiveRowCount);

  if (rowCount === null) return null;

  return (
    <span
      className="sql-results-progress inline-flex items-center gap-1 text-[var(--fintech-green)]"
      role="status"
      aria-live="polite"
    >
      <Loader2 className="w-3 h-3 animate-spin" />
      <span>{t("tabs.deliveringRows", { count: rowCount.toLocaleString() })}</span>
    </span>
  );
}

export const ProgressiveDeliveryIndicator = memo(ProgressiveDeliveryIndicatorImpl);
