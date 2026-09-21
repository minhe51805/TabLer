import type { AppShellCopy } from "./types";

export const VI_COPY: AppShellCopy = {
  updates: {
    check: "Kiểm tra cập nhật",
    checking: "Đang kiểm tra…",
    upToDate: "TableR đã là bản mới nhất.",
    available: "Đã có phiên bản {version}.",
    releaseNotes: "Ghi chú phát hành",
    install: "Tải xuống & cài đặt",
    downloading: "Đang tải bản cập nhật… {progress}%",
    installing: "Đang cài đặt — TableR sẽ khởi động lại…",
    retry: "Thử lại",
    checkFailed: "Kiểm tra cập nhật thất bại",
  },
  storageRecovery: {
    kicker: "Khôi phục khởi động",
    title: "Dữ liệu workspace có vẻ bị hỏng",
    description:
      "TableR không đọc được một số tệp workspace đã lưu. Bạn có thể cách ly các tệp bị hỏng và bắt đầu lại — bản gốc được giữ dưới dạng sao lưu .corrupt — hoặc thoát để tự kiểm tra các tệp.",
    affectedFiles: "Tệp bị ảnh hưởng",
    reset: "Đặt lại & tiếp tục",
    resetting: "Đang đặt lại…",
    quit: "Thoát",
    resetFailed: "Đặt lại thất bại",
  },
};
