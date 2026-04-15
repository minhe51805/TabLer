// i18n — Language infrastructure
// Per-language translation objects live in src/i18n/*.ts
export {
  en,
  vi,
  zh,
  tr,
  ko,
  getCurrentAppLanguage,
  useLanguageStore,
  translateLanguage,
  translateCurrent,
  formatCountLabel,
  useI18n,
} from "./i18n/index";

export type { AppLanguage, AppLanguagePreference, TranslationKey } from "./i18n/index";