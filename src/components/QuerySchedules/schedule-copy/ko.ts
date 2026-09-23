import type { ScheduleCopy } from "./types";

export const KO_COPY: ScheduleCopy = {
  missedBanner: (count) => `앱이 닫혀 있는 동안 ${count}회 실행이 누락되었습니다`,
  missedDismiss: "닫기",
  statusMissed: "누락됨",
  catchUp: "앱이 닫혔을 때",
  catchUpSkip: "누락된 실행 건너뛰기",
  catchUpRunOnce: "다음 실행 시 한 번 실행",
  missedToast: (count) => `앱이 닫혀 있는 동안 예약된 실행 ${count}회가 누락되었습니다`,
  loading: "불러오는 중...",
  statusNew: "새 항목",
  every: (label) => `${label}마다`,
  ago: {
    seconds: (n) => `${n}초 전`,
    minutes: (n) => `${n}분 전`,
    hours: (n) => `${n}시간 전`,
    days: (n) => `${n}일 전`,
  },
  rowsCount: (count) => `행 ${count}개`,
  loadFailed: "일정을 불러올 수 없습니다",
  sqlRunOk: (name) => `예약된 쿼리 실행됨: ${name}`,
  sqlRunOkRows: (rows) => `행 ${rows}개 반환됨.`,
  sqlRunFailed: (name) => `예약된 쿼리 실패: ${name}`,
  unknownError: "알 수 없는 오류.",
  agentReadOnlyHint:
    "앱이 열려 있는 동안 무인으로 읽기 전용으로 실행됩니다: 데이터를 변경하거나 질문하지 않습니다. 행 데이터는 아래 옵션을 켰을 때만 읽어 AI 제공자에게 전송되며, 그렇지 않으면 스키마 메타데이터만 봅니다.",
  agentDataRead: "이 작업이 데이터를 읽어 AI 제공자에게 보내도록 허용",
};
