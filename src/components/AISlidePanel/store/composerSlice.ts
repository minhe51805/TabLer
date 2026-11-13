import type { Dispatch, SetStateAction } from "react";
import type { StateCreator } from "zustand";
import type { AIAttachmentDraft } from "../../../utils/ai-attachments";
import type { SelectionContextState } from "../ai-panel-selection";
import type { PendingPrompt } from "../hooks/use-ai-bubble-rerun";

function applyUpdater<T>(current: T, updater: SetStateAction<T>): T {
  return typeof updater === "function" ? (updater as (prev: T) => T)(current) : updater;
}

export interface ComposerSlice {
  promptDraft: string;
  composerAttachments: AIAttachmentDraft[];
  attachedSelection: SelectionContextState | null;
  pendingQueue: PendingPrompt[];
  isAttachmentManagerOpen: boolean;
  slashActiveIndex: number;
  slashDismissed: boolean;

  setPromptDraft: Dispatch<SetStateAction<string>>;
  updateComposerDraft: (value: string) => void;
  setComposerAttachments: Dispatch<SetStateAction<AIAttachmentDraft[]>>;
  setAttachedSelection: Dispatch<SetStateAction<SelectionContextState | null>>;
  setPendingQueue: Dispatch<SetStateAction<PendingPrompt[]>>;
  enqueuePendingPrompt: (item: PendingPrompt) => void;
  shiftPendingPrompt: () => PendingPrompt | undefined;
  clearPendingQueue: () => void;
  setIsAttachmentManagerOpen: Dispatch<SetStateAction<boolean>>;
  setSlashActiveIndex: Dispatch<SetStateAction<number>>;
  setSlashDismissed: Dispatch<SetStateAction<boolean>>;
}

export const INITIAL_COMPOSER_STATE = {
  promptDraft: "",
  composerAttachments: [] as AIAttachmentDraft[],
  attachedSelection: null as SelectionContextState | null,
  pendingQueue: [] as PendingPrompt[],
  isAttachmentManagerOpen: false,
  slashActiveIndex: 0,
  slashDismissed: false,
};

export const createComposerSlice: StateCreator<ComposerSlice, [], [], ComposerSlice> = (
  set,
  get,
) => ({
  ...INITIAL_COMPOSER_STATE,

  setPromptDraft: (updater) =>
    set((state) => {
      const next = applyUpdater(state.promptDraft, updater);
      return next === state.promptDraft ? state : { promptDraft: next };
    }),

  updateComposerDraft: (value) =>
    set((state) => {
      if (
        state.promptDraft === value &&
        state.slashDismissed === false &&
        state.slashActiveIndex === 0
      ) {
        return state;
      }
      return {
        promptDraft: value,
        slashDismissed: false,
        slashActiveIndex: 0,
      };
    }),

  setComposerAttachments: (updater) =>
    set((state) => {
      const next = applyUpdater(state.composerAttachments, updater);
      return next === state.composerAttachments ? state : { composerAttachments: next };
    }),

  setAttachedSelection: (updater) =>
    set((state) => {
      const next = applyUpdater(state.attachedSelection, updater);
      return next === state.attachedSelection ? state : { attachedSelection: next };
    }),

  setPendingQueue: (updater) =>
    set((state) => {
      const next = applyUpdater(state.pendingQueue, updater);
      return next === state.pendingQueue ? state : { pendingQueue: next };
    }),

  enqueuePendingPrompt: (item) =>
    set((state) => ({
      pendingQueue: [...state.pendingQueue, item],
    })),

  shiftPendingPrompt: () => {
    const current = get().pendingQueue;
    if (current.length === 0) return undefined;
    const [head, ...rest] = current;
    set({ pendingQueue: rest });
    return head;
  },

  clearPendingQueue: () =>
    set((state) => (state.pendingQueue.length === 0 ? state : { pendingQueue: [] })),

  setIsAttachmentManagerOpen: (updater) =>
    set((state) => {
      const next = applyUpdater(state.isAttachmentManagerOpen, updater);
      return next === state.isAttachmentManagerOpen ? state : { isAttachmentManagerOpen: next };
    }),

  setSlashActiveIndex: (updater) =>
    set((state) => {
      const next = applyUpdater(state.slashActiveIndex, updater);
      return next === state.slashActiveIndex ? state : { slashActiveIndex: next };
    }),

  setSlashDismissed: (updater) =>
    set((state) => {
      const next = applyUpdater(state.slashDismissed, updater);
      return next === state.slashDismissed ? state : { slashDismissed: next };
    }),
});
