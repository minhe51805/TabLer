import type { ScheduleCopy } from "./types";

export const KO_COPY: ScheduleCopy = {
  missedBanner: (count) => `앱이 닫혀 있는 동안 ${count}회 실행이 누락되었습니다`,
  missedDismiss: "닫기",
  statusMissed: "누락됨",
  catchUp: "앱이 닫혔을 때",
  catchUpSkip: "누락된 실행 건너뛰기",
  catchUpRunOnce: "다음 실행 시 한 번 실행",
  missedToast: (count) => `앱이 닫혀 있는 동안 예약된 실행 ${count}회가 누락되었습니다`,
};
