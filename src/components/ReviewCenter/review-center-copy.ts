/**
 * Review Center copy — per-language strings for the unified review modal.
 * English is the fallback for any missing locale.
 */

import type { AppLanguage } from "../../i18n";

export interface ReviewCenterCopy {
  /** Modal title. */
  title: string;
  /** Modal subtitle. */
  subtitle: string;
  /** Close button aria-label. */
  close: string;
  /** Window-menu item label. */
  menuItem: string;
  /** Floating launcher button label (badge count is appended separately). */
  launcherLabel: string;
  /** Launcher tooltip. */
  launcherTitle: string;
  tabs: {
    pendingEdits: string;
    structureChanges: string;
    schemaDiff: string;
  };
  pendingEdits: {
    /** Empty-state message. */
    empty: string;
    /** Group header: table name plus optional database. */
    groupTitle: (table: string, database?: string) => string;
    /** Connection label under a group header. */
    connectionLabel: (name: string) => string;
    /** Per-change approve button. */
    approve: string;
    /** Per-change discard button. */
    discard: string;
    /** Group-level apply button. */
    applyGroup: (count: number) => string;
    /** Group-level discard button. */
    discardGroup: (count: number) => string;
    /** Footer apply-everything button. */
    applyAll: (count: number) => string;
    /** Footer discard-everything button. */
    discardAll: (count: number) => string;
    /** SQL preview pane label. */
    sqlPreviewLabel: string;
    /** Copy-all-SQL button. */
    copyAll: string;
    /** Cell-diff section title. */
    cellChanges: string;
    /** Footer warning about transactional commit. */
    transactionNote: string;
    /** Busy label while a commit is in flight. */
    applying: string;
    /** Toast after a successful apply. */
    appliedToast: (count: number) => string;
    /** Toast after discarding. */
    discardedToast: (count: number) => string;
    /** Toast title when a commit fails. */
    applyFailedTitle: string;
    /** Error when a staged change has no connection to commit through. */
    missingConnection: string;
    /** Error when a staged change could not resolve its column names. */
    unresolvedColumns: (type: string, table: string) => string;
    /** Error when the selection contains a staged row deletion. */
    deleteNotCommittable: string;
  };
  structure: {
    /** Empty-state message. */
    empty: string;
    /** Explains that structure edits live inside the structure tab. */
    hint: string;
    /** Pending-count badge. */
    pendingBadge: (count: number) => string;
    /** Button that jumps to the table's review panel. */
    openReview: string;
    /** Button that runs the snapshot diff for the table. */
    compareSnapshot: string;
  };
}

const EN_COPY: ReviewCenterCopy = {
  title: "Review Center",
  subtitle: "Everything waiting for your approval, in one place",
  close: "Close review center",
  menuItem: "Review changes",
  launcherLabel: "Review changes",
  launcherTitle: "Open the Review Center",
  tabs: {
    pendingEdits: "Pending edits",
    structureChanges: "Structure changes",
    schemaDiff: "Schema diff",
  },
  pendingEdits: {
    empty: "No staged edits. Changes you make in a data grid land here before they are committed.",
    groupTitle: (table, database) => (database ? `${database} · ${table}` : table),
    connectionLabel: (name) => `on ${name}`,
    approve: "Approve",
    discard: "Discard",
    applyGroup: (count) => `Apply ${count}`,
    discardGroup: (count) => `Discard ${count}`,
    applyAll: (count) => `Apply all (${count})`,
    discardAll: (count) => `Discard all (${count})`,
    sqlPreviewLabel: "SQL to execute",
    copyAll: "Copy all",
    cellChanges: "Cell changes",
    transactionNote: "Each table's changes are committed as one atomic batch.",
    applying: "Applying…",
    appliedToast: (count) => `Applied ${count} staged change${count === 1 ? "" : "s"}.`,
    discardedToast: (count) => `Discarded ${count} staged change${count === 1 ? "" : "s"}.`,
    applyFailedTitle: "Could not apply staged changes",
    missingConnection:
      "This staged change has no connection attached, so it cannot be committed here. Apply it from the grid that staged it.",
    unresolvedColumns: (type, table) =>
      `A staged ${type} on ${table} has no resolved columns — reload the table and re-stage the edit.`,
    deleteNotCommittable:
      "The selection contains a staged row deletion, which cannot be committed through the atomic apply path. Discard it and delete the row directly instead.",
  },
  structure: {
    empty:
      "No pending structure changes. Column edits staged in a table's Structure tab show up here.",
    hint: "Structure changes are applied from the table's own review panel — open it to inspect the generated SQL.",
    pendingBadge: (count) => `${count} pending`,
    openReview: "Open review",
    compareSnapshot: "Compare snapshot",
  },
};

const VI_COPY: ReviewCenterCopy = {
  title: "Trung tâm duyệt",
  subtitle: "Mọi thay đổi đang chờ bạn phê duyệt, gom về một chỗ",
  close: "Đóng trung tâm duyệt",
  menuItem: "Duyệt thay đổi",
  launcherLabel: "Duyệt thay đổi",
  launcherTitle: "Mở trung tâm duyệt",
  tabs: {
    pendingEdits: "Chỉnh sửa đang chờ",
    structureChanges: "Thay đổi cấu trúc",
    schemaDiff: "So sánh schema",
  },
  pendingEdits: {
    empty:
      "Không có chỉnh sửa nào đang chờ. Thay đổi trong lưới dữ liệu sẽ xuất hiện ở đây trước khi ghi.",
    groupTitle: (table, database) => (database ? `${database} · ${table}` : table),
    connectionLabel: (name) => `trên ${name}`,
    approve: "Phê duyệt",
    discard: "Hủy bỏ",
    applyGroup: (count) => `Áp dụng ${count}`,
    discardGroup: (count) => `Hủy ${count}`,
    applyAll: (count) => `Áp dụng tất cả (${count})`,
    discardAll: (count) => `Hủy tất cả (${count})`,
    sqlPreviewLabel: "SQL sẽ chạy",
    copyAll: "Sao chép tất cả",
    cellChanges: "Thay đổi ô",
    transactionNote: "Thay đổi của mỗi bảng được ghi trong một giao dịch nguyên tử.",
    applying: "Đang áp dụng…",
    appliedToast: (count) => `Đã áp dụng ${count} thay đổi đã lưu.`,
    discardedToast: (count) => `Đã hủy ${count} thay đổi đã lưu.`,
    applyFailedTitle: "Không thể áp dụng thay đổi",
    missingConnection:
      "Thay đổi này không gắn với kết nối nào nên không thể ghi tại đây. Hãy áp dụng từ lưới đã tạo nó.",
    unresolvedColumns: (type, table) =>
      `Một thay đổi ${type} trên ${table} không có cột đã phân giải — tải lại bảng và lưu lại thay đổi.`,
    deleteNotCommittable:
      "Lựa chọn chứa thao tác xóa hàng đã lưu, không thể ghi qua đường áp dụng nguyên tử. Hãy hủy nó và xóa hàng trực tiếp.",
  },
  structure: {
    empty:
      "Không có thay đổi cấu trúc nào đang chờ. Chỉnh sửa cột trong tab Structure của bảng sẽ hiện ở đây.",
    hint: "Thay đổi cấu trúc được áp dụng từ panel duyệt của chính bảng — mở nó để xem SQL được tạo.",
    pendingBadge: (count) => `${count} đang chờ`,
    openReview: "Mở duyệt",
    compareSnapshot: "So với snapshot",
  },
};

const KO_COPY: ReviewCenterCopy = {
  title: "검토 센터",
  subtitle: "승인을 기다리는 모든 변경 사항을 한곳에서 확인",
  close: "검토 센터 닫기",
  menuItem: "변경 사항 검토",
  launcherLabel: "변경 사항 검토",
  launcherTitle: "검토 센터 열기",
  tabs: {
    pendingEdits: "대기 중인 편집",
    structureChanges: "구조 변경",
    schemaDiff: "스키마 비교",
  },
  pendingEdits: {
    empty:
      "스테이징된 편집이 없습니다. 데이터 그리드에서 변경한 내용은 커밋 전에 여기에 표시됩니다.",
    groupTitle: (table, database) => (database ? `${database} · ${table}` : table),
    connectionLabel: (name) => `${name}에서`,
    approve: "승인",
    discard: "폐기",
    applyGroup: (count) => `${count}개 적용`,
    discardGroup: (count) => `${count}개 폐기`,
    applyAll: (count) => `모두 적용 (${count})`,
    discardAll: (count) => `모두 폐기 (${count})`,
    sqlPreviewLabel: "실행할 SQL",
    copyAll: "모두 복사",
    cellChanges: "셀 변경",
    transactionNote: "각 테이블의 변경 사항은 하나의 원자적 배치로 커밋됩니다.",
    applying: "적용 중…",
    appliedToast: (count) => `스테이징된 변경 ${count}개를 적용했습니다.`,
    discardedToast: (count) => `스테이징된 변경 ${count}개를 폐기했습니다.`,
    applyFailedTitle: "스테이징된 변경을 적용할 수 없습니다",
    missingConnection:
      "이 스테이징 변경에는 연결이 지정되지 않아 여기서 커밋할 수 없습니다. 스테이징한 그리드에서 적용하세요.",
    unresolvedColumns: (type, table) =>
      `${table}의 스테이징된 ${type}에 확인된 열이 없습니다 — 테이블을 다시 로드하고 편집을 다시 스테이징하세요.`,
    deleteNotCommittable:
      "선택 항목에 스테이징된 행 삭제가 포함되어 있어 원자적 적용 경로로 커밋할 수 없습니다. 폐기하고 행을 직접 삭제하세요.",
  },
  structure: {
    empty:
      "대기 중인 구조 변경이 없습니다. 테이블의 Structure 탭에서 스테이징한 열 편집이 여기에 표시됩니다.",
    hint: "구조 변경은 해당 테이블의 검토 패널에서 적용됩니다 — 생성된 SQL을 확인하려면 여십시오.",
    pendingBadge: (count) => `${count}개 대기 중`,
    openReview: "검토 열기",
    compareSnapshot: "스냅샷 비교",
  },
};

const TR_COPY: ReviewCenterCopy = {
  title: "İnceleme Merkezi",
  subtitle: "Onayınızı bekleyen her şey tek yerde",
  close: "İnceleme merkezini kapat",
  menuItem: "Değişiklikleri incele",
  launcherLabel: "Değişiklikleri incele",
  launcherTitle: "İnceleme Merkezini aç",
  tabs: {
    pendingEdits: "Bekleyen düzenlemeler",
    structureChanges: "Yapı değişiklikleri",
    schemaDiff: "Şema farkı",
  },
  pendingEdits: {
    empty:
      "Aşamalı düzenleme yok. Veri kılavuzunda yaptığınız değişiklikler işlenmeden önce burada görünür.",
    groupTitle: (table, database) => (database ? `${database} · ${table}` : table),
    connectionLabel: (name) => `${name} üzerinde`,
    approve: "Onayla",
    discard: "Vazgeç",
    applyGroup: (count) => `${count} uygula`,
    discardGroup: (count) => `${count} vazgeç`,
    applyAll: (count) => `Tümünü uygula (${count})`,
    discardAll: (count) => `Tümünden vazgeç (${count})`,
    sqlPreviewLabel: "Çalıştırılacak SQL",
    copyAll: "Tümünü kopyala",
    cellChanges: "Hücre değişiklikleri",
    transactionNote: "Her tablonun değişiklikleri tek atomik toplu işlem olarak işlenir.",
    applying: "Uygulanıyor…",
    appliedToast: (count) => `${count} aşamalı değişiklik uygulandı.`,
    discardedToast: (count) => `${count} aşamalı değişiklikten vazgeçildi.`,
    applyFailedTitle: "Aşamalı değişiklikler uygulanamadı",
    missingConnection:
      "Bu aşamalı değişikliğin bağlı olduğu bir bağlantı yok, buradan işlenemez. Onu aşamalı hale getiren kılavuzdan uygulayın.",
    unresolvedColumns: (type, table) =>
      `${table} üzerindeki aşamalı ${type} işleminin çözümlenmiş sütunu yok — tabloyu yeniden yükleyip düzenlemeyi tekrar aşamalandırın.`,
    deleteNotCommittable:
      "Seçim, atomik uygulama yoluyla işlenemeyen aşamalı bir satır silme içeriyor. Vazgeçip satırı doğrudan silin.",
  },
  structure: {
    empty:
      "Bekleyen yapı değişikliği yok. Bir tablonun Structure sekmesinde aşamalanan sütun düzenlemeleri burada görünür.",
    hint: "Yapı değişiklikleri tablonun kendi inceleme panelinden uygulanır — oluşturulan SQL'i görmek için açın.",
    pendingBadge: (count) => `${count} bekliyor`,
    openReview: "İncelemeyi aç",
    compareSnapshot: "Snapshot ile karşılaştır",
  },
};

const ZH_COPY: ReviewCenterCopy = {
  title: "审查中心",
  subtitle: "所有待批准的变更集中在一处",
  close: "关闭审查中心",
  menuItem: "审查更改",
  launcherLabel: "审查更改",
  launcherTitle: "打开审查中心",
  tabs: {
    pendingEdits: "待处理编辑",
    structureChanges: "结构变更",
    schemaDiff: "架构对比",
  },
  pendingEdits: {
    empty: "没有暂存的编辑。在数据网格中所做的更改会先出现在这里，再提交到数据库。",
    groupTitle: (table, database) => (database ? `${database} · ${table}` : table),
    connectionLabel: (name) => `位于 ${name}`,
    approve: "批准",
    discard: "丢弃",
    applyGroup: (count) => `应用 ${count} 项`,
    discardGroup: (count) => `丢弃 ${count} 项`,
    applyAll: (count) => `全部应用 (${count})`,
    discardAll: (count) => `全部丢弃 (${count})`,
    sqlPreviewLabel: "将执行的 SQL",
    copyAll: "复制全部",
    cellChanges: "单元格变更",
    transactionNote: "每个表的更改作为一个原子批次提交。",
    applying: "正在应用…",
    appliedToast: (count) => `已应用 ${count} 项暂存更改。`,
    discardedToast: (count) => `已丢弃 ${count} 项暂存更改。`,
    applyFailedTitle: "无法应用暂存更改",
    missingConnection: "此暂存更改没有关联连接，无法在此提交。请从暂存它的网格中应用。",
    unresolvedColumns: (type, table) =>
      `${table} 上一个暂存的 ${type} 没有已解析的列 — 请重新加载表并重新暂存该编辑。`,
    deleteNotCommittable:
      "所选内容包含暂存的行删除，无法通过原子应用路径提交。请丢弃它并直接删除该行。",
  },
  structure: {
    empty: "没有待处理的结构变更。在表的 Structure 标签页中暂存的列编辑会显示在这里。",
    hint: "结构变更需在该表自己的审查面板中应用 — 打开它可查看生成的 SQL。",
    pendingBadge: (count) => `${count} 项待处理`,
    openReview: "打开审查",
    compareSnapshot: "对比快照",
  },
};

const COPY: Record<AppLanguage, ReviewCenterCopy> = {
  en: EN_COPY,
  vi: VI_COPY,
  ko: KO_COPY,
  tr: TR_COPY,
  zh: ZH_COPY,
};

export function getReviewCenterCopy(language: AppLanguage): ReviewCenterCopy {
  return COPY[language] ?? EN_COPY;
}
