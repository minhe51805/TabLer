import { useCallback, useEffect, useRef, useState } from "react";
import { translateLanguage, type AppLanguage } from "../../../i18n";
import {
  denyPendingAIFailoverConsent,
  resolveAIFailoverConsent,
} from "../../../utils/ai-failover-consent";
import { approveDataRead, dataReadScopeKey, revokeDataRead } from "../ai-data-read-approvals";
import { isVisualizationPrompt, prefersVietnameseSystemReply } from "../ai-visualization-intent";
import type { AIProviderConfig } from "../../../types";

export interface VisualizationReadConsentState {
  title: string;
  message: string;
  confirmText: string;
  cancelText: string;
}

interface UseAIConsentGatesOptions {
  connectionId: string | null;
  currentDatabase: string | null;
  language: AppLanguage;
  activeProvider: AIProviderConfig | null | undefined;
  /** Runs synchronously right after the panel opens / the database changes,
   *  AFTER useAIWorkspaceEffects has cleared the approval — kept in the caller
   *  because effect ordering across hooks is call-order dependent. */
}

/**
 * Every consent gate the panel can block a run on: the remembered
 * visualization/data-read grant, the always-ask destructive consent, the
 * once-only provider failover consent, and the session data-read toggle.
 * Resolvers live in refs so a cancelled run can deny every pending dialog at
 * once through `denyPendingConsents` — denials are never persisted, a stopped
 * run is not a user decision.
 */
export function useAIConsentGates({
  connectionId,
  currentDatabase,
  language,
  activeProvider,
}: UseAIConsentGatesOptions) {
  const visualizationConsentResolverRef = useRef<((value: boolean) => void) | null>(null);
  const visualizationApprovalScopeRef = useRef<string | null>(null);
  const destructiveConsentResolverRef = useRef<((approved: boolean) => void) | null>(null);
  const [visualizationConsentPending, setVisualizationConsentPending] =
    useState<VisualizationReadConsentState | null>(null);
  const [destructiveConsentPending, setDestructiveConsentPending] =
    useState<VisualizationReadConsentState | null>(null);
  const [isFailoverConsentPending, setIsFailoverConsentPending] = useState(false);
  const [isSessionDataReadEnabled, setIsSessionDataReadEnabled] = useState(false);

  // Deny every consent this component can be waiting on. Denials are never
  // persisted — a cancelled run is not a user decision, so the question may
  // be asked again on the next run.
  const denyPendingConsents = useCallback(() => {
    visualizationConsentResolverRef.current?.(false);
    visualizationConsentResolverRef.current = null;
    setVisualizationConsentPending(null);
    destructiveConsentResolverRef.current?.(false);
    destructiveConsentResolverRef.current = null;
    setDestructiveConsentPending(null);
    denyPendingAIFailoverConsent();
    setIsFailoverConsentPending(false);
  }, []);

  // The agent hook raises "ai-failover-consent-request" the first time a
  // provider fails; the dialog below collects the once-only decision.
  useEffect(() => {
    const onRequest = () => setIsFailoverConsentPending(true);
    window.addEventListener("ai-failover-consent-request", onRequest);
    return () => window.removeEventListener("ai-failover-consent-request", onRequest);
  }, []);

  const handleResolveFailoverConsent = useCallback((approved: boolean) => {
    setIsFailoverConsentPending(false);
    resolveAIFailoverConsent(approved);
  }, []);

  const failoverConsentState = isFailoverConsentPending
    ? {
        title: translateLanguage(language, "ai.failover.consentTitle"),
        message: translateLanguage(language, "ai.failover.consentBody", {
          failed: activeProvider?.name?.trim() || activeProvider?.model?.trim() || "",
        }),
        confirmText: translateLanguage(language, "ai.failover.consentAllow"),
        cancelText: translateLanguage(language, "ai.failover.consentDeny"),
      }
    : null;

  const getCurrentVisualizationApprovalScope = useCallback(
    // Persistent scope: connection + database only. Once a database is
    // approved the prompt stays quiet across app launches and AI sessions
    // (see ai-data-read-approvals.ts).
    () => dataReadScopeKey(connectionId, currentDatabase),
    [connectionId, currentDatabase],
  );

  const resolveVisualizationConsent = useCallback(
    (approved: boolean) => {
      const resolver = visualizationConsentResolverRef.current;
      visualizationConsentResolverRef.current = null;
      setVisualizationConsentPending(null);
      if (approved) {
        approveDataRead(connectionId, currentDatabase);
        visualizationApprovalScopeRef.current = getCurrentVisualizationApprovalScope();
        setIsSessionDataReadEnabled(true);
      } else if (visualizationApprovalScopeRef.current === getCurrentVisualizationApprovalScope()) {
        revokeDataRead(connectionId, currentDatabase);
        visualizationApprovalScopeRef.current = null;
        setIsSessionDataReadEnabled(false);
      }
      resolver?.(approved);
    },
    [connectionId, currentDatabase, getCurrentVisualizationApprovalScope],
  );

  const requestVisualizationReadConsent = useCallback(
    async (promptText: string) => {
      if (!connectionId) {
        return true;
      }

      if (visualizationApprovalScopeRef.current === getCurrentVisualizationApprovalScope()) {
        return true;
      }

      if (visualizationConsentResolverRef.current) {
        visualizationConsentResolverRef.current(false);
        visualizationConsentResolverRef.current = null;
      }

      const isVietnamese = prefersVietnameseSystemReply(promptText, language);
      const isVisualization = isVisualizationPrompt(promptText);
      const databaseLabel = currentDatabase || "current database";

      return new Promise<boolean>((resolve) => {
        visualizationConsentResolverRef.current = resolve;
        setVisualizationConsentPending({
          title: isVietnamese
            ? isVisualization
              ? "Cấp quyền đọc data để vẽ biểu đồ?"
              : "Cấp quyền đọc data cho Agent?"
            : isVisualization
              ? "Allow AI to read data for charts?"
              : "Allow Agent to read live data?",
          message: isVietnamese
            ? isVisualization
              ? `Model đã có schema để hiểu cấu trúc DB. Bước tiếp theo cần đọc dữ liệu chỉ-đọc trong ${databaseLabel} để tạo chart/dashboard. Quyền sẽ được ghi nhớ cho database này, không hỏi lại. Bạn có muốn tiếp tục không?`
              : `Agent đã có schema để hiểu cấu trúc DB. Bước tiếp theo cần đọc dữ liệu chỉ-đọc trong ${databaseLabel} để trả lời. Quyền sẽ được ghi nhớ cho database này, không hỏi lại. Bạn có muốn tiếp tục không?`
            : isVisualization
              ? `The model already has a schema capsule for structure. The next step needs read-only access to live data in ${databaseLabel} to build charts or dashboards. The grant is remembered for this database and will not be asked again. Continue?`
              : `The agent already has the database schema. The next step needs read-only access to live data in ${databaseLabel} to answer your request. The grant is remembered for this database and will not be asked again. Continue?`,
          confirmText: isVietnamese ? "Cho phép đọc data" : "Allow data read",
          cancelText: isVietnamese ? "Không cho phép" : "Deny",
        });
      });
    },
    [connectionId, currentDatabase, getCurrentVisualizationApprovalScope, language],
  );

  // Destructive-action consent: ALWAYS asks, every single time. It never
  // reuses the standing data-read grant (which silently auto-approves) and
  // never persists an approval. Used for irreversible operations such as the
  // agent's delete_memory, which must not ride on a read permission.
  const resolveDestructiveConsent = useCallback((approved: boolean) => {
    const resolver = destructiveConsentResolverRef.current;
    destructiveConsentResolverRef.current = null;
    setDestructiveConsentPending(null);
    resolver?.(approved);
  }, []);

  const requestDestructiveConsent = useCallback(
    async (detail: {
      title: string;
      message: string;
      confirmText?: string;
      cancelText?: string;
    }) => {
      // A new destructive prompt cancels any still-pending one (resolved false).
      destructiveConsentResolverRef.current?.(false);
      destructiveConsentResolverRef.current = null;
      return new Promise<boolean>((resolve) => {
        destructiveConsentResolverRef.current = resolve;
        setDestructiveConsentPending({
          title: detail.title,
          message: detail.message,
          confirmText: detail.confirmText ?? "Confirm",
          cancelText: detail.cancelText ?? "Cancel",
        });
      });
    },
    [],
  );

  // Clicking the Data toggle only OPENS the confirmation dialog; the grant
  // happens in resolveVisualizationConsent once the user confirms, so no
  // permission is ever remembered from a single click.
  const confirmSessionDataReadEnable = useCallback(() => {
    if (!connectionId) {
      return;
    }
    if (visualizationApprovalScopeRef.current === getCurrentVisualizationApprovalScope()) {
      return;
    }
    if (visualizationConsentResolverRef.current) {
      visualizationConsentResolverRef.current(false);
      visualizationConsentResolverRef.current = null;
    }
    const isVietnamese = language === "vi";
    const databaseLabel =
      currentDatabase || (isVietnamese ? "database hiện tại" : "the current database");
    visualizationConsentResolverRef.current = (approved: boolean) => {
      resolveVisualizationConsent(approved);
    };
    setVisualizationConsentPending({
      title: isVietnamese ? "Cho phép AI đọc live data?" : "Allow AI to read live data?",
      message: isVietnamese
        ? `TableR sẽ cho AI đọc dữ liệu chỉ-đọc trong ${databaseLabel} cho đến khi bạn tắt quyền này hoặc đổi sang database khác. Quyền được ghi nhớ, không hỏi lại. Tiếp tục?`
        : `TableR will let the AI read read-only data in ${databaseLabel} until you turn this off or switch databases. The grant is remembered and will not be asked again. Continue?`,
      confirmText: isVietnamese ? "Cho phép đọc data" : "Allow data read",
      cancelText: isVietnamese ? "Không cho phép" : "Deny",
    });
  }, [
    connectionId,
    currentDatabase,
    getCurrentVisualizationApprovalScope,
    language,
    resolveVisualizationConsent,
  ]);

  const setSessionDataReadEnabled = useCallback(
    (enabled: boolean) => {
      if (enabled) {
        confirmSessionDataReadEnable();
        return;
      }

      if (visualizationConsentResolverRef.current) {
        visualizationConsentResolverRef.current(false);
        visualizationConsentResolverRef.current = null;
      }
      // An explicit toggle back to Ask re-arms the prompt for this database
      // only; approvals for other databases stay remembered.
      revokeDataRead(connectionId, currentDatabase);
      visualizationApprovalScopeRef.current = null;
      setVisualizationConsentPending(null);
      setIsSessionDataReadEnabled(false);
    },
    [confirmSessionDataReadEnable, connectionId, currentDatabase],
  );

  return {
    denyPendingConsents,
    destructiveConsentPending,
    destructiveConsentResolverRef,
    failoverConsentState,
    getCurrentVisualizationApprovalScope,
    handleResolveFailoverConsent,
    isSessionDataReadEnabled,
    requestDestructiveConsent,
    requestVisualizationReadConsent,
    resolveDestructiveConsent,
    resolveVisualizationConsent,
    setDestructiveConsentPending,
    setIsSessionDataReadEnabled,
    setSessionDataReadEnabled,
    setVisualizationConsentPending,
    visualizationApprovalScopeRef,
    visualizationConsentPending,
    visualizationConsentResolverRef,
  };
}
