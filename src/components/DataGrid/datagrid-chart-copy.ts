/**
 * Public facade for DataGrid chart modal + auto-refresh copy.
 * Per-language data lives under ./datagrid-chart-copy/*.
 */

import type { AppLanguage } from "../../i18n";
import { EN_COPY } from "./datagrid-chart-copy/en";
import { VI_COPY } from "./datagrid-chart-copy/vi";
import { KO_COPY } from "./datagrid-chart-copy/ko";
import { TR_COPY } from "./datagrid-chart-copy/tr";
import { ZH_COPY } from "./datagrid-chart-copy/zh";
import type { DataGridChartCopy } from "./datagrid-chart-copy/types";

export type { DataGridChartCopy } from "./datagrid-chart-copy/types";

const COPY: Record<AppLanguage, DataGridChartCopy> = {
  en: EN_COPY,
  vi: VI_COPY,
  ko: KO_COPY,
  tr: TR_COPY,
  zh: ZH_COPY,
};

export function getDataGridChartCopy(language: AppLanguage): DataGridChartCopy {
  return COPY[language];
}
