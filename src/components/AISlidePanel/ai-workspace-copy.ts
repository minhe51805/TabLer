/**
 * Public facade for AI workspace copy.
 * Per-language data lives under ./ai-workspace-copy/*.
 */

import type { AppLanguage } from "../../i18n";
import { EN_COPY } from "./ai-workspace-copy/en";
import { VI_COPY } from "./ai-workspace-copy/vi";
import { KO_COPY } from "./ai-workspace-copy/ko";
import { TR_COPY } from "./ai-workspace-copy/tr";
import { ZH_COPY } from "./ai-workspace-copy/zh";
import type { AIWorkspaceCopy } from "./ai-workspace-copy/types";

export type { PromptIdeaCopy, AIWorkspaceCopy } from "./ai-workspace-copy/types";

const COPY: Record<AppLanguage, AIWorkspaceCopy> = {
  en: EN_COPY,
  vi: VI_COPY,
  ko: KO_COPY,
  tr: TR_COPY,
  zh: ZH_COPY,
};

export function getAIWorkspaceCopy(language: AppLanguage): AIWorkspaceCopy {
  return COPY[language];
}
