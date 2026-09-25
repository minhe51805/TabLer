/**
 * Pending Edits tab — every staged grid change, grouped by table scope.
 * Per-change approve/discard plus per-group and global apply/discard.
 * Reuses the ct-* preview styles from the change-tracking modal.
 */

import { useMemo, useState } from "react";
import { AlertTriangle, Check, X } from "lucide-react";
import { StagedChangeDetail } from "../DataGrid/components/StagedChangeDetail";
import {
  changeScopeKey,
  useChangeTrackingStore,
  type ScopedStagedChange,
} from "../../stores/change-tracking-store";
import { useConnectionStore } from "../../stores/connectionStore";
import { emitAppToast } from "../../utils/app-toast";
import { commitStagedChanges, discardStagedChanges } from "./staged-change-commit";
import type { ReviewCenterCopy } from "./review-center-copy";

interface PendingEditsTabProps {
  copy: ReviewCenterCopy;
}

interface ChangeGroup {
  scopeKey: string;
  connectionId: string;
  tableName: string;
  database?: string;
  changes: ScopedStagedChange[];
}

export function PendingEditsTab({ copy }: PendingEditsTabProps) {
  const stagedChanges = useChangeTrackingStore((s) => s.stagedChanges);
  const selectedChangeId = useChangeTrackingStore((s) => s.selectedChangeId);
  const selectChange = useChangeTrackingStore((s) => s.selectChange);
  const connections = useConnectionStore((s) => s.connections);
  const [applyingIds, setApplyingIds] = useState<ReadonlySet<string>>(new Set());
  const [isApplyingAll, setIsApplyingAll] = useState(false);

  const groups = useMemo<ChangeGroup[]>(() => {
    const byScope = new Map<string, ChangeGroup>();
    for (const change of stagedChanges) {
      const scopeKey = changeScopeKey(change.connectionId ?? "", change.database, change.tableName);
      const group = byScope.get(scopeKey) ?? {
        scopeKey,
        connectionId: change.connectionId ?? "",
        tableName: change.tableName,
        database: change.database,
        changes: [],
      };
      group.changes.push(change);
      byScope.set(scopeKey, group);
    }
    return [...byScope.values()];
  }, [stagedChanges]);

  const selectedChange =
    stagedChanges.find((c) => c.id === selectedChangeId) ?? stagedChanges[0] ?? null;

  const runApply = async (changes: ScopedStagedChange[], all = false) => {
    const ids = changes.map((c) => c.id);
    if (all) setIsApplyingAll(true);
    else setApplyingIds((prev) => new Set([...prev, ...ids]));
    try {
      await commitStagedChanges(changes, copy.pendingEdits);
      emitAppToast({ tone: "success", title: copy.pendingEdits.appliedToast(changes.length) });
    } catch (errorValue) {
      emitAppToast({
        tone: "error",
        title: copy.pendingEdits.applyFailedTitle,
        description: errorValue instanceof Error ? errorValue.message : String(errorValue),
      });
    } finally {
      if (all) setIsApplyingAll(false);
      else
        setApplyingIds((prev) => {
          const next = new Set(prev);
          for (const id of ids) next.delete(id);
          return next;
        });
    }
  };

  const runDiscard = (changes: ScopedStagedChange[]) => {
    discardStagedChanges(changes);
    emitAppToast({ tone: "info", title: copy.pendingEdits.discardedToast(changes.length) });
  };
  if (stagedChanges.length === 0) {
    return <div className="rc-empty">{copy.pendingEdits.empty}</div>;
  }

  return (
    <div className="rc-edits">
      <div className="rc-edits-body">
        {/* Change list, grouped by table */}
        <div className="ct-change-list rc-change-list">
          {groups.map((group) => (
            <div key={group.scopeKey} className="rc-change-group">
              <div className="rc-change-group-head">
                <div className="rc-change-group-title">
                  <strong>{copy.pendingEdits.groupTitle(group.tableName, group.database)}</strong>
                  {group.connectionId && (
                    <span className="rc-change-group-conn">
                      {copy.pendingEdits.connectionLabel(
                        connections.find((c) => c.id === group.connectionId)?.name ??
                          group.connectionId,
                      )}
                    </span>
                  )}
                </div>
                <div className="rc-change-group-actions">
                  <button
                    type="button"
                    className="rc-mini-btn"
                    disabled={isApplyingAll}
                    onClick={() => void runApply(group.changes)}
                  >
                    {copy.pendingEdits.applyGroup(group.changes.length)}
                  </button>
                  <button
                    type="button"
                    className="rc-mini-btn danger"
                    disabled={isApplyingAll}
                    onClick={() => runDiscard(group.changes)}
                  >
                    {copy.pendingEdits.discardGroup(group.changes.length)}
                  </button>
                </div>
              </div>
              {group.changes.map((change) => (
                <div
                  key={change.id}
                  className={`ct-change-item rc-change-item ${
                    change.id === selectedChange?.id ? "selected" : ""
                  }`}
                >
                  <button
                    type="button"
                    className="rc-change-item-main"
                    onClick={() => selectChange(change.id)}
                  >
                    <span className={`ct-change-type ct-change-type-${change.type}`}>
                      {change.type.toUpperCase()}
                    </span>
                    <span className="ct-change-preview">
                      {change.sqlPreview.split("\n")[0].slice(0, 40)}
                      {change.sqlPreview.length > 40 ? "..." : ""}
                    </span>
                  </button>
                  <span className="rc-change-item-actions">
                    <button
                      type="button"
                      className="rc-mini-btn"
                      disabled={isApplyingAll || applyingIds.has(change.id)}
                      onClick={() => void runApply([change])}
                      title={copy.pendingEdits.approve}
                    >
                      <Check className="!w-3 !h-3" />
                    </button>
                    <button
                      type="button"
                      className="rc-mini-btn danger"
                      disabled={isApplyingAll || applyingIds.has(change.id)}
                      onClick={() => runDiscard([change])}
                      title={copy.pendingEdits.discard}
                    >
                      <X className="!w-3 !h-3" />
                    </button>
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>

        {/* SQL preview + cell diff for the selected change */}
        <StagedChangeDetail
          selectedChange={selectedChange}
          allChanges={stagedChanges}
          sqlLabel={copy.pendingEdits.sqlPreviewLabel}
          copyAllLabel={copy.pendingEdits.copyAll}
          cellChangesLabel={copy.pendingEdits.cellChanges}
        />
      </div>

      <div className="ct-modal-footer rc-edits-footer">
        <div className="ct-warning">
          <AlertTriangle className="!w-3 !h-3" />
          <span>{copy.pendingEdits.transactionNote}</span>
        </div>
        <div className="ct-modal-actions">
          <button
            type="button"
            className="ct-btn-secondary"
            disabled={isApplyingAll}
            onClick={() => runDiscard(stagedChanges)}
          >
            <X className="!w-3.5 !h-3.5" />
            <span>{copy.pendingEdits.discardAll(stagedChanges.length)}</span>
          </button>
          <button
            type="button"
            className="ct-btn-primary"
            disabled={isApplyingAll}
            onClick={() => void runApply(stagedChanges, true)}
          >
            {isApplyingAll ? (
              <>
                <span className="ct-spinner" />
                <span>{copy.pendingEdits.applying}</span>
              </>
            ) : (
              <>
                <Check className="!w-3.5 !h-3.5" />
                <span>{copy.pendingEdits.applyAll(stagedChanges.length)}</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
