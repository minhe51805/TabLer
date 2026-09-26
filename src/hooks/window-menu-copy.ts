/**
 * Copy for the window-menu Help items that link out to GitHub.
 * Kept out of src/i18n per the per-feature copy-module convention.
 */

import type { AppLanguage } from "../i18n";

export interface WindowMenuCopy {
  /** Help → opens the GitHub "new issue" page. */
  reportIssue: string;
  /** Help → opens the GitHub issues list. */
  sendFeedback: string;
  /** Help → replays the first-run onboarding tour. */
  restartTour: string;
}

const EN_COPY: WindowMenuCopy = {
  reportIssue: "Report an issue",
  sendFeedback: "Send feedback",
  restartTour: "Restart tour",
};

const VI_COPY: WindowMenuCopy = {
  reportIssue: "Báo cáo sự cố",
  sendFeedback: "Gửi phản hồi",
  restartTour: "Chạy lại hướng dẫn",
};

const ZH_COPY: WindowMenuCopy = {
  reportIssue: "报告问题",
  sendFeedback: "发送反馈",
  restartTour: "重新运行导览",
};

const TR_COPY: WindowMenuCopy = {
  reportIssue: "Sorun bildir",
  sendFeedback: "Geri bildirim gönder",
  restartTour: "Turu yeniden başlat",
};

const KO_COPY: WindowMenuCopy = {
  reportIssue: "문제 신고",
  sendFeedback: "피드백 보내기",
  restartTour: "투어 다시 시작",
};

const COPY: Record<AppLanguage, WindowMenuCopy> = {
  en: EN_COPY,
  vi: VI_COPY,
  zh: ZH_COPY,
  tr: TR_COPY,
  ko: KO_COPY,
};

export function getWindowMenuCopy(language: AppLanguage): WindowMenuCopy {
  return COPY[language] ?? EN_COPY;
}
