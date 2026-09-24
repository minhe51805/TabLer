/**
 * Copy for view-time column masking (capability-parity A4): the header
 * context-menu "Mask column" submenu, the masked-cell placeholder, the
 * reveal badge, and the export guard. Kept out of src/i18n per the
 * per-feature copy-module convention.
 */

import type { AppLanguage } from "../../i18n";
import type { AnonymizerStrategy } from "../../utils/anonymizer";

export interface DataGridMaskingCopy {
  /** Header context-menu submenu label. */
  maskColumn: string;
  /** Submenu item that removes the mask rule. */
  unmask: string;
  /** Human label per anonymizer strategy. */
  strategies: Record<AnonymizerStrategy, string>;
  /** Shown when the column is a primary key and cannot be masked. */
  pkBlocked: string;
  /** Session-only reveal toggle (masked → raw). */
  reveal: string;
  /** Re-hide toggle (raw → masked). */
  hide: string;
  /** Header badge tooltip on a masked column. */
  badgeMasked: string;
  /** Header badge tooltip while the column is revealed. */
  badgeRevealed: string;
  /** Cell text while masked values are being computed. */
  pendingPlaceholder: string;
  /** Error when a full-table export is attempted with active masks. */
  exportBlocked: string;
}

const EN_COPY: DataGridMaskingCopy = {
  maskColumn: "Mask column",
  unmask: "Remove mask",
  strategies: {
    hash: "Hash",
    redact: "Redact",
    null: "Null",
    "fake-email": "Fake email",
    "fake-name": "Fake name",
    "fake-phone": "Fake phone",
    noise: "Numeric noise",
  },
  pkBlocked: "Primary-key columns cannot be masked — masked keys would break row identity.",
  reveal: "Reveal values (this session)",
  hide: "Hide values again",
  badgeMasked: "Column masked — click to reveal for this session",
  badgeRevealed: "Column revealed — click to mask again",
  pendingPlaceholder: "•••",
  exportBlocked:
    "Full-table export is unavailable while column masks are active — the streaming export cannot apply masks. Remove the masks or export the loaded rows instead.",
};

const VI_COPY: DataGridMaskingCopy = {
  maskColumn: "Che giấu cột",
  unmask: "Bỏ che giấu",
  strategies: {
    hash: "Băm",
    redact: "Che chắn",
    null: "Null",
    "fake-email": "Email giả",
    "fake-name": "Tên giả",
    "fake-phone": "Số điện thoại giả",
    noise: "Nhiễu số",
  },
  pkBlocked: "Không thể che giấu cột khóa chính — khóa bị che sẽ phá vỡ định danh hàng.",
  reveal: "Hiện giá trị (phiên này)",
  hide: "Ẩn giá trị lại",
  badgeMasked: "Cột đang bị che — nhấn để hiện trong phiên này",
  badgeRevealed: "Cột đang hiện — nhấn để che lại",
  pendingPlaceholder: "•••",
  exportBlocked:
    "Không thể xuất toàn bộ bảng khi đang che giấu cột — luồng xuất không áp dụng được mặt nạ. Hãy bỏ che giấu hoặc xuất các hàng đã tải.",
};

const KO_COPY: DataGridMaskingCopy = {
  maskColumn: "열 마스킹",
  unmask: "마스킹 해제",
  strategies: {
    hash: "해시",
    redact: "가리기",
    null: "Null",
    "fake-email": "가짜 이메일",
    "fake-name": "가짜 이름",
    "fake-phone": "가짜 전화번호",
    noise: "숫자 노이즈",
  },
  pkBlocked: "기본 키 열은 마스킹할 수 없습니다 — 마스킹된 키는 행 식별을 깨뜨립니다.",
  reveal: "값 표시 (이 세션)",
  hide: "다시 값 숨기기",
  badgeMasked: "열이 마스킹됨 — 클릭하면 이 세션에서 표시",
  badgeRevealed: "열이 표시됨 — 클릭하면 다시 마스킹",
  pendingPlaceholder: "•••",
  exportBlocked:
    "열 마스킹이 활성화된 동안에는 전체 테이블보내기를 사용할 수 없습니다 — 스트리밍보내기는 마스킹을 적용할 수 없습니다. 마스킹을 제거하거나 로드된 행을보내세요.",
};

const TR_COPY: DataGridMaskingCopy = {
  maskColumn: "Sütunu maskele",
  unmask: "Maskeyi kaldır",
  strategies: {
    hash: "Hash",
    redact: "Gizle",
    null: "Null",
    "fake-email": "Sahte e-posta",
    "fake-name": "Sahte ad",
    "fake-phone": "Sahte telefon",
    noise: "Sayısal gürültü",
  },
  pkBlocked:
    "Birincil anahtar sütunları maskelenemez — maskelenen anahtarlar satır kimliğini bozar.",
  reveal: "Değerleri göster (bu oturum)",
  hide: "Değerleri yeniden gizle",
  badgeMasked: "Sütun maskeli — bu oturum için göstermek üzere tıklayın",
  badgeRevealed: "Sütun gösteriliyor — yeniden maskelemek için tıklayın",
  pendingPlaceholder: "•••",
  exportBlocked:
    "Sütun maskeleri etkinken tam tablo dışa aktarımı kullanılamaz — akışlı dışa aktarım maske uygulayamaz. Maskeleri kaldırın veya yüklenen satırları dışa aktarın.",
};

const ZH_COPY: DataGridMaskingCopy = {
  maskColumn: "掩码列",
  unmask: "移除掩码",
  strategies: {
    hash: "哈希",
    redact: "遮盖",
    null: "Null",
    "fake-email": "假邮箱",
    "fake-name": "假姓名",
    "fake-phone": "假电话",
    noise: "数值噪声",
  },
  pkBlocked: "主键列无法掩码 — 掩码后的键会破坏行标识。",
  reveal: "显示值（本次会话）",
  hide: "重新隐藏值",
  badgeMasked: "列已掩码 — 点击在本次会话中显示",
  badgeRevealed: "列已显示 — 点击重新掩码",
  pendingPlaceholder: "•••",
  exportBlocked: "列掩码启用时无法导出整张表 — 流式导出无法应用掩码。请移除掩码或导出已加载的行。",
};

const COPY: Record<AppLanguage, DataGridMaskingCopy> = {
  en: EN_COPY,
  vi: VI_COPY,
  ko: KO_COPY,
  tr: TR_COPY,
  zh: ZH_COPY,
};

export function getDataGridMaskingCopy(language: AppLanguage): DataGridMaskingCopy {
  return COPY[language] ?? EN_COPY;
}
