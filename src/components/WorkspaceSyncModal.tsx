import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle,
  Check,
  CloudDownload,
  CloudUpload,
  FolderOpen,
  History,
  LoaderCircle,
  RotateCcw,
  ShieldCheck,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type {
  WorkspaceSyncProvider,
  WorkspaceSyncPullResult,
  WorkspaceSyncPushResult,
  WorkspaceSyncVersion,
} from "../types/workspace-sync";
import {
  planWorkspaceMerge,
  resolveWorkspaceConflicts,
  type WorkspaceConflictChoice,
  type WorkspaceMergePlan,
} from "../utils/workspace-conflicts";
import {
  parseWorkspaceBundle,
  type WorkspaceBundle,
} from "../utils/workspace-bundle";
import { emitAppToast } from "../utils/app-toast";

interface WorkspaceSyncModalProps {
  connectionName: string;
  defaultWorkspaceId: string;
  buildBundle: () => WorkspaceBundle | null;
  applyBundle: (bundle: WorkspaceBundle, mode: "replace") => Promise<void>;
  onClose: () => void;
}

interface PendingConflict {
  plan: WorkspaceMergePlan;
  remoteRevision: string;
}

function safeWorkspaceId(value: string) {
  return (
    value
      .trim()
      .replace(/[^a-zA-Z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120) || "workspace"
  );
}

function getDeviceId() {
  const key = "tabler.workspace-sync.device-id.v1";
  const existing = localStorage.getItem(key);
  if (existing) return existing;
  const created = `device-${crypto.randomUUID()}`;
  localStorage.setItem(key, created);
  return created;
}

function revisionStorageKey(workspaceId: string) {
  return `tabler.workspace-sync.revision.v1.${workspaceId}`;
}

function baseStorageKey(workspaceId: string) {
  return `tabler.workspace-sync.base.v1.${workspaceId}`;
}

function readBaseBundle(workspaceId: string): WorkspaceBundle | undefined {
  const raw = localStorage.getItem(baseStorageKey(workspaceId));
  if (!raw) return undefined;
  try {
    return parseWorkspaceBundle(raw);
  } catch {
    return undefined;
  }
}

function rememberSyncState(
  workspaceId: string,
  revision: string,
  base: WorkspaceBundle,
) {
  localStorage.setItem(revisionStorageKey(workspaceId), revision);
  localStorage.setItem(baseStorageKey(workspaceId), JSON.stringify(base));
}

export function WorkspaceSyncModal({
  connectionName,
  defaultWorkspaceId,
  buildBundle,
  applyBundle,
  onClose,
}: WorkspaceSyncModalProps) {
  const [providerKind, setProviderKind] = useState<"local-folder" | "web-dav">("local-folder");
  const [directory, setDirectory] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [username, setUsername] = useState("");
  const [webDavPassword, setWebDavPassword] = useState("");
  const [syncPassword, setSyncPassword] = useState("");
  const [workspaceId, setWorkspaceId] = useState(() => safeWorkspaceId(defaultWorkspaceId));
  const [busy, setBusy] = useState<"push" | "pull" | "restore" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<WorkspaceSyncVersion[]>([]);
  const [currentRevision, setCurrentRevision] = useState<string | null>(() =>
    localStorage.getItem(revisionStorageKey(safeWorkspaceId(defaultWorkspaceId))),
  );
  const [pendingConflict, setPendingConflict] = useState<PendingConflict | null>(null);
  const [choices, setChoices] = useState<Record<string, WorkspaceConflictChoice>>({});

  useEffect(() => {
    setCurrentRevision(localStorage.getItem(revisionStorageKey(workspaceId)));
    setHistory([]);
    setPendingConflict(null);
    setChoices({});
    setError(null);
  }, [workspaceId]);

  const provider = useMemo<WorkspaceSyncProvider | null>(() => {
    if (providerKind === "local-folder") {
      return directory.trim() ? { kind: "local-folder", directory: directory.trim() } : null;
    }
    return endpoint.trim()
      ? {
          kind: "web-dav",
          endpoint: endpoint.trim(),
          username: username.trim() || undefined,
          password: webDavPassword || undefined,
        }
      : null;
  }, [directory, endpoint, providerKind, username, webDavPassword]);

  const validateInputs = () => {
    if (!provider) throw new Error("Choose a sync provider destination.");
    if (syncPassword.length < 10) throw new Error("Sync password must contain at least 10 characters.");
    const normalizedId = safeWorkspaceId(workspaceId);
    if (normalizedId !== workspaceId) throw new Error("Workspace ID may contain only letters, numbers, '-' and '_'.");
    return provider;
  };

  const pullRemote = async (revision?: string) => {
    const selectedProvider = validateInputs();
    return invoke<WorkspaceSyncPullResult>("pull_workspace_sync", {
      provider: selectedProvider,
      workspaceId,
      password: syncPassword,
      revision,
    });
  };

  const pushBundle = async (bundle: WorkspaceBundle, expectedRevision: string | null) => {
    const selectedProvider = validateInputs();
    return invoke<WorkspaceSyncPushResult>("push_workspace_sync", {
      provider: selectedProvider,
      workspaceId,
      bundle: JSON.stringify(bundle),
      password: syncPassword,
      deviceId: getDeviceId(),
      expectedRevision,
    });
  };

  const acceptPushed = async (
    result: Extract<WorkspaceSyncPushResult, { status: "pushed" }>,
    bundle: WorkspaceBundle,
  ) => {
    rememberSyncState(workspaceId, result.version.revision, bundle);
    setCurrentRevision(result.version.revision);
    setPendingConflict(null);
    setChoices({});
    await applyBundle(bundle, "replace");
    emitAppToast({
      tone: "success",
      title: "Workspace synced",
      description: `Revision ${result.version.revision.slice(0, 10)}`,
    });
  };

  const prepareConflict = async (local: WorkspaceBundle) => {
    const remote = await pullRemote();
    const remoteBundle = parseWorkspaceBundle(remote.bundle);
    setHistory(remote.history);
    const plan = planWorkspaceMerge(local, remoteBundle, readBaseBundle(workspaceId));
    if (plan.conflicts.length === 0) {
      const pushed = await pushBundle(plan.merged, remote.version.revision);
      if (pushed.status !== "pushed") throw new Error("Remote workspace changed again; retry sync.");
      await acceptPushed(pushed, plan.merged);
      return;
    }
    setPendingConflict({ plan, remoteRevision: remote.version.revision });
    setChoices({});
  };

  const handlePush = async () => {
    const local = buildBundle();
    if (!local) return;
    setBusy("push");
    setError(null);
    try {
      const expected = localStorage.getItem(revisionStorageKey(workspaceId));
      const result = await pushBundle(local, expected);
      if (result.status === "conflict") {
        await prepareConflict(local);
      } else {
        await acceptPushed(result, local);
      }
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(null);
    }
  };

  const handlePull = async () => {
    const local = buildBundle();
    if (!local) return;
    setBusy("pull");
    setError(null);
    try {
      const remote = await pullRemote();
      const remoteBundle = parseWorkspaceBundle(remote.bundle);
      setHistory(remote.history);
      const plan = planWorkspaceMerge(local, remoteBundle, readBaseBundle(workspaceId));
      if (plan.conflicts.length > 0) {
        setPendingConflict({ plan, remoteRevision: remote.version.revision });
        setChoices({});
      } else {
        await applyBundle(plan.merged, "replace");
        rememberSyncState(workspaceId, remote.version.revision, remoteBundle);
        setCurrentRevision(remote.version.revision);
      }
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(null);
    }
  };

  const handleResolve = async () => {
    if (!pendingConflict) return;
    setBusy("push");
    setError(null);
    try {
      const resolved = resolveWorkspaceConflicts(pendingConflict.plan, choices);
      const result = await pushBundle(resolved, pendingConflict.remoteRevision);
      if (result.status !== "pushed") throw new Error("Remote workspace changed again; review the newest conflict.");
      await acceptPushed(result, resolved);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(null);
    }
  };

  const handleRestore = async (version: WorkspaceSyncVersion) => {
    if (!currentRevision || !window.confirm(`Restore revision ${version.revision.slice(0, 10)}?`)) return;
    setBusy("restore");
    setError(null);
    try {
      const historical = await pullRemote(version.revision);
      const bundle = parseWorkspaceBundle(historical.bundle);
      const result = await pushBundle(bundle, currentRevision);
      if (result.status !== "pushed") throw new Error("Remote workspace changed; pull before restoring.");
      await acceptPushed(result, bundle);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(null);
    }
  };

  const allConflictsResolved = Boolean(
    pendingConflict && pendingConflict.plan.conflicts.every((conflict) => choices[conflict.key]),
  );

  return (
    <div className="app-help-modal-backdrop" onClick={onClose}>
      <div className="app-help-modal workspace-sync-modal" onClick={(event) => event.stopPropagation()}>
        <div className="app-help-modal-header">
          <div className="app-help-modal-copy">
            <span className="app-help-modal-kicker">Encrypted sync</span>
            <h3 className="app-help-modal-title">{connectionName}</h3>
            <p className="app-help-modal-description">{currentRevision ? `Current ${currentRevision.slice(0, 12)}` : "Not synced"}</p>
          </div>
          <button type="button" className="app-help-modal-close" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>

        <div className="workspace-sync-provider-tabs" role="tablist">
          <button type="button" className={providerKind === "local-folder" ? "active" : ""} onClick={() => setProviderKind("local-folder")}><FolderOpen className="w-4 h-4" />Local folder</button>
          <button type="button" className={providerKind === "web-dav" ? "active" : ""} onClick={() => setProviderKind("web-dav")}><CloudUpload className="w-4 h-4" />WebDAV</button>
        </div>

        <div className="workspace-sync-fields">
          <label><span>Workspace ID</span><input value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)} /></label>
          {providerKind === "local-folder" ? (
            <label className="workspace-sync-path-field"><span>Folder</span><div><input value={directory} onChange={(event) => setDirectory(event.target.value)} /><button type="button" className="icon-btn" title="Choose folder" onClick={async () => { const selected = await open({ directory: true, multiple: false }); if (typeof selected === "string") setDirectory(selected); }}><FolderOpen className="w-4 h-4" /></button></div></label>
          ) : (
            <>
              <label><span>WebDAV HTTPS endpoint</span><input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="https://dav.example.com/tabler" /></label>
              <label><span>Username</span><input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" /></label>
              <label><span>WebDAV password</span><input type="password" value={webDavPassword} onChange={(event) => setWebDavPassword(event.target.value)} autoComplete="current-password" /></label>
            </>
          )}
          <label><span>Encryption password</span><input type="password" value={syncPassword} onChange={(event) => setSyncPassword(event.target.value)} autoComplete="new-password" /></label>
        </div>

        {error ? <div className="workspace-sync-error"><AlertTriangle className="w-4 h-4" />{error}</div> : null}

        {pendingConflict ? (
          <div className="workspace-sync-conflicts">
            <div className="workspace-sync-section-heading"><AlertTriangle className="w-4 h-4" /><span>Resolve {pendingConflict.plan.conflicts.length} conflict(s)</span></div>
            {pendingConflict.plan.conflicts.map((conflict) => (
              <div className="workspace-sync-conflict-row" key={conflict.key}>
                <div><strong>{conflict.kind}</strong><span>{conflict.entityId}</span><small>{conflict.reason}</small></div>
                <div className="workspace-sync-choice-group">
                  {(["local", "remote"] as const).map((choice) => <button key={choice} type="button" className={choices[conflict.key] === choice ? "active" : ""} onClick={() => setChoices((current) => ({ ...current, [conflict.key]: choice }))}>{choices[conflict.key] === choice ? <Check className="w-3.5 h-3.5" /> : null}{choice}</button>)}
                  {conflict.kind !== "connection" ? <button type="button" className={choices[conflict.key] === "duplicate" ? "active" : ""} onClick={() => setChoices((current) => ({ ...current, [conflict.key]: "duplicate" }))}>Keep both</button> : null}
                </div>
              </div>
            ))}
            <button type="button" className="btn btn-primary" disabled={!allConflictsResolved || Boolean(busy)} onClick={() => void handleResolve()}>{busy ? <LoaderCircle className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}Apply resolution</button>
          </div>
        ) : null}

        {history.length > 0 ? (
          <div className="workspace-sync-history">
            <div className="workspace-sync-section-heading"><History className="w-4 h-4" /><span>History</span></div>
            {history.slice().reverse().map((version) => (
              <div className="workspace-sync-history-row" key={version.revision}><div><strong>{version.revision.slice(0, 12)}</strong><span>{new Date(version.updatedAt).toLocaleString()}</span></div><button type="button" className="icon-btn" title="Restore version" disabled={Boolean(busy)} onClick={() => void handleRestore(version)}><RotateCcw className="w-4 h-4" /></button></div>
            ))}
          </div>
        ) : null}

        <div className="app-help-modal-actions workspace-sync-actions">
          <button type="button" className="btn btn-secondary" disabled={Boolean(busy) || Boolean(pendingConflict)} onClick={() => void handlePull()}>{busy === "pull" ? <LoaderCircle className="w-4 h-4 animate-spin" /> : <CloudDownload className="w-4 h-4" />}Pull</button>
          <button type="button" className="btn btn-primary" disabled={Boolean(busy) || Boolean(pendingConflict)} onClick={() => void handlePush()}>{busy === "push" ? <LoaderCircle className="w-4 h-4 animate-spin" /> : <CloudUpload className="w-4 h-4" />}Push</button>
        </div>
      </div>
    </div>
  );
}
