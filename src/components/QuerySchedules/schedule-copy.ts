/**
 * Public facade for schedule-panel copy.
 * Per-language data lives under ./schedule-copy/*.
 */

import type { AppLanguage } from "../../i18n";
import { EN_COPY } from "./schedule-copy/en";
import { VI_COPY } from "./schedule-copy/vi";
import { KO_COPY } from "./schedule-copy/ko";
import { TR_COPY } from "./schedule-copy/tr";
import { ZH_COPY } from "./schedule-copy/zh";
import type { ScheduleCopy } from "./schedule-copy/types";

export type { ScheduleCopy } from "./schedule-copy/types";

const COPY: Record<AppLanguage, ScheduleCopy> = {
  en: EN_COPY,
  vi: VI_COPY,
  ko: KO_COPY,
  tr: TR_COPY,
  zh: ZH_COPY,
};

export function getScheduleCopy(language: AppLanguage): ScheduleCopy {
  return COPY[language];
}
