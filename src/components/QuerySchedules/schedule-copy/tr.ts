import type { ScheduleCopy } from "./types";

export const TR_COPY: ScheduleCopy = {
  missedBanner: (count) => `Uygulama kapalıyken ${count} çalıştırma kaçırıldı`,
  missedDismiss: "Kapat",
  statusMissed: "kaçırıldı",
  catchUp: "Uygulama kapalıyken",
  catchUpSkip: "Kaçırılanları atla",
  catchUpRunOnce: "Sonraki açılışta bir kez çalıştır",
  missedToast: (count) => `Uygulama kapalıyken ${count} zamanlanmış çalıştırma kaçırıldı`,
};
