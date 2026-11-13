import { create } from "zustand";
import { createComposerSlice, INITIAL_COMPOSER_STATE, type ComposerSlice } from "./composerSlice";
import {
  clearConsentResolversForTests,
  createConsentSlice,
  INITIAL_CONSENT_STATE,
  type ConsentSlice,
} from "./consentSlice";
import { createSessionSlice, getInitialSessionState, type SessionSlice } from "./sessionSlice";

export type AIPanelStoreState = ComposerSlice & ConsentSlice & SessionSlice;

export const useAIPanelStore = create<AIPanelStoreState>()((...args) => ({
  ...createComposerSlice(...args),
  ...createConsentSlice(...args),
  ...createSessionSlice(...args),
}));

export function resetAIPanelStoreForTests(): void {
  clearConsentResolversForTests();
  useAIPanelStore.setState({
    ...INITIAL_COMPOSER_STATE,
    ...INITIAL_CONSENT_STATE,
    ...getInitialSessionState(),
  });
}
