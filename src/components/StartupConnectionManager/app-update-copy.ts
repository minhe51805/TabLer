/**
 * Copy for the topbar "Update" pill (AppUpdateButton): the available-update
 * popup plus the quiet retry state shown when the background update check
 * fails. Kept out of src/i18n per the per-feature copy-module convention.
 */

import type { AppLanguage } from "../../i18n";

export interface AppUpdateCopy {
  button: string;
  title: string;
  available: string;
  install: string;
  later: string;
  downloading: string;
  installing: string;
  skip: string;
  /** Pill label when the background check failed (quiet retry affordance). */
  retry: string;
  /** Tooltip describing the failed check; `{error}` is the backend message. */
  checkFailed: (error: string) => string;
}

const EN_COPY: AppUpdateCopy = {
  button: "Update",
  title: "Update TableR",
  available: "A new version is ready:",
  install: "Download & install",
  later: "Later",
  downloading: "Downloading update…",
  installing: "Installing — the app will restart…",
  skip: "Skip this version",
  retry: "Retry update check",
  checkFailed: (error) => `Update check failed — click to retry. ${error}`,
};

const VI_COPY: AppUpdateCopy = {
  button: "Cập nhật",
  title: "Cập nhật TableR",
  available: "Phiên bản mới đã sẵn sàng:",
  install: "Tải xuống & cài đặt",
  later: "Để sau",
  downloading: "Đang tải bản cập nhật…",
  installing: "Đang cài đặt — ứng dụng sẽ khởi động lại…",
  skip: "Bỏ qua bản này",
  retry: "Thử kiểm tra lại",
  checkFailed: (error) => `Kiểm tra cập nhật thất bại — nhấn để thử lại. ${error}`,
};

const ZH_COPY: AppUpdateCopy = {
  button: "更新",
  title: "更新 TableR",
  available: "新版本已就绪：",
  install: "下载并安装",
  later: "稍后",
  downloading: "正在下载更新…",
  installing: "正在安装 — 应用即将重启…",
  skip: "跳过此版本",
  retry: "重试检查更新",
  checkFailed: (error) => `检查更新失败 — 点击重试。${error}`,
};

const TR_COPY: AppUpdateCopy = {
  button: "Güncelle",
  title: "TableR'ı güncelle",
  available: "Yeni sürüm hazır:",
  install: "İndir ve kur",
  later: "Sonra",
  downloading: "Güncelleme indiriliyor…",
  installing: "Kuruluyor — uygulama yeniden başlatılacak…",
  skip: "Bu sürümü atla",
  retry: "Güncelleme kontrolünü tekrarla",
  checkFailed: (error) => `Güncelleme kontrolü başarısız — tekrar denemek için tıklayın. ${error}`,
};

const KO_COPY: AppUpdateCopy = {
  button: "업데이트",
  title: "TableR 업데이트",
  available: "새 버전이 준비되었습니다:",
  install: "다운로드 및 설치",
  later: "나중에",
  downloading: "업데이트 다운로드 중…",
  installing: "설치 중 — 앱이 재시작됩니다…",
  skip: "이 버전 건너뛰기",
  retry: "업데이트 확인 재시도",
  checkFailed: (error) => `업데이트 확인 실패 — 클릭하여 재시도. ${error}`,
};

const COPY: Record<AppLanguage, AppUpdateCopy> = {
  en: EN_COPY,
  vi: VI_COPY,
  zh: ZH_COPY,
  tr: TR_COPY,
  ko: KO_COPY,
};

export function getAppUpdateCopy(language: AppLanguage): AppUpdateCopy {
  return COPY[language] ?? EN_COPY;
}
