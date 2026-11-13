import { useCallback, useEffect } from "react";
import { translateLanguage, type AppLanguage } from "../../../i18n";
import type { AIProviderConfig } from "../../../types";
import { resolveAIFailoverConsent } from "../../../utils/ai-failover-consent";
import { approveDataRead, dataReadScopeKey, revokeDataRead } from "../ai-data-read-approvals";
import { isVisualizationPrompt, prefersVietnameseSystemReply } from "../ai-visualization-intent";
import { useAIPanelStore } from "../store/aiPanelStore";

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
}

/**
 * Every consent gate the panel can block a run on: the remembered
 * visualization/data-read grant, the always-ask destructive consent, the
 * once-only provider failover consent, and the session data-read toggle.
 * Backed by `consentSlice` in `useAIPanelStore` so `denyPendingConsents` can be
 * invoked directly on generation cancellation or panel close without circular
 * ref forwarding (`denyPendingConsentsRef`).
 */
export function useAIConsentGates({
  connectionId,
  currentDatabase,
  language,
  activeProvider,
}: UseAIConsentGatesOptions) {
  const visualizationConsentPending = useAIPanelStore((state) => state.visualizationConsentPending);
  const destructiveConsentPending = useAIPanelStore((state) => state.destructiveConsentPending);
  const isFailoverConsentPending = useAIPanelStore((state) => state.isFailoverConsentPending);
  const isSessionDataReadEnabled = useAIPanelStore((state) => state.isSessionDataReadEnabled);

  const setVisualizationConsentPending = useAIPanelStore(
    (state) => state.setVisualizationConsentPending,
  );
  const setDestructiveConsentPending = useAIPanelStore(
    (state) => state.setDestructiveConsentPending,
  );
  const setIsFailoverConsentPending = useAIPanelStore((state) => state.setIsFailoverConsentPending);
  const setIsSessionDataReadEnabled = useAIPanelStore((state) => state.setIsSessionDataReadEnabled);
  const setVisualizationApprovalScope = useAIPanelStore(
    (state) => state.setVisualizationApprovalScope,
  );
  const openVisualizationConsentPrompt = useAIPanelStore(
    (state) => state.openVisualizationConsentPrompt,
  );
  const settleVisualizationConsent = useAIPanelStore((state) => state.settleVisualizationConsent);
  const openDestructiveConsentPrompt = useAIPanelStore(
    (state) => state.openDestructiveConsentPrompt,
  );
  const settleDestructiveConsent = useAIPanelStore((state) => state.settleDestructiveConsent);
  const denyPendingConsents = useAIPanelStore((state) => state.denyPendingConsents);

  // The agent transport raises "ai-failover-consent-request" the first time a
  // provider fails; the dialog collects the once-only decision.
  useEffect(() => {
    const onRequest = () => setIsFailoverConsentPending(true);
    window.addEventListener("ai-failover-consent-request", onRequest);
    return () => window.removeEventListener("ai-failover-consent-request", onRequest);
  }, [setIsFailoverConsentPending]);

  const handleResolveFailoverConsent = useCallback(
    (approved: boolean) => {
      setIsFailoverConsentPending(false);
      resolveAIFailoverConsent(approved);
    },
    [setIsFailoverConsentPending],
  );

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
    () => dataReadScopeKey(connectionId, currentDatabase),
    [connectionId, currentDatabase],
  );

  const applyVisualizationDecisionSideEffects = useCallback(
    (approved: boolean) => {
      const currentScope = getCurrentVisualizationApprovalScope();
      if (approved) {
        approveDataRead(connectionId, currentDatabase);
        setVisualizationApprovalScope(currentScope);
        setIsSessionDataReadEnabled(true);
      } else if (useAIPanelStore.getState().visualizationApprovalScope === currentScope) {
        revokeDataRead(connectionId, currentDatabase);
        setVisualizationApprovalScope(null);
        setIsSessionDataReadEnabled(false);
      }
    },
    [
      connectionId,
      currentDatabase,
      getCurrentVisualizationApprovalScope,
      setIsSessionDataReadEnabled,
      setVisualizationApprovalScope,
    ],
  );

  const resolveVisualizationConsent = useCallback(
    (approved: boolean) => {
      applyVisualizationDecisionSideEffects(approved);
      settleVisualizationConsent(approved);
    },
    [applyVisualizationDecisionSideEffects, settleVisualizationConsent],
  );

  const requestVisualizationReadConsent = useCallback(
    async (promptText: string) => {
      if (!connectionId) {
        return true;
      }

      if (
        useAIPanelStore.getState().visualizationApprovalScope ===
        getCurrentVisualizationApprovalScope()
      ) {
        return true;
      }

      const isVietnamese = prefersVietnameseSystemReply(promptText, language);
      const isVisualization = isVisualizationPrompt(promptText);
      const databaseLabel = currentDatabase || "current database";

      return openVisualizationConsentPrompt({
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
    },
    [
      connectionId,
      currentDatabase,
      getCurrentVisualizationApprovalScope,
      language,
      openVisualizationConsentPrompt,
    ],
  );

  const resolveDestructiveConsent = useCallback(
    (approved: boolean) => {
      settleDestructiveConsent(approved);
    },
    [settleDestructiveConsent],
  );

  const requestDestructiveConsent = useCallback(
    async (detail: { title: string; message: string; confirmText?: string; cancelText?: string }) =>
      openDestructiveConsentPrompt({
        title: detail.title,
        message: detail.message,
        confirmText: detail.confirmText ?? "Confirm",
        cancelText: detail.cancelText ?? "Cancel",
      }),
    [openDestructiveConsentPrompt],
  );

  const confirmSessionDataReadEnable = useCallback(() => {
    if (!connectionId) {
      return;
    }
    if (
      useAIPanelStore.getState().visualizationApprovalScope ===
      getCurrentVisualizationApprovalScope()
    ) {
      return;
    }
    const isVietnamese = language === "vi";
    const databaseLabel =
      currentDatabase || (isVietnamese ? "database hiện tại" : "the current database");
    void openVisualizationConsentPrompt({
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
    openVisualizationConsentPrompt,
  ]);

  const setSessionDataReadEnabled = useCallback(
    (enabled: boolean) => {
      if (enabled) {
        confirmSessionDataReadEnable();
        return;
      }

      settleVisualizationConsent(false);
      revokeDataRead(connectionId, currentDatabase);
      setVisualizationApprovalScope(null);
      setVisualizationConsentPending(null);
      setIsSessionDataReadEnabled(false);
    },
    [
      confirmSessionDataReadEnable,
      connectionId,
      currentDatabase,
      setIsSessionDataReadEnabled,
      setVisualizationApprovalScope,
      setVisualizationConsentPending,
      settleVisualizationConsent,
    ],
  );

  return {
    denyPendingConsents,
    destructiveConsentPending,
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
    setVisualizationApprovalScope,
    setVisualizationConsentPending,
    visualizationConsentPending,
  };
}
