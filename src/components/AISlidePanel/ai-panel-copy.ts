/**
 * Public facade for AI panel copy that is not part of the workspace-chat pack
 * (run cost line, guardrail rules manager). Per-language data lives under
 * ./ai-panel-copy/*.
 */

import type { AppLanguage } from "../../i18n";
import { EN_PANEL_COPY } from "./ai-panel-copy/en";
import { VI_PANEL_COPY } from "./ai-panel-copy/vi";
import { KO_PANEL_COPY } from "./ai-panel-copy/ko";
import { TR_PANEL_COPY } from "./ai-panel-copy/tr";
import { ZH_PANEL_COPY } from "./ai-panel-copy/zh";
import type { AIPanelCopy } from "./ai-panel-copy/types";

export type { AIPanelCopy } from "./ai-panel-copy/types";

const COPY: Record<AppLanguage, AIPanelCopy> = {
  en: EN_PANEL_COPY,
  vi: VI_PANEL_COPY,
  ko: KO_PANEL_COPY,
  tr: TR_PANEL_COPY,
  zh: ZH_PANEL_COPY,
};

export function getAIPanelCopy(language: AppLanguage): AIPanelCopy {
  return COPY[language];
}

/** `{placeholder}` interpolation for the copy templates above. */
export function formatPanelCopy(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? String(values[key]) : match,
  );
}
