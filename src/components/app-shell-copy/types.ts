export interface AppShellCopy {
  /** Manual "Check for updates" control in the About dialog. */
  updates: {
    check: string;
    checking: string;
    upToDate: string;
    available: string;
    releaseNotes: string;
    install: string;
    downloading: string;
    installing: string;
    retry: string;
    checkFailed: string;
  };
  /** Startup dialog shown when persisted workspace files fail to parse. */
  storageRecovery: {
    kicker: string;
    title: string;
    description: string;
    affectedFiles: string;
    reset: string;
    resetting: string;
    quit: string;
    resetFailed: string;
  };
}
