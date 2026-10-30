import type { AppLanguage } from "../../i18n";

export interface ConnectionTlsCopy {
  title: string;
  dismiss: string;
  badge: string;
}

const EN_COPY: ConnectionTlsCopy = {
  title: "Insecure TLS configuration",
  dismiss: "Dismiss",
  badge: "TLS risk",
};

const COPY: Record<AppLanguage, ConnectionTlsCopy> = {
  en: EN_COPY,
  vi: {
    title: "Cấu hình TLS không an toàn",
    dismiss: "Bỏ qua",
    badge: "TLS rủi ro",
  },
  zh: {
    title: "TLS 配置不安全",
    dismiss: "忽略",
    badge: "TLS 风险",
  },
  tr: {
    title: "Güvensiz TLS yapılandırması",
    dismiss: "Yok say",
    badge: "TLS riski",
  },
  ko: {
    title: "안전하지 않은 TLS 구성",
    dismiss: "무시",
    badge: "TLS 위험",
  },
};

export function getConnectionTlsCopy(language: AppLanguage): ConnectionTlsCopy {
  return COPY[language] ?? EN_COPY;
}
