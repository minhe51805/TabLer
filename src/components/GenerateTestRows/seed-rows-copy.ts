/**
 * Copy for the "Generate test rows" dialog and its entry points. Kept out of
 * src/i18n per the per-feature copy-module convention.
 */

import type { AppLanguage } from "../../i18n";

export interface SeedRowsCopy {
  /** Sidebar context-menu item + toolbar button label. */
  menuItem: string;
  title: string;
  rowCount: string;
  hintLabel: string;
  hintPlaceholder: string;
  generate: string;
  cancel: string;
  loading: string;
  loadFailed: string;
  noColumns: string;
  stagedToast: (count: number, table: string) => string;
}

const EN_COPY: SeedRowsCopy = {
  menuItem: "Generate test rows",
  title: "Generate test rows",
  rowCount: "Rows to generate",
  hintLabel: "Hint (optional)",
  hintPlaceholder: "e.g. realistic VN names",
  generate: "Generate & stage",
  cancel: "Cancel",
  loading: "Loading table structure…",
  loadFailed: "Could not load the table structure.",
  noColumns: "No seedable columns — every column is auto-generated.",
  stagedToast: (count, table) => `${count} test row(s) staged for ${table} — review & apply`,
};

const VI_COPY: SeedRowsCopy = {
  menuItem: "Tạo dữ liệu mẫu",
  title: "Tạo dữ liệu mẫu",
  rowCount: "Số dòng cần tạo",
  hintLabel: "Gợi ý (không bắt buộc)",
  hintPlaceholder: "vd: tên Việt Nam thực tế",
  generate: "Tạo & xếp hàng",
  cancel: "Hủy",
  loading: "Đang tải cấu trúc bảng…",
  loadFailed: "Không tải được cấu trúc bảng.",
  noColumns: "Không có cột nào để tạo — mọi cột đều tự sinh.",
  stagedToast: (count, table) => `Đã xếp ${count} dòng mẫu cho ${table} — xem & áp dụng`,
};

const KO_COPY: SeedRowsCopy = {
  menuItem: "테스트 행 생성",
  title: "테스트 행 생성",
  rowCount: "생성할 행 수",
  hintLabel: "힌트 (선택)",
  hintPlaceholder: "예: 현실적인 베트남 이름",
  generate: "생성 후 스테이징",
  cancel: "취소",
  loading: "테이블 구조를 불러오는 중…",
  loadFailed: "테이블 구조를 불러오지 못했습니다.",
  noColumns: "생성할 열이 없습니다 — 모든 열이 자동 생성됩니다.",
  stagedToast: (count, table) => `${table}에 테스트 행 ${count}개 스테이징됨 — 검토 후 적용`,
};

const TR_COPY: SeedRowsCopy = {
  menuItem: "Test satırları üret",
  title: "Test satırları üret",
  rowCount: "Üretilecek satır sayısı",
  hintLabel: "İpucu (isteğe bağlı)",
  hintPlaceholder: "örn. gerçekçi VN isimleri",
  generate: "Üret ve kuyruğa al",
  cancel: "İptal",
  loading: "Tablo yapısı yükleniyor…",
  loadFailed: "Tablo yapısı yüklenemedi.",
  noColumns: "Üretilecek sütun yok — tüm sütunlar otomatik üretiliyor.",
  stagedToast: (count, table) =>
    `${table} için ${count} test satırı kuyruğa alındı — incele & uygula`,
};

const ZH_COPY: SeedRowsCopy = {
  menuItem: "生成测试数据",
  title: "生成测试数据",
  rowCount: "生成行数",
  hintLabel: "提示（可选）",
  hintPlaceholder: "例如：真实的越南姓名",
  generate: "生成并暂存",
  cancel: "取消",
  loading: "正在加载表结构…",
  loadFailed: "无法加载表结构。",
  noColumns: "没有可生成的列 — 所有列均为自动生成。",
  stagedToast: (count, table) => `已为 ${table} 暂存 ${count} 行测试数据 — 请检查并应用`,
};

const COPY: Record<AppLanguage, SeedRowsCopy> = {
  en: EN_COPY,
  vi: VI_COPY,
  ko: KO_COPY,
  tr: TR_COPY,
  zh: ZH_COPY,
};

export function getSeedRowsCopy(language: AppLanguage): SeedRowsCopy {
  return COPY[language] ?? EN_COPY;
}
