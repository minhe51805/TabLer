/**
 * Copy for the startup launcher's first-run "sample database" card.
 * Kept out of src/i18n per the per-feature copy-module convention.
 */

import type { AppLanguage } from "../../i18n";

export interface StartupCopy {
  sampleCard: {
    title: string;
    description: string;
    action: string;
    creating: string;
  };
  pingAll: {
    /** Toolbar button that probes every saved connection. */
    action: string;
    /** Badge tooltip when the probe succeeded. */
    reachable: string;
    /** Badge label/tooltip when the probe failed. */
    unreachable: string;
  };
}

const EN_COPY: StartupCopy = {
  sampleCard: {
    title: "Try a sample database",
    description:
      "Spin up a local SQLite demo with customers, products, and orders — no server needed.",
    action: "Create & connect",
    creating: "Creating sample…",
  },
  pingAll: {
    action: "Ping all",
    reachable: "Reachable",
    unreachable: "Unreachable",
  },
};

const VI_COPY: StartupCopy = {
  sampleCard: {
    title: "Thử cơ sở dữ liệu mẫu",
    description: "Tạo SQLite demo cục bộ với customers, products và orders — không cần server.",
    action: "Tạo & kết nối",
    creating: "Đang tạo mẫu…",
  },
  pingAll: {
    action: "Ping tất cả",
    reachable: "Kết nối được",
    unreachable: "Không kết nối được",
  },
};

const ZH_COPY: StartupCopy = {
  sampleCard: {
    title: "试用示例数据库",
    description: "在本地创建一个包含 customers、products 和 orders 的 SQLite 演示库，无需服务器。",
    action: "创建并连接",
    creating: "正在创建示例…",
  },
  pingAll: {
    action: "全部 Ping",
    reachable: "可连接",
    unreachable: "无法连接",
  },
};

const TR_COPY: StartupCopy = {
  sampleCard: {
    title: "Örnek veritabanını dene",
    description:
      "Sunucu gerekmeden customers, products ve orders içeren yerel bir SQLite demosu oluştur.",
    action: "Oluştur ve bağlan",
    creating: "Örnek oluşturuluyor…",
  },
  pingAll: {
    action: "Tümünü ping'le",
    reachable: "Ulaşılabilir",
    unreachable: "Ulaşılamıyor",
  },
};

const KO_COPY: StartupCopy = {
  sampleCard: {
    title: "샘플 데이터베이스 사용해 보기",
    description:
      "customers, products, orders가 포함된 로컬 SQLite 데모를 만듭니다. 서버가 필요 없습니다.",
    action: "생성 후 연결",
    creating: "샘플 생성 중…",
  },
  pingAll: {
    action: "모두 핑",
    reachable: "연결 가능",
    unreachable: "연결 불가",
  },
};

export const STARTUP_COPY: Record<AppLanguage, StartupCopy> = {
  en: EN_COPY,
  vi: VI_COPY,
  zh: ZH_COPY,
  tr: TR_COPY,
  ko: KO_COPY,
};
