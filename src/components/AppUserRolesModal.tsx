import { invoke } from "@tauri-apps/api/core";
import { KeyRound, LoaderCircle, RefreshCw, ShieldCheck, UserCog, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ConnectionConfig } from "../types/database";
import { assertStatementsAllowed } from "../utils/safe-mode-query-guard";
import { emitAppToast } from "../utils/app-toast";
import { useConnectionCapabilities } from "../hooks/useConnectionCapabilities";
import { isCapabilitySupported } from "../types";

type ChangeAction = "createUser" | "grantRole" | "revokeRole";

interface Principal {
  id: string;
  name: string;
  host: string | null;
  canLogin: boolean;
  isSuperuser: boolean;
  roles: string[];
  privileges: string[];
}

interface Snapshot {
  engine: string;
  principals: Principal[];
}

interface Review {
  engine: string;
  statements: string[];
  confirmationPhrase: string;
}

interface ChangeRequest {
  action: ChangeAction;
  userName: string;
  host: string | null;
  roleName: string | null;
  password: string | null;
}

interface Props {
  connection: ConnectionConfig | null;
  onClose: () => void;
}

const ACTIONS: Array<{ value: ChangeAction; label: string }> = [
  { value: "createUser", label: "Create user" },
  { value: "grantRole", label: "Grant role" },
  { value: "revokeRole", label: "Revoke role" },
];

export function AppUserRolesModal({ connection, onClose }: Props) {
  const capabilityProfile = useConnectionCapabilities(connection?.id);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isStaging, setIsStaging] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [action, setAction] = useState<ChangeAction>("createUser");
  const [userName, setUserName] = useState("");
  const [host, setHost] = useState("%");
  const [roleName, setRoleName] = useState("");
  const [password, setPassword] = useState("");
  const [review, setReview] = useState<Review | null>(null);
  const [confirmation, setConfirmation] = useState("");

  const supportsUsersRoles = isCapabilitySupported(capabilityProfile?.capabilities.administration);
  const actionNeedsRole = action !== "createUser";
  const actionNeedsHost = connection?.db_type === "mysql" || connection?.db_type === "mariadb";
  const request = useMemo<ChangeRequest>(() => ({
    action,
    userName: userName.trim(),
    host: actionNeedsHost ? host.trim() || "%" : null,
    roleName: actionNeedsRole ? roleName.trim() || null : null,
    password: action === "createUser" && password ? password : null,
  }), [action, actionNeedsHost, actionNeedsRole, host, password, roleName, userName]);

  const refresh = useCallback(async () => {
    if (!connection || !supportsUsersRoles) return;
    setIsLoading(true);
    try {
      setSnapshot(await invoke<Snapshot>("get_user_role_snapshot", { connectionId: connection.id }));
    } catch (error) {
      emitAppToast({ tone: "error", title: "Could not inspect users and roles", description: String(error) });
    } finally {
      setIsLoading(false);
    }
  }, [connection, supportsUsersRoles]);

  useEffect(() => { void refresh(); }, [refresh]);

  const stageChange = useCallback(async () => {
    if (!connection || !request.userName || (actionNeedsRole && !request.roleName)) {
      emitAppToast({ tone: "error", title: actionNeedsRole ? "Enter a user and role" : "Enter a user name" });
      return;
    }
    setIsStaging(true);
    try {
      const nextReview = await invoke<Review>("review_user_role_change", { connectionId: connection.id, request });
      setReview(nextReview);
      setConfirmation("");
    } catch (error) {
      emitAppToast({ tone: "error", title: "Could not stage role change", description: String(error) });
    } finally {
      setIsStaging(false);
    }
  }, [actionNeedsRole, connection, request]);

  const applyChange = useCallback(async () => {
    if (!connection || !review) return;
    if (confirmation.trim() !== review.confirmationPhrase) {
      emitAppToast({ tone: "error", title: "Confirmation phrase does not match" });
      return;
    }
    setIsApplying(true);
    try {
      await assertStatementsAllowed(review.statements, connection.id);
      const nextSnapshot = await invoke<Snapshot>("apply_user_role_change", {
        connectionId: connection.id,
        request,
        confirmationPhrase: confirmation,
      });
      setSnapshot(nextSnapshot);
      setReview(null);
      setUserName("");
      setRoleName("");
      setPassword("");
      emitAppToast({ tone: "success", title: "User and role change applied", description: "Server state has been refreshed." });
    } catch (error) {
      emitAppToast({ tone: "error", title: "User and role change was not applied", description: String(error) });
    } finally {
      setIsApplying(false);
    }
  }, [confirmation, connection, request, review]);

  return (
    <div className="app-help-modal-backdrop" onClick={onClose}>
      <div className="app-help-modal app-user-roles-modal" onClick={(event) => event.stopPropagation()}>
        <div className="app-help-modal-header">
          <div className="app-help-modal-copy">
            <span className="app-help-modal-kicker">Administration</span>
            <h3 className="app-help-modal-title">Users & Roles</h3>
            <p className="app-help-modal-description">Inspect server principals and stage access changes for review before they reach the database.</p>
          </div>
          <button type="button" className="app-help-modal-close" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>

        {!connection || !supportsUsersRoles ? <div className="app-plugin-manager-empty">{capabilityProfile ? `${capabilityProfile.label} does not support Users & Roles in TableR.` : "Checking database administration capabilities..."}</div> : <>
          <section className="user-role-section">
            <div className="mcp-list-header"><div className="mcp-section-heading"><UserCog className="w-4 h-4" /><span>Effective access</span><span className="app-plugin-manager-badge accent">{snapshot?.principals.length ?? 0}</span></div><button type="button" className="icon-btn" title="Refresh server state" aria-label="Refresh server state" onClick={() => void refresh()} disabled={isLoading}><RefreshCw className={`w-4 h-4 ${isLoading ? "animate-spin" : ""}`} /></button></div>
            {isLoading ? <div className="app-plugin-manager-empty"><LoaderCircle className="w-4 h-4 animate-spin" /> Loading principals...</div> : snapshot?.principals.length ? <div className="user-role-principal-list">{snapshot.principals.map((principal) => <div className="user-role-principal" key={principal.id}><div><strong>{principal.name}</strong><span>{principal.host ? `@${principal.host}` : "Server role"}{principal.isSuperuser ? " · Superuser" : principal.canLogin ? " · Login" : ""}</span></div><div className="user-role-tags">{principal.roles.slice(0, 3).map((role) => <span key={role}>{role}</span>)}{principal.privileges.slice(0, 2).map((privilege) => <span key={privilege}>{privilege}</span>)}</div></div>)}</div> : <div className="app-plugin-manager-empty">No server principals were returned. The connected account may not have catalog access.</div>}
          </section>

          <section className="user-role-section">
            <div className="mcp-section-heading"><KeyRound className="w-4 h-4" /><span>Stage a change</span></div>
            <div className="user-role-form-grid">
              <label className="mcp-field"><span>Action</span><select value={action} onChange={(event) => { setAction(event.target.value as ChangeAction); setReview(null); }} >{ACTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
              <label className="mcp-field"><span>User</span><input value={userName} onChange={(event) => setUserName(event.target.value)} placeholder="analyst" /></label>
              {actionNeedsHost ? <label className="mcp-field"><span>Host</span><input value={host} onChange={(event) => setHost(event.target.value)} placeholder="%" /></label> : null}
              {actionNeedsRole ? <label className="mcp-field"><span>Role</span><input value={roleName} onChange={(event) => setRoleName(event.target.value)} placeholder="read_only" /></label> : <label className="mcp-field"><span>Password (optional)</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Stored only for this apply" /></label>}
            </div>
            <button type="button" className="btn btn-secondary" onClick={() => void stageChange()} disabled={isStaging}>{isStaging ? <LoaderCircle className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />} Review change</button>
          </section>

          {review ? <section className="user-role-section user-role-review"><div className="mcp-section-heading"><ShieldCheck className="w-4 h-4" /><span>Review SQL</span></div><pre>{review.statements.join("\n")}</pre><label className="mcp-field"><span>Type {review.confirmationPhrase} to apply</span><input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label><button type="button" className="btn btn-primary" onClick={() => void applyChange()} disabled={isApplying}>{isApplying ? <LoaderCircle className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />} Apply reviewed change</button></section> : null}
        </>}
      </div>
    </div>
  );
}
