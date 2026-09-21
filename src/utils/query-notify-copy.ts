/**
 * Copy for the query-finished OS notification and the "cached" grid status
 * badge. Kept out of src/i18n per the per-feature copy-module convention.
 */

import type { AppLanguage } from "../i18n";

export interface QueryNotifyCopy {
  /** Grid status pill shown when a result came from the local result cache. */
  cachedBadge: string;
  /** Notification title for a successful run. */
  queryFinishedTitle: string;
  /** Notification title for a failed run. */
  queryFailedTitle: string;
  /** Notification body for a successful run: "N rows in Xs". */
  finishedBody: (rows: number, seconds: string) => string;
  /** Notification body for a failed run. */
  failedBody: (error: string, seconds: string) => string;
}

const EN_COPY: QueryNotifyCopy = {
  cachedBadge: "cached",
  queryFinishedTitle: "Query finished",
  queryFailedTitle: "Query failed",
  finishedBody: (rows, seconds) => `${rows} row${rows === 1 ? "" : "s"} in ${seconds}s`,
  failedBody: (error, seconds) => `Failed after ${seconds}s: ${error}`,
};

const VI_COPY: QueryNotifyCopy = {
  cachedBadge: "cache",
  queryFinishedTitle: "Truy vấn hoàn tất",
  queryFailedTitle: "Truy vấn thất bại",
  finishedBody: (rows, seconds) => `${rows} dòng trong ${seconds} giây`,
  failedBody: (error, seconds) => `Thất bại sau ${seconds} giây: ${error}`,
};

const ZH_COPY: QueryNotifyCopy = {
  cachedBadge: "缓存",
  queryFinishedTitle: "查询完成",
  queryFailedTitle: "查询失败",
  finishedBody: (rows, seconds) => `${seconds} 秒内返回 ${rows} 行`,
  failedBody: (error, seconds) => `${seconds} 秒后失败：${error}`,
};

const TR_COPY: QueryNotifyCopy = {
  cachedBadge: "önbellek",
  queryFinishedTitle: "Sorgu tamamlandı",
  queryFailedTitle: "Sorgu başarısız",
  finishedBody: (rows, seconds) => `${seconds} saniyede ${rows} satır`,
  failedBody: (error, seconds) => `${seconds} saniye sonra başarısız: ${error}`,
};

const KO_COPY: QueryNotifyCopy = {
  cachedBadge: "캐시됨",
  queryFinishedTitle: "쿼리 완료",
  queryFailedTitle: "쿼리 실패",
  finishedBody: (rows, seconds) => `${seconds}초 만에 ${rows}개 행`,
  failedBody: (error, seconds) => `${seconds}초 후 실패: ${error}`,
};

const COPY: Record<AppLanguage, QueryNotifyCopy> = {
  en: EN_COPY,
  vi: VI_COPY,
  zh: ZH_COPY,
  tr: TR_COPY,
  ko: KO_COPY,
};

export function getQueryNotifyCopy(language: AppLanguage): QueryNotifyCopy {
  return COPY[language] ?? EN_COPY;
}
