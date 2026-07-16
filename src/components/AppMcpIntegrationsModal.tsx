import { invoke } from "@tauri-apps/api/core";
import {
  Check,
  Copy,
  KeyRound,
  LoaderCircle,
  Power,
  PlugZap,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ConnectionConfig } from "../types/database";
import { emitAppToast } from "../utils/app-toast";

type ExternalAccessPolicy = "blocked" | "readOnly" | "readWrite";
type McpPermission = "readOnly" | "readWrite" | "admin";

interface McpTokenSummary {
  id: string;
  name: string;
  prefix: string;
  permission: McpPermission;
  connectionAllowlist: string[] | null;
  expiresAt: string | null;
  isActive: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

interface McpAuditEvent {
  id: string;
  at: string;
  tokenId: string | null;
  category: string;
  action: string;
  connectionId: string | null;
  outcome: string;
  detail: string | null;
}

interface CreatedMcpToken {
  token: string;
  summary: McpTokenSummary;
}

interface McpLocalServerStatus {
  enabled: boolean;
  host: string;
  port: number | null;
  endpoint: string | null;
  handshakePath: string;
}

interface Props {
  connections: ConnectionConfig[];
  onClose: () => void;
}

const POLICY_OPTIONS: Array<{ value: ExternalAccessPolicy; label: string; description: string }> = [
  { value: "blocked", label: "Blocked", description: "No external MCP client can use this connection." },
  { value: "readOnly", label: "Read only", description: "External tools may inspect metadata and run read-only queries." },
  { value: "readWrite", label: "Read/write", description: "Reserved for future approved write tools; the current server remains read-only." },
];

const PERMISSION_OPTIONS: Array<{ value: McpPermission; label: string }> = [
  { value: "readOnly", label: "Read only" },
  { value: "readWrite", label: "Read/write" },
  { value: "admin", label: "Admin" },
];

function formatTimestamp(value: string | null) {
  if (!value) return "Never";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

export function AppMcpIntegrationsModal({ connections, onClose }: Props) {
  const [selectedConnectionId, setSelectedConnectionId] = useState(connections[0]?.id ?? "");
  const [policy, setPolicy] = useState<ExternalAccessPolicy>("blocked");
  const [savedPolicy, setSavedPolicy] = useState<ExternalAccessPolicy>("blocked");
  const [tokens, setTokens] = useState<McpTokenSummary[]>([]);
  const [auditEvents, setAuditEvents] = useState<McpAuditEvent[]>([]);
  const [serverStatus, setServerStatus] = useState<McpLocalServerStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSavingPolicy, setIsSavingPolicy] = useState(false);
  const [isCreatingToken, setIsCreatingToken] = useState(false);
  const [tokenName, setTokenName] = useState("Desktop client");
  const [permission, setPermission] = useState<McpPermission>("readOnly");
  const [expiresAt, setExpiresAt] = useState("");
  const [allowedConnectionIds, setAllowedConnectionIds] = useState<string[]>(
    connections[0]?.id ? [connections[0].id] : [],
  );
  const [issuedToken, setIssuedToken] = useState<string | null>(null);
  const [busyTokenId, setBusyTokenId] = useState<string | null>(null);
  const [isChangingServer, setIsChangingServer] = useState(false);

  const selectedConnection = useMemo(
    () => connections.find((connection) => connection.id === selectedConnectionId) ?? null,
    [connections, selectedConnectionId],
  );

  const loadSecurityState = useCallback(async () => {
    setIsLoading(true);
    try {
      const [nextTokens, nextEvents, nextServerStatus] = await Promise.all([
        invoke<McpTokenSummary[]>("list_mcp_tokens"),
        invoke<McpAuditEvent[]>("get_mcp_audit_events", { limit: 80 }),
        invoke<McpLocalServerStatus>("get_mcp_local_server_status"),
      ]);
      setTokens(nextTokens);
      setAuditEvents(nextEvents);
      setServerStatus(nextServerStatus);
      if (selectedConnectionId) {
        const nextPolicy = await invoke<ExternalAccessPolicy>("get_mcp_connection_policy", {
          connectionId: selectedConnectionId,
        });
        setPolicy(nextPolicy);
        setSavedPolicy(nextPolicy);
      }
    } catch (error) {
      emitAppToast({
        tone: "error",
        title: "Could not load external integrations",
        description: String(error),
      });
    } finally {
      setIsLoading(false);
    }
  }, [selectedConnectionId]);

  useEffect(() => {
    void loadSecurityState();
  }, [loadSecurityState]);

  useEffect(() => {
    setAllowedConnectionIds((current) => {
      const available = current.filter((id) => connections.some((connection) => connection.id === id));
      return available.length > 0 || !selectedConnectionId ? available : [selectedConnectionId];
    });
  }, [connections, selectedConnectionId]);

  const savePolicy = useCallback(async () => {
    if (!selectedConnectionId) return;
    if (policy !== "blocked" && policy !== savedPolicy) {
      const phrase = policy === "readWrite" ? "ENABLE WRITE ACCESS" : "ENABLE EXTERNAL ACCESS";
      const confirmed = window.prompt(`Type ${phrase} to enable this connection for external MCP clients.`);
      if (confirmed !== phrase) {
        emitAppToast({ tone: "info", title: "External access was not enabled" });
        return;
      }
    }
    setIsSavingPolicy(true);
    try {
      await invoke("set_mcp_connection_policy", { connectionId: selectedConnectionId, policy });
      setSavedPolicy(policy);
      emitAppToast({
        tone: policy === "blocked" ? "info" : "success",
        title: policy === "blocked" ? "External access blocked" : "External access updated",
        description: selectedConnection?.name ?? selectedConnectionId,
      });
    } catch (error) {
      emitAppToast({ tone: "error", title: "Could not save access policy", description: String(error) });
    } finally {
      setIsSavingPolicy(false);
    }
  }, [policy, savedPolicy, selectedConnection?.name, selectedConnectionId]);

  const createToken = useCallback(async () => {
    if (!tokenName.trim()) {
      emitAppToast({ tone: "error", title: "Name the token before creating it" });
      return;
    }
    if (allowedConnectionIds.length === 0) {
      emitAppToast({ tone: "error", title: "Allow at least one connection" });
      return;
    }
    setIsCreatingToken(true);
    try {
      const created = await invoke<CreatedMcpToken>("create_mcp_token", {
        name: tokenName.trim(),
        permission,
        connectionAllowlist: allowedConnectionIds,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
      });
      setIssuedToken(created.token);
      setTokens((current) => [created.summary, ...current]);
      setTokenName("Desktop client");
      setExpiresAt("");
      emitAppToast({ tone: "success", title: "MCP token created", description: "Copy it now. It cannot be shown again." });
      void loadSecurityState();
    } catch (error) {
      emitAppToast({ tone: "error", title: "Could not create MCP token", description: String(error) });
    } finally {
      setIsCreatingToken(false);
    }
  }, [allowedConnectionIds, expiresAt, loadSecurityState, permission, tokenName]);

  const revokeToken = useCallback(async (token: McpTokenSummary) => {
    if (!window.confirm(`Revoke ${token.name}? Connected clients lose access immediately.`)) return;
    setBusyTokenId(token.id);
    try {
      await invoke("revoke_mcp_token", { tokenId: token.id });
      setTokens((current) => current.map((item) => (item.id === token.id ? { ...item, isActive: false } : item)));
      emitAppToast({ tone: "success", title: "MCP token revoked", description: token.name });
      void loadSecurityState();
    } catch (error) {
      emitAppToast({ tone: "error", title: "Could not revoke MCP token", description: String(error) });
    } finally {
      setBusyTokenId(null);
    }
  }, [loadSecurityState]);

  const copyIssuedToken = useCallback(async () => {
    if (!issuedToken) return;
    try {
      await navigator.clipboard.writeText(issuedToken);
      emitAppToast({ tone: "success", title: "Token copied" });
    } catch {
      emitAppToast({ tone: "error", title: "Clipboard access was unavailable" });
    }
  }, [issuedToken]);

  const toggleLocalServer = useCallback(async () => {
    setIsChangingServer(true);
    try {
      const command = serverStatus?.enabled ? "stop_mcp_local_server" : "start_mcp_local_server";
      const nextStatus = await invoke<McpLocalServerStatus>(command);
      setServerStatus(nextStatus);
      emitAppToast({
        tone: "success",
        title: nextStatus.enabled ? "Local MCP server started" : "Local MCP server stopped",
        description: nextStatus.endpoint ?? "External clients can no longer connect.",
      });
    } catch (error) {
      emitAppToast({ tone: "error", title: "Could not update local MCP server", description: String(error) });
    } finally {
      setIsChangingServer(false);
    }
  }, [serverStatus?.enabled]);

  const toggleAllowedConnection = (connectionId: string) => {
    setAllowedConnectionIds((current) =>
      current.includes(connectionId)
        ? current.filter((id) => id !== connectionId)
        : [...current, connectionId],
    );
  };

  return (
    <div className="app-help-modal-backdrop" onClick={onClose}>
      <div className="app-help-modal app-mcp-integrations-modal" onClick={(event) => event.stopPropagation()}>
        <div className="app-help-modal-header">
          <div className="app-help-modal-copy">
            <span className="app-help-modal-kicker">External integrations</span>
            <h3 className="app-help-modal-title">MCP access control</h3>
            <p className="app-help-modal-description">Grant narrowly scoped access to local MCP clients. Connection access starts blocked.</p>
          </div>
          <button type="button" className="app-help-modal-close" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        {issuedToken ? (
          <section className="mcp-token-reveal" aria-live="polite">
            <div className="mcp-token-reveal-head">
              <KeyRound className="w-4 h-4" />
              <strong>Copy this token now</strong>
              <span>It is never stored as plaintext.</span>
            </div>
            <code>{issuedToken}</code>
            <button type="button" className="btn btn-primary" onClick={copyIssuedToken}>
              <Copy className="w-4 h-4" /> Copy token
            </button>
          </section>
        ) : null}

        <section className="mcp-local-server-panel">
          <div className="mcp-local-server-copy">
            <span className={`mcp-server-indicator ${serverStatus?.enabled ? "online" : ""}`} />
            <div><strong>Local MCP service</strong><small>{serverStatus?.enabled ? serverStatus.endpoint : "Disabled. It never listens beyond 127.0.0.1."}</small></div>
          </div>
          <button type="button" className={serverStatus?.enabled ? "btn btn-secondary" : "btn btn-primary"} onClick={toggleLocalServer} disabled={isChangingServer || isLoading}>
            {isChangingServer ? <LoaderCircle className="w-4 h-4 animate-spin" /> : <Power className="w-4 h-4" />}
            {serverStatus?.enabled ? "Stop service" : "Start service"}
          </button>
        </section>

        <div className="mcp-integrations-layout">
          <section className="mcp-integrations-section">
            <div className="mcp-section-heading"><ShieldCheck className="w-4 h-4" /><span>Connection policy</span></div>
            {connections.length === 0 ? (
              <div className="app-plugin-manager-empty">Add a saved connection before enabling external access.</div>
            ) : (
              <>
                <label className="mcp-field">
                  <span>Connection</span>
                  <select value={selectedConnectionId} onChange={(event) => setSelectedConnectionId(event.target.value)}>
                    {connections.map((connection) => <option key={connection.id} value={connection.id}>{connection.name}</option>)}
                  </select>
                </label>
                <div className="mcp-policy-options">
                  {POLICY_OPTIONS.map((option) => (
                    <label key={option.value} className={`mcp-policy-option ${policy === option.value ? "selected" : ""}`}>
                      <input type="radio" value={option.value} checked={policy === option.value} onChange={() => setPolicy(option.value)} />
                      <span><strong>{option.label}</strong><small>{option.description}</small></span>
                    </label>
                  ))}
                </div>
                <button type="button" className="btn btn-secondary mcp-save-policy" onClick={savePolicy} disabled={isSavingPolicy || isLoading}>
                  {isSavingPolicy ? <LoaderCircle className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
                  Save policy
                </button>
              </>
            )}
          </section>

          <section className="mcp-integrations-section">
            <div className="mcp-section-heading"><KeyRound className="w-4 h-4" /><span>Create token</span></div>
            <div className="mcp-token-form-grid">
              <label className="mcp-field mcp-field-wide"><span>Name</span><input value={tokenName} maxLength={120} onChange={(event) => setTokenName(event.target.value)} /></label>
              <label className="mcp-field"><span>Scope</span><select value={permission} onChange={(event) => setPermission(event.target.value as McpPermission)}>{PERMISSION_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
              <label className="mcp-field"><span>Expires (optional)</span><input type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} /></label>
            </div>
            <div className="mcp-allowlist">
              <span>Allowed connections</span>
              {connections.map((connection) => (
                <label key={connection.id} className="mcp-allowlist-item">
                  <input type="checkbox" checked={allowedConnectionIds.includes(connection.id)} onChange={() => toggleAllowedConnection(connection.id)} />
                  <span>{connection.name}</span>
                </label>
              ))}
            </div>
            <button type="button" className="btn btn-primary" onClick={createToken} disabled={isCreatingToken || connections.length === 0}>
              {isCreatingToken ? <LoaderCircle className="w-4 h-4 animate-spin" /> : <KeyRound className="w-4 h-4" />}
              Create token
            </button>
          </section>
        </div>

        <section className="mcp-integrations-section mcp-token-list-section">
          <div className="mcp-list-header">
            <div className="mcp-section-heading"><PlugZap className="w-4 h-4" /><span>Issued tokens</span><span className="app-plugin-manager-badge accent">{tokens.length}</span></div>
            <button type="button" className="icon-btn" title="Refresh" aria-label="Refresh" onClick={() => void loadSecurityState()} disabled={isLoading}><RefreshCw className={`w-4 h-4 ${isLoading ? "animate-spin" : ""}`} /></button>
          </div>
          {tokens.length === 0 ? <div className="app-plugin-manager-empty">No MCP token has been issued.</div> : (
            <div className="mcp-token-list">
              {tokens.map((token) => (
                <div key={token.id} className={`mcp-token-row ${token.isActive ? "" : "revoked"}`}>
                  <div className="mcp-token-row-copy"><strong>{token.name}</strong><span>{token.prefix}... · {token.permission} · {token.connectionAllowlist?.length ?? "all"} connection{token.connectionAllowlist?.length === 1 ? "" : "s"}</span></div>
                  <div className="mcp-token-row-meta"><span>{token.isActive ? "Active" : "Revoked"}</span><small>{token.expiresAt ? `Expires ${formatTimestamp(token.expiresAt)}` : "No expiry"}</small></div>
                  {token.isActive ? <button type="button" className="app-plugin-manager-action-btn danger" title="Revoke token" aria-label={`Revoke ${token.name}`} onClick={() => void revokeToken(token)} disabled={busyTokenId === token.id}><Trash2 className="w-3.5 h-3.5" /></button> : null}
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="mcp-integrations-section mcp-audit-section">
          <div className="mcp-section-heading"><ShieldAlert className="w-4 h-4" /><span>Security activity</span></div>
          {auditEvents.length === 0 ? <div className="app-plugin-manager-empty">No external access activity recorded.</div> : (
            <div className="mcp-audit-list">
              {auditEvents.slice(0, 8).map((event) => <div key={event.id} className="mcp-audit-row"><span className={event.outcome === "success" ? "success" : "denied"}>{event.outcome === "success" ? <Check className="w-3.5 h-3.5" /> : <ShieldAlert className="w-3.5 h-3.5" />}</span><strong>{event.category}: {event.action}</strong><small>{formatTimestamp(event.at)}</small></div>)}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
