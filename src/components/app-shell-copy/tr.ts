import type { AppShellCopy } from "./types";

export const TR_COPY: AppShellCopy = {
  updates: {
    check: "Güncellemeleri denetle",
    checking: "Denetleniyor…",
    upToDate: "TableR güncel.",
    available: "{version} sürümü kullanılabilir.",
    releaseNotes: "Sürüm notları",
    install: "İndir ve kur",
    downloading: "Güncelleme indiriliyor… %{progress}",
    installing: "Kuruluyor — TableR yeniden başlatılacak…",
    retry: "Tekrar dene",
    checkFailed: "Güncelleme denetimi başarısız",
  },
  storageRecovery: {
    kicker: "Başlangıç Kurtarma",
    title: "Çalışma alanı verileri bozuk görünüyor",
    description:
      "TableR, kaydedilmiş bazı çalışma alanı dosyalarını okuyamadı. Bozuk dosyaları karantinaya alıp sıfırdan başlayabilirsiniz — orijinaller .corrupt yedeği olarak saklanır — ya da çıkıp dosyaları kendiniz inceleyebilirsiniz.",
    affectedFiles: "Etkilenen dosyalar",
    reset: "Sıfırla ve devam et",
    resetting: "Sıfırlanıyor…",
    quit: "Çık",
    resetFailed: "Sıfırlama başarısız",
  },
};
