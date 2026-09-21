/**
 * Copy for the grid power features: row-detail toggle, column stats popover,
 * and the extended Copy-as formats (Markdown / INSERT). Kept out of src/i18n
 * per the per-feature copy-module convention.
 */

import type { AppLanguage } from "../../i18n";

export interface DataGridPowerCopy {
  rowInspector: {
    /** Toolbar toggle button label + tooltip. */
    button: string;
  };
  stats: {
    /** Header context-menu item. */
    menuItem: string;
    /** Popover title prefix, e.g. "Column stats". */
    title: string;
    loading: string;
    failed: string;
    close: string;
    /** Metric row labels. */
    rows: string;
    distinct: string;
    nulls: string;
    min: string;
    max: string;
    avg: string;
  };
  copyAs: {
    /** Copy-menu entries. */
    markdown: string;
    markdownHint: string;
    insert: string;
    insertHint: string;
  };
  /** "Set selected cells to…" bulk-edit menu item and dialog. */
  setCells: {
    menuItem: string;
    title: string;
    description: (count: number) => string;
    valueLabel: string;
    nullLabel: string;
    apply: string;
    cancel: string;
    stagedToast: (count: number) => string;
    errNotEditable: string;
    errNoData: string;
    errNoSelection: string;
    errNoUpdates: string;
    errStageFailed: string;
  };
  /** Duplicate-row staging feedback. */
  duplicate: {
    stagedToast: string;
    nothingToDuplicate: string;
  };
}

const EN_COPY: DataGridPowerCopy = {
  rowInspector: {
    button: "Inspect row",
  },
  stats: {
    menuItem: "Column stats",
    title: "Column stats",
    loading: "Running stats query…",
    failed: "Stats query failed",
    close: "Close",
    rows: "Rows",
    distinct: "Distinct",
    nulls: "NULLs",
    min: "Min",
    max: "Max",
    avg: "Avg",
  },
  copyAs: {
    markdown: "Markdown",
    markdownHint: "GFM table",
    insert: "INSERT",
    insertHint: "SQL statements",
  },
  setCells: {
    menuItem: "Set selected cells to…",
    title: "Set selected cells",
    description: (count) =>
      `Stage the same value for ${count} selected cell${count === 1 ? "" : "s"}. The change lands in the review queue.`,
    valueLabel: "New value",
    nullLabel: "Set to NULL",
    apply: "Stage value",
    cancel: "Cancel",
    stagedToast: (count) => `Staged ${count} cell update${count === 1 ? "" : "s"}`,
    errNotEditable: "Inline editing is not available for this result.",
    errNoData: "No data is loaded.",
    errNoSelection: "There is no cell selection to update.",
    errNoUpdates:
      "Nothing to stage: the selection only covers protected cells or cells that already hold this value.",
    errStageFailed: "The value could not be staged for this result.",
  },
  duplicate: {
    stagedToast: "Row staged for insert",
    nothingToDuplicate: "Nothing to duplicate: every column is database-generated.",
  },
};

const VI_COPY: DataGridPowerCopy = {
  rowInspector: {
    button: "Xem dòng",
  },
  stats: {
    menuItem: "Thống kê cột",
    title: "Thống kê cột",
    loading: "Đang chạy truy vấn thống kê…",
    failed: "Truy vấn thống kê thất bại",
    close: "Đóng",
    rows: "Số dòng",
    distinct: "Khác nhau",
    nulls: "NULL",
    min: "Nhỏ nhất",
    max: "Lớn nhất",
    avg: "Trung bình",
  },
  copyAs: {
    markdown: "Markdown",
    markdownHint: "Bảng GFM",
    insert: "INSERT",
    insertHint: "Câu lệnh SQL",
  },
  setCells: {
    menuItem: "Đặt các ô đã chọn thành…",
    title: "Đặt các ô đã chọn",
    description: (count) =>
      `Xếp hàng cùng một giá trị cho ${count} ô đã chọn. Thay đổi sẽ vào hàng đợi xem trước.`,
    valueLabel: "Giá trị mới",
    nullLabel: "Đặt thành NULL",
    apply: "Xếp hàng giá trị",
    cancel: "Hủy",
    stagedToast: (count) => `Đã xếp hàng ${count} cập nhật ô`,
    errNotEditable: "Chỉnh sửa nội tuyến không khả dụng cho kết quả này.",
    errNoData: "Chưa tải dữ liệu.",
    errNoSelection: "Không có vùng ô nào để cập nhật.",
    errNoUpdates:
      "Không có gì để xếp hàng: vùng chọn chỉ gồm ô được bảo vệ hoặc ô đã có giá trị này.",
    errStageFailed: "Không thể xếp hàng giá trị cho kết quả này.",
  },
  duplicate: {
    stagedToast: "Đã xếp hàng dòng để chèn",
    nothingToDuplicate: "Không có gì để nhân bản: mọi cột đều do cơ sở dữ liệu tạo.",
  },
};

const KO_COPY: DataGridPowerCopy = {
  rowInspector: {
    button: "행 검사",
  },
  stats: {
    menuItem: "열 통계",
    title: "열 통계",
    loading: "통계 쿼리 실행 중…",
    failed: "통계 쿼리 실패",
    close: "닫기",
    rows: "행 수",
    distinct: "고유값",
    nulls: "NULL",
    min: "최소",
    max: "최대",
    avg: "평균",
  },
  copyAs: {
    markdown: "Markdown",
    markdownHint: "GFM 테이블",
    insert: "INSERT",
    insertHint: "SQL 문",
  },
  setCells: {
    menuItem: "선택한 셀을 다음으로 설정…",
    title: "선택한 셀 설정",
    description: (count) =>
      `선택한 ${count}개 셀에 같은 값을 스테이징합니다. 변경 사항은 검토 큐에 추가됩니다.`,
    valueLabel: "새 값",
    nullLabel: "NULL로 설정",
    apply: "값 스테이징",
    cancel: "취소",
    stagedToast: (count) => `셀 업데이트 ${count}개를 스테이징했습니다`,
    errNotEditable: "이 결과에서는 인라인 편집을 사용할 수 없습니다.",
    errNoData: "로드된 데이터가 없습니다.",
    errNoSelection: "업데이트할 셀 선택 영역이 없습니다.",
    errNoUpdates:
      "스테이징할 항목이 없습니다: 선택 영역에 보호된 셀이나 이미 같은 값을 가진 셀만 있습니다.",
    errStageFailed: "이 결과에 값을 스테이징할 수 없습니다.",
  },
  duplicate: {
    stagedToast: "삽입할 행을 스테이징했습니다",
    nothingToDuplicate: "복제할 내용이 없습니다: 모든 열이 데이터베이스에서 생성됩니다.",
  },
};

const TR_COPY: DataGridPowerCopy = {
  rowInspector: {
    button: "Satırı incele",
  },
  stats: {
    menuItem: "Sütun istatistikleri",
    title: "Sütun istatistikleri",
    loading: "İstatistik sorgusu çalışıyor…",
    failed: "İstatistik sorgusu başarısız",
    close: "Kapat",
    rows: "Satır",
    distinct: "Benzersiz",
    nulls: "NULL",
    min: "Min",
    max: "Maks",
    avg: "Ort",
  },
  copyAs: {
    markdown: "Markdown",
    markdownHint: "GFM tablosu",
    insert: "INSERT",
    insertHint: "SQL deyimleri",
  },
  setCells: {
    menuItem: "Seçili hücreleri şuna ayarla…",
    title: "Seçili hücreleri ayarla",
    description: (count) =>
      `Seçili ${count} hücre için aynı değeri kuyruğa alır. Değişiklik inceleme kuyruğuna eklenir.`,
    valueLabel: "Yeni değer",
    nullLabel: "NULL olarak ayarla",
    apply: "Değeri kuyruğa al",
    cancel: "İptal",
    stagedToast: (count) => `${count} hücre güncellemesi kuyruğa alındı`,
    errNotEditable: "Bu sonuç için satır içi düzenleme kullanılamıyor.",
    errNoData: "Yüklenmiş veri yok.",
    errNoSelection: "Güncellenecek hücre seçimi yok.",
    errNoUpdates:
      "Kuyruğa alınacak bir şey yok: seçim yalnızca korumalı hücreleri veya zaten bu değere sahip hücreleri kapsıyor.",
    errStageFailed: "Değer bu sonuç için kuyruğa alınamadı.",
  },
  duplicate: {
    stagedToast: "Satır ekleme için kuyruğa alındı",
    nothingToDuplicate:
      "Kopyalanacak bir şey yok: tüm sütunlar veritabanı tarafından oluşturuluyor.",
  },
};

const ZH_COPY: DataGridPowerCopy = {
  rowInspector: {
    button: "检查行",
  },
  stats: {
    menuItem: "列统计",
    title: "列统计",
    loading: "正在运行统计查询…",
    failed: "统计查询失败",
    close: "关闭",
    rows: "行数",
    distinct: "去重数",
    nulls: "NULL",
    min: "最小值",
    max: "最大值",
    avg: "平均值",
  },
  copyAs: {
    markdown: "Markdown",
    markdownHint: "GFM 表格",
    insert: "INSERT",
    insertHint: "SQL 语句",
  },
  setCells: {
    menuItem: "将所选单元格设置为…",
    title: "设置所选单元格",
    description: (count) => `为选中的 ${count} 个单元格暂存相同的值。更改将进入审核队列。`,
    valueLabel: "新值",
    nullLabel: "设为 NULL",
    apply: "暂存值",
    cancel: "取消",
    stagedToast: (count) => `已暂存 ${count} 个单元格更新`,
    errNotEditable: "此结果不支持内联编辑。",
    errNoData: "尚未加载数据。",
    errNoSelection: "没有可更新的单元格选择区域。",
    errNoUpdates: "没有可暂存的内容：所选区域仅包含受保护的单元格或已具有该值的单元格。",
    errStageFailed: "无法为此结果暂存该值。",
  },
  duplicate: {
    stagedToast: "行已暂存待插入",
    nothingToDuplicate: "没有可复制的列：所有列均由数据库生成。",
  },
};

const COPY: Record<AppLanguage, DataGridPowerCopy> = {
  en: EN_COPY,
  vi: VI_COPY,
  ko: KO_COPY,
  tr: TR_COPY,
  zh: ZH_COPY,
};

export function getDataGridPowerCopy(language: AppLanguage): DataGridPowerCopy {
  return COPY[language] ?? EN_COPY;
}
