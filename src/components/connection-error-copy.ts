/**
 * Copy for the structured connection-failure UI (stage badge + hint) shared by
 * the workspace connecting overlay and the connection form test alert.
 * Kept out of src/i18n per the per-feature copy-module convention.
 */

import type { AppLanguage } from "../i18n";
import type { ConnectionErrorStage } from "../utils/connection-error";

export interface ConnectionErrorCopy {
  /** Label prefixing the actionable hint line. */
  hintLabel: string;
  /** Human label per failure stage. */
  stageLabels: Record<ConnectionErrorStage, string>;
}

const EN_COPY: ConnectionErrorCopy = {
  hintLabel: "Hint",
  stageLabels: {
    dns: "DNS",
    tcp: "Network",
    tunnel: "SSH tunnel",
    tls: "TLS",
    auth: "Authentication",
    database: "Database",
    timeout: "Timeout",
    driver: "Driver",
    unknown: "Connection",
  },
};

const VI_COPY: ConnectionErrorCopy = {
  hintLabel: "Gợi ý",
  stageLabels: {
    dns: "DNS",
    tcp: "Mạng",
    tunnel: "SSH tunnel",
    tls: "TLS",
    auth: "Xác thực",
    database: "Cơ sở dữ liệu",
    timeout: "Hết thời gian",
    driver: "Driver",
    unknown: "Kết nối",
  },
};

const ZH_COPY: ConnectionErrorCopy = {
  hintLabel: "提示",
  stageLabels: {
    dns: "DNS",
    tcp: "网络",
    tunnel: "SSH 隧道",
    tls: "TLS",
    auth: "身份验证",
    database: "数据库",
    timeout: "超时",
    driver: "驱动",
    unknown: "连接",
  },
};

const TR_COPY: ConnectionErrorCopy = {
  hintLabel: "İpucu",
  stageLabels: {
    dns: "DNS",
    tcp: "Ağ",
    tunnel: "SSH tüneli",
    tls: "TLS",
    auth: "Kimlik doğrulama",
    database: "Veritabanı",
    timeout: "Zaman aşımı",
    driver: "Sürücü",
    unknown: "Bağlantı",
  },
};

const KO_COPY: ConnectionErrorCopy = {
  hintLabel: "힌트",
  stageLabels: {
    dns: "DNS",
    tcp: "네트워크",
    tunnel: "SSH 터널",
    tls: "TLS",
    auth: "인증",
    database: "데이터베이스",
    timeout: "시간 초과",
    driver: "드라이버",
    unknown: "연결",
  },
};

const COPY: Record<AppLanguage, ConnectionErrorCopy> = {
  en: EN_COPY,
  vi: VI_COPY,
  zh: ZH_COPY,
  tr: TR_COPY,
  ko: KO_COPY,
};

export function getConnectionErrorCopy(language: AppLanguage): ConnectionErrorCopy {
  return COPY[language] ?? EN_COPY;
}
