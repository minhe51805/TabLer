import type { AppShellCopy } from "./types";

export const ZH_COPY: AppShellCopy = {
  updates: {
    check: "检查更新",
    checking: "正在检查…",
    upToDate: "TableR 已是最新版本。",
    available: "新版本 {version} 可用。",
    releaseNotes: "更新说明",
    install: "下载并安装",
    downloading: "正在下载更新… {progress}%",
    installing: "正在安装 — TableR 即将重启…",
    retry: "重试",
    checkFailed: "检查更新失败",
  },
  storageRecovery: {
    kicker: "启动恢复",
    title: "工作区数据似乎已损坏",
    description:
      "TableR 无法读取部分已保存的工作区文件。您可以隔离损坏的文件并重新开始 — 原文件会保留为 .corrupt 备份 — 或退出并自行检查这些文件。",
    affectedFiles: "受影响的文件",
    reset: "重置并继续",
    resetting: "正在重置…",
    quit: "退出",
    resetFailed: "重置失败",
  },
};
