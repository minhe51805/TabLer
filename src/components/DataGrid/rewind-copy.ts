/**
 * Copy for the grid Rewind feature: the pre-write checkpoint list plus the
 * restore/delete actions in the Rewind modal. Kept out of src/i18n per the
 * per-feature copy-module convention.
 */

import type { AppLanguage } from "../../i18n";
import type { RefusalCode } from "../../types";

export interface RewindCopy {
  /** Modal title. */
  title: string;
  /** Tools-menu entry that opens the modal. */
  menuItem: string;
  /** Hint line under the menu entry. */
  menuHint: string;
  /** Empty state — also what engines without rewind capture show. */
  empty: string;
  /** Small caption explaining that capture depends on engine support. */
  unsupportedHint: string;
  /** Kind badges; SQL verbs stay untranslated per convention. */
  kinds: {
    update: string;
    delete: string;
    insert: string;
  };
  /** Row-count text on each checkpoint row. */
  rowsCount: (count: number) => string;
  /** Relative timestamp for a checkpoint row. */
  ago: {
    seconds: (n: number) => string;
    minutes: (n: number) => string;
    hours: (n: number) => string;
    days: (n: number) => string;
  };
  /** Per-row action buttons. */
  restore: string;
  delete: string;
  /** Confirmation text before a restore runs. */
  confirmRestore: (tableName: string, kindLabel: string, rowCount: number) => string;
  /** Success toast after a restore. */
  restoredToast: (restored: number, tableName: string) => string;
  /** Error toast title when the checkpoint list fails to load. */
  loadFailed: string;
  /** Error toast title when a restore/delete command throws. */
  actionFailed: string;
  /** Close-button aria label. */
  close: string;
  /** Inline reason shown under a checkpoint row when a restore is refused.
   *  Short cause plus what to do; the checkpoint itself stays listed. */
  refusals: Record<RefusalCode, string>;
  /** Badge on checkpoints older than the 7-day retention window. */
  expiredBadge: string;
}

const EN_COPY: RewindCopy = {
  title: "Rewind checkpoints",
  menuItem: "Rewind…",
  menuHint: "Encrypted pre-write checkpoints for this connection",
  empty:
    "No rewind checkpoints. Checkpoints appear here after UPDATE or DELETE writes on this connection.",
  unsupportedHint:
    "Checkpoints are captured automatically before update/delete writes on engines that support rewind.",
  kinds: {
    update: "UPDATE",
    delete: "DELETE",
    insert: "INSERT",
  },
  rowsCount: (count) => `${count} ${count === 1 ? "row" : "rows"}`,
  ago: {
    seconds: (n) => `${n}s ago`,
    minutes: (n) => `${n}m ago`,
    hours: (n) => `${n}h ago`,
    days: (n) => `${n}d ago`,
  },
  restore: "Restore",
  delete: "Delete",
  confirmRestore: (tableName, kindLabel, rowCount) =>
    `Restore the ${rowCount} row(s) captured before ${kindLabel} on ${tableName}? Current values will be replaced.`,
  restoredToast: (restored, tableName) =>
    `Restored ${restored} ${restored === 1 ? "row" : "rows"} in ${tableName}.`,
  loadFailed: "Could not load rewind checkpoints",
  actionFailed: "Rewind action failed",
  close: "Close",
  refusals: {
    capabilityMissing:
      "this engine does not support rewind — run the write again with a transaction-safe backup",
    safeModeBlocked: "restore blocked by safe mode — approve it or raise the safety level",
    connectionReadOnly: "connection is read-only — restore needs write access",
    checkpointExpired: "older than 7 days — pre-image too stale",
    connectionMismatch: "captured on a different connection — open the checkpoint from its source",
    emptyCheckpoint: "checkpoint has no rows — nothing to restore",
    rowDriftDetected: "rows changed since capture — checkpoint kept",
  },
  expiredBadge: "expired",
};

const VI_COPY: RewindCopy = {
  title: "Điểm khôi phục Rewind",
  menuItem: "Rewind…",
  menuHint: "Điểm kiểm tra đã mã hóa trước khi ghi cho kết nối này",
  empty:
    "Chưa có điểm khôi phục. Chúng sẽ xuất hiện ở đây sau các lần ghi UPDATE hoặc DELETE trên kết nối này.",
  unsupportedHint:
    "Điểm kiểm tra được ghi lại tự động trước các thao tác update/delete trên các engine hỗ trợ rewind.",
  kinds: {
    update: "UPDATE",
    delete: "DELETE",
    insert: "INSERT",
  },
  rowsCount: (count) => `${count} hàng`,
  ago: {
    seconds: (n) => `${n} giây trước`,
    minutes: (n) => `${n} phút trước`,
    hours: (n) => `${n} giờ trước`,
    days: (n) => `${n} ngày trước`,
  },
  restore: "Khôi phục",
  delete: "Xóa",
  confirmRestore: (tableName, kindLabel, rowCount) =>
    `Khôi phục ${rowCount} hàng đã ghi lại trước ${kindLabel} trên ${tableName}? Giá trị hiện tại sẽ bị thay thế.`,
  restoredToast: (restored, tableName) => `Đã khôi phục ${restored} hàng trong ${tableName}.`,
  loadFailed: "Không tải được điểm khôi phục",
  actionFailed: "Thao tác Rewind thất bại",
  close: "Đóng",
  refusals: {
    capabilityMissing: "engine này không hỗ trợ rewind — hãy ghi lại kèm bản sao lưu an toàn",
    safeModeBlocked: "safe mode chặn khôi phục — hãy phê duyệt hoặc nâng mức an toàn",
    connectionReadOnly: "kết nối chỉ đọc — khôi phục cần quyền ghi",
    checkpointExpired: "cũ hơn 7 ngày — dữ liệu gốc đã quá lạc hậu",
    connectionMismatch: "được ghi trên kết nối khác — hãy mở điểm kiểm tra từ nguồn của nó",
    emptyCheckpoint: "điểm kiểm tra không có hàng — không có gì để khôi phục",
    rowDriftDetected: "các hàng đã thay đổi kể từ khi ghi — giữ nguyên điểm kiểm tra",
  },
  expiredBadge: "hết hạn",
};

const KO_COPY: RewindCopy = {
  title: "Rewind 체크포인트",
  menuItem: "Rewind…",
  menuHint: "이 연결의 암호화된 쓰기 전 체크포인트",
  empty:
    "Rewind 체크포인트가 없습니다. 이 연결에서 UPDATE 또는 DELETE 쓰기 후에 여기에 표시됩니다.",
  unsupportedHint:
    "Rewind를 지원하는 엔진에서는 UPDATE/DELETE 쓰기 전에 체크포인트가 자동으로 캡처됩니다.",
  kinds: {
    update: "UPDATE",
    delete: "DELETE",
    insert: "INSERT",
  },
  rowsCount: (count) => `${count}행`,
  ago: {
    seconds: (n) => `${n}초 전`,
    minutes: (n) => `${n}분 전`,
    hours: (n) => `${n}시간 전`,
    days: (n) => `${n}일 전`,
  },
  restore: "복원",
  delete: "삭제",
  confirmRestore: (tableName, kindLabel, rowCount) =>
    `${tableName}에서 ${kindLabel} 전에 캡처된 ${rowCount}개 행을 복원하시겠습니까? 현재 값이 대체됩니다.`,
  restoredToast: (restored, tableName) => `${tableName}에서 ${restored}개 행을 복원했습니다.`,
  loadFailed: "Rewind 체크포인트를 불러오지 못했습니다",
  actionFailed: "Rewind 작업 실패",
  close: "닫기",
  refusals: {
    capabilityMissing:
      "이 엔진은 Rewind를 지원하지 않습니다 — 트랜잭션 안전 백업과 함께 쓰기를 다시 실행하세요",
    safeModeBlocked: "세이프 모드가 복원을 차단했습니다 — 승인하거나 안전 수준을 높이세요",
    connectionReadOnly: "연결이 읽기 전용입니다 — 복원에는 쓰기 권한이 필요합니다",
    checkpointExpired: "7일이 지남 — 캡처된 이미지가 너무 오래되었습니다",
    connectionMismatch: "다른 연결에서 캡처됨 — 원본 연결에서 체크포인트를 여세요",
    emptyCheckpoint: "체크포인트에 행이 없습니다 — 복원할 내용이 없습니다",
    rowDriftDetected: "캡처 이후 행이 변경됨 — 체크포인트는 유지됩니다",
  },
  expiredBadge: "만료됨",
};

const TR_COPY: RewindCopy = {
  title: "Rewind denetim noktaları",
  menuItem: "Rewind…",
  menuHint: "Bu bağlantı için şifrelenmiş yazma öncesi denetim noktaları",
  empty:
    "Rewind denetim noktası yok. Bu bağlantıdaki UPDATE veya DELETE yazma işlemlerinden sonra burada görünürler.",
  unsupportedHint:
    "Rewind destekleyen motorlarda UPDATE/DELETE yazma işlemlerinden önce denetim noktaları otomatik yakalanır.",
  kinds: {
    update: "UPDATE",
    delete: "DELETE",
    insert: "INSERT",
  },
  rowsCount: (count) => `${count} satır`,
  ago: {
    seconds: (n) => `${n} sn önce`,
    minutes: (n) => `${n} dk önce`,
    hours: (n) => `${n} sa önce`,
    days: (n) => `${n} gün önce`,
  },
  restore: "Geri yükle",
  delete: "Sil",
  confirmRestore: (tableName, kindLabel, rowCount) =>
    `${tableName} üzerinde ${kindLabel} öncesinde yakalanan ${rowCount} satır geri yüklensin mi? Mevcut değerler değiştirilecek.`,
  restoredToast: (restored, tableName) => `${tableName} içinde ${restored} satır geri yüklendi.`,
  loadFailed: "Rewind denetim noktaları yüklenemedi",
  actionFailed: "Rewind işlemi başarısız",
  close: "Kapat",
  refusals: {
    capabilityMissing:
      "bu motor rewind desteklemiyor — yazma işlemini işlem güvenli bir yedekle tekrarlayın",
    safeModeBlocked:
      "güvenli mod geri yüklemeyi engelledi — onaylayın veya güvenlik seviyesini yükseltin",
    connectionReadOnly: "bağlantı salt-okunur — geri yükleme yazma erişimi gerektirir",
    checkpointExpired: "7 günden eski — görüntü çok bayat",
    connectionMismatch: "farklı bir bağlantıda yakalandı — denetim noktasını kaynağından açın",
    emptyCheckpoint: "denetim noktasında satır yok — geri yüklenecek bir şey yok",
    rowDriftDetected: "yakalamadan sonra satırlar değişti — denetim noktası korundu",
  },
  expiredBadge: "süresi doldu",
};

const ZH_COPY: RewindCopy = {
  title: "Rewind 检查点",
  menuItem: "Rewind…",
  menuHint: "此连接的加密写入前检查点",
  empty: "没有 Rewind 检查点。在此连接上执行 UPDATE 或 DELETE 写入后会显示在这里。",
  unsupportedHint: "在支持 Rewind 的引擎上，UPDATE/DELETE 写入前会自动捕获检查点。",
  kinds: {
    update: "UPDATE",
    delete: "DELETE",
    insert: "INSERT",
  },
  rowsCount: (count) => `${count} 行`,
  ago: {
    seconds: (n) => `${n} 秒前`,
    minutes: (n) => `${n} 分钟前`,
    hours: (n) => `${n} 小时前`,
    days: (n) => `${n} 天前`,
  },
  restore: "恢复",
  delete: "删除",
  confirmRestore: (tableName, kindLabel, rowCount) =>
    `要恢复在 ${tableName} 上 ${kindLabel} 之前捕获的 ${rowCount} 行吗？当前值将被替换。`,
  restoredToast: (restored, tableName) => `已在 ${tableName} 中恢复 ${restored} 行。`,
  loadFailed: "无法加载 Rewind 检查点",
  actionFailed: "Rewind 操作失败",
  close: "关闭",
  refusals: {
    capabilityMissing: "此引擎不支持 Rewind — 请在安全事务备份下重新执行写入",
    safeModeBlocked: "安全模式阻止了恢复 — 请批准或提高安全级别",
    connectionReadOnly: "连接为只读 — 恢复需要写入权限",
    checkpointExpired: "超过 7 天 — 前置映像过于陈旧",
    connectionMismatch: "在其他连接上捕获 — 请从其来源打开检查点",
    emptyCheckpoint: "检查点没有行 — 没有可恢复的内容",
    rowDriftDetected: "捕获后行已更改 — 检查点已保留",
  },
  expiredBadge: "已过期",
};

const COPY: Record<AppLanguage, RewindCopy> = {
  en: EN_COPY,
  vi: VI_COPY,
  ko: KO_COPY,
  tr: TR_COPY,
  zh: ZH_COPY,
};

export function getRewindCopy(language: AppLanguage): RewindCopy {
  return COPY[language] ?? EN_COPY;
}
