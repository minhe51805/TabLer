import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getTableRReleases } from "@/lib/github-releases";
import { getSiteLanguage } from "@/lib/language";
import { getDictionary } from "@/lib/i18n";
import { LanguageToggle } from "../LanguageToggle";
import { ReleaseNotes } from "./ReleaseNotes";

export const metadata: Metadata = {
  title: "TableR Changelog",
  description:
    "Every shipped TableR release with release notes, newest first.",
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
    <main className="download-page" id="main">
      <header className="site-header">
        <div className="shell header-inner">
          <Link className="brand" href="/" aria-label="TableR home">
            <Image
              src="/tabler-brand-mark.png"
              width={36}
              height={36}
              alt=""
              priority
            />
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
          </div>
        </section>

        {releases.length === 0 ? (
          <div className="release-empty">{t.changelog.empty}</div>
        ) : (
          <div className="release-stack">
            {releases.map((release, index) => (
              <article
                className={`changelog-entry${index === 0 ? " is-latest" : ""}`}
                key={release.id}
              >
                <div className="changelog-entry-head">
                  <span className="release-version">
                    {release.tag}
                    {index === 0 ? <em>{t.download.latest}</em> : release.prerelease ? <em>{t.download.preRelease}</em> : null}
                  </span>
                  <span className="changelog-date">
                    {formatDate(release.publishedAt)}
                  </span>
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
        )}
      </div>
    </main>
  );
}
