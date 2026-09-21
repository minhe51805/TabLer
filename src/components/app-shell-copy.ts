/**
 * Public facade for app-shell copy (updater control, storage recovery).
 * Per-language data lives under ./app-shell-copy/*.
 */

import type { AppLanguage } from "../i18n";
import { EN_COPY } from "./app-shell-copy/en";
import { VI_COPY } from "./app-shell-copy/vi";
import { KO_COPY } from "./app-shell-copy/ko";
import { TR_COPY } from "./app-shell-copy/tr";
import { ZH_COPY } from "./app-shell-copy/zh";
import type { AppShellCopy } from "./app-shell-copy/types";

export type { AppShellCopy } from "./app-shell-copy/types";

const COPY: Record<AppLanguage, AppShellCopy> = {
  en: EN_COPY,
  vi: VI_COPY,
  ko: KO_COPY,
  tr: TR_COPY,
  zh: ZH_COPY,
};

export function getAppShellCopy(language: AppLanguage): AppShellCopy {
  return COPY[language];
}
