import { useCallback } from "react";
import { create } from "zustand";

import { en } from "./en";
import { vi } from "./vi";
import { zh } from "./zh";
import { tr } from "./tr";
import { ko } from "./ko";

// Re-export language objects
export { en, vi, zh, tr, ko };

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
  if (stored === "auto" || stored === "en" || stored === "vi" || stored === "zh" || stored === "tr" || stored === "ko") {
    return stored;
  }

  return "auto";
}

type LanguageState = {
  languagePreference: AppLanguagePreference;
  setLanguage: (language: AppLanguagePreference) => void;
};

export const useLanguageStore = create<LanguageState>((set) => ({
  languagePreference: getInitialLanguagePreference(),
  setLanguage: (languagePreference) => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(LANGUAGE_STORAGE_KEY, languagePreference);
    }
    set({ languagePreference });
  },
}));

const translations: Record<AppLanguage, Partial<Record<keyof typeof en, string>>> = { en, vi, zh, tr, ko };

export function translateLanguage(
  language: AppLanguage,
  key: TranslationKey,
  params?: Record<string, string | number>,
) {
  const template = translations[language][key] ?? translations.en[key] ?? key;

  if (!params) return template;

  return template.replace(/\{\{(\w+)\}\}/g, (_, token: string) =>
    token in params ? String(params[token]) : "",
  );
}

export function translateCurrent(
  key: TranslationKey,
  params?: Record<string, string | number>,
) {
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
    return `${count} ${count === 1 ? labels.one : labels.other}`;
  }

  if (language === "ko") {
    return `${count} ${labels.ko ?? labels.other}`;
  }

  return `${count} ${count === 1 ? labels.one : labels.other}`;
}

export function useI18n() {
  const languagePreference = useLanguageStore((state) => state.languagePreference);
  const setLanguage = useLanguageStore((state) => state.setLanguage);
  const language = resolveLanguage(languagePreference);
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