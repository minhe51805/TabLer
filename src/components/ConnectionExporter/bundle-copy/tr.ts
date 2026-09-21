import type { BundleCopy } from "./types";

export const TR_BUNDLE_COPY: BundleCopy = {
  modes: {
    connections: "Yalnızca bağlantılar",
    bundle: "Tam çalışma alanı paketi",
  },
  export: {
    title: "Çalışma Alanı Paketini Dışa Aktar",
    subtitle: "Tüm çalışma alanı kurulumunu tek dosyada paylaş",
    info: "Paket, ekip paylaşımı için düz bir JSON dosyasıdır. Parolalar, SSH anahtarları ve AI API anahtarları bu makinenin güvenli deposunda kalır — yalnızca hangi kimlik bilgilerinin yeniden girilmesi gerektiğini gösteren bir işaret dışa aktarılır.",
    includes: "İçerik:",
    connections: "Kayıtlı bağlantılar (parolalar hariç)",
    favorites: "SQL favorileri",
    schedules: "Kayıtlı zamanlamalar",
    aiProviders: "AI sağlayıcı ayarları (API anahtarları hariç)",
    button: "Paketi Dışa Aktar",
    working: "Dışa aktarılıyor...",
    done: "Çalışma alanı paketi şuraya aktarıldı:",
  },
  import: {
    dropzoneHint: "TableR Dışa Aktarımı (*.tabler-connections, *.tabler-bundle)",
    title: "Çalışma Alanı Paketini İçe Aktar",
    subtitle: "Paket içeriğini inceleyin ve içe aktarılacakları seçin",
    sections: {
      connections: "Bağlantılar",
      sqlFavorites: "SQL Favorileri",
      schedules: "Zamanlamalar",
      aiProviders: "AI Sağlayıcıları",
    },
    exists: "zaten var",
    needsPassword: "parola yeniden gerekli",
    button: "Seçilenleri İçe Aktar",
    working: "İçe aktarılıyor...",
    done: "İçe aktarıldı",
    empty: "Bu pakette öğe yok.",
  },
};
