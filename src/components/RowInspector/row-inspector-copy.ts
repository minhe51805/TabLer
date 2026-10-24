import type { AppLanguage } from "../../i18n";

export interface RowInspectorCopy {
  staleRow: string;
}

const EN_COPY: RowInspectorCopy = {
  staleRow: "This row changed after the inspector opened. Reopen it before editing.",
};

const COPY: Record<AppLanguage, RowInspectorCopy> = {
  en: EN_COPY,
  vi: { staleRow: "Dòng này đã thay đổi sau khi mở inspector. Hãy mở lại trước khi sửa." },
  zh: { staleRow: "此行在检查器打开后已更改。请重新打开后再编辑。" },
  tr: { staleRow: "Bu satır inceleme açıldıktan sonra değişti. Düzenlemeden önce yeniden açın." },
  ko: { staleRow: "인스펙터를 연 후 행이 변경되었습니다. 편집하기 전에 다시 여세요." },
};

export function getRowInspectorCopy(language: AppLanguage): RowInspectorCopy {
  return COPY[language] ?? EN_COPY;
}
