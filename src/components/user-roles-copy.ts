/**
 * Copy for the Users & Roles safe-mode remedy path. Kept out of src/i18n per
 * the per-feature copy-module convention; English is the fallback.
 */

import type { AppLanguage } from "../i18n";

export interface UserRolesCopy {
  /** Confirm-dialog title when Safe Mode hard-blocks the reviewed change. */
  safeModeBlockedTitle: string;
  /**
   * Message when switching this connection to Standard (level 3) unblocks the
   * reviewed statements. {level} is the current level, {statement} the first
   * blocked statement.
   */
  safeModeBlockedStandard: (level: number, statement: string) => string;
  /**
   * Message when only disabling Safe Mode unblocks the reviewed statements.
   */
  safeModeBlockedDisable: (level: number, statement: string) => string;
  /** Confirm button: per-connection override to Standard (level 3). */
  safeModeUseStandard: string;
  /** Confirm button: per-connection override to Disabled (level 0). */
  safeModeDisable: string;
  /** Toast after the connection override was applied. */
  safeModeOverrideApplied: string;
  /** Toast when the user cancels the Safe Mode confirmation dialog. */
  safeModeCancelled: string;
  /** Empty-state when privilege/membership queries failed (lists incomplete). */
  privilegesUnavailable: string;
}

const EN_COPY: UserRolesCopy = {
  safeModeBlockedTitle: "Blocked by Safe Mode",
  safeModeBlockedStandard: (level, statement) =>
    `Safe Mode level ${level} blocks this change:\n\n${statement}\n\n` +
    "Switch this connection to Standard (level 3) to apply it? " +
    "Standard still blocks destructive statements like DROP and TRUNCATE.",
  safeModeBlockedDisable: (level, statement) =>
    `Safe Mode level ${level} blocks this change:\n\n${statement}\n\n` +
    "Disable Safe Mode for this connection to apply it?",
  safeModeUseStandard: "Use Standard for this connection",
  safeModeDisable: "Disable Safe Mode for this connection",
  safeModeOverrideApplied: "Safe Mode updated for this connection",
  safeModeCancelled: "Change cancelled by Safe Mode.",
  privilegesUnavailable:
    "Could not load privileges or role memberships — the lists below may be incomplete.",
};

const VI_COPY: UserRolesCopy = {
  safeModeBlockedTitle: "Bị Safe Mode chặn",
  safeModeBlockedStandard: (level, statement) =>
    `Safe Mode mức ${level} chặn thay đổi này:\n\n${statement}\n\n` +
    "Chuyển kết nối này sang Standard (mức 3) để áp dụng? " +
    "Standard vẫn chặn các câu lệnh phá hủy như DROP và TRUNCATE.",
  safeModeBlockedDisable: (level, statement) =>
    `Safe Mode mức ${level} chặn thay đổi này:\n\n${statement}\n\n` +
    "Tắt Safe Mode cho kết nối này để áp dụng?",
  safeModeUseStandard: "Dùng Standard cho kết nối này",
  safeModeDisable: "Tắt Safe Mode cho kết nối này",
  safeModeOverrideApplied: "Đã cập nhật Safe Mode cho kết nối này",
  safeModeCancelled: "Đã hủy thay đổi theo Safe Mode.",
  privilegesUnavailable:
    "Không tải được quyền hoặc thành viên vai trò — danh sách bên dưới có thể chưa đầy đủ.",
};

const KO_COPY: UserRolesCopy = {
  safeModeBlockedTitle: "Safe Mode에 의해 차단됨",
  safeModeBlockedStandard: (level, statement) =>
    `Safe Mode 레벨 ${level}이(가) 이 변경을 차단합니다:\n\n${statement}\n\n` +
    "이 연결을 Standard(레벨 3)로 전환하여 적용할까요? " +
    "Standard는 DROP, TRUNCATE 같은 파괴적 문을 계속 차단합니다.",
  safeModeBlockedDisable: (level, statement) =>
    `Safe Mode 레벨 ${level}이(가) 이 변경을 차단합니다:\n\n${statement}\n\n` +
    "이 연결의 Safe Mode를 해제하여 적용할까요?",
  safeModeUseStandard: "이 연결에 Standard 사용",
  safeModeDisable: "이 연결의 Safe Mode 해제",
  safeModeOverrideApplied: "이 연결의 Safe Mode가 업데이트되었습니다",
  safeModeCancelled: "Safe Mode에 의해 변경이 취소되었습니다.",
  privilegesUnavailable:
    "권한 또는 역할 멤버십을 불러오지 못했습니다 — 아래 목록이 불완전할 수 있습니다.",
};

const TR_COPY: UserRolesCopy = {
  safeModeBlockedTitle: "Safe Mode tarafından engellendi",
  safeModeBlockedStandard: (level, statement) =>
    `Safe Mode seviye ${level} bu değişikliği engelliyor:\n\n${statement}\n\n` +
    "Uygulamak için bu bağlantıyı Standard'a (seviye 3) geçirilsin mi? " +
    "Standard, DROP ve TRUNCATE gibi yıkıcı ifadeleri yine engeller.",
  safeModeBlockedDisable: (level, statement) =>
    `Safe Mode seviye ${level} bu değişikliği engelliyor:\n\n${statement}\n\n` +
    "Uygulamak için bu bağlantıda Safe Mode kapatılsın mı?",
  safeModeUseStandard: "Bu bağlantı için Standard kullan",
  safeModeDisable: "Bu bağlantıda Safe Mode'u kapat",
  safeModeOverrideApplied: "Bu bağlantı için Safe Mode güncellendi",
  safeModeCancelled: "Değişiklik Safe Mode tarafından iptal edildi.",
  privilegesUnavailable:
    "Ayrıcalıklar veya rol üyelikleri yüklenemedi — aşağıdaki listeler eksik olabilir.",
};

const ZH_COPY: UserRolesCopy = {
  safeModeBlockedTitle: "被 Safe Mode 阻止",
  safeModeBlockedStandard: (level, statement) =>
    `Safe Mode 级别 ${level} 阻止了此更改：\n\n${statement}\n\n` +
    "将此连接切换为 Standard（级别 3）以应用？" +
    "Standard 仍会阻止 DROP、TRUNCATE 等破坏性语句。",
  safeModeBlockedDisable: (level, statement) =>
    `Safe Mode 级别 ${level} 阻止了此更改：\n\n${statement}\n\n` +
    "为此连接禁用 Safe Mode 以应用？",
  safeModeUseStandard: "为此连接使用 Standard",
  safeModeDisable: "为此连接禁用 Safe Mode",
  safeModeOverrideApplied: "已更新此连接的 Safe Mode",
  safeModeCancelled: "更改已被 Safe Mode 取消。",
  privilegesUnavailable: "无法加载权限或角色成员关系 — 下方列表可能不完整。",
};

const COPY: Record<AppLanguage, UserRolesCopy> = {
  en: EN_COPY,
  vi: VI_COPY,
  ko: KO_COPY,
  tr: TR_COPY,
  zh: ZH_COPY,
};

export function getUserRolesCopy(language: AppLanguage): UserRolesCopy {
  return COPY[language] ?? EN_COPY;
}
