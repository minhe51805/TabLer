import { useEffect, useMemo, useState } from "react";
import { CalendarClock, Play, Trash2, X } from "lucide-react";
import { useI18n } from "../../i18n";
import { useQuerySchedulesStore } from "../../stores/query-schedules-store";
import { useConnectionStore } from "../../stores/connectionStore";
import { useAppLayoutStore } from "../../stores/appLayoutStore";
import { emitAppToast } from "../../utils/app-toast";
import "../../styles/lazy-overlays.css";

const MINUTE_OPTIONS = [5, 15, 30, 60, 180, 360, 720, 1440];

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

export function QuerySchedulesPanel({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { schedules, isLoading, loadSchedules, saveSchedule, deleteSchedule } = useQuerySchedulesStore();
  const connections = useConnectionStore((state) => state.connections);
  const activeConnectionId = useConnectionStore((state) => state.activeConnectionId);
  const currentDatabase = useConnectionStore((state) => state.currentDatabase);
  const draftSql = useAppLayoutStore((state) => state.querySchedulesDraftSql);
  const setDraftSql = useAppLayoutStore((state) => state.setQuerySchedulesDraftSql);

  const [editor, setEditor] = useState<{
    open: boolean;
    id?: string;
    name: string;
    sql: string;
    connectionId: string;
    database: string;
    intervalMinutes: number;
    enabled: boolean;
  }>({ open: false, name: "", sql: "", connectionId: "", database: "", intervalMinutes: 60, enabled: true });

  // Hydrate the list + the draft SQL handed over by the favorites panel.
  useEffect(() => {
    if (!isOpen) return;
    void loadSchedules();
    if (draftSql) {
      setEditor((current) => (current.open || current.sql ? current : { ...current, open: true, sql: draftSql, connectionId: activeConnectionId ?? "", database: currentDatabase ?? "" }));
      setDraftSql(null);
    }
  }, [isOpen, draftSql, activeConnectionId, currentDatabase, loadSchedules, setDraftSql]);

  const canSave = useMemo(
    () => Boolean(editor.name.trim() && editor.sql.trim() && editor.connectionId),
    [editor],
  );

  const handleSave = async () => {
    if (!canSave) return;
    try {
      await saveSchedule({
        id: editor.id,
        name: editor.name.trim(),
        sql: editor.sql.trim(),
        connectionId: editor.connectionId,
        database: editor.database.trim() || null,
        intervalSeconds: editor.intervalMinutes * 60,
        enabled: editor.enabled,
      });
      emitAppToast({ title: t("schedules.saved"), tone: "success" });
      setEditor({ open: false, name: "", sql: "", connectionId: "", database: "", intervalMinutes: 60, enabled: true });
    } catch (error) {
      emitAppToast({
        title: t("schedules.saveFailed"),
        description: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    }
  };

  const handleDelete = async (id: string) => {
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

        {editor.open ? (
          <div className="fav-form">
            <div className="fav-form-field">
              <label className="fav-form-label">{t("schedules.name")} *</label>
              <input
                type="text"
                className="fav-form-input"
                value={editor.name}
                onChange={(event) => setEditor((current) => ({ ...current, name: event.target.value }))}
                autoFocus
              />
            </div>
            <div className="fav-form-field">
              <label className="fav-form-label">{t("schedules.sql")} *</label>
              <textarea
                className="fav-form-textarea"
                rows={6}
                value={editor.sql}
                onChange={(event) => setEditor((current) => ({ ...current, sql: event.target.value }))}
                spellCheck={false}
              />
            </div>
            <div className="fav-form-field">
              <label className="fav-form-label">{t("schedules.connection")} *</label>
              <select
                className="fav-form-input"
                value={editor.connectionId}
                onChange={(event) => setEditor((current) => ({ ...current, connectionId: event.target.value }))}
              >
                <option value="">—</option>
                {connections.map((connection) => (
                  <option key={connection.id} value={connection.id}>{connection.name}</option>
                ))}
              </select>
            </div>
            <div className="fav-form-field">
              <label className="fav-form-label">{t("schedules.database")}</label>
              <input
                type="text"
                className="fav-form-input"
                value={editor.database}
                onChange={(event) => setEditor((current) => ({ ...current, database: event.target.value }))}
              />
            </div>
            <div className="fav-form-field">
              <label className="fav-form-label">{t("schedules.interval")}</label>
              <select
                className="fav-form-input"
                value={editor.intervalMinutes}
                onChange={(event) => setEditor((current) => ({ ...current, intervalMinutes: Number(event.target.value) }))}
              >
                {MINUTE_OPTIONS.map((minutes) => (
                  <option key={minutes} value={minutes}>{minutes}m</option>
                ))}
              </select>
            </div>
            <div className="fav-form-field">
              <label className="fav-form-label">
                <input
                  type="checkbox"
                  checked={editor.enabled}
                  onChange={(event) => setEditor((current) => ({ ...current, enabled: event.target.checked }))}
                /> {t("schedules.enabled")}
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
          schedules.map((schedule) => (
            <div key={schedule.id} className="fav-entry" title={schedule.sql}>
              <div className="fav-entry-header">
                <CalendarClock className={`w-3.5 h-3.5 ${schedule.enabled ? "text-[var(--accent)]" : "text-[var(--text-dim)]"}`} />
                <span className="fav-entry-name">{schedule.name}</span>
                <span className="fav-tag">{formatInterval(schedule.intervalSeconds)}</span>
                <span className="fav-tag" title={schedule.lastError ?? undefined}>
                  {schedule.lastStatus === "error" ? "⚠" : schedule.lastStatus ? "✓" : "new"}
                </span>
              </div>
              <p className="fav-entry-desc">
                {t("schedules.lastRan")}: {relativeTime(schedule.lastRanAt)}
                {schedule.lastRows != null ? ` · ${schedule.lastRows} rows` : ""}
              </p>
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
                      name: schedule.name,
                      sql: schedule.sql,
                      connectionId: schedule.connectionId ?? "",
                      database: schedule.database ?? "",
                      intervalMinutes: Math.max(1, Math.round(schedule.intervalSeconds / 60)),
                      enabled: schedule.enabled,
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
          ))
        )}

        {!editor.open && (
          <div className="fav-form-actions">
            <button
              type="button"
              className="fav-form-submit"
              onClick={() =>
                setEditor({ open: true, name: "", sql: "", connectionId: activeConnectionId ?? "", database: currentDatabase ?? "", intervalMinutes: 60, enabled: true })
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
