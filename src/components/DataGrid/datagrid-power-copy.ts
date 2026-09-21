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
