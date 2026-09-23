import type { ScheduleCopy } from "./types";

export const ZH_COPY: ScheduleCopy = {
  missedBanner: (count) => `应用关闭期间错过了 ${count} 次运行`,
  missedDismiss: "忽略",
  statusMissed: "已错过",
  catchUp: "应用关闭时",
  catchUpSkip: "跳过错过的运行",
  catchUpRunOnce: "下次启动时运行一次",
  missedToast: (count) => `应用关闭期间错过了 ${count} 次计划运行`,
  loading: "加载中...",
  statusNew: "新",
  every: (label) => `每 ${label}`,
  ago: {
    seconds: (n) => `${n} 秒前`,
    minutes: (n) => `${n} 分钟前`,
    hours: (n) => `${n} 小时前`,
    days: (n) => `${n} 天前`,
  },
  rowsCount: (count) => `${count} 行`,
  loadFailed: "无法加载计划",
  sqlRunOk: (name) => `计划查询已运行：${name}`,
  sqlRunOkRows: (rows) => `返回 ${rows} 行。`,
  sqlRunFailed: (name) => `计划查询失败：${name}`,
  unknownError: "未知错误。",
  agentReadOnlyHint:
    "在应用打开期间以只读方式无人值守运行：绝不更改数据，也绝不提问。仅当勾选下方选项时才会读取行数据并发送给 AI 提供方——否则任务只能看到架构元数据。",
  agentDataRead: "允许此任务读取数据并发送给 AI 提供方",
};
