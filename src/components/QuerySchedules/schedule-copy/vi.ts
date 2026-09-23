import type { ScheduleCopy } from "./types";

export const VI_COPY: ScheduleCopy = {
  missedBanner: (count) => `${count} lượt chạy bị bỏ lỡ khi ứng dụng đóng`,
  missedDismiss: "Bỏ qua",
  statusMissed: "bỏ lỡ",
  catchUp: "Khi ứng dụng đóng",
  catchUpSkip: "Bỏ qua các lượt bị lỡ",
  catchUpRunOnce: "Chạy một lần khi mở lại",
  missedToast: (count) => `${count} lượt chạy định kỳ bị bỏ lỡ khi ứng dụng đóng`,
  loading: "Đang tải...",
  statusNew: "mới",
  every: (label) => `mỗi ${label}`,
  ago: {
    seconds: (n) => `${n} giây trước`,
    minutes: (n) => `${n} phút trước`,
    hours: (n) => `${n} giờ trước`,
    days: (n) => `${n} ngày trước`,
  },
  rowsCount: (count) => `${count} hàng`,
  loadFailed: "Không tải được lịch trình",
  sqlRunOk: (name) => `Truy vấn định kỳ đã chạy: ${name}`,
  sqlRunOkRows: (rows) => `Trả về ${rows} hàng.`,
  sqlRunFailed: (name) => `Truy vấn định kỳ thất bại: ${name}`,
  unknownError: "Lỗi không xác định.",
  agentReadOnlyHint:
    "Chạy tự động khi ứng dụng mở, chỉ đọc: không bao giờ thay đổi dữ liệu và không hỏi câu hỏi. Dữ liệu hàng chỉ được đọc và gửi tới nhà cung cấp AI khi bật tùy chọn bên dưới — nếu không, tác vụ chỉ thấy siêu dữ liệu lược đồ.",
  agentDataRead: "Cho phép tác vụ này đọc dữ liệu và gửi tới nhà cung cấp AI",
};
