/**
 * Copy for the schema-object wizard validation errors produced by
 * utils/sql-generator. Kept out of src/i18n per the per-feature copy-module
 * convention; English is the fallback.
 */

import type { AppLanguage } from "../../i18n";

export interface SchemaWizardCopy {
  errors: {
    tableNameRequired: string;
    addColumn: string;
    /** {names} is the comma-joined duplicate column list. */
    duplicateColumns: (names: string) => string;
    viewNameRequired: string;
    viewQueryRequired: string;
    triggerNameRequired: string;
    triggerTableRequired: string;
    triggerBodyRequired: string;
    redshiftTriggers: string;
  };
}

const EN_COPY: SchemaWizardCopy = {
  errors: {
    tableNameRequired: "Table name is required.",
    addColumn: "Add at least one column.",
    duplicateColumns: (names) => `Duplicate column names: ${names}.`,
    viewNameRequired: "View name is required.",
    viewQueryRequired: "View query is required.",
    triggerNameRequired: "Trigger name is required.",
    triggerTableRequired: "Choose a target table for the trigger.",
    triggerBodyRequired: "Trigger body is required.",
    redshiftTriggers: "Trigger scaffolding is not enabled for Redshift in this build.",
  },
};

const VI_COPY: SchemaWizardCopy = {
  errors: {
    tableNameRequired: "Cần nhập tên bảng.",
    addColumn: "Thêm ít nhất một cột.",
    duplicateColumns: (names) => `Tên cột trùng lặp: ${names}.`,
    viewNameRequired: "Cần nhập tên view.",
    viewQueryRequired: "Cần nhập truy vấn của view.",
    triggerNameRequired: "Cần nhập tên trigger.",
    triggerTableRequired: "Chọn bảng đích cho trigger.",
    triggerBodyRequired: "Cần nhập phần thân trigger.",
    redshiftTriggers: "Bản dựng này chưa hỗ trợ tạo trigger cho Redshift.",
  },
};

const KO_COPY: SchemaWizardCopy = {
  errors: {
    tableNameRequired: "테이블 이름이 필요합니다.",
    addColumn: "열을 하나 이상 추가하세요.",
    duplicateColumns: (names) => `중복된 열 이름: ${names}.`,
    viewNameRequired: "뷰 이름이 필요합니다.",
    viewQueryRequired: "뷰 쿼리가 필요합니다.",
    triggerNameRequired: "트리거 이름이 필요합니다.",
    triggerTableRequired: "트리거의 대상 테이블을 선택하세요.",
    triggerBodyRequired: "트리거 본문이 필요합니다.",
    redshiftTriggers: "이 빌드에서는 Redshift 트리거 스캐폴딩이 비활성화되어 있습니다.",
  },
};

const TR_COPY: SchemaWizardCopy = {
  errors: {
    tableNameRequired: "Tablo adı gerekli.",
    addColumn: "En az bir sütun ekleyin.",
    duplicateColumns: (names) => `Yinelenen sütun adları: ${names}.`,
    viewNameRequired: "Görünüm adı gerekli.",
    viewQueryRequired: "Görünüm sorgusu gerekli.",
    triggerNameRequired: "Tetikleyici adı gerekli.",
    triggerTableRequired: "Tetikleyici için hedef tablo seçin.",
    triggerBodyRequired: "Tetikleyici gövdesi gerekli.",
    redshiftTriggers: "Bu derlemede Redshift için tetikleyici iskelesi etkin değil.",
  },
};

const ZH_COPY: SchemaWizardCopy = {
  errors: {
    tableNameRequired: "需要填写表名。",
    addColumn: "请至少添加一列。",
    duplicateColumns: (names) => `列名重复：${names}。`,
    viewNameRequired: "需要填写视图名。",
    viewQueryRequired: "需要填写视图查询。",
    triggerNameRequired: "需要填写触发器名。",
    triggerTableRequired: "请为触发器选择目标表。",
    triggerBodyRequired: "需要填写触发器主体。",
    redshiftTriggers: "此版本未启用 Redshift 触发器脚手架。",
  },
};

const COPY: Record<AppLanguage, SchemaWizardCopy> = {
  en: EN_COPY,
  vi: VI_COPY,
  ko: KO_COPY,
  tr: TR_COPY,
  zh: ZH_COPY,
};

export function getSchemaWizardCopy(language: AppLanguage): SchemaWizardCopy {
  return COPY[language] ?? EN_COPY;
}
