import type { ScheduleCopy } from "./types";

export const TR_COPY: ScheduleCopy = {
  missedBanner: (count) => `Uygulama kapalıyken ${count} çalıştırma kaçırıldı`,
  missedDismiss: "Kapat",
  statusMissed: "kaçırıldı",
  catchUp: "Uygulama kapalıyken",
  catchUpSkip: "Kaçırılanları atla",
  catchUpRunOnce: "Sonraki açılışta bir kez çalıştır",
  missedToast: (count) => `Uygulama kapalıyken ${count} zamanlanmış çalıştırma kaçırıldı`,
  loading: "Yükleniyor...",
  statusNew: "yeni",
  every: (label) => `her ${label}`,
  ago: {
    seconds: (n) => `${n} sn önce`,
    minutes: (n) => `${n} dk önce`,
    hours: (n) => `${n} sa önce`,
    days: (n) => `${n} gün önce`,
  },
  rowsCount: (count) => `${count} satır`,
  loadFailed: "Zamanlamalar yüklenemedi",
  sqlRunOk: (name) => `Zamanlanmış sorgu çalıştı: ${name}`,
  sqlRunOkRows: (rows) => `${rows} satır döndü.`,
  sqlRunFailed: (name) => `Zamanlanmış sorgu başarısız: ${name}`,
  unknownError: "Bilinmeyen hata.",
  agentReadOnlyHint:
    "Uygulama açıkken gözetimsiz ve salt okunur çalışır: veriyi asla değiştirmez ve soru sormaz. Satır verileri yalnızca aşağıdaki seçenek işaretliyken okunur ve AI sağlayıcısına gönderilir — aksi halde görev yalnızca şema meta verilerini görür.",
  agentDataRead: "Bu görevin veri okuyup AI sağlayıcısına göndermesine izin ver",
};
