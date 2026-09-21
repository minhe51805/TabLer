import type { AIPanelCopy } from "./types";

export const TR_PANEL_COPY: AIPanelCopy = {
  runCost: {
    label: "{used} / {budget} token",
    title: "Bu çalıştırmada kullanılan model tokeni (çalıştırma başına bütçeye göre).",
  },
  runDetails: {
    label: "Çalıştırma detayları",
    callCount: "{count} araç çağrısı",
    total: "Toplam {duration}",
    ok: "ok",
    failed: "hata",
    sqlLabel: "Çalıştırılan SQL",
  },
  rules: {
    title: "Koruma kuralları",
    subtitle:
      "<workspace>/rules içindeki Markdown kuralları ve yerleşik paket, ajanın çalıştırdığı her ifadeyi denetler.",
    close: "Kapat",
    newRule: "Yeni kural",
    noWorkspaceTitle:
      "Önce bu çalışma alanına bir klasör bağlayın — çalışma alanı kuralları <klasör>/rules içinde yaşar.",
    refresh: "Listeyi yenile",
    loading: "Yükleniyor…",
    empty: "Etkin kural yok.",
    armedCount: "{count} etkin",
    errorsTitle: "Yüklenemeyen dosyalar",
    nameLabel: "Kural adı",
    nameHint: "Küçük harf, rakam, '-' ve '_' (1-64). <ad>.md dosyası olur.",
    contentLabel: "Kural dosyası (.md)",
    contentHint: "Frontmatter + gövde. Dosya yazılmadan önce doğrulanır.",
    cancel: "İptal",
    create: "Kural oluştur",
    creating: "Oluşturuluyor…",
    savedAt: "Kural kaydedildi: {path}",
    originBuiltin: "yerleşik",
    originGlobal: "genel",
    originWorkspace: "çalışma alanı",
    actionWarn: "uyarı",
    actionRequireApproval: "onay gerekli",
    actionBlock: "engelle",
  },
};
