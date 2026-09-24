import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { ArrowLeft, Rss } from "lucide-react";
import { getTableRReleases } from "@/lib/github-releases";
import { getSiteLanguage } from "@/lib/language";
import { getDictionary } from "@/lib/i18n";
import { LanguageToggle } from "../LanguageToggle";
import { SiteFooter } from "../SiteFooter";
import { ReleaseNotes } from "./ReleaseNotes";
import { ScrollProgress, ScrollReveal, CursorGlow } from "../Home3D";

export const metadata: Metadata = {
  title: "TableR Changelog",
  description: "Every shipped TableR release with release notes, newest first.",
  alternates: {
    types: { "application/rss+xml": "/changelog/feed.xml" },
  },
};

export const revalidate = 300;

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(value));
}

export default async function ChangelogPage() {
  const language = await getSiteLanguage();
  const t = getDictionary(language);
  const releases = await getTableRReleases();

  return (
    <main className="neu download-page" id="main">
      <div className="scroll-progress" aria-hidden="true" />
      <ScrollProgress />
      <ScrollReveal />
      <CursorGlow />
      <header className="site-header">
        <div className="shell header-inner">
          <Link className="brand" href="/" aria-label="TableR home">
            <Image src="/tabler-brand-mark.png" width={36} height={36} alt="" priority />
            <span>TableR</span>
          </Link>
          <div className="header-actions">
            <LanguageToggle current={language} />
            <Link className="button button-small button-secondary" href="/">
              <ArrowLeft size={16} aria-hidden="true" />
              {t.changelog.back}
            </Link>
          </div>
        </div>
      </header>

      <div className="shell download-shell">
        <section className="download-intro">
          <div>
            <p className="eyebrow">{t.changelog.eyebrow}</p>
            <h1>{t.changelog.heading}</h1>
            <p>{t.changelog.intro}</p>
            <a className="changelog-rss" href="/changelog/feed.xml" title="RSS feed">
              <Rss size={14} aria-hidden="true" />
              RSS
            </a>
          </div>
        </section>

        {releases.length === 0 ? (
          <div className="release-empty">{t.changelog.empty}</div>
        ) : (
          <div className="changelog-layout">
            <nav className="changelog-nav" aria-label="Versions">
              {releases.map((release, index) => (
                <a
                  key={release.id}
                  href={`#${release.tag}`}
                  className={index === 0 ? "is-latest" : undefined}
                >
                  {release.tag}
                </a>
              ))}
            </nav>
            <div className="release-stack">
              {releases.map((release, index) => (
                <article
                  id={release.tag}
                  className={`changelog-entry${index === 0 ? " is-latest" : ""}`}
                  key={release.id}
                >
                  <div className="changelog-entry-head">
                    <span className="release-version">
                      {release.tag}
                      {index === 0 ? (
                        <em>{t.download.latest}</em>
                      ) : release.prerelease ? (
                        <em>{t.download.preRelease}</em>
                      ) : null}
                    </span>
                    <span className="changelog-date">{formatDate(release.publishedAt)}</span>
                  </div>
                  {release.body ? <ReleaseNotes body={release.body} /> : null}
                  <a
                    className="release-notes-link"
                    href={release.htmlUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t.download.viewNotes} {release.tag}
                  </a>
                </article>
              ))}
            </div>
          </div>
        )}
      </div>

      <SiteFooter t={t} />
    </main>
  );
}
