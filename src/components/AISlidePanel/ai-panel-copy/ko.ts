import type { AIPanelCopy } from "./types";

export const KO_PANEL_COPY: AIPanelCopy = {
  runCost: {
    label: "{used} / {budget} 토큰",
    title: "이번 실행에서 사용한 모델 토큰 수 (실행당 예산 대비).",
  },
  rules: {
    title: "가드레일 규칙",
    subtitle:
      "<workspace>/rules의 Markdown 규칙과 내장 팩이 에이전트가 실행하는 모든 문을 검사합니다.",
    close: "닫기",
    newRule: "새 규칙",
    noWorkspaceTitle:
      "먼저 이 워크스페이스에 폴더를 연결하세요 — 워크스페이스 규칙은 <폴더>/rules에 저장됩니다.",
    refresh: "목록 새로고침",
    loading: "불러오는 중…",
    empty: "활성화된 규칙이 없습니다.",
    armedCount: "{count}개 활성",
    errorsTitle: "불러오지 못한 파일",
    nameLabel: "규칙 이름",
    nameHint: "소문자, 숫자, '-', '_' (1-64자). <이름>.md 파일이 됩니다.",
    contentLabel: "규칙 파일 (.md)",
    contentHint: "프론트매터 + 본문. 쓰기 전에 유효성을 검사합니다.",
    cancel: "취소",
    create: "규칙 만들기",
    creating: "만드는 중…",
    savedAt: "규칙 저장 위치: {path}",
    originBuiltin: "내장",
    originGlobal: "전역",
    originWorkspace: "워크스페이스",
    actionWarn: "경고",
    actionRequireApproval: "승인 필요",
    actionBlock: "차단",
  },
};
