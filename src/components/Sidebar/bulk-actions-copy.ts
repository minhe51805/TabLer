/**
 * Copy for the explorer multi-select bulk actions (selection bar, bulk export,
 * typed-phrase bulk drop). Kept out of src/i18n per the per-feature
 * copy-module convention.
 */

import type { AppLanguage } from "../../i18n";

export interface BulkActionsCopy {
  /** Selection bar label, e.g. "3 selected". */
  selectedCount: (count: number) => string;
  /** Selection bar / context menu actions. */
  exportTables: string;
  exportCsv: string;
  exportJsonl: string;
  dropTables: string;
  clearSelection: string;
  /** Bulk export toasts. */
  exportDone: (exported: number, failed: number) => string;
  exportCancelled: string;
  exportFailed: string;
  /** Bulk drop confirmation modal. */
  dropTitle: (count: number) => string;
  dropDescription: string;
  dropRowsColumn: string;
  dropRowsLoading: string;
  dropRowsUnknown: string;
  dropTotalRows: (total: number) => string;
  dropTypePhrase: (phrase: string) => string;
  dropConfirm: (count: number) => string;
  dropDone: (count: number) => string;
  dropFailed: string;
  cancel: string;
}

const EN_COPY: BulkActionsCopy = {
  selectedCount: (count) => `${count} selected`,
  exportTables: "Export tables…",
  exportCsv: "Export as CSV",
  exportJsonl: "Export as JSONL",
  dropTables: "Drop tables…",
  clearSelection: "Clear selection",
  exportDone: (exported, failed) =>
    failed === 0
      ? `Exported ${exported} table${exported === 1 ? "" : "s"}.`
      : `Exported ${exported} table${exported === 1 ? "" : "s"}; ${failed} failed.`,
  exportCancelled: "Bulk export cancelled.",
  exportFailed: "Bulk export failed",
  dropTitle: (count) => `Drop ${count} table${count === 1 ? "" : "s"}?`,
  dropDescription:
    "This permanently drops the selected tables and all their data. Review the row counts below before confirming.",
  dropRowsColumn: "Rows",
  dropRowsLoading: "counting…",
  dropRowsUnknown: "unknown",
  dropTotalRows: (total) => `Total rows to be lost: ${total.toLocaleString()}`,
  dropTypePhrase: (phrase) => `Type ${phrase} to confirm`,
  dropConfirm: (count) => `Drop ${count} table${count === 1 ? "" : "s"}`,
  dropDone: (count) => `Dropped ${count} table${count === 1 ? "" : "s"}.`,
  dropFailed: "Bulk drop failed",
  cancel: "Cancel",
};

const VI_COPY: BulkActionsCopy = {
  selectedCount: (count) => `Đã chọn ${count}`,
  exportTables: "Xuất các bảng…",
  exportCsv: "Xuất dạng CSV",
  exportJsonl: "Xuất dạng JSONL",
  dropTables: "Xóa các bảng…",
  clearSelection: "Bỏ chọn",
  exportDone: (exported, failed) =>
    failed === 0 ? `Đã xuất ${exported} bảng.` : `Đã xuất ${exported} bảng; ${failed} thất bại.`,
  exportCancelled: "Đã hủy xuất hàng loạt.",
  exportFailed: "Xuất hàng loạt thất bại",
  dropTitle: (count) => `Xóa ${count} bảng?`,
  dropDescription:
    "Thao tác này xóa vĩnh viễn các bảng đã chọn cùng toàn bộ dữ liệu. Kiểm tra số dòng bên dưới trước khi xác nhận.",
  dropRowsColumn: "Số dòng",
  dropRowsLoading: "đang đếm…",
  dropRowsUnknown: "không rõ",
  dropTotalRows: (total) => `Tổng số dòng sẽ mất: ${total.toLocaleString()}`,
  dropTypePhrase: (phrase) => `Nhập ${phrase} để xác nhận`,
  dropConfirm: (count) => `Xóa ${count} bảng`,
  dropDone: (count) => `Đã xóa ${count} bảng.`,
  dropFailed: "Xóa hàng loạt thất bại",
  cancel: "Hủy",
};

const ZH_COPY: BulkActionsCopy = {
  selectedCount: (count) => `已选择 ${count} 项`,
  exportTables: "导出表…",
  exportCsv: "导出为 CSV",
  exportJsonl: "导出为 JSONL",
  dropTables: "删除表…",
  clearSelection: "清除选择",
  exportDone: (exported, failed) =>
    failed === 0 ? `已导出 ${exported} 张表。` : `已导出 ${exported} 张表；${failed} 张失败。`,
  exportCancelled: "批量导出已取消。",
  exportFailed: "批量导出失败",
  dropTitle: (count) => `删除 ${count} 张表？`,
  dropDescription: "此操作将永久删除所选表及其全部数据。请在确认前查看下方的行数。",
  dropRowsColumn: "行数",
  dropRowsLoading: "统计中…",
  dropRowsUnknown: "未知",
  dropTotalRows: (total) => `将丢失的总行数：${total.toLocaleString()}`,
  dropTypePhrase: (phrase) => `输入 ${phrase} 以确认`,
  dropConfirm: (count) => `删除 ${count} 张表`,
  dropDone: (count) => `已删除 ${count} 张表。`,
  dropFailed: "批量删除失败",
  cancel: "取消",
};

const TR_COPY: BulkActionsCopy = {
  selectedCount: (count) => `${count} seçildi`,
  exportTables: "Tabloları dışa aktar…",
  exportCsv: "CSV olarak dışa aktar",
  exportJsonl: "JSONL olarak dışa aktar",
  dropTables: "Tabloları bırak…",
  clearSelection: "Seçimi temizle",
  exportDone: (exported, failed) =>
    failed === 0
      ? `${exported} tablo dışa aktarıldı.`
      : `${exported} tablo aktarıldı; ${failed} başarısız.`,
  exportCancelled: "Toplu dışa aktarma iptal edildi.",
  exportFailed: "Toplu dışa aktarma başarısız",
  dropTitle: (count) => `${count} tablo bırakılsın mı?`,
  dropDescription:
    "Bu işlem seçili tabloları ve tüm verilerini kalıcı olarak siler. Onaylamadan önce aşağıdaki satır sayılarını inceleyin.",
  dropRowsColumn: "Satır",
  dropRowsLoading: "sayılıyor…",
  dropRowsUnknown: "bilinmiyor",
  dropTotalRows: (total) => `Kaybedilecek toplam satır: ${total.toLocaleString()}`,
  dropTypePhrase: (phrase) => `Onaylamak için ${phrase} yazın`,
  dropConfirm: (count) => `${count} tabloyu bırak`,
  dropDone: (count) => `${count} tablo bırakıldı.`,
  dropFailed: "Toplu bırakma başarısız",
  cancel: "İptal",
};

const KO_COPY: BulkActionsCopy = {
  selectedCount: (count) => `${count}개 선택됨`,
  exportTables: "테이블보내기…",
  exportCsv: "CSV로보내기",
  exportJsonl: "JSONL로보내기",
  dropTables: "테이블 삭제…",
  clearSelection: "선택 해제",
  exportDone: (exported, failed) =>
    failed === 0
      ? `테이블 ${exported}개를보냈습니다.`
      : `테이블 ${exported}개보냄, ${failed}개 실패.`,
  exportCancelled: "일괄보내기가 취소되었습니다.",
  exportFailed: "일괄보내기 실패",
  dropTitle: (count) => `테이블 ${count}개를 삭제할까요?`,
  dropDescription:
    "선택한 테이블과 모든 데이터가 영구적으로 삭제됩니다. 확인하기 전에 아래 행 수를 검토하세요.",
  dropRowsColumn: "행 수",
  dropRowsLoading: "계산 중…",
  dropRowsUnknown: "알 수 없음",
  dropTotalRows: (total) => `삭제될 총 행 수: ${total.toLocaleString()}`,
  dropTypePhrase: (phrase) => `확인하려면 ${phrase}를 입력하세요`,
  dropConfirm: (count) => `테이블 ${count}개 삭제`,
  dropDone: (count) => `테이블 ${count}개를 삭제했습니다.`,
  dropFailed: "일괄 삭제 실패",
  cancel: "취소",
};

const COPY: Record<AppLanguage, BulkActionsCopy> = {
  en: EN_COPY,
  vi: VI_COPY,
  zh: ZH_COPY,
  tr: TR_COPY,
  ko: KO_COPY,
};

export function getBulkActionsCopy(language: AppLanguage): BulkActionsCopy {
  return COPY[language] ?? EN_COPY;
}
