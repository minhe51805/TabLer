import type { AIPanelCopy } from "./types";

export const VI_PANEL_COPY: AIPanelCopy = {
  runCost: {
    label: "{used} / {budget} token",
    title: "Số token model đã dùng trong lượt chạy này, so với ngân sách mỗi lượt.",
  },
  runDetails: {
    label: "Chi tiết lượt chạy",
    callCount: "{count} lần gọi tool",
    total: "Tổng {duration}",
    ok: "ok",
    failed: "lỗi",
    sqlLabel: "SQL đã chạy",
  },
  rules: {
    title: "Quy tắc guardrail",
    subtitle:
      "Các rule Markdown trong <workspace>/rules và gói built-in duyệt mọi câu lệnh agent chạy.",
    close: "Đóng",
    newRule: "Rule mới",
    noWorkspaceTitle:
      "Hãy liên kết một thư mục với workspace trước — rule của workspace nằm trong <thư-mục>/rules.",
    refresh: "Tải lại danh sách",
    loading: "Đang tải…",
    empty: "Chưa có rule nào đang bật.",
    armedCount: "{count} đang bật",
    errorsTitle: "Các file không tải được",
    nameLabel: "Tên rule",
    nameHint: "Chữ thường, số, '-' và '_' (1-64). Sẽ thành <tên>.md.",
    contentLabel: "File rule (.md)",
    contentHint: "Frontmatter + nội dung. File được kiểm tra trước khi ghi.",
    cancel: "Huỷ",
    create: "Tạo rule",
    creating: "Đang tạo…",
    savedAt: "Đã lưu rule tại: {path}",
    originBuiltin: "built-in",
    originGlobal: "toàn cục",
    originWorkspace: "workspace",
    actionWarn: "cảnh báo",
    actionRequireApproval: "cần duyệt",
    actionBlock: "chặn",
  },
};
