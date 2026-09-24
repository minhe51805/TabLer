import { useCallback, useEffect } from "react";
import { create } from "zustand";

import { en } from "./en";

// Non-English locales load on demand: the eager path only ever reads the
// resolved language plus the English fallback, so bundling all five costs
// ~190 KB of object literals parsed before first paint for no benefit.
// Dynamic imports are runtime-selected by the stored preference — a static
// import would defeat the split.
const localeLoaders = {
  vi: () => import("./vi"),
  zh: () => import("./zh"),
  tr: () => import("./tr"),
  ko: () => import("./ko"),
} as const;

// Only the eager fallback is re-exported; other locales load via
// ensureLanguage(). Tests import locale files directly.
export { en };

// Types
export type AppLanguage = "en" | "vi" | "zh" | "tr" | "ko";
export type AppLanguagePreference = "auto" | AppLanguage;
export type TranslationKey = keyof typeof en;

const LANGUAGE_STORAGE_KEY = "tabler.language";

function detectSystemLanguage(): AppLanguage {
  if (typeof window === "undefined") return "en";

  const normalized = window.navigator.language.toLowerCase();
  if (normalized.startsWith("vi")) return "vi";
  if (normalized.startsWith("zh")) return "zh";
  if (normalized.startsWith("tr")) return "tr";
  if (normalized.startsWith("ko")) return "ko";
  return "en";
}

function resolveLanguage(preference: AppLanguagePreference): AppLanguage {
  return preference === "auto" ? detectSystemLanguage() : preference;
}

export function getCurrentAppLanguage(): AppLanguage {
  return resolveLanguage(useLanguageStore.getState().languagePreference);
}

function getInitialLanguagePreference(): AppLanguagePreference {
  if (typeof window === "undefined") return "auto";

  const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
  if (
    stored === "auto" ||
    stored === "en" ||
    stored === "vi" ||
    stored === "zh" ||
    stored === "tr" ||
    stored === "ko"
  ) {
    return stored;
  }

  return "auto";
}

type LanguageState = {
  languagePreference: AppLanguagePreference;
  /** Bumped when a locale finishes loading so subscribed components re-render. */
  languageVersion: number;
  setLanguage: (language: AppLanguagePreference) => void;
};

export const useLanguageStore = create<LanguageState>((set) => ({
  languagePreference: getInitialLanguagePreference(),
  languageVersion: 0,
  setLanguage: (languagePreference) => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(LANGUAGE_STORAGE_KEY, languagePreference);
    }
    set({ languagePreference });
    ensureLanguage(resolveLanguage(languagePreference));
  },
}));

type TranslationTable = Partial<Record<keyof typeof en, string>>;

const translations: Partial<Record<AppLanguage, TranslationTable>> = { en };

/** Loads a non-English locale once; resolves immediately for `en` or a
 *  locale that is already cached. */
export function ensureLanguage(language: AppLanguage): Promise<void> {
  if (language === "en" || translations[language]) {
    return Promise.resolve();
  }
  return localeLoaders[language]()
    .then((module) => {
      translations[language] = (module as Record<string, TranslationTable>)[language];
      useLanguageStore.setState((state) => ({ languageVersion: state.languageVersion + 1 }));
    })
    .catch((error) => {
      console.error(`[i18n] failed to load locale "${language}"`, error);
    });
}

// Warm the resolved locale at module load; components render English for the
// first frame and swap when the chunk arrives (sub-100 ms on local bundle).
void ensureLanguage(resolveLanguage(getInitialLanguagePreference()));

export function translateLanguage(
  language: AppLanguage,
  key: TranslationKey,
  params?: Record<string, string | number>,
) {
  const template = translations[language]?.[key] ?? en[key] ?? key;

  if (!params) return template;

  return template.replace(/\{\{(\w+)\}\}/g, (_, token: string) =>
    token in params ? String(params[token]) : "",
  );
}

export function translateCurrent(key: TranslationKey, params?: Record<string, string | number>) {
  return translateLanguage(getCurrentAppLanguage(), key, params);
}

export function formatCountLabel(
  language: AppLanguage,
  count: number,
  labels: { one: string; other: string; vi: string; zh?: string; tr?: string; ko?: string },
) {
  if (language === "vi") {
    return `${count} ${labels.vi}`;
  }

  if (language === "zh") {
    return `${count} ${labels.zh ?? labels.other}`;
  }

  if (language === "tr") {
    return `${count} ${labels.tr ?? (count === 1 ? labels.one : labels.other)}`;
  }

  if (language === "ko") {
    return `${count} ${labels.ko ?? labels.other}`;
  }

  return `${count} ${count === 1 ? labels.one : labels.other}`;
}

export function useI18n() {
  const languagePreference = useLanguageStore((state) => state.languagePreference);
  const setLanguage = useLanguageStore((state) => state.setLanguage);
  // Subscribing to languageVersion re-renders once the lazy locale arrives.
  useLanguageStore((state) => state.languageVersion);
  const language = resolveLanguage(languagePreference);
  useEffect(() => {
    void ensureLanguage(language);
  }, [language]);
  const t = useCallback(
    (key: TranslationKey, params?: Record<string, string | number>) =>
      translateLanguage(language, key, params),
    [language],
  );

  return {
    language,
    languagePreference,
    setLanguage,
    t,
  };
}
