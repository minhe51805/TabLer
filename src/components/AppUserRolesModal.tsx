import { invoke } from "@tauri-apps/api/core";
import { KeyRound, LoaderCircle, RefreshCw, ShieldCheck, UserCog, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ConnectionConfig } from "../types/database";
import { assertStatementsAllowed } from "../utils/safe-mode-query-guard";
import { isBlockedAtLevel } from "../types/safe-mode";
import { useSafeModeStore } from "../stores/safeModeStore";
import { requestAppConfirmation } from "../stores/confirmStore";
import { getUserRolesCopy } from "./user-roles-copy";
import { emitAppToast } from "../utils/app-toast";
import { useConnectionCapabilities } from "../hooks/useConnectionCapabilities";
import { isCapabilitySupported } from "../types";
import { useI18n, type TranslationKey } from "../i18n";

type ChangeAction =
  "createUser" | "grantRole" | "revokeRole" | "grantPrivilege" | "revokePrivilege";

interface Principal {
  id: string;
  name: string;
  host: string | null;
  canLogin: boolean;
  isSuperuser: boolean;
  roles: string[];
  directPrivileges: string[];
  effectivePrivileges: string[];
  privileges: string[];
}

interface Snapshot {
  engine: string;
  principals: Principal[];
  /** True when the privilege/membership queries failed — the lists below are
   *  incomplete, not empty. */
  privilegesUnavailable?: boolean;
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
  privilege: string | null;
  objectName: string | null;
}

interface Props {
  connection: ConnectionConfig | null;
  onClose: () => void;
}

const ACTIONS: Array<{ value: ChangeAction; labelKey: TranslationKey }> = [
  { value: "createUser", labelKey: "userRoles.action.createUser" },
  { value: "grantRole", labelKey: "userRoles.action.grantRole" },
  { value: "revokeRole", labelKey: "userRoles.action.revokeRole" },
  { value: "grantPrivilege", labelKey: "userRoles.action.grantPrivilege" },
  { value: "revokePrivilege", labelKey: "userRoles.action.revokePrivilege" },
];

export function AppUserRolesModal({ connection, onClose }: Props) {
  const { t, language } = useI18n();
  const rolesCopy = getUserRolesCopy(language);
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
  const [privilege, setPrivilege] = useState("SELECT");
  const [objectName, setObjectName] = useState("");
  const [review, setReview] = useState<Review | null>(null);
  const [confirmation, setConfirmation] = useState("");

  const supportsUsersRoles = isCapabilitySupported(capabilityProfile?.capabilities.administration);
  const actionNeedsRole = action === "grantRole" || action === "revokeRole";
  const actionNeedsPrivilege = action === "grantPrivilege" || action === "revokePrivilege";
  const actionNeedsHost = connection?.db_type === "mysql" || connection?.db_type === "mariadb";
  const request = useMemo<ChangeRequest>(
    () => ({
      action,
      userName: userName.trim(),
      host: actionNeedsHost ? host.trim() || "%" : null,
      roleName: actionNeedsRole ? roleName.trim() || null : null,
      password: action === "createUser" && password ? password : null,
      privilege: actionNeedsPrivilege ? privilege : null,
      objectName: actionNeedsPrivilege ? objectName.trim() || null : null,
    }),
    [
      action,
      actionNeedsHost,
      actionNeedsPrivilege,
      actionNeedsRole,
      host,
      objectName,
      password,
      privilege,
      roleName,
      userName,
    ],
  );

  const refresh = useCallback(async () => {
    if (!connection || !supportsUsersRoles) return;
    setIsLoading(true);
    try {
      setSnapshot(
        await invoke<Snapshot>("get_user_role_snapshot", { connectionId: connection.id }),
      );
    } catch (error) {
      emitAppToast({
        tone: "error",
        title: t("userRoles.inspectFailed"),
        description: String(error),
      });
    } finally {
      setIsLoading(false);
    }
  }, [connection, supportsUsersRoles, t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const stageChange = useCallback(async () => {
    if (
      !connection ||
      !request.userName ||
      (actionNeedsRole && !request.roleName) ||
      (actionNeedsPrivilege && !request.objectName)
    ) {
      emitAppToast({
        tone: "error",
        title: t(actionNeedsRole ? "userRoles.needUserAndRole" : "userRoles.needUser"),
      });
      return;
    }
    setIsStaging(true);
    try {
      const nextReview = await invoke<Review>("review_user_role_change", {
        connectionId: connection.id,
        request,
      });
      setReview(nextReview);
      setConfirmation("");
    } catch (error) {
      emitAppToast({
        tone: "error",
        title: t("userRoles.stageFailed"),
        description: String(error),
      });
    } finally {
      setIsStaging(false);
    }
  }, [actionNeedsPrivilege, actionNeedsRole, connection, request, t]);

  const applyChange = useCallback(async () => {
    if (!connection || !review) return;
    if (confirmation.trim() !== review.confirmationPhrase) {
      emitAppToast({ tone: "error", title: t("userRoles.phraseMismatch") });
      return;
    }
    setIsApplying(true);
    try {
      // A hard block (levels 1-2 for GRANT/REVOKE/CREATE) used to dead-end on
      // a raw error. Offer the remedy instead: a per-connection override that
      // permits the reviewed statements — Standard when it suffices, Disabled
      // otherwise — so the user can proceed without leaving the modal.
      const safeLevel = useSafeModeStore.getState().getEffectiveLevel(connection.id);
      const blockedStatement = review.statements.find((statement) =>
        isBlockedAtLevel(safeLevel, statement),
      );
      if (blockedStatement) {
        const canUseStandard = review.statements.every(
          (statement) => !isBlockedAtLevel(3, statement),
        );
        const approved = await requestAppConfirmation({
          title: rolesCopy.safeModeBlockedTitle,
          message: canUseStandard
            ? rolesCopy.safeModeBlockedStandard(safeLevel, blockedStatement)
            : rolesCopy.safeModeBlockedDisable(safeLevel, blockedStatement),
          confirmText: canUseStandard ? rolesCopy.safeModeUseStandard : rolesCopy.safeModeDisable,
        });
        if (!approved) return;
        useSafeModeStore.getState().setConnectionOverride(connection.id, canUseStandard ? 3 : 0);
        emitAppToast({ tone: "info", title: rolesCopy.safeModeOverrideApplied });
      }
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
      emitAppToast({
        tone: "success",
        title: t("userRoles.applied"),
        description: t("userRoles.appliedHint"),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A denied Safe Mode confirmation is a user choice, not a failure.
      emitAppToast({
        tone: "error",
        title: message.includes("Safe Mode")
          ? rolesCopy.safeModeCancelled
          : t("userRoles.applyFailed"),
        description: message.includes("Safe Mode") ? undefined : message,
      });
    } finally {
      setIsApplying(false);
    }
  }, [confirmation, connection, request, review, rolesCopy, t]);

  return (
    <div className="app-help-modal-backdrop" onClick={onClose}>
      <div
        className="app-help-modal app-user-roles-modal"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="app-help-modal-header">
          <div className="app-help-modal-copy">
            <span className="app-help-modal-kicker">{t("userRoles.kicker")}</span>
            <h3 className="app-help-modal-title">{t("userRoles.title")}</h3>
            <p className="app-help-modal-description">{t("userRoles.description")}</p>
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

        {!connection || !supportsUsersRoles ? (
          <div className="app-plugin-manager-empty">
            {capabilityProfile
              ? t("userRoles.unsupported", { engine: capabilityProfile.label })
              : t("userRoles.checkingCapabilities")}
          </div>
        ) : (
          <>
            <section className="user-role-section">
              <div className="mcp-list-header">
                <div className="mcp-section-heading">
                  <UserCog className="w-4 h-4" />
                  <span>{t("userRoles.accessTitle")}</span>
                  <span className="app-plugin-manager-badge accent">
                    {snapshot?.principals.length ?? 0}
                  </span>
                </div>
                <button
                  type="button"
                  className="icon-btn"
                  title={t("userRoles.refresh")}
                  aria-label={t("userRoles.refresh")}
                  onClick={() => void refresh()}
                  disabled={isLoading}
                >
                  <RefreshCw className={`w-4 h-4 ${isLoading ? "animate-spin" : ""}`} />
                </button>
              </div>
              {isLoading ? (
                <div className="app-plugin-manager-empty">
                  <LoaderCircle className="w-4 h-4 animate-spin" />{" "}
                  {t("userRoles.loadingPrincipals")}
                </div>
              ) : snapshot?.privilegesUnavailable ? (
                <div className="app-plugin-manager-empty">{rolesCopy.privilegesUnavailable}</div>
              ) : snapshot?.principals.length ? (
                <div className="user-role-principal-list">
                  {snapshot.principals.map((principal) => (
                    <div className="user-role-principal" key={principal.id}>
                      <div>
                        <strong>{principal.name}</strong>
                        <span>
                          {principal.host ? `@${principal.host}` : t("userRoles.serverRole")}
                          {principal.isSuperuser
                            ? ` · ${t("userRoles.superuser")}`
                            : principal.canLogin
                              ? ` · ${t("userRoles.login")}`
                              : ""}
                        </span>
                      </div>
                      <div className="user-role-tags">
                        {principal.roles.slice(0, 3).map((role) => (
                          <span key={`role-${role}`} title={t("userRoles.roleMembership")}>
                            {role}
                          </span>
                        ))}
                        {principal.directPrivileges.slice(0, 2).map((privilege) => (
                          <span key={`direct-${privilege}`} title={t("userRoles.directGrant")}>
                            {t("userRoles.directLabel", { privilege })}
                          </span>
                        ))}
                        {principal.effectivePrivileges
                          .filter((privilege) => !principal.directPrivileges.includes(privilege))
                          .slice(0, 2)
                          .map((privilege) => (
                            <span
                              key={`effective-${privilege}`}
                              title={t("userRoles.inheritedGrant")}
                            >
                              {t("userRoles.inheritedLabel", { privilege })}
                            </span>
                          ))}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="app-plugin-manager-empty">{t("userRoles.empty")}</div>
              )}
            </section>

            <section className="user-role-section">
              <div className="mcp-section-heading">
                <KeyRound className="w-4 h-4" />
                <span>{t("userRoles.stageTitle")}</span>
              </div>
              <div className="user-role-form-grid">
                <label className="mcp-field">
                  <span>{t("userRoles.action")}</span>
                  <select
                    value={action}
                    onChange={(event) => {
                      setAction(event.target.value as ChangeAction);
                      setReview(null);
                    }}
                  >
                    {ACTIONS.map((item) => (
                      <option key={item.value} value={item.value}>
                        {t(item.labelKey)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="mcp-field">
                  <span>{t("userRoles.user")}</span>
                  <input
                    value={userName}
                    onChange={(event) => setUserName(event.target.value)}
                    placeholder="analyst"
                  />
                </label>
                {actionNeedsHost ? (
                  <label className="mcp-field">
                    <span>{t("userRoles.host")}</span>
                    <input
                      value={host}
                      onChange={(event) => setHost(event.target.value)}
                      placeholder="%"
                    />
                  </label>
                ) : null}
                {actionNeedsRole ? (
                  <label className="mcp-field">
                    <span>{t("userRoles.role")}</span>
                    <input
                      value={roleName}
                      onChange={(event) => setRoleName(event.target.value)}
                      placeholder="read_only"
                    />
                  </label>
                ) : null}
                {actionNeedsPrivilege ? (
                  <>
                    <label className="mcp-field">
                      <span>{t("userRoles.privilege")}</span>
                      <select
                        value={privilege}
                        onChange={(event) => setPrivilege(event.target.value)}
                      >
                        {["SELECT", "INSERT", "UPDATE", "DELETE", "REFERENCES", "TRIGGER"].map(
                          (item) => (
                            <option key={item} value={item}>
                              {item}
                            </option>
                          ),
                        )}
                      </select>
                    </label>
                    <label className="mcp-field">
                      <span>{t("userRoles.object")}</span>
                      <input
                        value={objectName}
                        onChange={(event) => setObjectName(event.target.value)}
                        placeholder="public.orders"
                      />
                    </label>
                  </>
                ) : null}
                {action === "createUser" ? (
                  <label className="mcp-field">
                    <span>{t("userRoles.passwordOptional")}</span>
                    <input
                      type="password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      placeholder={t("userRoles.passwordHint")}
                    />
                  </label>
                ) : null}
              </div>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => void stageChange()}
                disabled={isStaging}
              >
                {isStaging ? (
                  <LoaderCircle className="w-4 h-4 animate-spin" />
                ) : (
                  <ShieldCheck className="w-4 h-4" />
                )}{" "}
                {t("userRoles.reviewChange")}
              </button>
            </section>

            {review ? (
              <section className="user-role-section user-role-review">
                <div className="mcp-section-heading">
                  <ShieldCheck className="w-4 h-4" />
                  <span>{t("userRoles.reviewSql")}</span>
                </div>
                <pre>{review.statements.join("\n")}</pre>
                <label className="mcp-field">
                  <span>{t("userRoles.typeToApply", { phrase: review.confirmationPhrase })}</span>
                  <input
                    value={confirmation}
                    onChange={(event) => setConfirmation(event.target.value)}
                  />
                </label>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void applyChange()}
                  disabled={isApplying}
                >
                  {isApplying ? (
                    <LoaderCircle className="w-4 h-4 animate-spin" />
                  ) : (
                    <ShieldCheck className="w-4 h-4" />
                  )}{" "}
                  {t("userRoles.applyChange")}
                </button>
              </section>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
