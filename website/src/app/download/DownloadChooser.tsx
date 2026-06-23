"use client";

import {
  Check,
  ChevronDown,
  Download,
  FileArchive,
  Laptop,
  Monitor,
  Package,
  Terminal,
} from "lucide-react";
import { useSyncExternalStore } from "react";
import type {
  DownloadAsset,
  DownloadRelease,
  PlatformDownload,
  PlatformId,
} from "@/lib/release-types";

type Platform = PlatformId | "unknown";

const platformIcons = {
  windows: Monitor,
  macos: Laptop,
  linux: Terminal,
};

function detectPlatform(): Platform {
  const navigatorWithUserAgentData = navigator as Navigator & {
    userAgentData?: { platform?: string };
  };
  const platform =
    navigatorWithUserAgentData.userAgentData?.platform ??
    navigator.platform ??
    navigator.userAgent;
  const value = platform.toLowerCase();

  if (value.includes("win")) return "windows";
  if (value.includes("mac")) return "macos";
  if (value.includes("linux")) return "linux";
  return "unknown";
}

function subscribeToPlatform() {
  return () => {};
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(value));
}

function optionIcon(option: DownloadAsset, index: number) {
  if (index === 0) return Download;
  if (option.filename.toLowerCase().endsWith(".tar.gz")) return FileArchive;
  return Package;
}

function PlatformSection({
  item,
  detected,
}: {
  item: PlatformDownload;
  detected: boolean;
}) {
  const PlatformIcon = platformIcons[item.id];

  return (
    <section
      className={`download-platform${detected ? " is-detected" : ""}`}
    >
      <div className="download-platform-heading">
        <span className="download-platform-icon">
          <PlatformIcon size={21} aria-hidden="true" />
        </span>
        <div>
          <div className="download-platform-title">
            <h3>{item.name}</h3>
            {detected ? (
              <span className="detected-label">
                <Check size={13} aria-hidden="true" />
                Your device
              </span>
            ) : null}
          </div>
          <p>{item.support}</p>
        </div>
      </div>

      <div className="download-option-list">
        {item.options.map((option, index) => {
          const OptionIcon = optionIcon(option, index);

          return (
            <a
              className={`download-option${option.recommended ? " is-recommended" : ""}`}
              href={option.url}
              key={option.id}
            >
              <span className="download-option-icon">
                <OptionIcon size={19} aria-hidden="true" />
              </span>
              <span className="download-option-copy">
                <strong>{option.name}</strong>
                <small>{option.detail}</small>
              </span>
              <span className="download-option-meta">
                {option.recommended ? <em>Recommended</em> : null}
                <small>{formatBytes(option.size)}</small>
              </span>
              <Download
                className="download-option-action"
                size={18}
                aria-hidden="true"
              />
            </a>
          );
        })}
      </div>
    </section>
  );
}

export default function DownloadChooser({
  releases,
}: {
  releases: DownloadRelease[];
}) {
  const platform = useSyncExternalStore(
    subscribeToPlatform,
    detectPlatform,
    () => "unknown",
  );

  if (!releases.length) {
    return (
      <div className="release-empty">
        Release information is temporarily unavailable. Please try again in a
        few minutes.
      </div>
    );
  }

  return (
    <div className="release-stack">
      {releases.map((release, releaseIndex) => {
        const orderedPlatforms =
          platform === "unknown"
            ? release.platforms
            : [
                ...release.platforms.filter((item) => item.id === platform),
                ...release.platforms.filter((item) => item.id !== platform),
              ];

        return (
          <details
            className={`release-section${releaseIndex === 0 ? " is-latest" : ""}`}
            key={release.id}
            open={releaseIndex === 0}
          >
            <summary className="release-summary">
              <span className="release-summary-copy">
                <span className="release-version">
                  {release.tag}
                  {releaseIndex === 0 ? (
                    <em>Latest</em>
                  ) : release.prerelease ? (
                    <em>Pre-release</em>
                  ) : null}
                </span>
                <span>
                  {release.name} - {formatDate(release.publishedAt)}
                </span>
              </span>
              <span className="release-summary-action">
                {release.platforms.reduce(
                  (count, item) => count + item.options.length,
                  0,
                )}{" "}
                files
                <ChevronDown size={18} aria-hidden="true" />
              </span>
            </summary>

            <div className="release-content">
              <div className="download-platforms">
                {orderedPlatforms.map((item) => (
                  <PlatformSection
                    detected={item.id === platform}
                    item={item}
                    key={item.id}
                  />
                ))}
              </div>
              <a
                className="release-notes-link"
                href={release.htmlUrl}
                target="_blank"
                rel="noreferrer"
              >
                View release notes for {release.tag}
              </a>
            </div>
          </details>
        );
      })}
    </div>
  );
}
