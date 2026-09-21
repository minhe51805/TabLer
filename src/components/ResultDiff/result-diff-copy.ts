/**
 * Public facade for result-diff modal + toolbar copy.
 * Per-language data lives under ./result-diff-copy/*.
 */

import type { AppLanguage } from "../../i18n";
import { EN_COPY } from "./result-diff-copy/en";
import { VI_COPY } from "./result-diff-copy/vi";
import { KO_COPY } from "./result-diff-copy/ko";
import { TR_COPY } from "./result-diff-copy/tr";
import { ZH_COPY } from "./result-diff-copy/zh";
import type { ResultDiffCopy } from "./result-diff-copy/types";

export type { ResultDiffCopy } from "./result-diff-copy/types";

const COPY: Record<AppLanguage, ResultDiffCopy> = {
  en: EN_COPY,
  vi: VI_COPY,
  ko: KO_COPY,
  tr: TR_COPY,
  zh: ZH_COPY,
};

export function getResultDiffCopy(language: AppLanguage): ResultDiffCopy {
  return COPY[language];
}
