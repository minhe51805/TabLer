/**
 * Public facade for Plugin Manager copy.
 * Per-language data lives under ./plugin-manager-copy/*.
 */

import type { AppLanguage } from "../i18n";
import { EN_COPY } from "./plugin-manager-copy/en";
import { VI_COPY } from "./plugin-manager-copy/vi";
import { KO_COPY } from "./plugin-manager-copy/ko";
import { TR_COPY } from "./plugin-manager-copy/tr";
import { ZH_COPY } from "./plugin-manager-copy/zh";
import type { PluginManagerCopy } from "./plugin-manager-copy/types";

export type { PluginManagerCopy } from "./plugin-manager-copy/types";

const COPY: Record<AppLanguage, PluginManagerCopy> = {
  en: EN_COPY,
  vi: VI_COPY,
  ko: KO_COPY,
  tr: TR_COPY,
  zh: ZH_COPY,
};

export function getPluginManagerCopy(language: AppLanguage): PluginManagerCopy {
  return COPY[language];
}
