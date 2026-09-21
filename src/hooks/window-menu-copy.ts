/**
 * Copy for the window-menu Help items that link out to GitHub.
 * Kept out of src/i18n per the per-feature copy-module convention.
 */

import type { AppLanguage } from "../i18n";

export interface WindowMenuCopy {
  /** Help → opens the GitHub "new issue" page. */
  reportIssue: string;
  /** Help → opens the GitHub discussions page. */
  sendFeedback: string;
}

const EN_COPY: WindowMenuCopy = {
  reportIssue: "Report an issue",
  sendFeedback: "Send feedback",
};

const VI_COPY: WindowMenuCopy = {
  reportIssue: "Báo cáo sự cố",
  sendFeedback: "Gửi phản hồi",
};

const ZH_COPY: WindowMenuCopy = {
  reportIssue: "报告问题",
  sendFeedback: "发送反馈",
};

const TR_COPY: WindowMenuCopy = {
  reportIssue: "Sorun bildir",
  sendFeedback: "Geri bildirim gönder",
};

const KO_COPY: WindowMenuCopy = {
  reportIssue: "문제 신고",
  sendFeedback: "피드백 보내기",
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
