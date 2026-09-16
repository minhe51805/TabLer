import type { Metadata } from "next";
import { getSiteLanguage } from "@/lib/language";
import { getDocPage, getDocs } from "@/lib/docs";
import { DocView } from "./DocView";

export async function generateMetadata(): Promise<Metadata> {
  const language = await getSiteLanguage();
  const docs = getDocs(language);
  const page = getDocPage(language, "");

  return {
    title: `${page?.title ?? docs.label} — TableR ${docs.label}`,
    description: page?.description ?? docs.tagline,
  };
}

export default async function DocsHomePage() {
  const language = await getSiteLanguage();
  return <DocView language={language} slug="" />;
}
