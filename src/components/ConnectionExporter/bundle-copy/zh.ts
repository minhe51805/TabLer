import type { BundleCopy } from "./types";

export const ZH_BUNDLE_COPY: BundleCopy = {
  modes: {
    connections: "仅连接",
    bundle: "完整工作区包",
  },
  export: {
    title: "导出工作区包",
    subtitle: "将整个工作区配置分享为单个文件",
    info: "该包是用于团队共享的纯 JSON 文件。密码、SSH 密钥和 AI API 密钥保留在本机的安全存储中——仅导出一个标记，以便团队成员知道需要重新输入哪些凭据。",
    includes: "包含：",
    connections: "已保存的连接（不含密码）",
    favorites: "SQL 收藏",
    schedules: "已保存的计划",
    aiProviders: "AI 提供方设置（不含 API 密钥）",
    button: "导出包",
    working: "正在导出...",
    done: "工作区包已导出到",
  },
  import: {
    dropzoneHint: "TableR 导出文件 (*.tabler-connections, *.tabler-bundle)",
    title: "导入工作区包",
    subtitle: "查看包内容并选择要导入的项目",
    sections: {
      connections: "连接",
      sqlFavorites: "SQL 收藏",
      schedules: "计划",
      aiProviders: "AI 提供方",
    },
    exists: "已存在",
    needsPassword: "需重新输入密码",
    button: "导入所选",
    working: "正在导入...",
    done: "已导入",
    empty: "此包中没有内容。",
  },
};
