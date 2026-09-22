/**
 * Copy for the sidebar "Copy as code" codegen menu. Per-feature copy module —
 * kept out of src/i18n per convention.
 */

import type { AppLanguage } from "../../i18n";
import type { CodegenTarget } from "../../utils/schema-codegen";

export interface CodegenCopy {
  menuLabel: string;
  targets: Record<CodegenTarget, string>;
  copiedTitle: (typeName: string, fieldCount: number) => string;
  failedTitle: string;
}

const EN_COPY: CodegenCopy = {
  menuLabel: "Copy as code",
  targets: {
    typescript: "TypeScript interface",
    zod: "Zod schema",
    rust: "Rust struct",
    go: "Go struct",
    jsonschema: "JSON Schema",
  },
  copiedTitle: (typeName, fieldCount) =>
    `${typeName} copied — ${fieldCount} field${fieldCount === 1 ? "" : "s"}`,
  failedTitle: "Couldn't generate code",
};

const VI_COPY: CodegenCopy = {
  menuLabel: "Copy thành code",
  targets: {
    typescript: "Interface TypeScript",
    zod: "Schema Zod",
    rust: "Struct Rust",
    go: "Struct Go",
    jsonschema: "JSON Schema",
  },
  copiedTitle: (typeName, fieldCount) => `Đã copy ${typeName} — ${fieldCount} trường`,
  failedTitle: "Không tạo được code",
};

const ZH_COPY: CodegenCopy = {
  menuLabel: "复制为代码",
  targets: {
    typescript: "TypeScript 接口",
    zod: "Zod schema",
    rust: "Rust 结构体",
    go: "Go 结构体",
    jsonschema: "JSON Schema",
  },
  copiedTitle: (typeName, fieldCount) => `已复制 ${typeName} — ${fieldCount} 个字段`,
  failedTitle: "无法生成代码",
};

const TR_COPY: CodegenCopy = {
  menuLabel: "Kod olarak kopyala",
  targets: {
    typescript: "TypeScript arayüzü",
    zod: "Zod şeması",
    rust: "Rust struct'ı",
    go: "Go struct'ı",
    jsonschema: "JSON Schema",
  },
  copiedTitle: (typeName, fieldCount) => `${typeName} kopyalandı — ${fieldCount} alan`,
  failedTitle: "Kod oluşturulamadı",
};

const KO_COPY: CodegenCopy = {
  menuLabel: "코드로 복사",
  targets: {
    typescript: "TypeScript 인터페이스",
    zod: "Zod 스키마",
    rust: "Rust 구조체",
    go: "Go 구조체",
    jsonschema: "JSON Schema",
  },
  copiedTitle: (typeName, fieldCount) => `${typeName} 복사됨 — 필드 ${fieldCount}개`,
  failedTitle: "코드를 생성할 수 없습니다",
};

const COPY: Record<AppLanguage, CodegenCopy> = {
  en: EN_COPY,
  vi: VI_COPY,
  zh: ZH_COPY,
  tr: TR_COPY,
  ko: KO_COPY,
};

export function getCodegenCopy(language: AppLanguage): CodegenCopy {
  return COPY[language] ?? EN_COPY;
}
