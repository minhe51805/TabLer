/**
 * Review Center store — modal visibility and the active tab.
 * Kept next to the component (not in src/stores) because nothing outside
 * ReviewCenter reads it; entry points dispatch the window event below.
 */

import { create } from "zustand";

import { getAllShortcuts } from "../../stores/keyboard-shortcuts-store";

export type ReviewCenterTab = "edits" | "structure" | "schema";

/** Window event that opens the modal (menu item, command surfaces). */
export const OPEN_REVIEW_CENTER_EVENT = "open-review-center";

interface ReviewCenterState {
  isOpen: boolean;
  activeTab: ReviewCenterTab;
  open: (tab?: ReviewCenterTab) => void;
  close: () => void;
  setActiveTab: (tab: ReviewCenterTab) => void;
}

export const useReviewCenterStore = create<ReviewCenterState>((set) => ({
  isOpen: false,
  activeTab: "edits",
  open: (tab) => set({ isOpen: true, ...(tab ? { activeTab: tab } : {}) }),
  close: () => set({ isOpen: false }),
  setActiveTab: (activeTab) => set({ activeTab }),
}));

/** Open the Review Center from anywhere (menu, palette, shortcut). */
export function openReviewCenter(tab?: ReviewCenterTab): void {
  useReviewCenterStore.getState().open(tab);
}

/** Current binding for the review-center shortcut (menu label, tooltips). */
export function getReviewCenterShortcutLabel(): string {
  return (
    getAllShortcuts().find((s) => s.action === "open-review-center")?.currentKey ?? "Ctrl+Shift+R"
  );
}
