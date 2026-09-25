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

// ─── Export encryption prompt ────────────────────────────────────────────
//
// Data exports (database dump, full-table export, bulk directory export) all
// offer an optional AES-256-GCM envelope. The flows have no settings dialog
// of their own, so the single <ExportEncryptDialog> host in AppGlobalModals
// serves every caller through `requestAppExportEncryption` — same pattern as
// `requestAppConfirmation` above.

export interface ExportEncryptRequest {
  /** What is being exported, e.g. "mydb_2026-09-25.sql". */
  fileLabel: string;
}

export interface ExportEncryptAnswer {
  /** False when the user cancelled — abort the whole export. */
  confirmed: boolean;
  /** Set only when the user asked for encryption; already min-length checked. */
  password: string | null;
}

interface PendingExportEncrypt extends ExportEncryptRequest {
  resolve: (answer: ExportEncryptAnswer) => void;
}

interface ExportEncryptState {
  pendingExportEncrypt: PendingExportEncrypt | null;
  /** Called by the dialog host; resolves the pending request and clears it. */
  respondExportEncrypt: (answer: ExportEncryptAnswer) => void;
}

export const useExportEncryptStore = create<ExportEncryptState>((set, get) => ({
  pendingExportEncrypt: null,
  respondExportEncrypt: (answer) => {
    const pending = get().pendingExportEncrypt;
    if (!pending) return;
    set({ pendingExportEncrypt: null });
    pending.resolve(answer);
  },
}));

/**
 * Ask the user whether an export file should be encrypted, and for the
 * password when it should. Resolves `{ confirmed: true, password }` —
 * `password` is `null` for plaintext — or `{ confirmed: false }` on cancel.
 * Without a dialog host it resolves cancelled so an unattended call can
 * never silently export.
 */
export function requestAppExportEncryption(
  request: ExportEncryptRequest,
): Promise<ExportEncryptAnswer> {
  if (!isHostMounted) {
    console.warn(
      `[ExportEncryptDialog] No dialog host mounted — cancelling "${request.fileLabel}" without asking.`,
    );
    return Promise.resolve({ confirmed: false, password: null });
  }
  return new Promise<ExportEncryptAnswer>((resolve) => {
    const previous = useExportEncryptStore.getState().pendingExportEncrypt;
    previous?.resolve({ confirmed: false, password: null });
    useExportEncryptStore.setState({ pendingExportEncrypt: { ...request, resolve } });
  });
}
