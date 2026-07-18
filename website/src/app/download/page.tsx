import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { ArrowLeft, RefreshCw, ShieldCheck } from "lucide-react";
import DownloadChooser from "./DownloadChooser";
import { getTableRReleases } from "@/lib/github-releases";

export const metadata: Metadata = {
  title: "Download TableR",
  description:
    "Download current and previous TableR releases for Windows, macOS, and Linux.",
};

export const revalidate = 300;

export default async function DownloadPage() {
  const releases = await getTableRReleases();
  const latestRelease = releases[0];

  return (
    <main className="download-page">
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

          <Link className="button button-small button-secondary" href="/">
            <ArrowLeft size={16} aria-hidden="true" />
            Back to home
          </Link>
        </div>
      </header>

      <div className="shell download-shell">
        <section className="download-intro">
          <div>
            <p className="eyebrow">
              {latestRelease
                ? `LATEST RELEASE ${latestRelease.tag}`
                : "TABLE R RELEASES"}
            </p>
            <h1>Download TableR</h1>
            <p>
              Choose a current or previous release. Each option starts the
              installer download directly.
            </p>
          </div>
          <div className="download-trust">
            <ShieldCheck size={20} aria-hidden="true" />
            <div>
              <strong>Official release files</strong>
              <span>
                {releases.length
                  ? `${releases.length} versions available`
                  : "GitHub Releases"}
              </span>
            </div>
          </div>
        </section>

        <div className="release-sync-note">
          <RefreshCw size={15} aria-hidden="true" />
          Synced automatically from GitHub Releases every 5 minutes.
        </div>

        <DownloadChooser releases={releases} />

        <aside className="download-help">
          <strong>Not sure which file to choose?</strong>
          <span>
            Open the latest release and use the option marked Recommended for
            your operating system.
          </span>
        </aside>

        <aside className="download-help">
          <strong>Installing the unsigned macOS build</strong>
          <span>
            Move TableR to Applications, try to open it once, then choose Open
            Anyway in System Settings &gt; Privacy &amp; Security. If Gatekeeper still
            blocks it, run <code>xattr -dr com.apple.quarantine /Applications/TableR.app</code>
            and open it again. This override does not mean the app is Apple-notarized.
          </span>
        </aside>
      </div>

      <footer className="download-footer">
        <div className="shell">
          <span>TableR is open source and licensed under GPL-3.0.</span>
          <a
            href="https://github.com/minhe51805/TabLer/releases"
            target="_blank"
            rel="noreferrer"
          >
            All releases on GitHub
          </a>
        </div>
      </footer>
    </main>
  );
}
