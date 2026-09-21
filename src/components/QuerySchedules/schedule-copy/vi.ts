import type { ScheduleCopy } from "./types";

export const VI_COPY: ScheduleCopy = {
  missedBanner: (count) => `${count} lượt chạy bị bỏ lỡ khi ứng dụng đóng`,
  missedDismiss: "Bỏ qua",
  statusMissed: "bỏ lỡ",
  catchUp: "Khi ứng dụng đóng",
  catchUpSkip: "Bỏ qua các lượt bị lỡ",
  catchUpRunOnce: "Chạy một lần khi mở lại",
  missedToast: (count) => `${count} lượt chạy định kỳ bị bỏ lỡ khi ứng dụng đóng`,
};
