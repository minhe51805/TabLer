import type { Metadata } from "next";
import { getSiteLanguage } from "@/lib/language";
import { docsSlugs, getDocPage, getDocs } from "@/lib/docs";
import { DocView } from "../DocView";

type PageParams = { params: Promise<{ slug: string }> };

export function generateStaticParams() {
  return docsSlugs
    .filter((slug) => slug !== "")
    .map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: PageParams): Promise<Metadata> {
  const { slug } = await params;
  const language = await getSiteLanguage();
  const docs = getDocs(language);
  const page = getDocPage(language, slug);

  if (!page) {
    return { title: `TableR ${docs.label}` };
  }

  return {
    title: `${page.title} — TableR ${docs.label}`,
    description: page.description,
  };
}

export default async function DocsSlugPage({ params }: PageParams) {
  const { slug } = await params;
  const language = await getSiteLanguage();
  return <DocView language={language} slug={slug} />;
}
