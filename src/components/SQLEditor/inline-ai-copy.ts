/**
 * Copy for the Ctrl+K inline AI edit widget in the SQL editor.
 *
 * Lives outside src/i18n per the copy-module pattern (see ai-proposal-copy.ts):
 * new UI strings ship in a local *-copy module and the i18n tables stay
 * untouched.
 */

import type { AppLanguage } from "../../i18n";

export interface InlineAiCopy {
  /** Placeholder for the instruction input. */
  placeholder: string;
  /** Shown while the rewrite request is in flight. */
  generating: string;
  /** Accept button on the diff preview. */
  accept: string;
  /** Reject button on the diff preview. */
  reject: string;
  /** Shown when the model returns the statement unchanged. */
  noChanges: string;
}

const COPY: Record<AppLanguage, InlineAiCopy> = {
  en: {
    placeholder: "Ask AI to edit…",
    generating: "Generating…",
    accept: "Accept",
    reject: "Reject",
    noChanges: "AI returned the statement unchanged.",
  },
  vi: {
    placeholder: "Yêu cầu AI chỉnh sửa…",
    generating: "Đang tạo…",
    accept: "Chấp nhận",
    reject: "Từ chối",
    noChanges: "AI trả về câu lệnh không đổi.",
  },
  zh: {
    placeholder: "让 AI 编辑…",
    generating: "正在生成…",
    accept: "接受",
    reject: "拒绝",
    noChanges: "AI 返回的语句未发生变化。",
  },
  tr: {
    placeholder: "AI'dan düzenlemesini iste…",
    generating: "Oluşturuluyor…",
    accept: "Kabul et",
    reject: "Reddet",
    noChanges: "AI ifadeyi değiştirmeden döndürdü.",
  },
  ko: {
    placeholder: "AI에게 편집 요청…",
    generating: "생성 중…",
    accept: "수락",
    reject: "거절",
    noChanges: "AI가 변경 없이 문장을 반환했습니다.",
  },
};

export function getInlineAiCopy(language: AppLanguage): InlineAiCopy {
  return COPY[language] ?? COPY.en;
}
