import type { Dispatch, SetStateAction } from "react";
import type { StateCreator } from "zustand";
import { denyPendingAIFailoverConsent } from "../../../utils/ai-failover-consent";
import type { VisualizationReadConsentState } from "../hooks/use-ai-consent-gates";

function applyUpdater<T>(current: T, updater: SetStateAction<T>): T {
  return typeof updater === "function" ? (updater as (prev: T) => T)(current) : updater;
}

// Module-scoped resolver slots keep active Promise continuations out of React
// render cycles and break the circular hook dependency (`denyPendingConsentsRef`)
// between `useAISlidePanel` and `useAIConsentGates`.
interface PendingVisualizationConsentSlot {
  resolve: (approved: boolean) => void;
  onUserDecision?: (approved: boolean) => void;
}

let visualizationConsentSlot: PendingVisualizationConsentSlot | null = null;
let destructiveConsentResolver: ((approved: boolean) => void) | null = null;

export function clearConsentResolversForTests(): void {
  visualizationConsentSlot = null;
  destructiveConsentResolver = null;
}

export interface ConsentSlice {
  visualizationConsentPending: VisualizationReadConsentState | null;
  visualizationApprovalScope: string | null;
  destructiveConsentPending: VisualizationReadConsentState | null;
  isFailoverConsentPending: boolean;
  isSessionDataReadEnabled: boolean;

  setVisualizationConsentPending: Dispatch<SetStateAction<VisualizationReadConsentState | null>>;
  setVisualizationApprovalScope: (scope: string | null) => void;
  setDestructiveConsentPending: Dispatch<SetStateAction<VisualizationReadConsentState | null>>;
  setIsFailoverConsentPending: Dispatch<SetStateAction<boolean>>;
  setIsSessionDataReadEnabled: Dispatch<SetStateAction<boolean>>;
  openVisualizationConsentPrompt: (
    prompt: VisualizationReadConsentState,
    onSettle?: (approved: boolean) => void,
  ) => Promise<boolean>;
  settleVisualizationConsent: (approved: boolean) => void;
  openDestructiveConsentPrompt: (prompt: VisualizationReadConsentState) => Promise<boolean>;
  settleDestructiveConsent: (approved: boolean) => void;
  denyPendingConsents: () => void;
}

export const INITIAL_CONSENT_STATE = {
  visualizationConsentPending: null as VisualizationReadConsentState | null,
  visualizationApprovalScope: null as string | null,
  destructiveConsentPending: null as VisualizationReadConsentState | null,
  isFailoverConsentPending: false,
  isSessionDataReadEnabled: false,
};

export const createConsentSlice: StateCreator<ConsentSlice, [], [], ConsentSlice> = (set) => ({
  ...INITIAL_CONSENT_STATE,

  setVisualizationConsentPending: (updater) =>
    set((state) => {
      const next = applyUpdater(state.visualizationConsentPending, updater);
      return next === state.visualizationConsentPending
        ? state
        : { visualizationConsentPending: next };
    }),

  setVisualizationApprovalScope: (scope) =>
    set((state) =>
      state.visualizationApprovalScope === scope ? state : { visualizationApprovalScope: scope },
    ),

  setDestructiveConsentPending: (updater) =>
    set((state) => {
      const next = applyUpdater(state.destructiveConsentPending, updater);
      return next === state.destructiveConsentPending ? state : { destructiveConsentPending: next };
    }),

  setIsFailoverConsentPending: (updater) =>
    set((state) => {
      const next = applyUpdater(state.isFailoverConsentPending, updater);
      return next === state.isFailoverConsentPending ? state : { isFailoverConsentPending: next };
    }),

  setIsSessionDataReadEnabled: (updater) =>
    set((state) => {
      const next = applyUpdater(state.isSessionDataReadEnabled, updater);
      return next === state.isSessionDataReadEnabled ? state : { isSessionDataReadEnabled: next };
    }),

  openVisualizationConsentPrompt: (prompt, onSettle) => {
    if (visualizationConsentSlot) {
      visualizationConsentSlot.resolve(false);
      visualizationConsentSlot = null;
    }
    return new Promise<boolean>((resolve) => {
      visualizationConsentSlot = { resolve, onUserDecision: onSettle };
      set({ visualizationConsentPending: prompt });
    });
  },

  settleVisualizationConsent: (approved) => {
    const slot = visualizationConsentSlot;
    visualizationConsentSlot = null;
    set({ visualizationConsentPending: null });
    slot?.onUserDecision?.(approved);
    slot?.resolve(approved);
  },

  openDestructiveConsentPrompt: (prompt) => {
    if (destructiveConsentResolver) {
      destructiveConsentResolver(false);
      destructiveConsentResolver = null;
    }
    return new Promise<boolean>((resolve) => {
      destructiveConsentResolver = resolve;
      set({ destructiveConsentPending: prompt });
    });
  },

  settleDestructiveConsent: (approved) => {
    const resolver = destructiveConsentResolver;
    destructiveConsentResolver = null;
    set({ destructiveConsentPending: null });
    resolver?.(approved);
  },

  denyPendingConsents: () => {
    const vizSlot = visualizationConsentSlot;
    visualizationConsentSlot = null;
    const destResolver = destructiveConsentResolver;
    destructiveConsentResolver = null;

    // Resolve direct Promises without invoking persistent user-decision
    // callbacks — a cancelled run or closed panel is NOT a user denial decision.
    vizSlot?.resolve(false);
    destResolver?.(false);
    denyPendingAIFailoverConsent();

    set({
      visualizationConsentPending: null,
      destructiveConsentPending: null,
      isFailoverConsentPending: false,
    });
  },
});
