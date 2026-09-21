import type { AIPanelCopy } from "./types";

export const ZH_PANEL_COPY: AIPanelCopy = {
  runCost: {
    label: "{used} / {budget} tokens",
    title: "本次运行消耗的模型 token 数(相对每次运行的预算)。",
  },
  rules: {
    title: "护栏规则",
    subtitle: "<workspace>/rules 中的 Markdown 规则和内置规则包会审查代理执行的每条语句。",
    close: "关闭",
    newRule: "新建规则",
    noWorkspaceTitle: "请先为此工作区链接一个文件夹 —— 工作区规则保存在 <文件夹>/rules 中。",
    refresh: "刷新列表",
    loading: "加载中…",
    empty: "暂无启用的规则。",
    armedCount: "{count} 条已启用",
    errorsTitle: "加载失败的文件",
    nameLabel: "规则名称",
    nameHint: "小写字母、数字、'-' 和 '_'(1-64 个字符)。将保存为 <名称>.md。",
    contentLabel: "规则文件 (.md)",
    contentHint: "Frontmatter + 正文。写入前会先校验文件。",
    cancel: "取消",
    create: "创建规则",
    creating: "创建中…",
    savedAt: "规则已保存至:{path}",
    originBuiltin: "内置",
    originGlobal: "全局",
    originWorkspace: "工作区",
    actionWarn: "警告",
    actionRequireApproval: "需要批准",
    actionBlock: "阻止",
  },
};
