import { create } from "zustand";

/**
 * App-wide confirmation requests rendered by the single <ConfirmDialog> host
 * mounted in AppGlobalModals. Any code path — component, hook, or command
 * registry action — can await `requestAppConfirmation` instead of falling back
 * to the native window.confirm.
 */

export interface AppConfirmRequest {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
}

interface PendingConfirm extends AppConfirmRequest {
  resolve: (approved: boolean) => void;
}

interface ConfirmState {
  pending: PendingConfirm | null;
  /** Called by the dialog host; resolves the pending request and clears it. */
  respond: (approved: boolean) => void;
}

export const useConfirmStore = create<ConfirmState>((set, get) => ({
  pending: null,
  respond: (approved) => {
    const pending = get().pending;
    if (!pending) return;
    set({ pending: null });
    pending.resolve(approved);
  },
}));

/** Flipped by the dialog host in AppGlobalModals so callers can fall back. */
let isHostMounted = false;

export function setAppConfirmHostMounted(mounted: boolean) {
  isHostMounted = mounted;
}

/**
 * Ask the user to approve a destructive action through the in-app confirm
 * dialog. Resolves `true` only when the user explicitly confirms; a newer
 * request denies the superseded one so nothing is silently approved.
 */
export function requestAppConfirmation(request: AppConfirmRequest): Promise<boolean> {
  if (!isHostMounted) {
    // No dialog host (tests, detached shells, or a WebView where the native
    // confirm is a no-op — macOS WKWebView silently returns undefined).
    // Fail closed: an unanswerable confirmation must never approve.
    console.warn(
      `[ConfirmDialog] No dialog host mounted — denying "${request.title}" without asking.`,
    );
    return Promise.resolve(false);
  }

  return new Promise<boolean>((resolve) => {
    const previous = useConfirmStore.getState().pending;
    previous?.resolve(false);
    useConfirmStore.setState({ pending: { ...request, resolve } });
  });
}
