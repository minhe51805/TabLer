export interface BundleCopy {
  /** Shared buttons used by both modals. */
  common: {
    done: string;
    cancel: string;
  };
  /** Mode switch labels in the exporter modal. */
  modes: {
    connections: string;
    bundle: string;
  };
  /** Connections-only mode: encrypted .tabler-connections export. */
  connectionsExport: {
    title: string;
    subtitle: string;
    /** Rail header; counts are substituted in. */
    selectLabel: (selected: number, total: number) => string;
    selectAll: string;
    deselectAll: string;
    empty: string;
    /** Explains AES-256-GCM and that secrets are never exported. */
    encryptionNote: string;
    passwordLabel: string;
    passwordPlaceholder: string;
    confirmLabel: string;
    confirmPlaceholder: string;
    errorPasswordShort: string;
    errorPasswordMismatch: string;
    errorNoSelection: string;
    /** Primary button; {count} connections selected. */
    button: (count: number) => string;
    working: string;
    /** Success message; {path} is the written file. */
    done: (count: number, path: string) => string;
  };
  export: {
    title: string;
    subtitle: string;
    /** Explains what the bundle contains and that secrets stay local. */
    info: string;
    includes: string;
    connections: string;
    favorites: string;
    schedules: string;
    aiProviders: string;
    uiPrefs: string;
    button: string;
    working: string;
    done: string;
  };
  import: {
    title: string;
    subtitle: string;
    /** Dropzone hint when any supported file type is accepted. */
    dropzoneHint: string;
    sections: {
      connections: string;
      sqlFavorites: string;
      schedules: string;
      aiProviders: string;
      uiPrefs: string;
    };
    /** Badge on items already present locally (import would be a no-op). */
    exists: string;
    /** Badge on items whose secret was stripped and must be re-entered. */
    needsPassword: string;
    /** uiPrefs row meta; {total} and {existing} are replaced with counts. */
    uiPrefsMeta: string;
    /** Connections-only import flow (encrypted .tabler-connections file). */
    connectionsTitle: string;
    connectionsSubtitle: string;
    sourceFile: string;
    /** Dropzone title when no file was picked yet. */
    dropzonePick: string;
    /** External-file button while the preview is being read. */
    externalWorking: string;
    decryptLabel: string;
    decryptPlaceholder: string;
    decryptButton: string;
    decryptWorking: string;
    /** Primary button; {count} connections selected. */
    importButton: (count: number) => string;
    importWorking: string;
    /** Success message; {count} connections imported. */
    importedMessage: (count: number) => string;
    /** Note above the per-connection password list (TableR exports). */
    passwordNote: string;
    passwordPlaceholder: string;
    errorIncorrectPassword: string;
    errorOpenDialog: (detail: string) => string;
    errorImportFailed: (detail: string) => string;
    /** Done-message label for written localStorage keys. */
    uiPrefsWritten: string;
    /** Note appended when prefs were written (stores hydrate on startup). */
    uiPrefsRestart: string;
    button: string;
    working: string;
    done: string;
    empty: string;
    /** External-tool import (DBeaver / DataGrip). */
    external: {
      /** Button that opens the .json/.xml picker. */
      button: string;
      /** Preview banner: source tools never export passwords. */
      passwordNote: string;
      /** Summary line for entries that could not be mapped; {count} is replaced. */
      skipped: string;
    };
  };
}
