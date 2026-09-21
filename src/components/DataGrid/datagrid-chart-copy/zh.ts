import type { DataGridChartCopy } from "./types";

export const ZH_COPY: DataGridChartCopy = {
  chart: {
    title: "图表",
    buttonTitle: "将此结果绘制成图表",
    type: "图表类型",
    xAxis: "X 轴",
    yAxis: "Y 轴",
    value: "数值",
    close: "关闭",
    noRows: "没有可视化的数据。",
    noNumeric: "未检测到可用于图表的数值列。",
  },
  autoRefresh: {
    title: "自动刷新",
    off: "关闭",
    everySeconds: (seconds) => `每 ${seconds} 秒`,
    countdown: (seconds) => `${seconds}秒`,
    stoppedForEdit: "编辑时已停止自动刷新",
  },
};
