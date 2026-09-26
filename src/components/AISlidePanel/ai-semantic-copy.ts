/**
 * Strings for the semantic glossary manager modal and the remember_term
 * tool's toast. Per-feature copy module: `getAISemanticCopy` returns the
 * language pack with English as the fallback.
 */

export interface AISemanticCopy {
  /** Header button tooltip that opens the glossary manager. */
  openButton: string;
  title: string;
  subtitle: string;
  refresh: string;
  loading: string;
  empty: string;
  emptyHint: string;
  scopeLabel: string;
  updatedLabel: string;
  termColumn: string;
  kindLabel: string;
  sourceLabel: string;
  sourceAgent: string;
  sourceUser: string;
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
  /** Toast shown when the agent saves a glossary term. */
  savedToastTitle: string;
  savedToastBody: string;
}

const EN: AISemanticCopy = {
  openButton: "Business glossary",
  title: "Business glossary",
  subtitle: "Terms the agent learned (or you curated) for this connection/database.",
  refresh: "Reload the list",
  loading: "Loading…",
  empty: "No glossary entries yet.",
  emptyHint: "The agent saves durable meanings here with remember_term.",
  scopeLabel: "Scope",
  updatedLabel: "Updated",
  termColumn: "Term",
  kindLabel: "Kind",
  sourceLabel: "Source",
  sourceAgent: "agent",
  sourceUser: "user",
  deleteAction: "Delete",
  clearAllAction: "Clear all",
  closeAction: "Close",
  deleteTitle: "Delete this glossary entry?",
  deleteBody: 'Permanently delete "{term}"? The agent will stop seeing this definition.',
  deleteConfirm: "Delete",
  clearAllTitle: "Clear the glossary?",
  clearAllBody:
    "Permanently delete every glossary entry in this scope? The agent loses all curated meanings.",
  clearAllConfirm: "Clear all",
  cancelLabel: "Cancel",
  loadFailed: "Could not load the glossary.",
  deleteFailed: "Could not delete the entry.",
  savedToastTitle: "Glossary term saved",
  savedToastBody: 'The agent saved "{term}" to the glossary.',
};

const VI: AISemanticCopy = {
  openButton: "Từ điển nghiệp vụ",
  title: "Từ điển nghiệp vụ",
  subtitle: "Các thuật ngữ agent đã học (hoặc bạn định nghĩa) cho connection/database này.",
  refresh: "Tải lại danh sách",
  loading: "Đang tải…",
  empty: "Chưa có thuật ngữ nào.",
  emptyHint: "Agent lưu các ý nghĩa lâu dài ở đây bằng remember_term.",
  scopeLabel: "Phạm vi",
  updatedLabel: "Cập nhật",
  termColumn: "Thuật ngữ",
  kindLabel: "Loại",
  sourceLabel: "Nguồn",
  sourceAgent: "agent",
  sourceUser: "user",
  deleteAction: "Xóa",
  clearAllAction: "Xóa tất cả",
  closeAction: "Đóng",
  deleteTitle: "Xóa thuật ngữ này?",
  deleteBody: 'Xóa vĩnh viễn "{term}"? Agent sẽ không còn thấy định nghĩa này nữa.',
  deleteConfirm: "Xóa",
  clearAllTitle: "Xóa toàn bộ từ điển?",
  clearAllBody:
    "Xóa vĩnh viễn mọi thuật ngữ trong phạm vi này? Agent sẽ mất toàn bộ ý nghĩa đã lưu.",
  clearAllConfirm: "Xóa tất cả",
  cancelLabel: "Hủy",
  loadFailed: "Không thể tải từ điển.",
  deleteFailed: "Không thể xóa thuật ngữ.",
  savedToastTitle: "Đã lưu thuật ngữ",
  savedToastBody: 'Agent đã lưu "{term}" vào từ điển.',
};

const KO: AISemanticCopy = {
  openButton: "비즈니스 용어집",
  title: "비즈니스 용어집",
  subtitle: "에이전트가 이 연결/데이터베이스에 대해 학습한 용어입니다.",
  refresh: "목록 새로고침",
  loading: "불러오는 중…",
  empty: "저장된 용어가 없습니다.",
  emptyHint: "에이전트가 remember_term으로 저장한 의미가 여기에 표시됩니다.",
  scopeLabel: "범위",
  updatedLabel: "업데이트",
  termColumn: "용어",
  kindLabel: "종류",
  sourceLabel: "출처",
  sourceAgent: "agent",
  sourceUser: "user",
  deleteAction: "삭제",
  clearAllAction: "모두 삭제",
  closeAction: "닫기",
  deleteTitle: "이 용어를 삭제할까요?",
  deleteBody: '"{term}"을(를) 영구 삭제할까요? 에이전트가 더 이상 이 정의를 보지 못합니다.',
  deleteConfirm: "삭제",
  clearAllTitle: "용어집을 비울까요?",
  clearAllBody: "이 범위의 모든 용어를 영구 삭제할까요? 에이전트가 저장된 모든 의미를 잃습니다.",
  clearAllConfirm: "모두 삭제",
  cancelLabel: "취소",
  loadFailed: "용어집을 불러오지 못했습니다.",
  deleteFailed: "용어를 삭제하지 못했습니다.",
  savedToastTitle: "용어 저장됨",
  savedToastBody: '에이전트가 "{term}"을(를) 용어집에 저장했습니다.',
};

const TR: AISemanticCopy = {
  openButton: "İş terimleri sözlüğü",
  title: "İş terimleri sözlüğü",
  subtitle: "Ajanın bu bağlantı/veritabanı için öğrendiği terimler.",
  refresh: "Listeyi yenile",
  loading: "Yükleniyor…",
  empty: "Henüz terim yok.",
  emptyHint: "Ajan, remember_term ile öğrendiği kalıcı anlamları buraya kaydeder.",
  scopeLabel: "Kapsam",
  updatedLabel: "Güncellendi",
  termColumn: "Terim",
  kindLabel: "Tür",
  sourceLabel: "Kaynak",
  sourceAgent: "agent",
  sourceUser: "user",
  deleteAction: "Sil",
  clearAllAction: "Tümünü sil",
  closeAction: "Kapat",
  deleteTitle: "Bu terimi silinsin mi?",
  deleteBody: '"{term}" kalıcı olarak silinsin mi? Ajan bu tanımı artık göremez.',
  deleteConfirm: "Sil",
  clearAllTitle: "Sözlük temizlensin mi?",
  clearAllBody:
    "Bu kapsamdaki tüm terimler kalıcı silinsin mi? Ajan kayıtlı tüm anlamları kaybeder.",
  clearAllConfirm: "Tümünü sil",
  cancelLabel: "İptal",
  loadFailed: "Sözlük yüklenemedi.",
  deleteFailed: "Terim silinemedi.",
  savedToastTitle: "Terim kaydedildi",
  savedToastBody: 'Ajan "{term}" terimini sözlüğe kaydetti.',
};

const ZH: AISemanticCopy = {
  openButton: "业务术语表",
  title: "业务术语表",
  subtitle: "代理为此连接/数据库学习（或您整理）的术语。",
  refresh: "刷新列表",
  loading: "加载中…",
  empty: "暂无语词条目。",
  emptyHint: "代理通过 remember_term 将长期含义保存在这里。",
  scopeLabel: "范围",
  updatedLabel: "更新时间",
  termColumn: "术语",
  kindLabel: "类型",
  sourceLabel: "来源",
  sourceAgent: "agent",
  sourceUser: "user",
  deleteAction: "删除",
  clearAllAction: "全部清除",
  closeAction: "关闭",
  deleteTitle: "删除此术语？",
  deleteBody: '永久删除"{term}"？代理将不再看到此定义。',
  deleteConfirm: "删除",
  clearAllTitle: "清空术语表？",
  clearAllBody: "永久删除此范围内的所有术语？代理将丢失全部已存含义。",
  clearAllConfirm: "全部清除",
  cancelLabel: "取消",
  loadFailed: "无法加载术语表。",
  deleteFailed: "无法删除术语。",
  savedToastTitle: "术语已保存",
  savedToastBody: '代理已将"{term}"保存到术语表。',
};

export function getAISemanticCopy(language: string): AISemanticCopy {
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
