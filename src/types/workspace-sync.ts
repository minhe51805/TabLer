export type WorkspaceSyncProvider =
  | { kind: "local-folder"; directory: string }
  | {
      kind: "web-dav";
      endpoint: string;
      username?: string;
      password?: string;
    };

export interface WorkspaceSyncVersion {
  revision: string;
  parentRevision?: string | null;
  updatedAt: string;
  deviceId: string;
  byteLength: number;
}

export type WorkspaceSyncPushResult =
  | { status: "pushed"; version: WorkspaceSyncVersion }
  | {
      status: "conflict";
      expectedRevision?: string | null;
      remoteVersion: WorkspaceSyncVersion;
    };

export interface WorkspaceSyncPullResult {
  bundle: string;
  version: WorkspaceSyncVersion;
  history: WorkspaceSyncVersion[];
}
