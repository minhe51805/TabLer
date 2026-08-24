"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { setLanguagePreference } from "./actions";
import { SITE_LANGUAGES, type SiteLanguage } from "@/lib/i18n";

export function LanguageToggle({ current }: { current: SiteLanguage }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const setLanguage = (lang: SiteLanguage) => {
    startTransition(async () => {
      await setLanguagePreference(lang);
      router.refresh();
    });
  };

  return (
    <div className="lang-toggle" role="group" aria-label="Language">
      {SITE_LANGUAGES.map((lang) => (
        <button
          aria-pressed={lang === current}
          className={`lang-option${lang === current ? " is-active" : ""}`}
          disabled={isPending}
          key={lang}
          onClick={() => setLanguage(lang)}
          type="button"
        >
          {lang.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
