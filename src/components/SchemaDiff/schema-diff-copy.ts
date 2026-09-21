/**
 * Public facade for schema-diff modal copy.
 * Per-language data lives under ./schema-diff-copy/*.
 */

import type { AppLanguage } from "../../i18n";
import { EN_COPY } from "./schema-diff-copy/en";
import { VI_COPY } from "./schema-diff-copy/vi";
import { KO_COPY } from "./schema-diff-copy/ko";
import { TR_COPY } from "./schema-diff-copy/tr";
import { ZH_COPY } from "./schema-diff-copy/zh";
import type { SchemaDiffCopy } from "./schema-diff-copy/types";

export type { SchemaDiffCopy } from "./schema-diff-copy/types";

const COPY: Record<AppLanguage, SchemaDiffCopy> = {
  en: EN_COPY,
  vi: VI_COPY,
  ko: KO_COPY,
  tr: TR_COPY,
  zh: ZH_COPY,
};

export function getSchemaDiffCopy(language: AppLanguage): SchemaDiffCopy {
  return COPY[language];
}
