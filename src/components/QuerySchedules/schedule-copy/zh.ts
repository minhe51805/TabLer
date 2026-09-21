import type { ScheduleCopy } from "./types";

export const ZH_COPY: ScheduleCopy = {
  missedBanner: (count) => `应用关闭期间错过了 ${count} 次运行`,
  missedDismiss: "忽略",
  statusMissed: "已错过",
  catchUp: "应用关闭时",
  catchUpSkip: "跳过错过的运行",
  catchUpRunOnce: "下次启动时运行一次",
  missedToast: (count) => `应用关闭期间错过了 ${count} 次计划运行`,
};
