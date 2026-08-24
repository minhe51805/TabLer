import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { ArrowLeft, RefreshCw, ShieldCheck } from "lucide-react";
import DownloadChooser from "./DownloadChooser";
import { getTableRReleases } from "@/lib/github-releases";
import { getSiteLanguage } from "@/lib/language";
import { getDictionary } from "@/lib/i18n";
import { repositoryName, repositoryOwner } from "@/lib/site";
import { LanguageToggle } from "../LanguageToggle";

export const metadata: Metadata = {
  title: "Download TableR",
  description:
    "Download current and previous TableR releases for Windows, macOS, and Linux.",
};

export const revalidate = 0;

const macosQuarantineCommand =
  "xattr -dr com.apple.quarantine /Applications/TableR.app";

export default async function DownloadPage() {
  const language = await getSiteLanguage();
  const t = getDictionary(language);
  const releases = await getTableRReleases();
  const latestRelease = releases[0];

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
              {t.download.back}
            </Link>
          </div>
        </div>
      </header>

      <div className="shell download-shell">
        <section className="download-intro">
          <div>
            <p className="eyebrow">
              {latestRelease
                ? `${t.download.latestPrefix} ${latestRelease.tag}`
                : t.download.fallbackPrefix}
            </p>
            <h1>{t.download.heading}</h1>
            <p>{t.download.chooseIntro}</p>
          </div>
          <div className="download-trust">
            <ShieldCheck size={20} aria-hidden="true" />
            <div>
              <strong>{t.download.trustTitle}</strong>
              <span>
                {releases.length
                  ? t.download.versionsAvailable(releases.length)
                  : t.download.versionsFallback}
              </span>
            </div>
          </div>
        </section>

        <div className="release-sync-note">
          <RefreshCw size={15} aria-hidden="true" />
          {t.download.syncNote}
        </div>

        <DownloadChooser lang={language} releases={releases} />

        <aside className="download-help">
          <strong>{t.download.helpChooseTitle}</strong>
          <span>{t.download.helpChooseCopy}</span>
        </aside>

        <aside className="download-help">
          <strong>{t.download.helpMacosTitle}</strong>
          <span>
            {t.download.helpMacosCopyBefore}{" "}
            <code>{macosQuarantineCommand}</code>{" "}
            {t.download.helpMacosCopyAfter}
          </span>
        </aside>
      </div>

      <footer className="download-footer">
        <div className="shell">
          <span>{t.download.footerLicense}</span>
          <a
            href={`https://github.com/${repositoryOwner}/${repositoryName}/releases`}
            target="_blank"
            rel="noreferrer"
          >
            {t.download.allReleases}
          </a>
        </div>
      </footer>
    </main>
  );
}
