export type AppToastTone = "success" | "info" | "error";

export interface AppToastPayload {
  title: string;
  description?: string;
  tone?: AppToastTone;
  durationMs?: number;
}

export const APP_TOAST_EVENT = "app-toast";

export function emitAppToast(payload: AppToastPayload) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<AppToastPayload>(APP_TOAST_EVENT, { detail: payload }));
}
