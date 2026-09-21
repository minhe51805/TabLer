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
import { requestAppConfirmation } from "../stores/confirmStore";
import { useI18n, type TranslationKey } from "../i18n";

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

const POLICY_OPTIONS: Array<{
  value: ExternalAccessPolicy;
  labelKey: TranslationKey;
  descriptionKey: TranslationKey;
}> = [
  {
    value: "blocked",
    labelKey: "mcp.policy.blocked.label",
    descriptionKey: "mcp.policy.blocked.desc",
  },
  {
    value: "readOnly",
    labelKey: "mcp.policy.readOnly.label",
    descriptionKey: "mcp.policy.readOnly.desc",
  },
  {
    value: "readWrite",
    labelKey: "mcp.policy.readWrite.label",
    descriptionKey: "mcp.policy.readWrite.desc",
  },
];

const PERMISSION_OPTIONS: Array<{ value: McpPermission; labelKey: TranslationKey }> = [
  { value: "readOnly", labelKey: "mcp.permission.readOnly" },
  { value: "readWrite", labelKey: "mcp.permission.readWrite" },
  { value: "admin", labelKey: "mcp.permission.admin" },
];

function formatTimestamp(value: string | null, neverLabel: string) {
  if (!value) return neverLabel;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

export function AppMcpIntegrationsModal({ connections, onClose }: Props) {
  const { t } = useI18n();
  const [selectedConnectionId, setSelectedConnectionId] = useState(connections[0]?.id ?? "");
  const [policy, setPolicy] = useState<ExternalAccessPolicy>("blocked");
  const [savedPolicy, setSavedPolicy] = useState<ExternalAccessPolicy>("blocked");
  const [tokens, setTokens] = useState<McpTokenSummary[]>([]);
  const [auditEvents, setAuditEvents] = useState<McpAuditEvent[]>([]);
  const [serverStatus, setServerStatus] = useState<McpLocalServerStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSavingPolicy, setIsSavingPolicy] = useState(false);
  const [isCreatingToken, setIsCreatingToken] = useState(false);
  const [tokenName, setTokenName] = useState(() => t("mcp.defaultTokenName"));
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
        title: t("mcp.loadFailed"),
        description: String(error),
      });
    } finally {
      setIsLoading(false);
    }
  }, [selectedConnectionId, t]);

  useEffect(() => {
    void loadSecurityState();
  }, [loadSecurityState]);

  useEffect(() => {
    setAllowedConnectionIds((current) => {
      const available = current.filter((id) =>
        connections.some((connection) => connection.id === id),
      );
      return available.length > 0 || !selectedConnectionId ? available : [selectedConnectionId];
    });
  }, [connections, selectedConnectionId]);

  const savePolicy = useCallback(async () => {
    if (!selectedConnectionId) return;
    if (policy !== "blocked" && policy !== savedPolicy) {
      const phrase = t(policy === "readWrite" ? "mcp.enablePhraseWrite" : "mcp.enablePhraseRead");
      const confirmed = window.prompt(t("mcp.enablePrompt", { phrase }));
      if (confirmed !== phrase) {
        emitAppToast({ tone: "info", title: t("mcp.enableCancelled") });
        return;
      }
    }
    setIsSavingPolicy(true);
    try {
      await invoke("set_mcp_connection_policy", { connectionId: selectedConnectionId, policy });
      setSavedPolicy(policy);
      emitAppToast({
        tone: policy === "blocked" ? "info" : "success",
        title: t(policy === "blocked" ? "mcp.policyBlocked" : "mcp.policyUpdated"),
        description: selectedConnection?.name ?? selectedConnectionId,
      });
    } catch (error) {
      emitAppToast({ tone: "error", title: t("mcp.policySaveFailed"), description: String(error) });
    } finally {
      setIsSavingPolicy(false);
    }
  }, [policy, savedPolicy, selectedConnection?.name, selectedConnectionId, t]);

  const createToken = useCallback(async () => {
    if (!tokenName.trim()) {
      emitAppToast({ tone: "error", title: t("mcp.tokenNeedsName") });
      return;
    }
    if (allowedConnectionIds.length === 0) {
      emitAppToast({ tone: "error", title: t("mcp.tokenNeedsConnection") });
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
      setTokenName(t("mcp.defaultTokenName"));
      setExpiresAt("");
      emitAppToast({
        tone: "success",
        title: t("mcp.tokenCreated"),
        description: t("mcp.tokenCreatedHint"),
      });
      void loadSecurityState();
    } catch (error) {
      emitAppToast({
        tone: "error",
        title: t("mcp.tokenCreateFailed"),
        description: String(error),
      });
    } finally {
      setIsCreatingToken(false);
    }
  }, [allowedConnectionIds, expiresAt, loadSecurityState, permission, t, tokenName]);

  const revokeToken = useCallback(
    async (token: McpTokenSummary) => {
      const approved = await requestAppConfirmation({
        title: t("mcp.revokeTitle"),
        message: t("mcp.revokeConfirm", { name: token.name }),
        confirmText: t("mcp.revokeToken"),
      });
      if (!approved) return;
      setBusyTokenId(token.id);
      try {
        await invoke("revoke_mcp_token", { tokenId: token.id });
        setTokens((current) =>
          current.map((item) => (item.id === token.id ? { ...item, isActive: false } : item)),
        );
        emitAppToast({ tone: "success", title: t("mcp.tokenRevoked"), description: token.name });
        void loadSecurityState();
      } catch (error) {
        emitAppToast({
          tone: "error",
          title: t("mcp.tokenRevokeFailed"),
          description: String(error),
        });
      } finally {
        setBusyTokenId(null);
      }
    },
    [loadSecurityState, t],
  );

  const copyIssuedToken = useCallback(async () => {
    if (!issuedToken) return;
    try {
      await navigator.clipboard.writeText(issuedToken);
      emitAppToast({ tone: "success", title: t("mcp.tokenCopied") });
    } catch {
      emitAppToast({ tone: "error", title: t("mcp.clipboardUnavailable") });
    }
  }, [issuedToken, t]);

  const toggleLocalServer = useCallback(async () => {
    setIsChangingServer(true);
    try {
      const command = serverStatus?.enabled ? "stop_mcp_local_server" : "start_mcp_local_server";
      const nextStatus = await invoke<McpLocalServerStatus>(command);
      setServerStatus(nextStatus);
      emitAppToast({
        tone: "success",
        title: t(nextStatus.enabled ? "mcp.serverStarted" : "mcp.serverStopped"),
        description: nextStatus.endpoint ?? t("mcp.serverStoppedHint"),
      });
    } catch (error) {
      emitAppToast({
        tone: "error",
        title: t("mcp.serverUpdateFailed"),
        description: String(error),
      });
    } finally {
      setIsChangingServer(false);
    }
  }, [serverStatus?.enabled, t]);

  const toggleAllowedConnection = (connectionId: string) => {
    setAllowedConnectionIds((current) =>
      current.includes(connectionId)
        ? current.filter((id) => id !== connectionId)
        : [...current, connectionId],
    );
  };

  return (
    <div className="app-help-modal-backdrop" onClick={onClose}>
      <div
        className="app-help-modal app-mcp-integrations-modal"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="app-help-modal-header">
          <div className="app-help-modal-copy">
            <span className="app-help-modal-kicker">{t("mcp.kicker")}</span>
            <h3 className="app-help-modal-title">{t("mcp.title")}</h3>
            <p className="app-help-modal-description">{t("mcp.description")}</p>
          </div>
          <button
            type="button"
            className="app-help-modal-close"
            onClick={onClose}
            aria-label={t("common.close")}
          >
            <X size={16} />
          </button>
        </div>

        {issuedToken ? (
          <section className="mcp-token-reveal" aria-live="polite">
            <div className="mcp-token-reveal-head">
              <KeyRound className="w-4 h-4" />
              <strong>{t("mcp.copyTokenNow")}</strong>
              <span>{t("mcp.tokenNeverStored")}</span>
            </div>
            <code>{issuedToken}</code>
            <button type="button" className="btn btn-primary" onClick={copyIssuedToken}>
              <Copy className="w-4 h-4" /> {t("mcp.copyToken")}
            </button>
          </section>
        ) : null}

        <section className="mcp-local-server-panel">
          <div className="mcp-local-server-copy">
            <span className={`mcp-server-indicator ${serverStatus?.enabled ? "online" : ""}`} />
            <div>
              <strong>{t("mcp.localService")}</strong>
              <small>
                {serverStatus?.enabled ? serverStatus.endpoint : t("mcp.localServiceDisabled")}
              </small>
            </div>
          </div>
          <button
            type="button"
            className={serverStatus?.enabled ? "btn btn-secondary" : "btn btn-primary"}
            onClick={toggleLocalServer}
            disabled={isChangingServer || isLoading}
          >
            {isChangingServer ? (
              <LoaderCircle className="w-4 h-4 animate-spin" />
            ) : (
              <Power className="w-4 h-4" />
            )}
            {serverStatus?.enabled ? t("mcp.stopService") : t("mcp.startService")}
          </button>
        </section>

        <div className="mcp-integrations-layout">
          <section className="mcp-integrations-section">
            <div className="mcp-section-heading">
              <ShieldCheck className="w-4 h-4" />
              <span>{t("mcp.connectionPolicy")}</span>
            </div>
            {connections.length === 0 ? (
              <div className="app-plugin-manager-empty">{t("mcp.noConnections")}</div>
            ) : (
              <>
                <label className="mcp-field">
                  <span>{t("mcp.connection")}</span>
                  <select
                    value={selectedConnectionId}
                    onChange={(event) => setSelectedConnectionId(event.target.value)}
                  >
                    {connections.map((connection) => (
                      <option key={connection.id} value={connection.id}>
                        {connection.name}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="mcp-policy-options">
                  {POLICY_OPTIONS.map((option) => (
                    <label
                      key={option.value}
                      className={`mcp-policy-option ${policy === option.value ? "selected" : ""}`}
                    >
                      <input
                        type="radio"
                        value={option.value}
                        checked={policy === option.value}
                        onChange={() => setPolicy(option.value)}
                      />
                      <span>
                        <strong>{t(option.labelKey)}</strong>
                        <small>{t(option.descriptionKey)}</small>
                      </span>
                    </label>
                  ))}
                </div>
                <button
                  type="button"
                  className="btn btn-secondary mcp-save-policy"
                  onClick={savePolicy}
                  disabled={isSavingPolicy || isLoading}
                >
                  {isSavingPolicy ? (
                    <LoaderCircle className="w-4 h-4 animate-spin" />
                  ) : (
                    <ShieldCheck className="w-4 h-4" />
                  )}
                  {t("mcp.savePolicy")}
                </button>
              </>
            )}
          </section>

          <section className="mcp-integrations-section">
            <div className="mcp-section-heading">
              <KeyRound className="w-4 h-4" />
              <span>{t("mcp.createToken")}</span>
            </div>
            <div className="mcp-token-form-grid">
              <label className="mcp-field mcp-field-wide">
                <span>{t("mcp.tokenName")}</span>
                <input
                  value={tokenName}
                  maxLength={120}
                  onChange={(event) => setTokenName(event.target.value)}
                />
              </label>
              <label className="mcp-field">
                <span>{t("mcp.tokenScope")}</span>
                <select
                  value={permission}
                  onChange={(event) => setPermission(event.target.value as McpPermission)}
                >
                  {PERMISSION_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {t(option.labelKey)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="mcp-field">
                <span>{t("mcp.tokenExpires")}</span>
                <input
                  type="datetime-local"
                  value={expiresAt}
                  onChange={(event) => setExpiresAt(event.target.value)}
                />
              </label>
            </div>
            <div className="mcp-allowlist">
              <span>{t("mcp.allowedConnections")}</span>
              {connections.map((connection) => (
                <label key={connection.id} className="mcp-allowlist-item">
                  <input
                    type="checkbox"
                    checked={allowedConnectionIds.includes(connection.id)}
                    onChange={() => toggleAllowedConnection(connection.id)}
                  />
                  <span>{connection.name}</span>
                </label>
              ))}
            </div>
            <button
              type="button"
              className="btn btn-primary"
              onClick={createToken}
              disabled={isCreatingToken || connections.length === 0}
            >
              {isCreatingToken ? (
                <LoaderCircle className="w-4 h-4 animate-spin" />
              ) : (
                <KeyRound className="w-4 h-4" />
              )}
              {t("mcp.createToken")}
            </button>
          </section>
        </div>

        <section className="mcp-integrations-section mcp-token-list-section">
          <div className="mcp-list-header">
            <div className="mcp-section-heading">
              <PlugZap className="w-4 h-4" />
              <span>{t("mcp.issuedTokens")}</span>
              <span className="app-plugin-manager-badge accent">{tokens.length}</span>
            </div>
            <button
              type="button"
              className="icon-btn"
              title={t("common.refresh")}
              aria-label={t("common.refresh")}
              onClick={() => void loadSecurityState()}
              disabled={isLoading}
            >
              <RefreshCw className={`w-4 h-4 ${isLoading ? "animate-spin" : ""}`} />
            </button>
          </div>
          {tokens.length === 0 ? (
            <div className="app-plugin-manager-empty">{t("mcp.noTokens")}</div>
          ) : (
            <div className="mcp-token-list">
              {tokens.map((token) => (
                <div key={token.id} className={`mcp-token-row ${token.isActive ? "" : "revoked"}`}>
                  <div className="mcp-token-row-copy">
                    <strong>{token.name}</strong>
                    <span>
                      {token.prefix}... ·{" "}
                      {t(`mcp.permission.${token.permission}` as TranslationKey)} ·{" "}
                      {token.connectionAllowlist === null
                        ? t("mcp.allConnections")
                        : t(
                            token.connectionAllowlist.length === 1
                              ? "mcp.tokenConnections.one"
                              : "mcp.tokenConnections.other",
                            { count: token.connectionAllowlist.length },
                          )}
                    </span>
                  </div>
                  <div className="mcp-token-row-meta">
                    <span>{t(token.isActive ? "mcp.status.active" : "mcp.status.revoked")}</span>
                    <small>
                      {token.expiresAt
                        ? t("mcp.expiresAt", {
                            time: formatTimestamp(token.expiresAt, t("mcp.never")),
                          })
                        : t("mcp.noExpiry")}
                    </small>
                  </div>
                  {token.isActive ? (
                    <button
                      type="button"
                      className="app-plugin-manager-action-btn danger"
                      title={t("mcp.revokeToken")}
                      aria-label={t("mcp.revokeAriaLabel", { name: token.name })}
                      onClick={() => void revokeToken(token)}
                      disabled={busyTokenId === token.id}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="mcp-integrations-section mcp-audit-section">
          <div className="mcp-section-heading">
            <ShieldAlert className="w-4 h-4" />
            <span>{t("mcp.securityActivity")}</span>
          </div>
          {auditEvents.length === 0 ? (
            <div className="app-plugin-manager-empty">{t("mcp.noAuditEvents")}</div>
          ) : (
            <div className="mcp-audit-list">
              {auditEvents.slice(0, 8).map((event) => (
                <div key={event.id} className="mcp-audit-row">
                  <span className={event.outcome === "success" ? "success" : "denied"}>
                    {event.outcome === "success" ? (
                      <Check className="w-3.5 h-3.5" />
                    ) : (
                      <ShieldAlert className="w-3.5 h-3.5" />
                    )}
                  </span>
                  <strong>
                    {event.category}: {event.action}
                  </strong>
                  <small>{formatTimestamp(event.at, t("mcp.never"))}</small>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
