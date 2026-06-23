import type {
  DownloadAsset,
  DownloadRelease,
  PlatformDownload,
  PlatformId,
} from "./release-types";

type GitHubAsset = {
  id: number;
  name: string;
  size: number;
};

type GitHubRelease = {
  id: number;
  tag_name: string;
  name: string | null;
  published_at: string | null;
  draft: boolean;
  prerelease: boolean;
  html_url: string;
  assets: GitHubAsset[];
};

const releasesApi =
  "https://api.github.com/repos/minhe51805/TableR/releases?per_page=20";

function platformFor(filename: string): PlatformId | null {
  const value = filename.toLowerCase();

  if (value.endsWith(".exe") || value.endsWith(".msi")) return "windows";
  if (value.endsWith(".dmg") || value.endsWith(".app.tar.gz")) return "macos";
  if (
    value.endsWith(".appimage") ||
    value.endsWith(".deb") ||
    value.endsWith(".rpm")
  ) {
    return "linux";
  }

  return null;
}

function architectureLabel(filename: string) {
  const value = filename.toLowerCase();

  if (value.includes("aarch64") || value.includes("arm64")) {
    return "Apple Silicon";
  }
  if (
    value.includes("x86_64") ||
    value.includes("x64") ||
    value.includes("amd64")
  ) {
    return "x64";
  }
  return "Universal";
}

function describeAsset(filename: string) {
  const value = filename.toLowerCase();
  const architecture = architectureLabel(filename);

  if (value.endsWith("-setup.exe")) {
    return {
      name: "Windows installer",
      detail: `Setup EXE - ${architecture}`,
      recommended: true,
      order: 0,
    };
  }
  if (value.endsWith(".msi")) {
    return {
      name: "MSI package",
      detail: `Managed installation - ${architecture}`,
      recommended: false,
      order: 1,
    };
  }
  if (value.endsWith(".dmg")) {
    return {
      name: architecture === "Apple Silicon" ? "Apple Silicon" : "macOS",
      detail: `DMG installer - ${architecture}`,
      recommended: true,
      order: 0,
    };
  }
  if (value.endsWith(".app.tar.gz")) {
    return {
      name: "Application archive",
      detail: `Compressed .app bundle - ${architecture}`,
      recommended: false,
      order: 1,
    };
  }
  if (value.endsWith(".appimage")) {
    return {
      name: "AppImage",
      detail: `Portable package - ${architecture}`,
      recommended: true,
      order: 0,
    };
  }
  if (value.endsWith(".deb")) {
    return {
      name: "Debian package",
      detail: `Ubuntu, Debian and derivatives - ${architecture}`,
      recommended: false,
      order: 1,
    };
  }

  return {
    name: "RPM package",
    detail: `Fedora, RHEL and derivatives - ${architecture}`,
    recommended: false,
    order: 2,
  };
}

function platformDetails(id: PlatformId) {
  if (id === "windows") {
    return { name: "Windows", support: "Windows 10 and later" };
  }
  if (id === "macos") {
    return { name: "macOS", support: "Available Mac architectures" };
  }
  return { name: "Linux", support: "64-bit distributions" };
}

function mapRelease(release: GitHubRelease): DownloadRelease | null {
  const grouped = new Map<
    PlatformId,
    Array<DownloadAsset & { order: number }>
  >();

  for (const asset of release.assets) {
    const platform = platformFor(asset.name);
    if (!platform) continue;

    const description = describeAsset(asset.name);
    const option = {
      id: asset.id,
      filename: asset.name,
      name: description.name,
      detail: description.detail,
      size: asset.size,
      url: `/download/files/${encodeURIComponent(release.tag_name)}/${encodeURIComponent(asset.name)}`,
      recommended: description.recommended,
      order: description.order,
    };

    grouped.set(platform, [...(grouped.get(platform) ?? []), option]);
  }

  const platformOrder: PlatformId[] = ["windows", "macos", "linux"];
  const platforms: PlatformDownload[] = platformOrder.flatMap((id) => {
    const options = grouped.get(id);
    if (!options?.length) return [];

    const details = platformDetails(id);
    return [
      {
        id,
        ...details,
        options: options
          .sort((a, b) => a.order - b.order || a.filename.localeCompare(b.filename))
          .map((option) => ({
            id: option.id,
            filename: option.filename,
            name: option.name,
            detail: option.detail,
            size: option.size,
            url: option.url,
            recommended: option.recommended,
          })),
      },
    ];
  });

  if (!platforms.length || !release.published_at) return null;

  return {
    id: release.id,
    tag: release.tag_name,
    name: release.name || `TableR ${release.tag_name}`,
    publishedAt: release.published_at,
    prerelease: release.prerelease,
    htmlUrl: release.html_url,
    platforms,
  };
}

export async function getTableRReleases(): Promise<DownloadRelease[]> {
  const headers: HeadersInit = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "TableR-website",
  };

  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  try {
    const response = await fetch(releasesApi, {
      headers,
      next: {
        revalidate: 300,
        tags: ["tabler-github-releases"],
      },
    });

    if (!response.ok) {
      throw new Error(`GitHub releases request failed: ${response.status}`);
    }

    const releases = (await response.json()) as GitHubRelease[];
    return releases
      .filter((release) => !release.draft)
      .map(mapRelease)
      .filter((release): release is DownloadRelease => release !== null);
  } catch (error) {
    console.error("Unable to load TableR releases.", error);
    return [];
  }
}
