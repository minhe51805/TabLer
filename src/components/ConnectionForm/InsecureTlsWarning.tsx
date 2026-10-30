import { useState } from "react";
import { useI18n } from "../../i18n";
import type { InsecureTlsWarning as InsecureTlsDetails } from "../../utils/connection-tls";
import { getConnectionTlsCopy } from "./connection-tls-copy";
import "./connection-tls.css";

export const INSECURE_TLS_DISMISSAL_KEY = "tabler.insecureTlsWarningDismissed";

export function InsecureTlsWarning({ warning }: { warning: InsecureTlsDetails }) {
  const { language } = useI18n();
  const copy = getConnectionTlsCopy(language);
  const [dismissed, setDismissed] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem(INSECURE_TLS_DISMISSAL_KEY) === "1";
    } catch {
      return false;
    }
  });

  if (dismissed) return null;

  const dismiss = () => {
    try {
      window.localStorage.setItem(INSECURE_TLS_DISMISSAL_KEY, "1");
    } catch {
      // The current view still dismisses when storage is unavailable.
    }
    setDismissed(true);
  };

  return (
    <div className="connection-tls-warning" role="alert">
      <div className="connection-tls-warning-copy">
        <strong>{copy.title}</strong>
        <span className="connection-tls-warning-reason">{warning.reason}</span>
      </div>
      <button type="button" className="connection-tls-warning-dismiss" onClick={dismiss}>
        {copy.dismiss}
      </button>
    </div>
  );
}
