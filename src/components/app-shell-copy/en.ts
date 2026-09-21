import type { AppShellCopy } from "./types";

export const EN_COPY: AppShellCopy = {
  updates: {
    check: "Check for updates",
    checking: "Checking…",
    upToDate: "TableR is up to date.",
    available: "Version {version} is available.",
    releaseNotes: "Release notes",
    install: "Download & install",
    downloading: "Downloading update… {progress}%",
    installing: "Installing — TableR will relaunch…",
    retry: "Try again",
    checkFailed: "Update check failed",
  },
  storageRecovery: {
    kicker: "Startup Recovery",
    title: "Workspace data appears corrupted",
    description:
      "TableR could not read some of its saved workspace files. You can quarantine the corrupted files and start fresh — the originals are kept as .corrupt backups — or quit and investigate the files yourself.",
    affectedFiles: "Affected files",
    reset: "Reset & continue",
    resetting: "Resetting…",
    quit: "Quit",
    resetFailed: "Reset failed",
  },
};
