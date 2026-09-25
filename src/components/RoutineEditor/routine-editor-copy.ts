/**
 * Copy for the Routine Editor modal (stored procedure / function browser,
 * definition viewer, and executor). Kept out of src/i18n per the per-feature
 * copy-module convention; English is the fallback.
 */

import type { AppLanguage } from "../../i18n";

export interface RoutineEditorCopy {
  kicker: string;
  title: string;
  description: string;
  searchPlaceholder: string;
  proceduresGroup: string;
  functionsGroup: string;
  refresh: string;
  loading: string;
  empty: string;
  emptyFiltered: string;
  unsupportedEngine: (engine: string) => string;
  selectRoutine: string;
  definitionUnavailable: string;
  editAsDraft: string;
  execute: string;
  executing: string;
  argsTitle: string;
  noArgs: string;
  argPlaceholder: string;
  resultTitle: string;
  resultEmpty: string;
  rowsAffected: (count: number) => string;
  executionMs: (ms: number) => string;
  truncated: string;
  loadFailed: string;
  executeFailed: string;
  draftOpened: string;
  kindProcedure: string;
  kindFunction: string;
}

const EN_COPY: RoutineEditorCopy = {
  kicker: "Programmability",
  title: "Routine Editor",
  description:
    "Browse stored procedures and functions, view their definitions, and run them with arguments.",
  searchPlaceholder: "Filter routines…",
  proceduresGroup: "Procedures",
  functionsGroup: "Functions",
  refresh: "Refresh",
  loading: "Loading routines…",
  empty: "No stored procedures or functions found.",
  emptyFiltered: "No routines match the filter.",
  unsupportedEngine: (engine) => `${engine} does not support routines in TableR.`,
  selectRoutine: "Select a routine to view its definition.",
  definitionUnavailable: "Definition is not available for this routine.",
  editAsDraft: "Edit as new draft",
  execute: "Execute",
  executing: "Executing…",
  argsTitle: "Arguments",
  noArgs: "This routine takes no arguments.",
  argPlaceholder: "value or NULL",
  resultTitle: "Result",
  resultEmpty: "The routine ran successfully and returned no rows.",
  rowsAffected: (count) => `${count} row${count === 1 ? "" : "s"} affected`,
  executionMs: (ms) => `${ms} ms`,
  truncated: "Result truncated — showing the first rows only.",
  loadFailed: "Failed to load routines",
  executeFailed: "Routine execution failed",
  draftOpened: "Opened definition in a new query tab.",
  kindProcedure: "Procedure",
  kindFunction: "Function",
};

const VI_COPY: RoutineEditorCopy = {
  kicker: "Programmability",
  title: "Trình sửa routine",
  description: "Duyệt stored procedure và function, xem định nghĩa và chạy với tham số.",
  searchPlaceholder: "Lọc routine…",
  proceduresGroup: "Procedures",
  functionsGroup: "Functions",
  refresh: "Làm mới",
  loading: "Đang tải routines…",
  empty: "Không tìm thấy stored procedure hoặc function nào.",
  emptyFiltered: "Không có routine nào khớp bộ lọc.",
  unsupportedEngine: (engine) => `${engine} không hỗ trợ routine trong TableR.`,
  selectRoutine: "Chọn một routine để xem định nghĩa.",
  definitionUnavailable: "Không có định nghĩa cho routine này.",
  editAsDraft: "Sửa như bản nháp mới",
  execute: "Thực thi",
  executing: "Đang thực thi…",
  argsTitle: "Tham số",
  noArgs: "Routine này không có tham số.",
  argPlaceholder: "giá trị hoặc NULL",
  resultTitle: "Kết quả",
  resultEmpty: "Routine đã chạy thành công và không trả về dòng nào.",
  rowsAffected: (count) => `${count} dòng bị ảnh hưởng`,
  executionMs: (ms) => `${ms} ms`,
  truncated: "Kết quả bị cắt bớt — chỉ hiển thị các dòng đầu.",
  loadFailed: "Không tải được routines",
  executeFailed: "Thực thi routine thất bại",
  draftOpened: "Đã mở định nghĩa trong tab truy vấn mới.",
  kindProcedure: "Procedure",
  kindFunction: "Function",
};

const KO_COPY: RoutineEditorCopy = {
  kicker: "Programmability",
  title: "루틴 편집기",
  description: "저장 프로시저와 함수를 탐색하고 정의를 확인한 뒤 인수와 함께 실행합니다.",
  searchPlaceholder: "루틴 필터…",
  proceduresGroup: "프로시저",
  functionsGroup: "함수",
  refresh: "새로고침",
  loading: "루틴을 불러오는 중…",
  empty: "저장 프로시저나 함수가 없습니다.",
  emptyFiltered: "필터와 일치하는 루틴이 없습니다.",
  unsupportedEngine: (engine) => `${engine}은(는) TableR에서 루틴을 지원하지 않습니다.`,
  selectRoutine: "정의를 보려면 루틴을 선택하세요.",
  definitionUnavailable: "이 루틴의 정의를 사용할 수 없습니다.",
  editAsDraft: "새 초안으로 편집",
  execute: "실행",
  executing: "실행 중…",
  argsTitle: "인수",
  noArgs: "이 루틴은 인수가 없습니다.",
  argPlaceholder: "값 또는 NULL",
  resultTitle: "결과",
  resultEmpty: "루틴이 성공적으로 실행되었으며 반환된 행이 없습니다.",
  rowsAffected: (count) => `${count}개 행이 영향을 받음`,
  executionMs: (ms) => `${ms} ms`,
  truncated: "결과가 잘렸습니다 — 처음 행만 표시합니다.",
  loadFailed: "루틴을 불러오지 못했습니다",
  executeFailed: "루틴 실행에 실패했습니다",
  draftOpened: "새 쿼리 탭에서 정의를 열었습니다.",
  kindProcedure: "프로시저",
  kindFunction: "함수",
};

const TR_COPY: RoutineEditorCopy = {
  kicker: "Programmability",
  title: "Routine Düzenleyici",
  description:
    "Saklı yordamları ve fonksiyonları gezin, tanımlarını görüntüleyin ve argümanlarla çalıştırın.",
  searchPlaceholder: "Routine filtrele…",
  proceduresGroup: "Yordamlar",
  functionsGroup: "Fonksiyonlar",
  refresh: "Yenile",
  loading: "Routineler yükleniyor…",
  empty: "Saklı yordam veya fonksiyon bulunamadı.",
  emptyFiltered: "Filtreyle eşleşen routine yok.",
  unsupportedEngine: (engine) => `${engine}, TableR'da routineleri desteklemiyor.`,
  selectRoutine: "Tanımını görmek için bir routine seçin.",
  definitionUnavailable: "Bu routine için tanım mevcut değil.",
  editAsDraft: "Yeni taslak olarak düzenle",
  execute: "Çalıştır",
  executing: "Çalıştırılıyor…",
  argsTitle: "Argümanlar",
  noArgs: "Bu routine argüman almıyor.",
  argPlaceholder: "değer veya NULL",
  resultTitle: "Sonuç",
  resultEmpty: "Routine başarıyla çalıştı ve satır döndürmedi.",
  rowsAffected: (count) => `${count} satır etkilendi`,
  executionMs: (ms) => `${ms} ms`,
  truncated: "Sonuç kırpıldı — yalnızca ilk satırlar gösteriliyor.",
  loadFailed: "Routineler yüklenemedi",
  executeFailed: "Routine çalıştırma başarısız",
  draftOpened: "Tanım yeni bir sorgu sekmesinde açıldı.",
  kindProcedure: "Yordam",
  kindFunction: "Fonksiyon",
};

const ZH_COPY: RoutineEditorCopy = {
  kicker: "Programmability",
  title: "例程编辑器",
  description: "浏览存储过程和函数，查看定义并带参数执行。",
  searchPlaceholder: "筛选例程…",
  proceduresGroup: "存储过程",
  functionsGroup: "函数",
  refresh: "刷新",
  loading: "正在加载例程…",
  empty: "未找到存储过程或函数。",
  emptyFiltered: "没有匹配筛选条件的例程。",
  unsupportedEngine: (engine) => `${engine} 在 TableR 中不支持例程。`,
  selectRoutine: "选择一个例程以查看其定义。",
  definitionUnavailable: "此例程的定义不可用。",
  editAsDraft: "编辑为新草稿",
  execute: "执行",
  executing: "执行中…",
  argsTitle: "参数",
  noArgs: "此例程没有参数。",
  argPlaceholder: "值或 NULL",
  resultTitle: "结果",
  resultEmpty: "例程已成功执行，未返回任何行。",
  rowsAffected: (count) => `${count} 行受影响`,
  executionMs: (ms) => `${ms} ms`,
  truncated: "结果已截断 — 仅显示前几行。",
  loadFailed: "加载例程失败",
  executeFailed: "例程执行失败",
  draftOpened: "已在新的查询标签页中打开定义。",
  kindProcedure: "存储过程",
  kindFunction: "函数",
};

const COPY: Record<AppLanguage, RoutineEditorCopy> = {
  en: EN_COPY,
  vi: VI_COPY,
  ko: KO_COPY,
  tr: TR_COPY,
  zh: ZH_COPY,
};

export function getRoutineEditorCopy(language: AppLanguage): RoutineEditorCopy {
  return COPY[language] ?? EN_COPY;
}
