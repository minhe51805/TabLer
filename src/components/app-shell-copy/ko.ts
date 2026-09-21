import type { AppShellCopy } from "./types";

export const KO_COPY: AppShellCopy = {
  updates: {
    check: "업데이트 확인",
    checking: "확인 중…",
    upToDate: "TableR이 최신 버전입니다.",
    available: "버전 {version}을(를) 사용할 수 있습니다.",
    releaseNotes: "릴리스 노트",
    install: "다운로드 및 설치",
    downloading: "업데이트 다운로드 중… {progress}%",
    installing: "설치 중 — TableR이 다시 시작됩니다…",
    retry: "다시 시도",
    checkFailed: "업데이트 확인 실패",
  },
  storageRecovery: {
    kicker: "시작 복구",
    title: "워크스페이스 데이터가 손상된 것 같습니다",
    description:
      "TableR이 저장된 워크스페이스 파일 일부를 읽지 못했습니다. 손상된 파일을 격리하고 새로 시작할 수 있습니다 — 원본은 .corrupt 백업으로 보관됩니다 — 또는 종료하고 파일을 직접 확인할 수 있습니다.",
    affectedFiles: "영향을 받는 파일",
    reset: "초기화 후 계속",
    resetting: "초기화 중…",
    quit: "종료",
    resetFailed: "초기화 실패",
  },
};
