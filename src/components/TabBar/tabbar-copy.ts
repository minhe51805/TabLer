/**
 * Copy for the tab context menu (duplicate / split-right / move-between-panes).
 * Kept out of src/i18n per the per-feature copy-module convention.
 */

import type { AppLanguage } from "../../i18n";

export interface TabBarCopy {
  duplicate: string;
  splitRight: string;
  moveToLeftPane: string;
  closeSplit: string;
  closeTab: string;
  stopQuery: string;
  stopQueryClientOnly: string;
  stop: string;
}

const EN_COPY: TabBarCopy = {
  duplicate: "Duplicate",
  splitRight: "Split Right",
  moveToLeftPane: "Move to Left Pane",
  closeSplit: "Close Split",
  closeTab: "Close",
  stopQuery: "Stop query",
  stopQueryClientOnly: "Stop waiting (the server may keep running this query)",
  stop: "Stop",
};

const VI_COPY: TabBarCopy = {
  duplicate: "Nhân bản",
  splitRight: "Chia sang phải",
  moveToLeftPane: "Chuyển sang khung trái",
  closeSplit: "Đóng chia đôi",
  closeTab: "Đóng",
  stopQuery: "Dừng truy vấn",
  stopQueryClientOnly: "Ngừng chờ (server có thể vẫn đang chạy truy vấn này)",
  stop: "Dừng",
};

const ZH_COPY: TabBarCopy = {
  duplicate: "复制",
  splitRight: "向右拆分",
  moveToLeftPane: "移动到左窗格",
  closeSplit: "关闭拆分",
  closeTab: "关闭",
  stopQuery: "停止查询",
  stopQueryClientOnly: "停止等待（服务器可能仍在运行此查询）",
  stop: "停止",
};

const TR_COPY: TabBarCopy = {
  duplicate: "Çoğalt",
  splitRight: "Sağa Böl",
  moveToLeftPane: "Sol Bölmeye Taşı",
  closeSplit: "Bölmeyi Kapat",
  closeTab: "Kapat",
  stopQuery: "Sorguyu durdur",
  stopQueryClientOnly: "Beklemeyi bırak (sunucu sorguyu çalıştırmaya devam edebilir)",
  stop: "Durdur",
};

const KO_COPY: TabBarCopy = {
  duplicate: "복제",
  splitRight: "오른쪽으로 분할",
  moveToLeftPane: "왼쪽 창으로 이동",
  closeSplit: "분할 닫기",
  closeTab: "닫기",
  stopQuery: "쿼리 중지",
  stopQueryClientOnly: "대기 중지 (서버에서 쿼리가 계속 실행될 수 있음)",
  stop: "중지",
};

const COPY: Record<AppLanguage, TabBarCopy> = {
  en: EN_COPY,
  vi: VI_COPY,
  zh: ZH_COPY,
  tr: TR_COPY,
  ko: KO_COPY,
};

export function getTabBarCopy(language: AppLanguage): TabBarCopy {
  return COPY[language] ?? EN_COPY;
}
