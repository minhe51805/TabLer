import type { BundleCopy } from "./types";

export const VI_BUNDLE_COPY: BundleCopy = {
  modes: {
    connections: "Chỉ kết nối",
    bundle: "Gói workspace đầy đủ",
  },
  export: {
    title: "Xuất gói workspace",
    subtitle: "Chia sẻ toàn bộ thiết lập workspace trong một tệp",
    info: "Gói là tệp JSON thuần để chia sẻ trong nhóm. Mật khẩu, khóa SSH và khóa API AI vẫn nằm trong kho bảo mật của máy này — chỉ có cờ được xuất để đồng đội biết cần nhập lại thông tin xác thực nào.",
    includes: "Bao gồm:",
    connections: "Kết nối đã lưu (không kèm mật khẩu)",
    favorites: "SQL yêu thích",
    schedules: "Lịch trình đã lưu",
    aiProviders: "Cài đặt nhà cung cấp AI (không kèm khóa API)",
    uiPrefs: "Tùy chọn giao diện (chủ đề, bố cục, phím tắt)",
    button: "Xuất gói",
    working: "Đang xuất...",
    done: "Đã xuất gói workspace tới",
  },
  import: {
    dropzoneHint: "Tệp xuất TableR (*.tabler-connections, *.tabler-bundle)",
    title: "Nhập gói workspace",
    subtitle: "Xem nội dung gói và chọn mục cần nhập",
    sections: {
      connections: "Kết nối",
      sqlFavorites: "SQL yêu thích",
      schedules: "Lịch trình",
      aiProviders: "Nhà cung cấp AI",
      uiPrefs: "Tùy chọn giao diện",
    },
    exists: "đã tồn tại",
    needsPassword: "cần nhập lại mật khẩu",
    uiPrefsMeta: "{total} khóa · {existing} đã có sẵn",
    uiPrefsWritten: "khóa tùy chọn giao diện",
    uiPrefsRestart: "khởi động lại ứng dụng để áp dụng",
    button: "Nhập mục đã chọn",
    working: "Đang nhập...",
    done: "Đã nhập",
    empty: "Gói này không có mục nào.",
    external: {
      button: "Nhập từ DBeaver / DataGrip",
      passwordNote:
        "Mật khẩu không bao giờ được nhập — DBeaver và DataGrip lưu chúng dưới dạng mã hóa. Nhập mật khẩu cơ sở dữ liệu cho từng kết nối bạn muốn nhập.",
      skipped: "{count} mục bị bỏ qua (engine không hỗ trợ hoặc lỗi định dạng)",
    },
  },
};
