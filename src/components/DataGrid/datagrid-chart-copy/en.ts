import type { DataGridChartCopy } from "./types";

export const EN_COPY: DataGridChartCopy = {
  chart: {
    title: "Chart",
    buttonTitle: "Chart this result",
    type: "Chart type",
    xAxis: "X axis",
    yAxis: "Y axis",
    value: "Value",
    close: "Close",
    noRows: "No data to visualize.",
    noNumeric: "No numeric columns detected for charting.",
  },
  autoRefresh: {
    title: "Auto-refresh",
    off: "Off",
    everySeconds: (seconds) => `Every ${seconds} seconds`,
    countdown: (seconds) => `${seconds}s`,
    stoppedForEdit: "Auto-refresh stopped while editing",
  },
};
