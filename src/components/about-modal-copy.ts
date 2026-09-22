/**
 * Copy for the About modal's local usage-stats section.
 * Kept out of src/i18n per the per-feature copy-module convention.
 */

import type { AppLanguage } from "../i18n";

export interface AboutModalCopy {
  /** Section heading above the per-feature counters. */
  usageStats: string;
  /** Shown when no feature has been counted yet. */
  usageEmpty: string;
  /** Tooltip/label for the button copying the stats as JSON. */
  copyStats: string;
  /** Brief confirmation after the stats JSON lands on the clipboard. */
  copied: string;
  /** Copy for the Updates status section. */
  updates: {
    /** Section heading. */
    title: string;
    /** Prefix for the updater availability tag. */
    updater: string;
    /** Prefix for the last-check outcome tag. */
    lastCheck: string;
    /** Updater plugin is configured. */
    enabled: string;
    /** Updater plugin is not configured in this build. */
    disabled: string;
    /** Availability could not be determined. */
    unknown: string;
    /** No manual check has run yet. */
    never: string;
    /** Last check: already on the latest version. */
    upToDate: string;
    /** Last check: newer version found; `{version}` is substituted. */
    available: string;
    /** Last check: the check itself errored. */
    failed: string;
  };
}

const EN_COPY: AboutModalCopy = {
  usageStats: "Usage stats (local only)",
  usageEmpty: "Nothing counted yet — open a feature and it shows up here.",
  copyStats: "Copy stats",
  copied: "Copied",
  updates: {
    title: "Updates",
    updater: "Updater",
    lastCheck: "Last check",
    enabled: "enabled",
    disabled: "disabled",
    unknown: "unknown",
    never: "Never checked",
    upToDate: "Up to date",
    available: "Update available: v{version}",
    failed: "Check failed",
  },
};

const VI_COPY: AboutModalCopy = {
  usageStats: "Thống kê sử dụng (chỉ trên máy)",
  usageEmpty: "Chưa có gì được đếm — mở một tính năng và nó sẽ hiện ở đây.",
  copyStats: "Sao chép thống kê",
  copied: "Đã sao chép",
  updates: {
    title: "Cập nhật",
    updater: "Trình cập nhật",
    lastCheck: "Kiểm tra gần nhất",
    enabled: "đã bật",
    disabled: "đã tắt",
    unknown: "không rõ",
    never: "Chưa kiểm tra",
    upToDate: "Đã là bản mới nhất",
    available: "Có bản cập nhật: v{version}",
    failed: "Kiểm tra thất bại",
  },
};

const ZH_COPY: AboutModalCopy = {
  usageStats: "使用统计(仅本地)",
  usageEmpty: "还没有任何计数 — 打开一个功能后就会显示在这里。",
  copyStats: "复制统计",
  copied: "已复制",
  updates: {
    title: "更新",
    updater: "更新器",
    lastCheck: "上次检查",
    enabled: "已启用",
    disabled: "已禁用",
    unknown: "未知",
    never: "从未检查",
    upToDate: "已是最新",
    available: "有可用更新:v{version}",
    failed: "检查失败",
  },
};

const TR_COPY: AboutModalCopy = {
  usageStats: "Kullanım istatistikleri (yalnızca yerel)",
  usageEmpty: "Henüz sayılan bir şey yok — bir özellik açın, burada görünür.",
  copyStats: "İstatistikleri kopyala",
  copied: "Kopyalandı",
  updates: {
    title: "Güncellemeler",
    updater: "Güncelleyici",
    lastCheck: "Son denetim",
    enabled: "etkin",
    disabled: "devre dışı",
    unknown: "bilinmiyor",
    never: "Hiç denetlenmedi",
    upToDate: "Güncel",
    available: "Güncelleme mevcut: v{version}",
    failed: "Denetim başarısız",
  },
};

const KO_COPY: AboutModalCopy = {
  usageStats: "사용 통계 (로컬 전용)",
  usageEmpty: "아직 집계된 항목이 없습니다 — 기능을 열면 여기에 표시됩니다.",
  copyStats: "통계 복사",
  copied: "복사됨",
  updates: {
    title: "업데이트",
    updater: "업데이터",
    lastCheck: "마지막 확인",
    enabled: "활성화됨",
    disabled: "비활성화됨",
    unknown: "알 수 없음",
    never: "확인한 적 없음",
    upToDate: "최신 상태",
    available: "업데이트 사용 가능: v{version}",
    failed: "확인 실패",
  },
};

const COPY: Record<AppLanguage, AboutModalCopy> = {
  en: EN_COPY,
  vi: VI_COPY,
  zh: ZH_COPY,
  tr: TR_COPY,
  ko: KO_COPY,
};

export function getAboutModalCopy(language: AppLanguage): AboutModalCopy {
  return COPY[language] ?? EN_COPY;
}
