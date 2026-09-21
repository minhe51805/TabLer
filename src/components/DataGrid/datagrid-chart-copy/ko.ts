import type { DataGridChartCopy } from "./types";

export const KO_COPY: DataGridChartCopy = {
  chart: {
    title: "차트",
    buttonTitle: "이 결과를 차트로 보기",
    type: "차트 유형",
    xAxis: "X축",
    yAxis: "Y축",
    value: "값",
    close: "닫기",
    noRows: "시각화할 데이터가 없습니다.",
    noNumeric: "차트로 표시할 숫자 열이 없습니다.",
  },
  autoRefresh: {
    title: "자동 새로고침",
    off: "끄기",
    everySeconds: (seconds) => `${seconds}초마다`,
    countdown: (seconds) => `${seconds}초`,
    stoppedForEdit: "편집 중이라 자동 새로고침을 중지했습니다",
  },
};
