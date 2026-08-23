import { cookies } from "next/headers";
import { LANGUAGE_COOKIE, resolveSiteLanguage, type SiteLanguage } from "./i18n";

/** Reads the visitor's language preference from the language cookie. */
export async function getSiteLanguage(): Promise<SiteLanguage> {
  const store = await cookies();
  return resolveSiteLanguage(store.get(LANGUAGE_COOKIE)?.value);
}
