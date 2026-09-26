/**
 * Strings for the agent-memory manager modal and the memory tool's
 * user-facing messages. Per-feature copy module: `getAIMemoryCopy` returns
 * the language pack with English as the fallback.
 */

export interface AIMemoryCopy {
  /** Header button tooltip that opens the manager. */
  openButton: string;
  title: string;
  subtitle: string;
  refresh: string;
  loading: string;
  empty: string;
  emptyHint: string;
  scopeLabel: string;
  updatedLabel: string;
  /** Provenance badge: who wrote this memory file. */
  originAgent: string;
  originUser: string;
  viewAction: string;
  hideAction: string;
  deleteAction: string;
  clearAllAction: string;
  closeAction: string;
  deleteTitle: string;
  deleteBody: string;
  deleteConfirm: string;
  clearAllTitle: string;
  clearAllBody: string;
  clearAllConfirm: string;
  cancelLabel: string;
  loadFailed: string;
  deleteFailed: string;
  bodyTitle: string;
  /** Toast shown when the agent writes a memory. */
  savedToastTitle: string;
  savedToastBody: string;
  /** Native memory tool destructive-command consent. */
  nativeDeleteTitle: string;
  nativeDeleteBody: string;
  nativeDeleteConfirm: string;
}

const EN: AIMemoryCopy = {
  openButton: "Agent memories",
  title: "Agent memories",
  subtitle: "Facts the agent saved for this connection/database.",
  refresh: "Reload the list",
  loading: "Loading…",
  empty: "No memories saved yet.",
  emptyHint: "The agent saves durable facts here with save_memory.",
  scopeLabel: "Scope",
  updatedLabel: "Updated",
  originAgent: "agent",
  originUser: "user",
  viewAction: "View",
  hideAction: "Hide",
  deleteAction: "Delete",
  clearAllAction: "Clear all",
  closeAction: "Close",
  deleteTitle: "Delete this memory?",
  deleteBody: 'Permanently delete "{name}"? This cannot be undone.',
  deleteConfirm: "Delete",
  clearAllTitle: "Clear all memories?",
  clearAllBody: "Permanently delete every memory in this scope? This cannot be undone.",
  clearAllConfirm: "Clear all",
  cancelLabel: "Cancel",
  loadFailed: "Could not load memories.",
  deleteFailed: "Could not delete the memory.",
  bodyTitle: "Memory content",
  savedToastTitle: "Memory saved",
  savedToastBody: 'The agent saved "{name}" to memory.',
  nativeDeleteTitle: "Delete memory file?",
  nativeDeleteBody:
    'The agent wants to run the memory tool\'s "{command}" command on "{path}". This permanently removes memory content and cannot be undone.',
  nativeDeleteConfirm: "Delete",
};

const VI: AIMemoryCopy = {
  openButton: "Bộ nhớ agent",
  title: "Bộ nhớ agent",
  subtitle: "Các ghi nhớ agent đã lưu cho connection/database này.",
  refresh: "Tải lại danh sách",
  loading: "Đang tải…",
  empty: "Chưa có ghi nhớ nào.",
  emptyHint: "Agent lưu các ghi nhớ lâu dài ở đây bằng save_memory.",
  scopeLabel: "Phạm vi",
  updatedLabel: "Cập nhật",
  originAgent: "agent",
  originUser: "user",
  viewAction: "Xem",
  hideAction: "Ẩn",
  deleteAction: "Xóa",
  clearAllAction: "Xóa tất cả",
  closeAction: "Đóng",
  deleteTitle: "Xóa ghi nhớ này?",
  deleteBody: 'Xóa vĩnh viễn "{name}"? Không thể hoàn tác.',
  deleteConfirm: "Xóa",
  clearAllTitle: "Xóa tất cả ghi nhớ?",
  clearAllBody: "Xóa vĩnh viễn mọi ghi nhớ trong phạm vi này? Không thể hoàn tác.",
  clearAllConfirm: "Xóa tất cả",
  cancelLabel: "Hủy",
  loadFailed: "Không thể tải danh sách ghi nhớ.",
  deleteFailed: "Không thể xóa ghi nhớ.",
  bodyTitle: "Nội dung ghi nhớ",
  savedToastTitle: "Đã lưu ghi nhớ",
  savedToastBody: 'Agent đã lưu "{name}" vào bộ nhớ.',
  nativeDeleteTitle: "Xóa tệp ghi nhớ?",
  nativeDeleteBody:
    'Agent muốn chạy lệnh "{command}" của memory tool trên "{path}". Thao tác này xóa vĩnh viễn nội dung ghi nhớ và không thể hoàn tác.',
  nativeDeleteConfirm: "Xóa",
};

const KO: AIMemoryCopy = {
  openButton: "에이전트 메모리",
  title: "에이전트 메모리",
  subtitle: "에이전트가 이 연결/데이터베이스에 저장한 정보입니다.",
  refresh: "목록 새로고침",
  loading: "불러오는 중…",
  empty: "저장된 메모리가 없습니다.",
  emptyHint: "에이전트가 save_memory로 저장한 내용이 여기에 표시됩니다.",
  scopeLabel: "범위",
  updatedLabel: "업데이트",
  originAgent: "agent",
  originUser: "user",
  viewAction: "보기",
  hideAction: "숨기기",
  deleteAction: "삭제",
  clearAllAction: "모두 삭제",
  closeAction: "닫기",
  deleteTitle: "이 메모리를 삭제할까요?",
  deleteBody: '"{name}"을(를) 영구 삭제할까요? 되돌릴 수 없습니다.',
  deleteConfirm: "삭제",
  clearAllTitle: "모든 메모리를 삭제할까요?",
  clearAllBody: "이 범위의 모든 메모리를 영구 삭제할까요? 되돌릴 수 없습니다.",
  clearAllConfirm: "모두 삭제",
  cancelLabel: "취소",
  loadFailed: "메모리 목록을 불러오지 못했습니다.",
  deleteFailed: "메모리를 삭제하지 못했습니다.",
  bodyTitle: "메모리 내용",
  savedToastTitle: "메모리 저장됨",
  savedToastBody: '에이전트가 "{name}"을(를) 메모리에 저장했습니다.',
  nativeDeleteTitle: "메모리 파일을 삭제할까요?",
  nativeDeleteBody:
    '에이전트가 "{path}"에서 memory tool의 "{command}" 명령을 실행하려 합니다. 메모리 내용이 영구 삭제되며 되돌릴 수 없습니다.',
  nativeDeleteConfirm: "삭제",
};

const TR: AIMemoryCopy = {
  openButton: "Agent bellekleri",
  title: "Agent bellekleri",
  subtitle: "Agent'ın bu bağlantı/veritabanı için kaydettiği bilgiler.",
  refresh: "Listeyi yenile",
  loading: "Yükleniyor…",
  empty: "Henüz kayıtlı bellek yok.",
  emptyHint: "Agent, save_memory ile kalıcı bilgileri buraya kaydeder.",
  scopeLabel: "Kapsam",
  updatedLabel: "Güncellendi",
  originAgent: "agent",
  originUser: "user",
  viewAction: "Görüntüle",
  hideAction: "Gizle",
  deleteAction: "Sil",
  clearAllAction: "Tümünü sil",
  closeAction: "Kapat",
  deleteTitle: "Bu bellek silinsin mi?",
  deleteBody: '"{name}" kalıcı olarak silinsin mi? Bu işlem geri alınamaz.',
  deleteConfirm: "Sil",
  clearAllTitle: "Tüm bellekler silinsin mi?",
  clearAllBody: "Bu kapsamdaki tüm bellekler kalıcı olarak silinsin mi? Geri alınamaz.",
  clearAllConfirm: "Tümünü sil",
  cancelLabel: "İptal",
  loadFailed: "Bellekler yüklenemedi.",
  deleteFailed: "Bellek silinemedi.",
  bodyTitle: "Bellek içeriği",
  savedToastTitle: "Bellek kaydedildi",
  savedToastBody: 'Agent "{name}" öğesini belleğe kaydetti.',
  nativeDeleteTitle: "Bellek dosyası silinsin mi?",
  nativeDeleteBody:
    'Agent, "{path}" üzerinde memory tool\'un "{command}" komutunu çalıştırmak istiyor. Bellek içeriği kalıcı olarak silinir ve geri alınamaz.',
  nativeDeleteConfirm: "Sil",
};

const ZH: AIMemoryCopy = {
  openButton: "智能体记忆",
  title: "智能体记忆",
  subtitle: "智能体为此连接/数据库保存的信息。",
  refresh: "刷新列表",
  loading: "加载中…",
  empty: "尚未保存任何记忆。",
  emptyHint: "智能体通过 save_memory 保存的内容会显示在这里。",
  scopeLabel: "范围",
  updatedLabel: "更新时间",
  originAgent: "agent",
  originUser: "user",
  viewAction: "查看",
  hideAction: "隐藏",
  deleteAction: "删除",
  clearAllAction: "全部清除",
  closeAction: "关闭",
  deleteTitle: "删除此记忆？",
  deleteBody: '永久删除"{name}"？此操作无法撤销。',
  deleteConfirm: "删除",
  clearAllTitle: "清除所有记忆？",
  clearAllBody: "永久删除此范围内的所有记忆？此操作无法撤销。",
  clearAllConfirm: "全部清除",
  cancelLabel: "取消",
  loadFailed: "无法加载记忆列表。",
  deleteFailed: "无法删除该记忆。",
  bodyTitle: "记忆内容",
  savedToastTitle: "记忆已保存",
  savedToastBody: '智能体已将"{name}"保存到记忆中。',
  nativeDeleteTitle: "删除记忆文件？",
  nativeDeleteBody:
    '智能体想在"{path}"上运行 memory tool 的"{command}"命令。这将永久删除记忆内容，无法撤销。',
  nativeDeleteConfirm: "删除",
};

export function getAIMemoryCopy(language: string): AIMemoryCopy {
  switch (language) {
    case "vi":
      return VI;
    case "ko":
      return KO;
    case "tr":
      return TR;
    case "zh":
      return ZH;
    default:
      return EN;
  }
}

/** `{placeholder}` interpolation for the copy templates above. */
export function formatMemoryCopy(
  template: string,
  values: Record<string, string | number>,
): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? String(values[key]) : match,
  );
}
