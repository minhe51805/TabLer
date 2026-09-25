/**
 * Review Center — one modal aggregating everything awaiting review:
 * staged grid edits, pending structure changes, and the schema-diff tool.
 * Opened from the window menu, the Ctrl+Shift+R shortcut (rebindable via
 * keyboard-shortcuts-store), the floating badge launcher, or the
 * "open-review-center" window event.
 */

import { useEffect } from "react";
import { ClipboardCheck, X } from "lucide-react";
import { useI18n } from "../../i18n";
import { useChangeTrackingStore } from "../../stores/change-tracking-store";
import { keyboardEventToShortcutKey, resolveShortcut } from "../../stores/keyboard-shortcuts-store";
import { SchemaDiffPanel } from "../SchemaDiff/SchemaDiffPanel";
import { PendingEditsTab } from "./PendingEditsTab";
import { StructureChangesTab } from "./StructureChangesTab";
import { useStructureReviewRegistry } from "./structure-review-registry";
import {
  getReviewCenterShortcutLabel,
  OPEN_REVIEW_CENTER_EVENT,
  useReviewCenterStore,
  type ReviewCenterTab,
} from "./review-center-store";
import { getReviewCenterCopy } from "./review-center-copy";
import "./review-center.css";

export function ReviewCenter() {
  const isOpen = useReviewCenterStore((s) => s.isOpen);
  const activeTab = useReviewCenterStore((s) => s.activeTab);
  const setActiveTab = useReviewCenterStore((s) => s.setActiveTab);
  const close = useReviewCenterStore((s) => s.close);
  const pendingEditCount = useChangeTrackingStore((s) => s.stagedChanges.length);
  const structureEntries = useStructureReviewRegistry((s) => s.entries);
  const { language } = useI18n();
  const copy = getReviewCenterCopy(language);

  const pendingStructureCount = Object.values(structureEntries).reduce(
    (total, entry) => total + entry.pendingCount,
    0,
  );
  const pendingTotal = pendingEditCount + pendingStructureCount;

  // Entry points: window event (menu/palette) + rebindable shortcut.
  useEffect(() => {
    const openFromEvent = (event: Event) => {
      const tab = (event as CustomEvent<{ tab?: ReviewCenterTab }>).detail?.tab;
      useReviewCenterStore.getState().open(tab);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      const key = keyboardEventToShortcutKey(event);
      if (!key) return;
      if (resolveShortcut(key) !== "open-review-center") return;
      event.preventDefault();
      event.stopPropagation();
      const store = useReviewCenterStore.getState();
      if (store.isOpen) store.close();
      else store.open();
    };
    window.addEventListener(OPEN_REVIEW_CENTER_EVENT, openFromEvent);
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener(OPEN_REVIEW_CENTER_EVENT, openFromEvent);
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, []);

  // Escape closes the modal.
  useEffect(() => {
    if (!isOpen) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [isOpen, close]);

  const tabs: { key: ReviewCenterTab; label: string; badge: number }[] = [
    { key: "edits", label: copy.tabs.pendingEdits, badge: pendingEditCount },
    { key: "structure", label: copy.tabs.structureChanges, badge: pendingStructureCount },
    { key: "schema", label: copy.tabs.schemaDiff, badge: 0 },
  ];

  return (
    <>
      {/* Floating launcher with the pending-item badge — visible whenever
          something awaits review and the modal itself is closed. */}
      {!isOpen && pendingTotal > 0 && (
        <button
          type="button"
          className="rc-launcher"
          title={`${copy.launcherTitle} (${getReviewCenterShortcutLabel()})`}
          onClick={() => useReviewCenterStore.getState().open()}
        >
          <ClipboardCheck className="!w-4 !h-4" />
          <span>{copy.launcherLabel}</span>
          <span className="rc-launcher-badge">{pendingTotal}</span>
        </button>
      )}

      {isOpen && (
        <div className="rc-backdrop" onClick={close}>
          <div
            className="rc-modal"
            role="dialog"
            aria-modal="true"
            aria-label={copy.title}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="rc-header">
              <div className="rc-title-group">
                <span className="rc-kicker">TableR</span>
                <h3 className="rc-title">
                  {copy.title}
                  {pendingTotal > 0 && <span className="rc-title-badge">{pendingTotal}</span>}
                </h3>
                <p className="rc-subtitle">{copy.subtitle}</p>
              </div>
              <button type="button" className="rc-close" aria-label={copy.close} onClick={close}>
                <X className="!w-4 !h-4" />
              </button>
            </div>

            <div className="rc-tabs" role="tablist">
              {tabs.map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  role="tab"
                  aria-selected={activeTab === tab.key}
                  className={`rc-tab ${activeTab === tab.key ? "active" : ""}`}
                  onClick={() => setActiveTab(tab.key)}
                >
                  <span>{tab.label}</span>
                  {tab.badge > 0 && <span className="rc-tab-badge">{tab.badge}</span>}
                </button>
              ))}
            </div>

            <div className="rc-body">
              {activeTab === "edits" && <PendingEditsTab copy={copy} />}
              {activeTab === "structure" && <StructureChangesTab copy={copy} />}
              {activeTab === "schema" && <SchemaDiffPanel />}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
