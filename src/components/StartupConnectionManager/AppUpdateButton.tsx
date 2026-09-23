import { ArrowUpCircle, RefreshCw, X } from "lucide-react";
import { useState } from "react";
import { useI18n } from "../../i18n";
import { getAppUpdateCopy } from "./app-update-copy";
import { useAppUpdater } from "./use-app-updater";
import "./app-update.css";

/**
 * Compact "Update" pill shown next to the app version in the topbars once a
 * newer release is detected. Clicking it opens a confirm popup; accepting
 * downloads + installs the update and relaunches the app. When the background
 * check fails the pill degrades to a quiet retry state instead of vanishing.
 */
export function AppUpdateButton() {
  const { language } = useI18n();
  const { update, phase, progress, error, checkError, checkForUpdate, installUpdate, dismiss } =
    useAppUpdater();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const labels = getAppUpdateCopy(language);

  if (!update || phase === "idle") {
    if (checkError && phase !== "checking") {
      return (
        <div className="app-update" data-no-window-drag="true">
          <button
            type="button"
            className="app-update-btn is-retry"
            onClick={() => void checkForUpdate()}
            title={labels.checkFailed(checkError)}
          >
            <RefreshCw className="w-3 h-3" />
            {labels.retry}
          </button>
        </div>
      );
    }
    return null;
  }

  const busy = phase === "downloading" || phase === "installing";

  return (
    <div className="app-update" data-no-window-drag="true">
      <button
        type="button"
        className={`app-update-btn ${busy ? "is-busy" : ""}`}
        onClick={() => {
          if (!busy) setConfirmOpen((open) => !open);
        }}
        title={`${labels.button} → v${update.version}`}
      >
        {busy ? (
          <RefreshCw className="app-update-spin w-3 h-3" />
        ) : (
          <ArrowUpCircle className="w-3 h-3" />
        )}
        {phase === "downloading" ? `${progress}%` : phase === "installing" ? "…" : labels.button}
      </button>

      {confirmOpen && phase === "available" ? (
        <div className="app-update-popup" data-no-window-drag="true">
          <div className="app-update-popup-head">
            <strong>{labels.title}</strong>
            <button
              type="button"
              className="app-update-popup-close"
              onClick={() => setConfirmOpen(false)}
              aria-label={labels.later}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <p className="app-update-popup-version">
            {labels.available} <strong>v{update.version}</strong>
          </p>
          {update.notes ? <pre className="app-update-notes">{update.notes}</pre> : null}
          {error ? <p className="app-update-error">{error}</p> : null}
          {busy ? (
            <div>
              <div className="app-update-progress">
                <div
                  className="app-update-progress-bar"
                  style={{ width: `${phase === "installing" ? 100 : progress}%` }}
                />
              </div>
              <p className="app-update-popup-status">
                {phase === "installing" ? labels.installing : labels.downloading}
              </p>
            </div>
          ) : (
            <div className="app-update-actions">
              <button
                type="button"
                className="app-update-secondary"
                onClick={() => {
                  setConfirmOpen(false);
                  dismiss();
                }}
              >
                {labels.later}
              </button>
              <button
                type="button"
                className="app-update-primary"
                onClick={() => void installUpdate()}
              >
                {labels.install}
              </button>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
