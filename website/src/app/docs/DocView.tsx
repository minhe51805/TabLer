import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { docHref, getDocHeadings, getDocs } from "@/lib/docs";
import type { SiteLanguage } from "@/lib/i18n";
import { DocArticle } from "./DocArticle";
import { DocToc } from "./DocToc";

export function DocView({
  language,
  slug,
}: {
  language: SiteLanguage;
  slug: string;
}) {
  const docs = getDocs(language);
  const index = docs.pages.findIndex((page) => page.slug === slug);

  if (index === -1) {
    notFound();
  }

  const page = docs.pages[index];
  const previous = index > 0 ? docs.pages[index - 1] : null;
  const next = index < docs.pages.length - 1 ? docs.pages[index + 1] : null;

  const { headings, idByIndex } = getDocHeadings(page);
  const hasToc = headings.length > 0;

  return (
    <div
      className={`docs-content-layout${
        hasToc ? "" : " docs-content-layout--full"
      }`}
    >
      <article className="docs-article-shell">
        <header className="docs-article-head">
          <p className="eyebrow">{docs.label}</p>
          <h1>{page.title}</h1>
          <p className="docs-article-lede">{page.description}</p>
        </header>

        <DocArticle blocks={page.blocks} headingIds={idByIndex} />

        <nav className="doc-pager" aria-label={docs.label}>
          {previous ? (
            <Link className="doc-pager-link" href={docHref(previous.slug)}>
              <ArrowLeft size={16} aria-hidden="true" />
              <span>
                <em>{docs.previous}</em>
                {previous.title}
              </span>
            </Link>
          ) : (
            <span />
          )}
          {next ? (
            <Link
              className="doc-pager-link doc-pager-next"
              href={docHref(next.slug)}
            >
              <span>
                <em>{docs.next}</em>
                {next.title}
              </span>
              <ArrowRight size={16} aria-hidden="true" />
            </Link>
          ) : (
            <span />
          )}
        </nav>
      </article>

      {hasToc ? <DocToc headings={headings} label={docs.onThisSection} /> : null}
    </div>
  );
}
