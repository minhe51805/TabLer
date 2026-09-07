"use server";

import { cookies } from "next/headers";
import { LANGUAGE_COOKIE, resolveSiteLanguage } from "@/lib/i18n";

export async function setLanguagePreference(input: unknown) {
  const lang = resolveSiteLanguage(typeof input === "string" ? input : undefined);
  const store = await cookies();
  store.set(LANGUAGE_COOKIE, lang, {
    path: "/",
    maxAge: 31536000,
    sameSite: "lax",
  });
}
