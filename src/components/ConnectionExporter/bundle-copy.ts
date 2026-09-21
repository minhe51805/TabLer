/**
 * Public facade for workspace-bundle copy.
 * Per-language data lives under ./bundle-copy/*.
 */

import type { AppLanguage } from "../../i18n";
import { EN_BUNDLE_COPY } from "./bundle-copy/en";
import { VI_BUNDLE_COPY } from "./bundle-copy/vi";
import { KO_BUNDLE_COPY } from "./bundle-copy/ko";
import { TR_BUNDLE_COPY } from "./bundle-copy/tr";
import { ZH_BUNDLE_COPY } from "./bundle-copy/zh";
import type { BundleCopy } from "./bundle-copy/types";

export type { BundleCopy } from "./bundle-copy/types";

const COPY: Record<AppLanguage, BundleCopy> = {
  en: EN_BUNDLE_COPY,
  vi: VI_BUNDLE_COPY,
  ko: KO_BUNDLE_COPY,
  tr: TR_BUNDLE_COPY,
  zh: ZH_BUNDLE_COPY,
};

export function getBundleCopy(language: AppLanguage): BundleCopy {
  return COPY[language];
}
