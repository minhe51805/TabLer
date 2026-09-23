/**
 * Copy for the Global Search overlay (Ctrl+Shift+F). Kept out of src/i18n per
 * the per-feature copy-module convention; English is the fallback.
 */

import type { AppLanguage } from "../../i18n";

export interface GlobalSearchCopy {
  /** Dialog landmark label. */
  ariaLabel: string;
  /** Input landmark label. */
  inputAriaLabel: string;
  /** Clear-keyword button label. */
  clear: string;
  placeholderSchema: string;
  placeholderData: string;
  tabSchema: string;
  tabData: string;
  /** Scope hint next to the mode tabs; {db} is the active database name. */
  onDatabase: (db: string) => string;
  /** Scope hint when nothing is connected. */
  connectFirst: string;
  defaultDatabase: string;
  tableSelectAria: string;
  tableInputPlaceholder: string;
  resultsAria: string;
  emptySchemaType: string;
  emptySchemaNoMatch: string;
  /** Column match row: "{column} · in {table}". */
  columnInTable: (column: string, table: string) => string;
  emptyMultiType: string;
  emptyMultiNoMatch: string;
  rowsCount: (count: number) => string;
  matchingRows: (count: number, table: string) => string;
  openTableToBrowse: (table: string) => string;
  emptyDataType: string;
  emptyDataSelectTable: string;
  emptyDataNoMatch: string;
  footer: string;
  /** Kind badge on a schema match row. */
  kindTable: string;
  kindColumn: string;
}

const EN_COPY: GlobalSearchCopy = {
  ariaLabel: "Global search",
  inputAriaLabel: "Global search keyword",
  clear: "Clear",
  placeholderSchema: "Search tables and columns…",
  placeholderData: "Search text in table…",
  tabSchema: "Schema",
  tabData: "Data",
  onDatabase: (db) => `on ${db}`,
  connectFirst: "— connect to a database first",
  defaultDatabase: "default database",
  tableSelectAria: "Table to search",
  tableInputPlaceholder: "Table name (e.g. dbo.users)",
  resultsAria: "Global search results",
  emptySchemaType: "Type to search tables and columns",
  emptySchemaNoMatch: "No schema matches",
  columnInTable: (column, table) => `${column} · in ${table}`,
  emptyMultiType: "Type a keyword to search all tables",
  emptyMultiNoMatch: "No matching rows in any table",
  rowsCount: (count) => `${count} row(s)`,
  matchingRows: (count, table) => `${count} matching row(s) in ${table}`,
  openTableToBrowse: (table) => `Open ${table} to browse matches`,
  emptyDataType: "Type a keyword to search the selected table",
  emptyDataSelectTable: "Select a table to search",
  emptyDataNoMatch: "No matching rows",
  footer: "Esc to close · results limited to your active connection",
  kindTable: "table",
  kindColumn: "column",
};

const VI_COPY: GlobalSearchCopy = {
  ariaLabel: "Tìm kiếm toàn cục",
  inputAriaLabel: "Từ khóa tìm kiếm toàn cục",
  clear: "Xóa",
  placeholderSchema: "Tìm bảng và cột…",
  placeholderData: "Tìm văn bản trong bảng…",
  tabSchema: "Lược đồ",
  tabData: "Dữ liệu",
  onDatabase: (db) => `trên ${db}`,
  connectFirst: "— hãy kết nối cơ sở dữ liệu trước",
  defaultDatabase: "cơ sở dữ liệu mặc định",
  tableSelectAria: "Bảng cần tìm",
  tableInputPlaceholder: "Tên bảng (vd. dbo.users)",
  resultsAria: "Kết quả tìm kiếm toàn cục",
  emptySchemaType: "Nhập để tìm bảng và cột",
  emptySchemaNoMatch: "Không có lược đồ khớp",
  columnInTable: (column, table) => `${column} · trong ${table}`,
  emptyMultiType: "Nhập từ khóa để tìm trong mọi bảng",
  emptyMultiNoMatch: "Không có hàng khớp trong bảng nào",
  rowsCount: (count) => `${count} hàng`,
  matchingRows: (count, table) => `${count} hàng khớp trong ${table}`,
  openTableToBrowse: (table) => `Mở ${table} để xem kết quả`,
  emptyDataType: "Nhập từ khóa để tìm trong bảng đã chọn",
  emptyDataSelectTable: "Chọn một bảng để tìm",
  emptyDataNoMatch: "Không có hàng khớp",
  footer: "Esc để đóng · kết quả giới hạn trong kết nối đang dùng",
  kindTable: "bảng",
  kindColumn: "cột",
};

const KO_COPY: GlobalSearchCopy = {
  ariaLabel: "전역 검색",
  inputAriaLabel: "전역 검색 키워드",
  clear: "지우기",
  placeholderSchema: "테이블과 열 검색…",
  placeholderData: "테이블에서 텍스트 검색…",
  tabSchema: "스키마",
  tabData: "데이터",
  onDatabase: (db) => `${db}에서`,
  connectFirst: "— 먼저 데이터베이스에 연결하세요",
  defaultDatabase: "기본 데이터베이스",
  tableSelectAria: "검색할 테이블",
  tableInputPlaceholder: "테이블 이름 (예: dbo.users)",
  resultsAria: "전역 검색 결과",
  emptySchemaType: "입력하여 테이블과 열 검색",
  emptySchemaNoMatch: "일치하는 스키마 없음",
  columnInTable: (column, table) => `${column} · ${table} 내`,
  emptyMultiType: "모든 테이블을 검색할 키워드 입력",
  emptyMultiNoMatch: "어떤 테이블에도 일치하는 행 없음",
  rowsCount: (count) => `행 ${count}개`,
  matchingRows: (count, table) => `${table}에서 일치하는 행 ${count}개`,
  openTableToBrowse: (table) => `${table}을(를) 열어 결과 보기`,
  emptyDataType: "선택한 테이블을 검색할 키워드 입력",
  emptyDataSelectTable: "검색할 테이블 선택",
  emptyDataNoMatch: "일치하는 행 없음",
  footer: "Esc로 닫기 · 결과는 현재 연결로 제한됩니다",
  kindTable: "테이블",
  kindColumn: "열",
};

const TR_COPY: GlobalSearchCopy = {
  ariaLabel: "Genel arama",
  inputAriaLabel: "Genel arama anahtar kelimesi",
  clear: "Temizle",
  placeholderSchema: "Tablo ve sütun ara…",
  placeholderData: "Tabloda metin ara…",
  tabSchema: "Şema",
  tabData: "Veri",
  onDatabase: (db) => `${db} üzerinde`,
  connectFirst: "— önce bir veritabanına bağlanın",
  defaultDatabase: "varsayılan veritabanı",
  tableSelectAria: "Aranacak tablo",
  tableInputPlaceholder: "Tablo adı (örn. dbo.users)",
  resultsAria: "Genel arama sonuçları",
  emptySchemaType: "Tablo ve sütun aramak için yazın",
  emptySchemaNoMatch: "Eşleşen şema yok",
  columnInTable: (column, table) => `${column} · ${table} içinde`,
  emptyMultiType: "Tüm tablolarda aramak için anahtar kelime yazın",
  emptyMultiNoMatch: "Hiçbir tabloda eşleşen satır yok",
  rowsCount: (count) => `${count} satır`,
  matchingRows: (count, table) => `${table} içinde ${count} eşleşen satır`,
  openTableToBrowse: (table) => `Eşleşmeleri görmek için ${table} açın`,
  emptyDataType: "Seçili tabloda aramak için anahtar kelime yazın",
  emptyDataSelectTable: "Aranacak bir tablo seçin",
  emptyDataNoMatch: "Eşleşen satır yok",
  footer: "Kapatmak için Esc · sonuçlar etkin bağlantıyla sınırlı",
  kindTable: "tablo",
  kindColumn: "sütun",
};

const ZH_COPY: GlobalSearchCopy = {
  ariaLabel: "全局搜索",
  inputAriaLabel: "全局搜索关键词",
  clear: "清除",
  placeholderSchema: "搜索表和列…",
  placeholderData: "在表中搜索文本…",
  tabSchema: "架构",
  tabData: "数据",
  onDatabase: (db) => `位于 ${db}`,
  connectFirst: "— 请先连接数据库",
  defaultDatabase: "默认数据库",
  tableSelectAria: "要搜索的表",
  tableInputPlaceholder: "表名（例如 dbo.users）",
  resultsAria: "全局搜索结果",
  emptySchemaType: "输入以搜索表和列",
  emptySchemaNoMatch: "没有匹配的架构",
  columnInTable: (column, table) => `${column} · 位于 ${table}`,
  emptyMultiType: "输入关键词以搜索所有表",
  emptyMultiNoMatch: "任何表中都没有匹配的行",
  rowsCount: (count) => `${count} 行`,
  matchingRows: (count, table) => `${table} 中有 ${count} 行匹配`,
  openTableToBrowse: (table) => `打开 ${table} 查看匹配项`,
  emptyDataType: "输入关键词以搜索所选表",
  emptyDataSelectTable: "选择要搜索的表",
  emptyDataNoMatch: "没有匹配的行",
  footer: "按 Esc 关闭 · 结果仅限于当前连接",
  kindTable: "表",
  kindColumn: "列",
};

const COPY: Record<AppLanguage, GlobalSearchCopy> = {
  en: EN_COPY,
  vi: VI_COPY,
  ko: KO_COPY,
  tr: TR_COPY,
  zh: ZH_COPY,
};

export function getGlobalSearchCopy(language: AppLanguage): GlobalSearchCopy {
  return COPY[language] ?? EN_COPY;
}
