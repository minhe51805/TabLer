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
}

const EN_COPY: AboutModalCopy = {
  usageStats: "Usage stats (local only)",
  usageEmpty: "Nothing counted yet — open a feature and it shows up here.",
  copyStats: "Copy stats",
  copied: "Copied",
};

const VI_COPY: AboutModalCopy = {
  usageStats: "Thống kê sử dụng (chỉ trên máy)",
  usageEmpty: "Chưa có gì được đếm — mở một tính năng và nó sẽ hiện ở đây.",
  copyStats: "Sao chép thống kê",
  copied: "Đã sao chép",
};

const ZH_COPY: AboutModalCopy = {
  usageStats: "使用统计(仅本地)",
  usageEmpty: "还没有任何计数 — 打开一个功能后就会显示在这里。",
  copyStats: "复制统计",
  copied: "已复制",
};

const TR_COPY: AboutModalCopy = {
  usageStats: "Kullanım istatistikleri (yalnızca yerel)",
  usageEmpty: "Henüz sayılan bir şey yok — bir özellik açın, burada görünür.",
  copyStats: "İstatistikleri kopyala",
  copied: "Kopyalandı",
};

const KO_COPY: AboutModalCopy = {
  usageStats: "사용 통계 (로컬 전용)",
  usageEmpty: "아직 집계된 항목이 없습니다 — 기능을 열면 여기에 표시됩니다.",
  copyStats: "통계 복사",
  copied: "복사됨",
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
