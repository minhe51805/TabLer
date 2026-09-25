/**
 * Copy for the table-export format picker (DataGrid export menu and the
 * sidebar bulk-export submenu). Kept out of src/i18n per the per-feature
 * copy-module convention.
 */

import type { AppLanguage } from "../i18n";
import type { TableExportFormat } from "./export-formats";

export interface ExportFormatsCopy {
  /** Tag appended to a format's hint when the whole table streams to disk. */
  fullTableTag: string;
  /** Hint for entries that export only the currently loaded rows. */
  loadedRowsHint: string;
  /** Per-format picker label + short description. */
  formats: Record<TableExportFormat, { label: string; hint: string }>;
}

const EN_COPY: ExportFormatsCopy = {
  fullTableTag: "full table",
  loadedRowsHint: "Loaded rows only",
  formats: {
    csv: { label: "CSV", hint: "Comma-separated values" },
    tsv: { label: "TSV", hint: "Tab-separated values" },
    json: { label: "JSON", hint: "Pretty-printed array" },
    jsonl: { label: "JSONL", hint: "One JSON object per line" },
    sql: { label: "SQL", hint: "INSERT statements" },
    xlsx: { label: "XLSX", hint: "Excel workbook" },
    xml: { label: "XML", hint: "XML document" },
    html: { label: "HTML", hint: "HTML table" },
    markdown: { label: "Markdown", hint: "GFM table" },
    parquet: { label: "Parquet", hint: "Columnar binary" },
  },
};

const VI_COPY: ExportFormatsCopy = {
  fullTableTag: "toàn bộ bảng",
  loadedRowsHint: "Chỉ các hàng đã tải",
  formats: {
    csv: { label: "CSV", hint: "Giá trị phân cách bởi dấu phẩy" },
    tsv: { label: "TSV", hint: "Giá trị phân cách bằng tab" },
    json: { label: "JSON", hint: "Mảng JSON định dạng đẹp" },
    jsonl: { label: "JSONL", hint: "Một object JSON mỗi dòng" },
    sql: { label: "SQL", hint: "Câu lệnh INSERT" },
    xlsx: { label: "XLSX", hint: "Sổ tính Excel" },
    xml: { label: "XML", hint: "Tài liệu XML" },
    html: { label: "HTML", hint: "Bảng HTML" },
    markdown: { label: "Markdown", hint: "Bảng GFM" },
    parquet: { label: "Parquet", hint: "Nhị phân dạng cột" },
  },
};

const KO_COPY: ExportFormatsCopy = {
  fullTableTag: "전체 테이블",
  loadedRowsHint: "불러온 행만",
  formats: {
    csv: { label: "CSV", hint: "쉼표로 구분된 값" },
    tsv: { label: "TSV", hint: "탭으로 구분된 값" },
    json: { label: "JSON", hint: "정렬된 JSON 배열" },
    jsonl: { label: "JSONL", hint: "행당 하나의 JSON 객체" },
    sql: { label: "SQL", hint: "INSERT 문" },
    xlsx: { label: "XLSX", hint: "Excel 통합 문서" },
    xml: { label: "XML", hint: "XML 문서" },
    html: { label: "HTML", hint: "HTML 테이블" },
    markdown: { label: "Markdown", hint: "GFM 테이블" },
    parquet: { label: "Parquet", hint: "컬럼형 바이너리" },
  },
};

const TR_COPY: ExportFormatsCopy = {
  fullTableTag: "tüm tablo",
  loadedRowsHint: "Yalnızca yüklü satırlar",
  formats: {
    csv: { label: "CSV", hint: "Virgülle ayrılmış değerler" },
    tsv: { label: "TSV", hint: "Sekmeyle ayrılmış değerler" },
    json: { label: "JSON", hint: "Biçimlendirilmiş JSON dizisi" },
    jsonl: { label: "JSONL", hint: "Satır başına bir JSON nesnesi" },
    sql: { label: "SQL", hint: "INSERT ifadeleri" },
    xlsx: { label: "XLSX", hint: "Excel çalışma kitabı" },
    xml: { label: "XML", hint: "XML belgesi" },
    html: { label: "HTML", hint: "HTML tablosu" },
    markdown: { label: "Markdown", hint: "GFM tablosu" },
    parquet: { label: "Parquet", hint: "Sütunlu ikili" },
  },
};

const ZH_COPY: ExportFormatsCopy = {
  fullTableTag: "整表",
  loadedRowsHint: "仅已加载的行",
  formats: {
    csv: { label: "CSV", hint: "逗号分隔值" },
    tsv: { label: "TSV", hint: "制表符分隔值" },
    json: { label: "JSON", hint: "格式化 JSON 数组" },
    jsonl: { label: "JSONL", hint: "每行一个 JSON 对象" },
    sql: { label: "SQL", hint: "INSERT 语句" },
    xlsx: { label: "XLSX", hint: "Excel 工作簿" },
    xml: { label: "XML", hint: "XML 文档" },
    html: { label: "HTML", hint: "HTML 表格" },
    markdown: { label: "Markdown", hint: "GFM 表格" },
    parquet: { label: "Parquet", hint: "列式二进制" },
  },
};

const COPY: Record<AppLanguage, ExportFormatsCopy> = {
  en: EN_COPY,
  vi: VI_COPY,
  ko: KO_COPY,
  tr: TR_COPY,
  zh: ZH_COPY,
};

export function getExportFormatsCopy(language: AppLanguage): ExportFormatsCopy {
  return COPY[language] ?? EN_COPY;
}
