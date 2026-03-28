import type { AppLanguage } from "../../i18n";

export interface PromptIdeaCopy {
  title: string;
  prompt: string;
}

export interface AIWorkspaceCopy {
  bubbleMeta: {
    thinking: string;
    sandboxRun: string;
    needsReview: string;
    blockedInsert: string;
    reviewBeforeRun: string;
    ready: string;
  };
  bubbleActions: {
    dragBubble: string;
    dragPointer: string;
    dismissBubble: string;
    detail: string;
    copy: string;
    insert: string;
    approveRun: string;
  };
  modal: {
    kicker: string;
    originalRequest: string;
    noRequest: string;
    executionSummary: string;
    assistantExplanation: string;
    loadingExplanation: string;
    sql: string;
    agenticNote: string;
    rewriteTitle: string;
    rewriteHint: string;
    rewritePlaceholder: string;
    rewriting: string;
    rewriteBubble: string;
    running: string;
    approveAgenticRun: string;
  };
  composer: {
    alertDismiss: string;
    inspectOnTitle: string;
    inspectOffTitle: string;
      inspectHint: string;
      capturedLabel: string;
      selectionReady: string;
      kicker: string;
    title: string;
    noDatabaseSelected: string;
    noProvider: string;
    tableOne: string;
    tableOther: string;
    schemaShared: string;
    promptOnly: string;
    modePrompt: string;
    modeEdit: string;
    modeAgent: string;
    modePromptHint: string;
    modeEditHint: string;
    modeAgentHint: string;
    modeNeedsSchemaHint: string;
    openSettings: string;
    switchToPrompt: string;
    placeholder: string;
    note: string;
    generating: string;
    generateBubble: string;
    promptIdeas: PromptIdeaCopy[];
  };
  bubbleStates: {
    loadingInspectTitle: string;
    loadingComposeTitle: string;
    loadingInspectSubtitle: string;
    loadingInspectPreview: string;
    loadingComposePreview: string;
    readyInspectTitle: string;
    readySqlTitle: string;
    readyNoteTitle: string;
    readyInspectSqlSubtitle: string;
    readyInspectNoteSubtitle: string;
    readySqlSafeSubtitle: string;
    readySqlReviewSubtitle: string;
    readyNoteSubtitle: string;
    errorTitle: string;
    errorSubtitle: string;
    selectSomethingError: string;
    runSuccessTitle: string;
    runSuccessSandboxSubtitle: string;
    runSuccessDirectSubtitle: string;
    runFailedTitle: string;
    runFailedSubtitle: string;
  };
}

const COPY: Record<AppLanguage, AIWorkspaceCopy> = {
  en: {
    bubbleMeta: {
      thinking: "Thinking",
      sandboxRun: "Sandbox run",
      needsReview: "Needs review",
      blockedInsert: "Blocked insert",
      reviewBeforeRun: "Review before run",
      ready: "Ready",
    },
    bubbleActions: {
      dragBubble: "Drag bubble",
      dragPointer: "Drag this arrow toward the place you want the AI to explain. Double click to reset.",
      dismissBubble: "Dismiss bubble",
      detail: "Detail",
      copy: "Copy",
      insert: "Insert",
      approveRun: "Approve Run",
    },
    modal: {
      kicker: "Bubble Detail",
      originalRequest: "Original Request",
      noRequest: "No request was captured for this bubble.",
      executionSummary: "Execution Summary",
      assistantExplanation: "Assistant Explanation",
      loadingExplanation: "The assistant is reading the context you pointed at and building an explanation.",
      sql: "SQL",
      agenticNote: "Agentic execution stays locked until you explicitly approve it.",
      rewriteTitle: "Rewrite This Bubble",
      rewriteHint: "Add the change you want, then ask the AI to write a new version.",
      rewritePlaceholder: "Example: make it safer for PostgreSQL, add comments, split DDL and DML, or explain the joins more clearly.",
      rewriting: "Rewriting...",
      rewriteBubble: "Rewrite Bubble",
      running: "Running...",
      approveAgenticRun: "Approve Agentic Run",
    },
    composer: {
      alertDismiss: "Dismiss",
      inspectOnTitle: "Inspect mode is on. Select something and press Enter.",
      inspectOffTitle: "Open the AI assistant rail. Use Inspect to capture context from the workspace.",
      inspectHint: "Select text, then press Enter.",
      capturedLabel: "Captured",
      selectionReady: "Selection ready",
      kicker: "Workspace AI",
      title: "Assistant",
      noDatabaseSelected: "No database selected",
      noProvider: "No provider",
      tableOne: "table",
      tableOther: "tables",
      schemaShared: "Schema shared",
      promptOnly: "Prompt only",
      modePrompt: "Prompt",
      modeEdit: "Edit",
      modeAgent: "Agent",
      modePromptHint: "Ask with prompt only. No schema context will be sent.",
      modeEditHint: "Read the current DB schema and suggest SQL or changes for you to review first.",
      modeAgentHint: "Read the current DB schema and prepare executable SQL that still requires your approval.",
      modeNeedsSchemaHint: "This mode needs schema sharing enabled in AI Provider Settings.",
      openSettings: "Open settings",
      switchToPrompt: "Use prompt mode",
      placeholder: "Ask about this database, request SQL, or describe the change you want.",
      note: "Enter to send. Use Inspect to capture context from the workspace.",
      generating: "Generating...",
      generateBubble: "Ask AI",
      promptIdeas: [
        {
          title: "Create table",
          prompt: "Create a users table with id, name, email, role, and created_at.",
        },
        {
          title: "Alter schema",
          prompt: "Add a last_login_at column to the users table and backfill it with CURRENT_TIMESTAMP.",
        },
        {
          title: "Write query",
          prompt: "Write a query that shows the top 10 users by order count in the last 30 days.",
        },
      ],
    },
    bubbleStates: {
      loadingInspectTitle: "Reading your selected context",
      loadingComposeTitle: "AI is shaping a new bubble",
      loadingInspectSubtitle: "Context scan is in progress",
      loadingInspectPreview: "Looking at the selected text, preparing an explanation, and drafting a safer suggestion if it fits.",
      loadingComposePreview: "Reviewing your schema, grounding the request, and composing SQL...",
      readyInspectTitle: "Context explanation ready",
      readySqlTitle: "SQL bubble ready",
      readyNoteTitle: "Assistant note ready",
      readyInspectSqlSubtitle: "Explained the selection and proposed a runnable fix",
      readyInspectNoteSubtitle: "Explained the selection and suggested next steps",
      readySqlSafeSubtitle: "Looks safe to insert",
      readySqlReviewSubtitle: "Review before running",
      readyNoteSubtitle: "Explanation only, no runnable SQL yet",
      errorTitle: "Bubble could not be generated",
      errorSubtitle: "AI request failed",
      selectSomethingError: "Select some code or UI text first, then press Enter while the AI orb is in inspect mode.",
      runSuccessTitle: "SQL ran in the sandbox",
      runSuccessSandboxSubtitle: "Protected execution boundary",
      runSuccessDirectSubtitle: "Executed directly",
      runFailedTitle: "Run failed",
      runFailedSubtitle: "Sandbox execution stopped",
    },
  },
  vi: {
    bubbleMeta: {
      thinking: "Đang suy nghĩ",
      sandboxRun: "Chạy sandbox",
      needsReview: "Cần xem lại",
      blockedInsert: "Chặn chèn",
      reviewBeforeRun: "Xem lại trước khi chạy",
      ready: "Sẵn sàng",
    },
    bubbleActions: {
      dragBubble: "Kéo bong bóng",
      dragPointer: "Kéo mũi tên này tới chỗ bạn muốn AI giải thích. Double click để đặt lại.",
      dismissBubble: "Ẩn bong bóng",
      detail: "Chi tiết",
      copy: "Sao chép",
      insert: "Chèn",
      approveRun: "Duyệt chạy",
    },
    modal: {
      kicker: "Chi tiết bong bóng",
      originalRequest: "Yêu cầu gốc",
      noRequest: "Không có yêu cầu nào được lưu cho bong bóng này.",
      executionSummary: "Tóm tắt thực thi",
      assistantExplanation: "Giải thích của AI",
      loadingExplanation: "AI đang đọc ngữ cảnh bạn đã trỏ tới và chuẩn bị phần giải thích.",
      sql: "SQL",
      agenticNote: "Thực thi agentic vẫn bị khóa cho tới khi bạn duyệt rõ ràng.",
      rewriteTitle: "Viết lại bong bóng này",
      rewriteHint: "Nhập thay đổi bạn muốn, rồi yêu cầu AI viết lại phiên bản mới.",
      rewritePlaceholder: "Ví dụ: làm nó an toàn hơn cho PostgreSQL, thêm comment, tách DDL và DML, hoặc giải thích join rõ hơn.",
      rewriting: "Đang viết lại...",
      rewriteBubble: "Viết lại bong bóng",
      running: "Đang chạy...",
      approveAgenticRun: "Duyệt chạy agentic",
    },
    composer: {
      alertDismiss: "Đóng",
      inspectOnTitle: "Đang bật chế độ inspect. Bôi đen nội dung rồi nhấn Enter.",
      inspectOffTitle: "Mở khung AI. Dùng Inspect để lấy ngữ cảnh từ workspace.",
      inspectHint: "Bôi đen nội dung rồi nhấn Enter.",
      capturedLabel: "Đã bắt",
      selectionReady: "Đã chọn xong",
      kicker: "AI Workspace",
      title: "Trợ lý AI",
      noDatabaseSelected: "Chưa chọn cơ sở dữ liệu",
      noProvider: "Chưa có provider",
      tableOne: "bảng",
      tableOther: "bảng",
      schemaShared: "Có chia sẻ schema",
      promptOnly: "Chỉ prompt",
      modePrompt: "Chỉ prompt",
      modeEdit: "Chỉnh sửa",
      modeAgent: "Agent",
      modePromptHint: "Chỉ hỏi bằng prompt. Schema sẽ không được gửi.",
      modeEditHint: "Đọc schema DB hiện tại để gợi ý SQL hoặc chỉnh sửa cho bạn review.",
      modeAgentHint: "Đọc schema DB hiện tại và chuẩn bị SQL có thể chạy sau khi bạn duyệt.",
      modeNeedsSchemaHint: "Chế độ này cần bật chia sẻ schema trong AI Provider Settings.",
      openSettings: "Mở settings",
      switchToPrompt: "Dùng chỉ prompt",
      placeholder: "Hỏi về DB này, yêu cầu SQL, hoặc mô tả thay đổi bạn muốn.",
      note: "Enter để gửi. Inspect để lấy ngữ cảnh.",
      generating: "Đang tạo...",
      generateBubble: "Hỏi AI",
      promptIdeas: [
        {
          title: "Tạo bảng",
          prompt: "Tạo bảng users gồm id, name, email, role và created_at.",
        },
        {
          title: "Sửa schema",
          prompt: "Thêm cột last_login_at vào bảng users và backfill bằng CURRENT_TIMESTAMP.",
        },
        {
          title: "Viết query",
          prompt: "Viết query hiển thị top 10 users theo số lượng đơn hàng trong 30 ngày gần đây.",
        },
      ],
    },
    bubbleStates: {
      loadingInspectTitle: "Đang đọc ngữ cảnh đã chọn",
      loadingComposeTitle: "AI đang tạo một bong bóng mới",
      loadingInspectSubtitle: "Đang quét ngữ cảnh",
      loadingInspectPreview: "Đang xem phần bạn đã chọn, chuẩn bị lời giải thích và gợi ý an toàn hơn nếu phù hợp.",
      loadingComposePreview: "Đang xem schema, bám ngữ cảnh và soạn SQL...",
      readyInspectTitle: "Đã có phần giải thích ngữ cảnh",
      readySqlTitle: "Bong bóng SQL đã sẵn sàng",
      readyNoteTitle: "Ghi chú AI đã sẵn sàng",
      readyInspectSqlSubtitle: "Đã giải thích phần được chọn và đề xuất hướng chạy được",
      readyInspectNoteSubtitle: "Đã giải thích phần được chọn và gợi ý bước tiếp theo",
      readySqlSafeSubtitle: "Có vẻ an toàn để chèn",
      readySqlReviewSubtitle: "Xem lại trước khi chạy",
      readyNoteSubtitle: "Chỉ có giải thích, chưa có SQL chạy được",
      errorTitle: "Không thể tạo bong bóng",
      errorSubtitle: "Yêu cầu AI thất bại",
      selectSomethingError: "Hãy chọn một đoạn code hoặc chữ trên UI trước, rồi nhấn Enter khi orb AI đang ở chế độ inspect.",
      runSuccessTitle: "SQL đã chạy trong sandbox",
      runSuccessSandboxSubtitle: "Biên thực thi được bảo vệ",
      runSuccessDirectSubtitle: "Đã thực thi trực tiếp",
      runFailedTitle: "Chạy thất bại",
      runFailedSubtitle: "Sandbox đã dừng thực thi",
    },
  },
  zh: {
    bubbleMeta: {
      thinking: "思考中",
      sandboxRun: "沙箱运行",
      needsReview: "需要检查",
      blockedInsert: "已阻止插入",
      reviewBeforeRun: "运行前检查",
      ready: "就绪",
    },
    bubbleActions: {
      dragBubble: "拖动气泡",
      dragPointer: "把这条箭头拖到你希望 AI 解释的位置。双击可重置。",
      dismissBubble: "关闭气泡",
      detail: "详情",
      copy: "复制",
      insert: "插入",
      approveRun: "批准运行",
    },
    modal: {
      kicker: "气泡详情",
      originalRequest: "原始请求",
      noRequest: "这个气泡没有记录到请求内容。",
      executionSummary: "执行摘要",
      assistantExplanation: "AI 解释",
      loadingExplanation: "AI 正在读取你指向的上下文并生成解释。",
      sql: "SQL",
      agenticNote: "Agentic 执行会一直保持锁定，直到你明确批准。",
      rewriteTitle: "重写这个气泡",
      rewriteHint: "写下你希望修改的内容，然后让 AI 生成新版本。",
      rewritePlaceholder: "例如：让它对 PostgreSQL 更安全、加入注释、拆分 DDL 和 DML，或更清晰地解释 joins。",
      rewriting: "重写中...",
      rewriteBubble: "重写气泡",
      running: "运行中...",
      approveAgenticRun: "批准 agentic 运行",
    },
    composer: {
      alertDismiss: "关闭",
      inspectOnTitle: "Inspect 模式已开启。选中文本后按 Enter。",
      inspectOffTitle: "打开 AI 侧边助手。使用 Inspect 从工作区获取上下文。",
      inspectHint: "选中内容后按 Enter。",
      capturedLabel: "已捕获",
      selectionReady: "已选中",
      kicker: "工作区 AI",
      title: "AI 助手",
      noDatabaseSelected: "未选择数据库",
      noProvider: "没有可用 provider",
      tableOne: "张表",
      tableOther: "张表",
      schemaShared: "共享 schema",
      promptOnly: "仅提示词",
      modePrompt: "仅提示词",
      modeEdit: "编辑",
      modeAgent: "Agent",
      modePromptHint: "仅使用你的 prompt，不发送 schema 上下文。",
      modeEditHint: "读取当前 DB schema，给出 SQL 或修改建议，先由你审核。",
      modeAgentHint: "读取当前 DB schema，准备可执行 SQL，但仍需要你明确批准。",
      modeNeedsSchemaHint: "这个模式需要在 AI Provider Settings 中开启 schema sharing。",
      openSettings: "打开设置",
      switchToPrompt: "改用提示词模式",
      placeholder: "询问当前数据库、请求 SQL，或描述你想做的改动。",
      note: "按 Enter 发送。使用 Inspect 从工作区捕获上下文。",
      generating: "生成中...",
      generateBubble: "询问 AI",
      promptIdeas: [
        {
          title: "创建表",
          prompt: "创建一个 users 表，包含 id、name、email、role 和 created_at。",
        },
        {
          title: "修改 schema",
          prompt: "给 users 表增加 last_login_at 列，并用 CURRENT_TIMESTAMP 回填。",
        },
        {
          title: "编写查询",
          prompt: "编写一个查询，显示过去 30 天内按订单数排名前 10 的 users。",
        },
      ],
    },
    bubbleStates: {
      loadingInspectTitle: "正在读取你选中的上下文",
      loadingComposeTitle: "AI 正在生成一个新气泡",
      loadingInspectSubtitle: "正在扫描上下文",
      loadingInspectPreview: "正在查看你选中的内容，准备解释，并在合适时给出更安全的建议。",
      loadingComposePreview: "正在查看 schema、结合上下文并生成 SQL...",
      readyInspectTitle: "上下文解释已准备好",
      readySqlTitle: "SQL 气泡已准备好",
      readyNoteTitle: "AI 说明已准备好",
      readyInspectSqlSubtitle: "已解释选中内容并给出可执行建议",
      readyInspectNoteSubtitle: "已解释选中内容并建议下一步",
      readySqlSafeSubtitle: "看起来可以安全插入",
      readySqlReviewSubtitle: "运行前请检查",
      readyNoteSubtitle: "只有解释，没有可运行的 SQL",
      errorTitle: "无法生成气泡",
      errorSubtitle: "AI 请求失败",
      selectSomethingError: "请先选中一段代码或界面文本，然后在 AI orb 处于 inspect 模式时按 Enter。",
      runSuccessTitle: "SQL 已在沙箱中运行",
      runSuccessSandboxSubtitle: "受保护的执行边界",
      runSuccessDirectSubtitle: "已直接执行",
      runFailedTitle: "运行失败",
      runFailedSubtitle: "沙箱执行已停止",
    },
  },
};

export function getAIWorkspaceCopy(language: AppLanguage): AIWorkspaceCopy {
  return COPY[language];
}
