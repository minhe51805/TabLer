import { GitCompareArrows, Pin, PinOff } from "lucide-react";
import type { QueryResult } from "../../types";
import { useI18n } from "../../i18n";
import { emitAppToast } from "../../utils/app-toast";
import { getResultDiffCopy } from "./result-diff-copy";
import { useResultDiffStore } from "./result-diff-store";

interface ResultDiffControlsProps {
  /** The result currently rendered by the grid (null while loading). */
  result: QueryResult | null;
  /** Label used for the pinned snapshot (table name or SQL). */
  label: string;
}

/**
 * Pin / Compare buttons for the data-grid toolbar. Pinning stores a snapshot
 * in `useResultDiffStore`; once a different result is shown, Compare opens the
 * `ResultDiffModal` (mounted globally in AppGlobalModals).
 */
export function ResultDiffControls({ result, label }: ResultDiffControlsProps) {
  const { language } = useI18n();
  const copy = getResultDiffCopy(language);
  const pinned = useResultDiffStore((state) => state.pinned);
  const pin = useResultDiffStore((state) => state.pin);
  const unpin = useResultDiffStore((state) => state.unpin);
  const openCompare = useResultDiffStore((state) => state.openCompare);

  if (!result || result.rows.length === 0) return null;

  const isPinnedSource = pinned !== null && pinned.source === result;

  const handlePin = () => {
    if (isPinnedSource) {
      unpin();
      return;
    }
    pin(result, label);
    emitAppToast({ title: copy.pinnedToast, tone: "success", durationMs: 4000 });
  };

  return (
    <>
      <button
        type="button"
        className={`datagrid-footer-action${isPinnedSource ? " active" : ""}`}
        onClick={handlePin}
        title={isPinnedSource ? copy.unpin : copy.pinTitle}
        aria-label={isPinnedSource ? copy.unpin : copy.pin}
      >
        {isPinnedSource ? <PinOff className="!w-3.5 !h-3.5" /> : <Pin className="!w-3.5 !h-3.5" />}
        <span>{isPinnedSource ? copy.unpin : copy.pin}</span>
      </button>
      {pinned !== null && !isPinnedSource && (
        <button
          type="button"
          className="datagrid-footer-action"
          onClick={() => openCompare(result, label)}
          title={copy.compareTitle(pinned.label)}
          aria-label={copy.compare}
        >
          <GitCompareArrows className="!w-3.5 !h-3.5" />
          <span>{copy.compare}</span>
        </button>
      )}
    </>
  );
}
