import type { DataGridChartCopy } from "./types";

export const VI_COPY: DataGridChartCopy = {
  chart: {
    title: "Biểu đồ",
    buttonTitle: "Vẽ biểu đồ kết quả này",
    type: "Loại biểu đồ",
    xAxis: "Trục X",
    yAxis: "Trục Y",
    value: "Giá trị",
    close: "Đóng",
    noRows: "Không có dữ liệu để hiển thị.",
    noNumeric: "Không tìm thấy cột số nào để vẽ biểu đồ.",
  },
  autoRefresh: {
    title: "Tự động làm mới",
    off: "Tắt",
    everySeconds: (seconds) => `Mỗi ${seconds} giây`,
    countdown: (seconds) => `${seconds}s`,
    stoppedForEdit: "Đã dừng tự động làm mới khi đang chỉnh sửa",
  },
};
