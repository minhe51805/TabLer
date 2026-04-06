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
    historyTitle: string;
    historyHint: string;
    historyEmpty: string;
    historyDeleteTitle?: string;
    historyDeleteConfirm?: string;
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
    readyOptimizeTitle: string;
    readyOptimizeSubtitle: string;
    readyFixErrorTitle: string;
    readyFixErrorSubtitle: string;
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
      historyTitle: "Conversation history",
      historyHint: "Reopen a previous thread and continue where you left off.",
      historyEmpty: "Ask AI to start the first conversation in this workspace.",
      historyDeleteTitle: "Delete thread",
      historyDeleteConfirm: "Delete this conversation thread?",
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
        {
          title: "Optimize query",
          prompt: "Optimize this SQL: SELECT * FROM orders WHERE DATE(created_at) = CURDATE()",
        },
        {
          title: "Fix error",
          prompt: "Fix this SQL error: SELECT * FRMO users",
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
      readyOptimizeTitle: "Optimized SQL ready",
      readyOptimizeSubtitle: "SQL has been rewritten for better performance",
      readyFixErrorTitle: "SQL fix ready",
      readyFixErrorSubtitle: "The SQL error has been corrected",
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
      historyTitle: "Lịch sử trò chuyện",
      historyHint: "Mở lại cuộc trò chuyện trước đó và tiếp tục đúng ngữ cảnh đang làm.",
      historyEmpty: "Hãy hỏi AI để bắt đầu cuộc trò chuyện đầu tiên trong workspace này.",
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
        {
          title: "Tối ưu query",
          prompt: "Tối ưu câu SQL này: SELECT * FROM orders WHERE DATE(created_at) = CURDATE()",
        },
        {
          title: "Sửa lỗi",
          prompt: "Sửa lỗi SQL này: SELECT * FRMO users",
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
      readyOptimizeTitle: "SQL đã tối ưu",
      readyOptimizeSubtitle: "SQL đã được viết lại để chạy nhanh hơn",
      readyFixErrorTitle: "SQL đã sửa",
      readyFixErrorSubtitle: "Lỗi SQL đã được khắc phục",
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
      historyTitle: "对话历史",
      historyHint: "重新打开之前的线程，并从上次停下的位置继续。",
      historyEmpty: "先向 AI 发出一个请求，工作区里的第一段对话就会出现在这里。",
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
        {
          title: "优化查询",
          prompt: "优化这条 SQL：SELECT * FROM orders WHERE DATE(created_at) = CURDATE()",
        },
        {
          title: "修复错误",
          prompt: "修复这条 SQL 错误：SELECT * FRMO users",
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
      readyOptimizeTitle: "SQL 已优化",
      readyOptimizeSubtitle: "SQL 已重写以提升性能",
      readyFixErrorTitle: "SQL 已修复",
      readyFixErrorSubtitle: "SQL 错误已被纠正",
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
  tr: {
    bubbleMeta: {
      thinking: "Düşünüyor",
      sandboxRun: "Sandbox çalışması",
      needsReview: "İnceleme gerekli",
      blockedInsert: "Ekleme engellendi",
      reviewBeforeRun: "Çalıştırmadan önce incele",
      ready: "Hazır",
    },
    bubbleActions: {
      dragBubble: "Balonu sürükle",
      dragPointer: "Bu oku AI'nın açıklama yapmasını istediğiniz yere sürükleyin. Sıfırlamak için çift tıklayın.",
      dismissBubble: "Balonu kapat",
      detail: "Detay",
      copy: "Kopyala",
      insert: "Ekle",
      approveRun: "Çalıştırmayı onayla",
    },
    modal: {
      kicker: "Balon Detayı",
      originalRequest: "Orijinal İstek",
      noRequest: "Bu balon için kaydedilmiş bir istek yok.",
      executionSummary: "Çalıştırma Özeti",
      assistantExplanation: "AI Açıklaması",
      loadingExplanation: "AI, işaret ettiğiniz bağlamı okuyup açıklama hazırlıyor.",
      sql: "SQL",
      agenticNote: "Agentic çalıştırma, açıkça onaylayana kadar kilitli kalır.",
      rewriteTitle: "Bu Balonu Yeniden Yaz",
      rewriteHint: "İstediğiniz değişikliği yazın, ardından AI'dan yeni bir versiyon yazmasını isteyin.",
      rewritePlaceholder: "Örnek: PostgreSQL için daha güvenli yap, yorum ekle, DDL ve DML'yi ayır veya join'leri daha açık açıkla.",
      rewriting: "Yeniden yazılıyor...",
      rewriteBubble: "Balonu Yeniden Yaz",
      running: "Çalışıyor...",
      approveAgenticRun: "Agentic Çalıştırmayı Onayla",
    },
    composer: {
      alertDismiss: "Kapat",
      inspectOnTitle: "İnceleme modu açık. Bir şey seçin ve Enter'a basın.",
      inspectOffTitle: "AI asistan panelini açın. Bağlamı almak için İnceleme'yi kullanın.",
      inspectHint: "Metin seçin, ardından Enter'a basın.",
      capturedLabel: "Yakalandı",
      selectionReady: "Seçim hazır",
      kicker: "Çalışma Alanı AI",
      title: "Asistan",
      noDatabaseSelected: "Veritabanı seçilmedi",
      noProvider: "Sağlayıcı yok",
      tableOne: "tablo",
      tableOther: "tablo",
      schemaShared: "Şema paylaşıldı",
      promptOnly: "Yalnızca prompt",
      modePrompt: "Prompt",
      modeEdit: "Düzenle",
      modeAgent: "Agent",
      modePromptHint: "Yalnızca prompt ile sorun. Şema bağlamı gönderilmeyecek.",
      modeEditHint: "Mevcut DB şemasını okuyun ve SQL veya değişiklik önerin.",
      modeAgentHint: "Mevcut DB şemasını okuyun ve sizin onayınız gerektiren çalıştırılabilir SQL hazırlayın.",
      modeNeedsSchemaHint: "Bu mod, AI Sağlayıcı Ayarlarında şema paylaşımının etkinleştirilmesini gerektirir.",
      openSettings: "Ayarları aç",
      switchToPrompt: "Prompt moduna geç",
      historyTitle: "Konuşma geçmişi",
      historyHint: "Önceki bir konuyu yeniden açın ve kaldığınız yerden devam edin.",
      historyEmpty: "AI'ya bu çalışma alanında ilk konuşmayı başlatmasını sorun.",
      placeholder: "Bu veritabanı hakkında sorun, SQL isteyin veya istediğiniz değişikliği açıklayın.",
      note: "Göndermek için Enter. Bağlamı almak için İnceleme'yi kullanın.",
      generating: "Oluşturuluyor...",
      generateBubble: "AI'ya Sor",
      promptIdeas: [
        { title: "Tablo oluştur", prompt: "id, name, email, role ve created_at içeren bir users tablosu oluştur." },
        { title: "Şemayı değiştir", prompt: "users tablosuna last_login_at sütunu ekle ve CURRENT_TIMESTAMP ile doldur." },
        { title: "Sorgu yaz", prompt: "Son 30 günde sipariş sayısına göre en çok sipariş veren 10 kullanıcıyı gösteren bir sorgu yaz." },
        { title: "Sorguyu optimize et", prompt: "Bu SQL'i optimize et: SELECT * FROM orders WHERE DATE(created_at) = CURDATE()" },
        { title: "Hatayı düzelt", prompt: "Bu SQL hatasını düzelt: SELECT * FRMO users" },
      ],
    },
    bubbleStates: {
      loadingInspectTitle: "Seçili bağlam okunuyor",
      loadingComposeTitle: "AI yeni bir balon oluşturuyor",
      loadingInspectSubtitle: "Bağlam taranıyor",
      loadingInspectPreview: "Seçtiğiniz metne bakılıyor, açıklama hazırlanıyor ve uygunsa daha güvenli bir öneri yapılıyor.",
      loadingComposePreview: "Şema inceleniyor, bağlam birleştiriliyor ve SQL hazırlanıyor...",
      readyInspectTitle: "Bağlam açıklaması hazır",
      readySqlTitle: "SQL balonu hazır",
      readyNoteTitle: "AI notu hazır",
      readyInspectSqlSubtitle: "Seçimi açıkladı ve çalıştırılabilir bir düzeltme önerdi",
      readyInspectNoteSubtitle: "Seçimi açıkladı ve sonraki adımları önerdi",
      readySqlSafeSubtitle: "Güvenle eklenebilir görünüyor",
      readySqlReviewSubtitle: "Çalıştırmadan önce inceleyin",
      readyOptimizeTitle: "SQL optimize edildi",
      readyOptimizeSubtitle: "SQL daha iyi performans için yeniden yazıldı",
      readyFixErrorTitle: "SQL düzeltildi",
      readyFixErrorSubtitle: "SQL hatası düzeltildi",
      readyNoteSubtitle: "Yalnızca açıklama, henüz çalıştırılabilir SQL yok",
      errorTitle: "Balon oluşturulamadı",
      errorSubtitle: "AI isteği başarısız",
      selectSomethingError: "Önce bir kod veya UI metni seçin, ardından AI balonu inceleme modundayken Enter'a basın.",
      runSuccessTitle: "SQL sandbox'ta çalıştı",
      runSuccessSandboxSubtitle: "Korunan çalıştırma sınırı",
      runSuccessDirectSubtitle: "Doğrudan çalıştırıldı",
      runFailedTitle: "Çalıştırma başarısız",
      runFailedSubtitle: "Sandbox çalıştırmayı durdurdu",
    },
  },
  ko: {
    bubbleMeta: {
      thinking: "생각 중",
      sandboxRun: "샌드박스 실행",
      needsReview: "검토 필요",
      blockedInsert: "삽입 차단됨",
      reviewBeforeRun: "실행 전 검토",
      ready: "준비됨",
    },
    bubbleActions: {
      dragBubble: "버블 드래그",
      dragPointer: "이 화살표를 AI가 설명할 위치로 드래그하세요. 초기화하려면 더블 클릭하세요.",
      dismissBubble: "버블 닫기",
      detail: "상세",
      copy: "복사",
      insert: "삽입",
      approveRun: "실행 승인",
    },
    modal: {
      kicker: "버블 상세",
      originalRequest: "원본 요청",
      noRequest: "이 버블에 대해 기록된 요청이 없습니다.",
      executionSummary: "실행 요약",
      assistantExplanation: "AI 설명",
      loadingExplanation: "AI가 가리킨 컨텍스트를 읽고 설명을 작성 중입니다.",
      sql: "SQL",
      agenticNote: "Agentic 실행은 명시적으로 승인할 때까지 잠겨 있습니다.",
      rewriteTitle: "이 버블 다시 쓰기",
      rewriteHint: "원하는 변경 사항을 입력한 다음 AI에게 새 버전을 작성하도록 요청하세요.",
      rewritePlaceholder: "예: PostgreSQL에 더 안전하게 만들기, 주석 추가, DDL과 DML 분리, 또는 조인 설명 명확하게 하기.",
      rewriting: "다시 쓰는 중...",
      rewriteBubble: "버블 다시 쓰기",
      running: "실행 중...",
      approveAgenticRun: "Agentic 실행 승인",
    },
    composer: {
      alertDismiss: "닫기",
      inspectOnTitle: "inspect 모드가 켜져 있습니다. 무언가를 선택하고 Enter를 누르세요.",
      inspectOffTitle: "AI 어시스턴트 레일을 열세요. Inspect를 사용하여 워크스페이스에서 컨텍스트를 캡처하세요.",
      inspectHint: "텍스트를 선택한 다음 Enter를 누르세요.",
      capturedLabel: "캡처됨",
      selectionReady: "선택 준비 완료",
      kicker: "워크스페이스 AI",
      title: "어시스턴트",
      noDatabaseSelected: "데이터베이스 선택 안 됨",
      noProvider: "프로바이더 없음",
      tableOne: "개 테이블",
      tableOther: "개 테이블",
      schemaShared: "스키마 공유됨",
      promptOnly: "프롬프트만",
      modePrompt: "프롬프트",
      modeEdit: "편집",
      modeAgent: "에이전트",
      modePromptHint: "프롬프트만으로 질문하세요. 스키마 컨텍스트가 전송되지 않습니다.",
      modeEditHint: "현재 DB 스키마를 읽고 SQL 또는 변경 사항을 제안하여 먼저 검토하세요.",
      modeAgentHint: "현재 DB 스키마를 읽고 실행 가능한 SQL을 준비하되 여전히 승인이 필요합니다.",
      modeNeedsSchemaHint: "이 모드에는 AI 프로바이더 설정에서 스키마 공유를 활성화해야 합니다.",
      openSettings: "설정 열기",
      switchToPrompt: "프롬프트 모드로 전환",
      historyTitle: "대화 기록",
      historyHint: "이전 스레드를 다시 열고 중단된 위치부터 계속하세요.",
      historyEmpty: "AI에게 이 워크스페이스에서 첫 대화를 시작하도록 요청하세요.",
      placeholder: "이 데이터베이스에 대해 질문하거나, SQL을 요청하거나, 원하는 변경 사항을 설명하세요.",
      note: "Enter로 보내기. 컨텍스트를 캡처하려면 Inspect를 사용하세요.",
      generating: "생성 중...",
      generateBubble: "AI에게 질문",
      promptIdeas: [
        { title: "테이블 생성", prompt: "id, name, email, role, created_at를 포함하는 users 테이블을 생성하세요." },
        { title: "스키마 변경", prompt: "users 테이블에 last_login_at 열을 추가하고 CURRENT_TIMESTAMP로 채워넣으세요." },
        { title: "쿼리 작성", prompt: "최근 30일 동안 주문 수 기준으로 상위 10명의 사용자를 표시하는 쿼리를 작성하세요." },
        { title: "쿼리 최적화", prompt: "이 SQL을 최적화하세요: SELECT * FROM orders WHERE DATE(created_at) = CURDATE()" },
        { title: "오류 수정", prompt: "이 SQL 오류를 수정하세요: SELECT * FRMO users" },
      ],
    },
    bubbleStates: {
      loadingInspectTitle: "선택한 컨텍스트 읽는 중",
      loadingComposeTitle: "AI가 새 버블을 작성하는 중",
      loadingInspectSubtitle: "컨텍스트 스캔 중",
      loadingInspectPreview: "선택한 텍스트를 확인하고 설명을 준비하며 적절하면 더 안전한 제안을 작성합니다.",
      loadingComposePreview: "스키마 검토, 컨텍스트 통합 및 SQL 작성 중...",
      readyInspectTitle: "컨텍스트 설명 준비 완료",
      readySqlTitle: "SQL 버블 준비 완료",
      readyNoteTitle: "AI 노트 준비 완료",
      readyInspectSqlSubtitle: " 선택 항목을 설명하고 실행 가능한 수정 제안",
      readyInspectNoteSubtitle: "선택 항목을 설명하고 다음 단계 제안",
      readySqlSafeSubtitle: "삽입해도 안전한 것 같음",
      readySqlReviewSubtitle: "실행 전 검토 필요",
      readyOptimizeTitle: "SQL 최적화됨",
      readyOptimizeSubtitle: "성능 향상을 위해 SQL이 다시 작성됨",
      readyFixErrorTitle: "SQL 수정됨",
      readyFixErrorSubtitle: "SQL 오류가 수정됨",
      readyNoteSubtitle: "설명만 있고 실행 가능한 SQL은 아직 없음",
      errorTitle: "버블을 생성할 수 없음",
      errorSubtitle: "AI 요청 실패",
      selectSomethingError: "먼저 코드 또는 UI 텍스트를 선택한 다음 AI 오브가 inspect 모드에 있을 때 Enter를 누르세요.",
      runSuccessTitle: "SQL이 샌드박스에서 실행됨",
      runSuccessSandboxSubtitle: "보호된 실행 경계",
      runSuccessDirectSubtitle: "직접 실행됨",
      runFailedTitle: "실행 실패",
      runFailedSubtitle: "샌드박스 실행 중지됨",
    },
  },
};

export function getAIWorkspaceCopy(language: AppLanguage): AIWorkspaceCopy {
  return COPY[language];
}
