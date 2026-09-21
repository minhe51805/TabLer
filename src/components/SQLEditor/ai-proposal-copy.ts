/**
 * Copy for the AI edit-proposal banner's EXPLAIN dry-run line.
 *
 * Lives outside src/i18n because the proposal card is wired through the
 * AISlidePanel copy-module pattern: new UI strings ship in a local *-copy
 * module and the i18n tables stay untouched.
 */

import type { AppLanguage } from "../../i18n";

export interface AiProposalCopy {
  /** Prefix for the dry-run line, e.g. "EXPLAIN dry-run: <plan>". */
  explainLabel: string;
  /** Shown when EXPLAIN failed on an explainable (DML) statement. */
  explainFailed: string;
  /** Shown when the engine cannot plan this statement kind (DDL best-effort). */
  explainUnsupported: string;
}

const COPY: Record<AppLanguage, AiProposalCopy> = {
  en: {
    explainLabel: "EXPLAIN dry-run",
    explainFailed: "syntax check failed",
    explainUnsupported: "engine cannot EXPLAIN this statement",
  },
  vi: {
    explainLabel: "EXPLAIN dry-run",
    explainFailed: "kiểm tra cú pháp thất bại",
    explainUnsupported: "engine không hỗ trợ EXPLAIN cho câu lệnh này",
  },
  zh: {
    explainLabel: "EXPLAIN 试运行",
    explainFailed: "语法检查失败",
    explainUnsupported: "引擎无法对该语句执行 EXPLAIN",
  },
  tr: {
    explainLabel: "EXPLAIN denemesi",
    explainFailed: "sözdizimi denetimi başarısız",
    explainUnsupported: "motor bu ifade için EXPLAIN desteklemiyor",
  },
  ko: {
    explainLabel: "EXPLAIN 드라이런",
    explainFailed: "구문 검사 실패",
    explainUnsupported: "엔진이 이 문장을 EXPLAIN할 수 없습니다",
  },
};

export function getAiProposalCopy(language: AppLanguage): AiProposalCopy {
  return COPY[language] ?? COPY.en;
}
