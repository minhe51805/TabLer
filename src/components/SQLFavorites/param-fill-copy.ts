/**
 * Copy for the parameterized-favorite fill dialog. Per-feature copy module —
 * kept out of src/i18n per convention.
 */

import type { AppLanguage } from "../../i18n";

export interface ParamFillCopy {
  title: string;
  previewLabel: string;
  runLabel: string;
  cancelLabel: string;
  /** Hint shown next to a param that has a default, e.g. "default: paid". */
  defaultHint: (value: string) => string;
  /** Warning shown when a scheduled SQL still contains {{params}}. */
  scheduleWarning: string;
}

const EN_COPY: ParamFillCopy = {
  title: "Fill query parameters",
  previewLabel: "Resolved SQL",
  runLabel: "Run",
  cancelLabel: "Cancel",
  defaultHint: (value) => `default: ${value}`,
  scheduleWarning:
    "This query contains {{params}} — they are not substituted in scheduled runs. Resolve them first.",
};

const VI_COPY: ParamFillCopy = {
  title: "Điền tham số truy vấn",
  previewLabel: "SQL sau khi thay",
  runLabel: "Chạy",
  cancelLabel: "Hủy",
  defaultHint: (value) => `mặc định: ${value}`,
  scheduleWarning:
    "Query này chứa {{params}} — chúng không được thay thế khi chạy theo lịch. Hãy điền giá trị trước.",
};

const ZH_COPY: ParamFillCopy = {
  title: "填写查询参数",
  previewLabel: "替换后的 SQL",
  runLabel: "运行",
  cancelLabel: "取消",
  defaultHint: (value) => `默认值：${value}`,
  scheduleWarning: "此查询包含 {{params}} — 定时运行时不会替换。请先填写参数值。",
};

const TR_COPY: ParamFillCopy = {
  title: "Sorgu parametrelerini doldur",
  previewLabel: "Çözümlenmiş SQL",
  runLabel: "Çalıştır",
  cancelLabel: "İptal",
  defaultHint: (value) => `varsayılan: ${value}`,
  scheduleWarning:
    "Bu sorgu {{params}} içeriyor — zamanlanmış çalıştırmalarda değiştirilmez. Önce değerleri girin.",
};

const KO_COPY: ParamFillCopy = {
  title: "쿼리 매개변수 입력",
  previewLabel: "치환된 SQL",
  runLabel: "실행",
  cancelLabel: "취소",
  defaultHint: (value) => `기본값: ${value}`,
  scheduleWarning:
    "이 쿼리에는 {{params}}가 있습니다 — 예약 실행 시 치환되지 않습니다. 먼저 값을 입력하세요.",
};

const COPY: Record<AppLanguage, ParamFillCopy> = {
  en: EN_COPY,
  vi: VI_COPY,
  zh: ZH_COPY,
  tr: TR_COPY,
  ko: KO_COPY,
};

export function getParamFillCopy(language: AppLanguage): ParamFillCopy {
  return COPY[language] ?? EN_COPY;
}
