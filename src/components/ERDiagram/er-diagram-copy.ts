/**
 * Copy for the ER diagram export surface. Kept out of src/i18n per the
 * per-feature copy-module convention; English is the fallback.
 */

import type { AppLanguage } from "../../i18n";

export interface ERDiagramCopy {
  /** Guard shown when export is attempted with no tables selected. */
  exportNoTables: string;
  /** Canvas builder returned nothing before the PNG could be produced. */
  exportPrepareFailed: string;
  /** Fallback when the PNG export throws a non-Error. */
  exportPngFailed: string;
  /** Fallback when the SVG export throws a non-Error. */
  exportSvgFailed: string;
  /** Fallback when the draw.io export throws a non-Error. */
  exportDrawioFailed: string;
  /** Confirm title when NOT NULL needs existing NULLs backfilled first. */
  notNullBackfillTitle: string;
  /** Confirm body; {column} and {default} are interpolated. */
  notNullBackfillBody: string;
  /** Confirm button label for the backfill-then-apply flow. */
  notNullBackfillConfirm: string;
}

const EN_COPY: ERDiagramCopy = {
  exportNoTables: "Select at least one table before exporting the diagram.",
  exportPrepareFailed: "Could not prepare the ER diagram export image.",
  exportPngFailed: "Could not export the ER diagram PNG.",
  exportSvgFailed: "Could not export the ER diagram SVG.",
  exportDrawioFailed: "Could not export the ER diagram draw.io file.",
  notNullBackfillTitle: "Backfill NULL values first",
  notNullBackfillBody:
    'Column "{column}" has {count} NULL value(s). To set NOT NULL, TableR can update them to {default} first.',
  notNullBackfillConfirm: "Update and apply",
};

const VI_COPY: ERDiagramCopy = {
  exportNoTables: "Chọn ít nhất một bảng trước khi xuất sơ đồ.",
  exportPrepareFailed: "Không thể chuẩn bị ảnh xuất sơ đồ ER.",
  exportPngFailed: "Không thể xuất sơ đồ ER dạng PNG.",
  exportSvgFailed: "Không thể xuất sơ đồ ER dạng SVG.",
  exportDrawioFailed: "Không thể xuất tệp draw.io của sơ đồ ER.",
  notNullBackfillTitle: "Điền giá trị cho ô NULL trước",
  notNullBackfillBody:
    'Cột "{column}" có {count} giá trị NULL. Để đặt NOT NULL, TableR có thể cập nhật chúng thành {default} trước.',
  notNullBackfillConfirm: "Cập nhật và áp dụng",
};

const KO_COPY: ERDiagramCopy = {
  exportNoTables: "다이어그램을 내보내기 전에 테이블을 하나 이상 선택하세요.",
  exportPrepareFailed: "ER 다이어그램 내보내기 이미지를 준비할 수 없습니다.",
  exportPngFailed: "ER 다이어그램 PNG를 내보낼 수 없습니다.",
  exportSvgFailed: "ER 다이어그램 SVG를 내보낼 수 없습니다.",
  exportDrawioFailed: "ER 다이어그램 draw.io 파일을 내보낼 수 없습니다.",
  notNullBackfillTitle: "먼저 NULL 값을 채우세요",
  notNullBackfillBody:
    '"{column}" 열에 NULL 값이 {count}개 있습니다. NOT NULL을 설정하려면 TableR이 먼저 {default}(으)로 업데이트할 수 있습니다.',
  notNullBackfillConfirm: "업데이트 후 적용",
};

const TR_COPY: ERDiagramCopy = {
  exportNoTables: "Diyagramı dışa aktarmadan önce en az bir tablo seçin.",
  exportPrepareFailed: "ER diyagramı dışa aktarım görüntüsü hazırlanamadı.",
  exportPngFailed: "ER diyagramı PNG'si dışa aktarılamadı.",
  exportSvgFailed: "ER diyagramı SVG'si dışa aktarılamadı.",
  exportDrawioFailed: "ER diyagramı draw.io dosyası dışa aktarılamadı.",
  notNullBackfillTitle: "Önce NULL değerleri doldurun",
  notNullBackfillBody:
    '"{column}" sütununda {count} NULL değer var. NOT NULL ayarlamak için TableR önce bunları {default} olarak güncelleyebilir.',
  notNullBackfillConfirm: "Güncelle ve uygula",
};

const ZH_COPY: ERDiagramCopy = {
  exportNoTables: "导出图表前请至少选择一个表。",
  exportPrepareFailed: "无法准备 ER 图导出图像。",
  exportPngFailed: "无法导出 ER 图 PNG。",
  exportSvgFailed: "无法导出 ER 图 SVG。",
  exportDrawioFailed: "无法导出 ER 图 draw.io 文件。",
  notNullBackfillTitle: "先回填 NULL 值",
  notNullBackfillBody:
    '列 "{column}" 有 {count} 个 NULL 值。要设置 NOT NULL，TableR 可以先将它们更新为 {default}。',
  notNullBackfillConfirm: "更新并应用",
};

const COPY: Record<AppLanguage, ERDiagramCopy> = {
  en: EN_COPY,
  vi: VI_COPY,
  ko: KO_COPY,
  tr: TR_COPY,
  zh: ZH_COPY,
};

export function getERDiagramCopy(language: AppLanguage): ERDiagramCopy {
  return COPY[language] ?? EN_COPY;
}
