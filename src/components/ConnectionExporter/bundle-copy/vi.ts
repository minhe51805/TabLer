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
    },
    exists: "đã tồn tại",
    needsPassword: "cần nhập lại mật khẩu",
    button: "Nhập mục đã chọn",
    working: "Đang nhập...",
    done: "Đã nhập",
    empty: "Gói này không có mục nào.",
  },
};
