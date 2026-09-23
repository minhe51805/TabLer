/**
 * Copy for the MCP integrations typed-phrase confirmation. Kept out of
 * src/i18n per the per-feature copy-module convention; English is the
 * fallback.
 */

import type { AppLanguage } from "../i18n";

export interface McpIntegrationsCopy {
  /** Primary button on the typed-phrase policy escalation step. */
  enableAccess: string;
}

const EN_COPY: McpIntegrationsCopy = {
  enableAccess: "Enable access",
};

const VI_COPY: McpIntegrationsCopy = {
  enableAccess: "Bật quyền truy cập",
};

const KO_COPY: McpIntegrationsCopy = {
  enableAccess: "액세스 활성화",
};

const TR_COPY: McpIntegrationsCopy = {
  enableAccess: "Erişimi etkinleştir",
};

const ZH_COPY: McpIntegrationsCopy = {
  enableAccess: "启用访问",
};

const COPY: Record<AppLanguage, McpIntegrationsCopy> = {
  en: EN_COPY,
  vi: VI_COPY,
  ko: KO_COPY,
  tr: TR_COPY,
  zh: ZH_COPY,
};

export function getMcpIntegrationsCopy(language: AppLanguage): McpIntegrationsCopy {
  return COPY[language] ?? EN_COPY;
}
