export interface BundleCopy {
  /** Mode switch labels in the exporter modal. */
  modes: {
    connections: string;
    bundle: string;
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
    /** Done-message label for written localStorage keys. */
    uiPrefsWritten: string;
    /** Note appended when prefs were written (stores hydrate on startup). */
    uiPrefsRestart: string;
    button: string;
    working: string;
    done: string;
    empty: string;
  };
}
