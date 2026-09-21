import type { BundleCopy } from "./types";

export const EN_BUNDLE_COPY: BundleCopy = {
  modes: {
    connections: "Connections only",
    bundle: "Full workspace bundle",
  },
  export: {
    title: "Export Workspace Bundle",
    subtitle: "Share your whole workspace setup as a single file",
    info: "The bundle is a plain JSON file for team sharing. Passwords, SSH keys, and AI API keys stay in this machine's secure storage — only a flag is exported so teammates know which credentials to re-enter.",
    includes: "Includes:",
    connections: "Saved connections (without passwords)",
    favorites: "SQL favorites",
    schedules: "Saved schedules",
    aiProviders: "AI provider settings (without API keys)",
    uiPrefs: "UI preferences (theme, layouts, shortcuts)",
    button: "Export Bundle",
    working: "Exporting...",
    done: "Workspace bundle exported to",
  },
  import: {
    dropzoneHint: "TableR Export (*.tabler-connections, *.tabler-bundle)",
    title: "Import Workspace Bundle",
    subtitle: "Review the bundle contents and choose what to bring in",
    sections: {
      connections: "Connections",
      sqlFavorites: "SQL Favorites",
      schedules: "Schedules",
      aiProviders: "AI Providers",
      uiPrefs: "UI Preferences",
    },
    exists: "already exists",
    needsPassword: "re-enter password",
    uiPrefsMeta: "{total} keys · {existing} already present",
    uiPrefsWritten: "UI preference keys",
    uiPrefsRestart: "restart the app to apply them",
    button: "Import Selected",
    working: "Importing...",
    done: "Imported",
    empty: "This bundle contains no items.",
  },
};
