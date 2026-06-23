export type PlatformId = "windows" | "macos" | "linux";

export type DownloadAsset = {
  id: number;
  filename: string;
  name: string;
  detail: string;
  size: number;
  url: string;
  recommended: boolean;
};

export type PlatformDownload = {
  id: PlatformId;
  name: string;
  support: string;
  options: DownloadAsset[];
};

export type DownloadRelease = {
  id: number;
  tag: string;
  name: string;
  publishedAt: string;
  prerelease: boolean;
  htmlUrl: string;
  platforms: PlatformDownload[];
};
