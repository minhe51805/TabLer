import type { BundleCopy } from "./types";

export const KO_BUNDLE_COPY: BundleCopy = {
  modes: {
    connections: "연결만",
    bundle: "전체 워크스페이스 번들",
  },
  export: {
    title: "워크스페이스 번들보내기",
    subtitle: "워크스페이스 설정 전체를 하나의 파일로 공유",
    info: "번들은 팀 공유용 일반 JSON 파일입니다. 비밀번호, SSH 키, AI API 키는 이 컴퓨터의 보안 저장소에 남으며, 어떤 자격 증명을 다시 입력해야 하는지만 플래그로보냅니다.",
    includes: "포함 항목:",
    connections: "저장된 연결 (비밀번호 제외)",
    favorites: "SQL 즐겨찾기",
    schedules: "저장된 일정",
    aiProviders: "AI 제공자 설정 (API 키 제외)",
    uiPrefs: "UI 환경 설정 (테마, 레이아웃, 단축키)",
    button: "번들보내기",
    working: "보내는 중...",
    done: "워크스페이스 번들을 다음 위치에보냈습니다:",
  },
  import: {
    dropzoneHint: "TableR보내기 (*.tabler-connections, *.tabler-bundle)",
    title: "워크스페이스 번들 가져오기",
    subtitle: "번들 내용을 확인하고 가져올 항목을 선택하세요",
    sections: {
      connections: "연결",
      sqlFavorites: "SQL 즐겨찾기",
      schedules: "일정",
      aiProviders: "AI 제공자",
      uiPrefs: "UI 환경 설정",
    },
    exists: "이미 존재함",
    needsPassword: "비밀번호 재입력 필요",
    uiPrefsMeta: "키 {total}개 · {existing}개 이미 있음",
    uiPrefsWritten: "UI 환경 설정 키",
    uiPrefsRestart: "적용하려면 앱을 다시 시작하세요",
    button: "선택 항목 가져오기",
    working: "가져오는 중...",
    done: "가져옴",
    empty: "이 번들에는 항목이 없습니다.",
    external: {
      button: "DBeaver / DataGrip에서 가져오기",
      passwordNote:
        "비밀번호는 가져오지 않습니다 — DBeaver와 DataGrip은 암호화하여 저장합니다. 가져올 각 연결의 데이터베이스 비밀번호를 입력하세요.",
      skipped: "{count}개 항목 건너뜀 (지원하지 않는 엔진 또는 형식 오류)",
    },
  },
};
