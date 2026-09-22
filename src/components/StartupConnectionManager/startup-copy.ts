/**
 * Copy for the startup launcher's empty-state CTAs (sample database card,
 * external importer entry point) and list chrome.
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
  importCta: {
    /** Empty-state button that opens the connection importer. */
    action: string;
  };
  pingAll: {
    /** Toolbar button that probes every saved connection. */
    action: string;
    /** Badge tooltip when the probe succeeded. */
    reachable: string;
    /** Badge label/tooltip when the probe failed. */
    unreachable: string;
  };
  groups: {
    /** Context-menu section label above the group list. */
    moveToGroup: string;
    /** Context-menu item that clears the connection's group. */
    ungrouped: string;
    /** Context-menu item that switches the menu to the new-group input. */
    newGroup: string;
    /** Placeholder for the inline new-group name input. */
    newGroupPlaceholder: string;
    /** Confirm button next to the new-group name input. */
    create: string;
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
  importCta: {
    action: "Import from DBeaver / DataGrip",
  },
  pingAll: {
    action: "Ping all",
    reachable: "Reachable",
    unreachable: "Unreachable",
  },
  groups: {
    moveToGroup: "Move to group",
    ungrouped: "Ungrouped",
    newGroup: "New group…",
    newGroupPlaceholder: "Group name",
    create: "Create",
  },
};

const VI_COPY: StartupCopy = {
  sampleCard: {
    title: "Thử cơ sở dữ liệu mẫu",
    description: "Tạo SQLite demo cục bộ với customers, products và orders — không cần server.",
    action: "Tạo & kết nối",
    creating: "Đang tạo mẫu…",
  },
  importCta: {
    action: "Nhập từ DBeaver / DataGrip",
  },
  pingAll: {
    action: "Ping tất cả",
    reachable: "Kết nối được",
    unreachable: "Không kết nối được",
  },
  groups: {
    moveToGroup: "Chuyển vào nhóm",
    ungrouped: "Không nhóm",
    newGroup: "Nhóm mới…",
    newGroupPlaceholder: "Tên nhóm",
    create: "Tạo",
  },
};

const ZH_COPY: StartupCopy = {
  sampleCard: {
    title: "试用示例数据库",
    description: "在本地创建一个包含 customers、products 和 orders 的 SQLite 演示库，无需服务器。",
    action: "创建并连接",
    creating: "正在创建示例…",
  },
  importCta: {
    action: "从 DBeaver / DataGrip 导入",
  },
  pingAll: {
    action: "全部 Ping",
    reachable: "可连接",
    unreachable: "无法连接",
  },
  groups: {
    moveToGroup: "移动到分组",
    ungrouped: "未分组",
    newGroup: "新建分组…",
    newGroupPlaceholder: "分组名称",
    create: "创建",
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
  importCta: {
    action: "DBeaver / DataGrip'ten içe aktar",
  },
  pingAll: {
    action: "Tümünü ping'le",
    reachable: "Ulaşılabilir",
    unreachable: "Ulaşılamıyor",
  },
  groups: {
    moveToGroup: "Gruba taşı",
    ungrouped: "Gruplandırılmamış",
    newGroup: "Yeni grup…",
    newGroupPlaceholder: "Grup adı",
    create: "Oluştur",
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
  importCta: {
    action: "DBeaver / DataGrip에서 가져오기",
  },
  pingAll: {
    action: "모두 핑",
    reachable: "연결 가능",
    unreachable: "연결 불가",
  },
  groups: {
    moveToGroup: "그룹으로 이동",
    ungrouped: "그룹 없음",
    newGroup: "새 그룹…",
    newGroupPlaceholder: "그룹 이름",
    create: "만들기",
  },
};

export const STARTUP_COPY: Record<AppLanguage, StartupCopy> = {
  en: EN_COPY,
  vi: VI_COPY,
  zh: ZH_COPY,
  tr: TR_COPY,
  ko: KO_COPY,
};
