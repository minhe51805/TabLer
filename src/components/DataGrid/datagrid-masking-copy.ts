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
  /** Submenu listing every strategy ("Mask column with…"). */
  maskWith: string;
  /** Suffix marking the type-derived default strategy in the submenu. */
  defaultTag: string;
  /** Submenu item that removes the mask rule. */
  unmask: string;
  /** Toolbar popover action that removes every mask in the table. */
  unmaskAll: string;
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
  /** Toolbar indicator label, e.g. "2 masked columns". */
  maskedColumns: (count: number) => string;
  /** Toolbar indicator tooltip explaining the masked state. */
  maskedHint: string;
  /** Error when the user tries to inline-edit a masked cell. */
  editBlocked: string;
}

const EN_COPY: DataGridMaskingCopy = {
  maskColumn: "Mask column",
  maskWith: "Mask column with…",
  defaultTag: "default",
  unmask: "Remove mask",
  unmaskAll: "Unmask all columns",
  strategies: {
    hash: "Hash",
    redact: "Redact",
    null: "Null",
    "fake-email": "Fake email",
    "fake-name": "Fake name",
    "fake-phone": "Fake phone",
    noise: "Numeric noise",
  },
  maskedColumns: (count) => (count === 1 ? "1 masked column" : `${count} masked columns`),
  maskedHint: "These columns render masked values; copies and exports use the masked data.",
  editBlocked: "This column is masked — remove the mask or reveal it before editing.",
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
  maskWith: "Che giấu cột bằng…",
  defaultTag: "mặc định",
  unmask: "Bỏ che giấu",
  unmaskAll: "Bỏ che giấu tất cả cột",
  strategies: {
    hash: "Băm",
    redact: "Che chắn",
    null: "Null",
    "fake-email": "Email giả",
    "fake-name": "Tên giả",
    "fake-phone": "Số điện thoại giả",
    noise: "Nhiễu số",
  },
  maskedColumns: (count) => `${count} cột đang che giấu`,
  maskedHint: "Các cột này hiển thị giá trị đã che; thao tác sao chép và xuất dùng dữ liệu đã che.",
  editBlocked: "Cột này đang bị che — hãy bỏ che hoặc hiện giá trị trước khi sửa.",
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
  maskWith: "다음으로 열 마스킹…",
  defaultTag: "기본값",
  unmask: "마스킹 해제",
  unmaskAll: "모든 열 마스킹 해제",
  strategies: {
    hash: "해시",
    redact: "가리기",
    null: "Null",
    "fake-email": "가짜 이메일",
    "fake-name": "가짜 이름",
    "fake-phone": "가짜 전화번호",
    noise: "숫자 노이즈",
  },
  maskedColumns: (count) => `마스킹된 열 ${count}개`,
  maskedHint: "이 열들은 마스킹된 값을 표시하며, 복사 및보내기에도 마스킹된 데이터가 사용됩니다.",
  editBlocked: "이 열은 마스킹되어 있습니다 — 편집하려면 마스킹을 해제하거나 값을 표시하세요.",
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
  maskWith: "Sütunu şununla maskele…",
  defaultTag: "varsayılan",
  unmask: "Maskeyi kaldır",
  unmaskAll: "Tüm sütunların maskesini kaldır",
  strategies: {
    hash: "Hash",
    redact: "Gizle",
    null: "Null",
    "fake-email": "Sahte e-posta",
    "fake-name": "Sahte ad",
    "fake-phone": "Sahte telefon",
    noise: "Sayısal gürültü",
  },
  maskedColumns: (count) => `${count} maskeli sütun`,
  maskedHint:
    "Bu sütunlar maskeli değerler gösterir; kopyalama ve dışa aktarma maskeli veriyi kullanır.",
  editBlocked: "Bu sütun maskeli — düzenlemeden önce maskeyi kaldırın veya değerleri gösterin.",
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
  maskWith: "使用以下方式掩码列…",
  defaultTag: "默认",
  unmask: "移除掩码",
  unmaskAll: "移除所有列掩码",
  strategies: {
    hash: "哈希",
    redact: "遮盖",
    null: "Null",
    "fake-email": "假邮箱",
    "fake-name": "假姓名",
    "fake-phone": "假电话",
    noise: "数值噪声",
  },
  maskedColumns: (count) => `${count} 个已掩码列`,
  maskedHint: "这些列显示掩码后的值；复制和导出均使用掩码数据。",
  editBlocked: "此列已掩码 — 请先移除掩码或显示原值后再编辑。",
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
