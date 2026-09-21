import { CheckCircle, XCircle, Loader2 } from "lucide-react";
import { useI18n } from "../../../i18n";
import { getConnectionErrorCopy } from "../../connection-error-copy";
import type { ConnectionTestResult } from "../connection-form-utils";
import type { TestStepStrings } from "./ConnectionTestStep.types";

export interface ConnectionTestStepProps {
  testResult: ConnectionTestResult | null;
  isTesting: boolean;
  isConnecting: boolean;
  isCreatingDatabase: boolean;
  isBootstrappingWorkspace: boolean;
  strings: TestStepStrings;
  onTest: () => void;
  onConnect: () => void;
  onClose: () => void;
}

export function ConnectionTestStep({
  testResult,
  isTesting,
  isConnecting,
  isBootstrappingWorkspace,
  strings,
  onTest,
  onConnect,
  onClose,
}: ConnectionTestStepProps) {
  const { language } = useI18n();
  const errorCopy = getConnectionErrorCopy(language);

  return (
    <div className="connection-test-step">
      {/* Test result feedback */}
      {testResult && (
        <div className={`connection-form-alert ${testResult.success ? "success" : "error"}`}>
          {testResult.success ? (
            <CheckCircle className="w-4 h-4 shrink-0 mt-0.5" />
          ) : (
            <XCircle className="w-4 h-4 shrink-0 mt-0.5" />
          )}
          <span className="break-words">
            {!testResult.success && testResult.stage ? (
              <span className="connection-form-alert-stage">
                {errorCopy.stageLabels[testResult.stage] ?? errorCopy.stageLabels.unknown}
              </span>
            ) : null}
            {testResult.message}
            {!testResult.success && testResult.hint ? (
              <span className="connection-form-alert-hint">
                {errorCopy.hintLabel}: {testResult.hint}
              </span>
            ) : null}
          </span>
        </div>
      )}

      <div className="connection-form-footer">
        <div className="connection-form-footer-left">
          <button onClick={onTest} disabled={isTesting} className="btn btn-secondary">
            {isTesting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
            {strings.testConnection}
          </button>
        </div>

        <div className="connection-form-footer-actions">
          <button onClick={onClose} className="btn btn-secondary">
            {strings.cancel}
          </button>
          <button
            onClick={onConnect}
            disabled={isConnecting || isBootstrappingWorkspace}
            className="btn btn-primary"
          >
            {isConnecting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {strings.connect}
          </button>
        </div>
      </div>
    </div>
  );
}
