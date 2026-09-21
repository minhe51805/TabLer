import { useEffect, useMemo, useState } from "react";
import { CalendarClock, Play, Sparkles, Trash2, X } from "lucide-react";
import { useI18n, type TranslationKey } from "../../i18n";
import { useQuerySchedulesStore } from "../../stores/query-schedules-store";
import {
  describeTaskWait,
  useAgentScheduleStore,
  type AgentTaskWaitReason,
} from "../../stores/agent-schedule-store";
import { useConnectionStore } from "../../stores/connectionStore";
import { useAppLayoutStore } from "../../stores/appLayoutStore";
import { emitAppToast } from "../../utils/app-toast";
import { requestAppConfirmation } from "../../stores/confirmStore";
import { getScheduleCopy } from "./schedule-copy";
import "../../styles/lazy-overlays.css";

const MINUTE_OPTIONS = [5, 15, 30, 60, 180, 360, 720, 1440];

type ScheduleKind = "sql" | "agent";

function formatInterval(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds >= 60) return `${Math.round(seconds / 60)}m`;
  return `${seconds}s`;
}

function relativeTime(millis: number | null | undefined): string {
  if (!millis) return "—";
  const deltaSeconds = Math.round((Date.now() - millis) / 1000);
  if (deltaSeconds < 60) return `${deltaSeconds}s ago`;
  if (deltaSeconds < 3600) return `${Math.round(deltaSeconds / 60)}m ago`;
  if (deltaSeconds < 86_400) return `${Math.round(deltaSeconds / 3600)}h ago`;
  return `${Math.round(deltaSeconds / 86_400)}d ago`;
}

/** Localized name of the reason a dispatched agent task has not started. */
function waitReasonLabelKey(reason: AgentTaskWaitReason): TranslationKey {
  switch (reason) {
    case "connection":
      return "schedules.agentWaitConnection";
    case "database":
      return "schedules.agentWaitDatabase";
    case "busy":
      return "schedules.agentWaitBusy";
  }
}

export function QuerySchedulesPanel({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { t, language } = useI18n();
  const copy = getScheduleCopy(language);
  const {
    schedules,
    isLoading,
    loadSchedules,
    saveSchedule,
    deleteSchedule,
    acknowledgeMissedRuns,
  } = useQuerySchedulesStore();
  const agentRuns = useAgentScheduleStore((state) => state.runs);
  const connections = useConnectionStore((state) => state.connections);
  const activeConnectionId = useConnectionStore((state) => state.activeConnectionId);
  const currentDatabase = useConnectionStore((state) => state.currentDatabase);
  const draftSql = useAppLayoutStore((state) => state.querySchedulesDraftSql);
  const setDraftSql = useAppLayoutStore((state) => state.setQuerySchedulesDraftSql);

  const [editor, setEditor] = useState<{
    open: boolean;
    id?: string;
    kind: ScheduleKind;
    name: string;
    sql: string;
    prompt: string;
    connectionId: string;
    database: string;
    intervalMinutes: number;
    enabled: boolean;
    catchUpPolicy: "skip" | "run_once";
  }>({
    open: false,
    kind: "sql",
    name: "",
    sql: "",
    prompt: "",
    connectionId: "",
    database: "",
    intervalMinutes: 60,
    enabled: true,
    catchUpPolicy: "skip",
  });
  // The kind is fixed once a schedule exists: a row is either a statement the
  // backend runs or a task the app runs, and converting one into the other would
  // silently discard whichever field it was created with.
  const kindLocked = Boolean(editor.id);

  // Hydrate the list + the draft SQL handed over by the favorites panel.
  useEffect(() => {
    if (!isOpen) return;
    void loadSchedules();
    if (draftSql) {
      setEditor((current) =>
        current.open || current.sql
          ? current
          : {
              ...current,
              open: true,
              kind: "sql",
              sql: draftSql,
              connectionId: activeConnectionId ?? "",
              database: currentDatabase ?? "",
            },
      );
      setDraftSql(null);
    }
  }, [isOpen, draftSql, activeConnectionId, currentDatabase, loadSchedules, setDraftSql]);

  const canSave = useMemo(
    () =>
      Boolean(
        editor.name.trim() &&
        editor.connectionId &&
        (editor.kind === "agent" ? editor.prompt.trim() : editor.sql.trim()),
      ),
    [editor],
  );

  // Occurrences that elapsed while the app was closed, summed across schedules.
  const missedTotal = schedules.reduce((sum, s) => sum + (s.missedCount ?? 0), 0);

  const handleSave = async () => {
    if (!canSave) return;
    try {
      await saveSchedule({
        id: editor.id,
        name: editor.name.trim(),
        kind: editor.kind,
        sql: editor.kind === "sql" ? editor.sql.trim() : "",
        prompt: editor.kind === "agent" ? editor.prompt.trim() : null,
        connectionId: editor.connectionId,
        database: editor.database.trim() || null,
        intervalSeconds: editor.intervalMinutes * 60,
        catchUpPolicy: editor.catchUpPolicy,
        enabled: editor.enabled,
      });
      emitAppToast({ title: t("schedules.saved"), tone: "success" });
      setEditor({
        open: false,
        kind: "sql",
        name: "",
        sql: "",
        prompt: "",
        connectionId: "",
        database: "",
        intervalMinutes: 60,
        enabled: true,
        catchUpPolicy: "skip",
      });
    } catch (error) {
      emitAppToast({
        title: t("schedules.saveFailed"),
        description: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    }
  };

  const handleDelete = async (id: string) => {
    const schedule = schedules.find((item) => item.id === id);
    const approved = await requestAppConfirmation({
      title: t("confirm.deleteScheduleTitle"),
      message: t("confirm.deleteScheduleMessage", { name: schedule?.name ?? id }),
      confirmText: t("schedules.delete"),
    });
    if (!approved) return;
    try {
      await deleteSchedule(id);
    } catch (error) {
      emitAppToast({
        title: t("schedules.deleteFailed"),
        description: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fav-overlay" role="presentation" onClick={onClose}>
      <aside
        className="fav-panel"
        role="dialog"
        aria-label={t("schedules.title")}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="fav-header">
          <h2 className="fav-title">
            <CalendarClock className="w-4 h-4" /> {t("schedules.title")}
          </h2>
          <button type="button" className="fav-close" aria-label="Close" onClick={onClose}>
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Occurrences that elapsed while the app was closed are recorded at
            boot; the badge stays until the user acknowledges it. */}
        {missedTotal > 0 && (
          <div className="fav-entry-desc schedules-missed-banner" role="status">
            <span>{copy.missedBanner(missedTotal)}</span>
            <button
              type="button"
              className="fav-action-btn"
              onClick={() => void acknowledgeMissedRuns()}
            >
              {copy.missedDismiss}
            </button>
          </div>
        )}

        {editor.open ? (
          <div className="fav-form">
            <div className="fav-form-field">
              <label className="fav-form-label">{t("schedules.name")} *</label>
              <input
                type="text"
                className="fav-form-input"
                value={editor.name}
                onChange={(event) =>
                  setEditor((current) => ({ ...current, name: event.target.value }))
                }
                autoFocus
              />
            </div>
            <div className="fav-form-field">
              <label className="fav-form-label">{t("schedules.kind")}</label>
              <select
                className="fav-form-input"
                value={editor.kind}
                disabled={kindLocked}
                title={kindLocked ? t("schedules.kindLocked") : undefined}
                onChange={(event) =>
                  setEditor((current) => ({ ...current, kind: event.target.value as ScheduleKind }))
                }
              >
                <option value="sql">{t("schedules.kindSql")}</option>
                <option value="agent">{t("schedules.kindAgent")}</option>
              </select>
            </div>
            {editor.kind === "sql" ? (
              <div className="fav-form-field">
                <label className="fav-form-label">{t("schedules.sql")} *</label>
                <textarea
                  className="fav-form-textarea"
                  rows={6}
                  value={editor.sql}
                  onChange={(event) =>
                    setEditor((current) => ({ ...current, sql: event.target.value }))
                  }
                  spellCheck={false}
                />
              </div>
            ) : (
              <div className="fav-form-field">
                <label className="fav-form-label">{t("schedules.agentPrompt")} *</label>
                <textarea
                  className="fav-form-textarea"
                  rows={6}
                  value={editor.prompt}
                  placeholder={t("schedules.agentPromptPlaceholder")}
                  onChange={(event) =>
                    setEditor((current) => ({ ...current, prompt: event.target.value }))
                  }
                />
                {/* Said before the task exists, not after it fails: an agent task
                    runs unattended, read-only, and only while the app is open. */}
                <p className="fav-entry-desc">{t("schedules.agentReadOnlyHint")}</p>
              </div>
            )}
            <div className="fav-form-field">
              <label className="fav-form-label">{t("schedules.connection")} *</label>
              <select
                className="fav-form-input"
                value={editor.connectionId}
                onChange={(event) =>
                  setEditor((current) => ({ ...current, connectionId: event.target.value }))
                }
              >
                <option value="">—</option>
                {connections.map((connection) => (
                  <option key={connection.id} value={connection.id}>
                    {connection.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="fav-form-field">
              <label className="fav-form-label">{t("schedules.database")}</label>
              <input
                type="text"
                className="fav-form-input"
                value={editor.database}
                onChange={(event) =>
                  setEditor((current) => ({ ...current, database: event.target.value }))
                }
              />
            </div>
            <div className="fav-form-field">
              <label className="fav-form-label">{t("schedules.interval")}</label>
              <select
                className="fav-form-input"
                value={editor.intervalMinutes}
                onChange={(event) =>
                  setEditor((current) => ({
                    ...current,
                    intervalMinutes: Number(event.target.value),
                  }))
                }
              >
                {MINUTE_OPTIONS.map((minutes) => (
                  <option key={minutes} value={minutes}>
                    {minutes}m
                  </option>
                ))}
              </select>
            </div>
            <div className="fav-form-field">
              <label className="fav-form-label">{copy.catchUp}</label>
              <select
                className="fav-form-input"
                value={editor.catchUpPolicy}
                onChange={(event) =>
                  setEditor((current) => ({
                    ...current,
                    catchUpPolicy: event.target.value as "skip" | "run_once",
                  }))
                }
              >
                <option value="skip">{copy.catchUpSkip}</option>
                <option value="run_once">{copy.catchUpRunOnce}</option>
              </select>
            </div>
            <div className="fav-form-field">
              <label className="fav-form-label">
                <input
                  type="checkbox"
                  checked={editor.enabled}
                  onChange={(event) =>
                    setEditor((current) => ({ ...current, enabled: event.target.checked }))
                  }
                />{" "}
                {t("schedules.enabled")}
              </label>
            </div>
            <div className="fav-form-actions">
              <button
                type="button"
                className="fav-form-cancel"
                onClick={() => setEditor((current) => ({ ...current, open: false }))}
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="fav-form-submit"
                disabled={!canSave}
                onClick={() => void handleSave()}
              >
                {t("schedules.save")}
              </button>
            </div>
          </div>
        ) : isLoading ? (
          <div className="fav-empty">Loading...</div>
        ) : schedules.length === 0 ? (
          <div className="fav-empty">{t("schedules.empty")}</div>
        ) : (
          schedules.map((schedule) => {
            const isAgent = schedule.kind === "agent";
            const queuedRun = agentRuns.find((run) => run.scheduleId === schedule.id);
            // Why a dispatched task has not started. Shown from the app's real
            // state, so a task that cannot run is never mistaken for a task that
            // ran.
            const waitReason =
              queuedRun?.status === "waiting"
                ? describeTaskWait(queuedRun, {
                    connectionId: activeConnectionId,
                    database: currentDatabase,
                    isBusy: false,
                  })
                : null;
            const statusGlyph =
              schedule.lastStatus === "error"
                ? "⚠"
                : schedule.lastStatus === "needs_human"
                  ? "?"
                  : schedule.lastStatus === "dispatched"
                    ? "…"
                    : schedule.lastStatus === "missed"
                      ? copy.statusMissed
                      : schedule.lastStatus
                        ? "✓"
                        : "new";
            return (
              <div
                key={schedule.id}
                className="fav-entry"
                title={isAgent ? (schedule.prompt ?? "") : schedule.sql}
              >
                <div className="fav-entry-header">
                  {isAgent ? (
                    <Sparkles
                      className={`w-3.5 h-3.5 ${schedule.enabled ? "text-[var(--accent)]" : "text-[var(--text-dim)]"}`}
                    />
                  ) : (
                    <CalendarClock
                      className={`w-3.5 h-3.5 ${schedule.enabled ? "text-[var(--accent)]" : "text-[var(--text-dim)]"}`}
                    />
                  )}
                  <span className="fav-entry-name">{schedule.name}</span>
                  <span className="fav-tag">
                    {t(isAgent ? "schedules.tagAgent" : "schedules.tagSql")}
                  </span>
                  <span className="fav-tag">{formatInterval(schedule.intervalSeconds)}</span>
                  <span
                    className="fav-tag"
                    title={
                      schedule.lastError ??
                      (schedule.lastStatus === "dispatched"
                        ? t("schedules.agentDispatchedStatus")
                        : undefined)
                    }
                  >
                    {statusGlyph}
                  </span>
                </div>
                <p className="fav-entry-desc">
                  {t("schedules.lastRan")}: {relativeTime(schedule.lastRanAt)}
                  {schedule.lastRows != null ? ` · ${schedule.lastRows} rows` : ""}
                </p>
                {queuedRun && (
                  <p className="fav-entry-desc">
                    {queuedRun.status === "running"
                      ? t("schedules.agentRunning")
                      : t("schedules.agentWaiting")}
                    {waitReason ? ` — ${t(waitReasonLabelKey(waitReason))}` : ""}
                  </p>
                )}
                {!queuedRun && isAgent && schedule.lastStatus === "dispatched" && (
                  <p className="fav-entry-desc">{t("schedules.agentDispatchedStatus")}</p>
                )}
                {schedule.lastStatus === "needs_human" && (
                  <p className="fav-entry-desc">{t("schedules.agentNeedsHuman")}</p>
                )}
                {schedule.lastSummary && <p className="fav-entry-desc">{schedule.lastSummary}</p>}
                {schedule.lastError && <p className="fav-entry-desc">{schedule.lastError}</p>}
                <div className="fav-entry-actions">
                  <button
                    type="button"
                    className="fav-action-btn primary"
                    title={t("schedules.edit")}
                    onClick={() =>
                      setEditor({
                        open: true,
                        id: schedule.id,
                        kind: schedule.kind,
                        name: schedule.name,
                        sql: schedule.sql,
                        prompt: schedule.prompt ?? "",
                        connectionId: schedule.connectionId ?? "",
                        database: schedule.database ?? "",
                        intervalMinutes: Math.max(1, Math.round(schedule.intervalSeconds / 60)),
                        enabled: schedule.enabled,
                        catchUpPolicy: schedule.catchUpPolicy ?? "skip",
                      })
                    }
                  >
                    <Play className="w-3 h-3.5" />
                  </button>
                  <button
                    type="button"
                    className="fav-action-btn danger"
                    title={t("schedules.delete")}
                    onClick={() => void handleDelete(schedule.id)}
                  >
                    <Trash2 className="w-3 h-3.5" />
                  </button>
                </div>
              </div>
            );
          })
        )}

        {!editor.open && (
          <div className="fav-form-actions">
            <button
              type="button"
              className="fav-form-submit"
              onClick={() =>
                setEditor({
                  open: true,
                  kind: "sql",
                  name: "",
                  sql: "",
                  prompt: "",
                  connectionId: activeConnectionId ?? "",
                  database: currentDatabase ?? "",
                  intervalMinutes: 60,
                  enabled: true,
                  catchUpPolicy: "skip",
                })
              }
            >
              + {t("schedules.new")}
            </button>
          </div>
        )}
      </aside>
    </div>
  );
}
