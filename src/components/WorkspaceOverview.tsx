import { Database, GitBranch, Plus, Search, Sparkles, Terminal } from "lucide-react";
import type { useI18n } from "../i18n";
import type { getQueryProfile } from "../utils/query-profile";

type TFunction = ReturnType<typeof useI18n>["t"];
type QueryProfile = ReturnType<typeof getQueryProfile>;

/** Landing card when no connection is active: new-connection and
 *  create-local-db actions plus the three intro cards. */
export function WorkspaceEmptyState({
  t,
  onSetConnectionFormIntent,
}: {
  t: TFunction;
  onSetConnectionFormIntent: (intent: "connect" | "bootstrap") => void;
}) {
  return (
    <div className="workspace-empty">
      <div className="workspace-empty-panel">
        <div className="workspace-empty-hero">
          <div className="workspace-empty-icon">
            <Database className="workspace-empty-glyph w-10 h-10" />
          </div>

          <div className="workspace-empty-copy">
            <span className="workspace-empty-kicker">{t("workspace.empty.kicker")}</span>
            <h2 className="workspace-empty-title">{t("workspace.empty.title")}</h2>
            <p className="workspace-empty-description">{t("workspace.empty.description")}</p>
          </div>
        </div>

        <div className="workspace-empty-actions">
          <button
            type="button"
            onClick={() => onSetConnectionFormIntent("connect")}
            className="btn btn-primary"
          >
            <Plus className="w-3.5 h-3.5" />
            {t("workspace.empty.newConnection")}
          </button>
          <button
            type="button"
            onClick={() => onSetConnectionFormIntent("bootstrap")}
            className="btn btn-secondary"
          >
            <Database className="w-3.5 h-3.5" />
            {t("workspace.empty.createLocalDb")}
          </button>
        </div>

        <div className="workspace-empty-grid">
          <div className="workspace-empty-card">
            <span className="workspace-empty-card-kicker">{t("workspace.empty.connections")}</span>
            <strong className="workspace-empty-card-title">
              {t("workspace.empty.savedWorkspaces")}
            </strong>
            <p className="workspace-empty-card-copy">{t("workspace.empty.savedWorkspacesDesc")}</p>
          </div>

          <div className="workspace-empty-card">
            <span className="workspace-empty-card-kicker">{t("workspace.empty.supported")}</span>
            <strong className="workspace-empty-card-title">
              {t("workspace.empty.primaryEngines")}
            </strong>
            <p className="workspace-empty-card-copy">{t("workspace.empty.primaryEnginesDesc")}</p>
          </div>

          <div className="workspace-empty-card">
            <span className="workspace-empty-card-kicker">{t("workspace.empty.workflow")}</span>
            <strong className="workspace-empty-card-title">
              {t("workspace.empty.connectToQuery")}
            </strong>
            <p className="workspace-empty-card-copy">{t("workspace.empty.connectToQueryDesc")}</p>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Connected-but-no-tabs overview: connection meta chips and the four
 *  quick-action cards (query, explorer, AI, ER diagram). */
export function WorkspaceReadyState({
  t,
  activeConnName,
  activeDatabaseTarget,
  activeEngineLabel,
  workspaceQueryProfile,
  onNewQuery,
  onFocusExplorerSearch,
  onOpenAISlidePanel,
  onOpenERDiagram,
}: {
  t: TFunction;
  activeConnName: string;
  activeDatabaseTarget: string;
  activeEngineLabel: string;
  workspaceQueryProfile: QueryProfile;
  onNewQuery: () => void;
  onFocusExplorerSearch: () => void;
  onOpenAISlidePanel: () => void;
  onOpenERDiagram: () => void;
}) {
  return (
    <div className="workspace-empty workspace-ready-shell">
      <div className="workspace-empty-panel workspace-ready-panel">
        <div className="workspace-ready-header">
          <div className="workspace-ready-header-left">
            <div className="workspace-ready-icon">
              <Sparkles className="workspace-ready-glyph w-5 h-5" />
            </div>
            <div className="workspace-ready-header-copy">
              <span className="workspace-ready-kicker">{t("workspace.ready.kicker")}</span>
              <h2 className="workspace-ready-title">{t("workspace.ready.title")}</h2>
              <p className="workspace-ready-desc">{t("workspace.ready.description")}</p>
            </div>
          </div>
          <div className="workspace-ready-header-right">
            <div className="workspace-ready-meta-chip">
              <span className="workspace-ready-meta-label">{t("workspace.ready.connection")}</span>
              <strong className="workspace-ready-meta-value">{activeConnName}</strong>
            </div>
            <div className="workspace-ready-meta-chip">
              <span className="workspace-ready-meta-label">{t("workspace.ready.database")}</span>
              <strong className="workspace-ready-meta-value">{activeDatabaseTarget}</strong>
            </div>
            <div className="workspace-ready-meta-chip">
              <span className="workspace-ready-meta-label">{t("workspace.ready.engine")}</span>
              <strong className="workspace-ready-meta-value">{activeEngineLabel}</strong>
            </div>
          </div>
        </div>

        <div className="workspace-ready-actions workspace-ready-actions--compact">
          <button
            type="button"
            className="workspace-ready-action-card"
            data-tone="query"
            onClick={onNewQuery}
          >
            <div className="workspace-ready-action-icon">
              {workspaceQueryProfile.surface === "command" ? (
                <Terminal className="w-4 h-4" />
              ) : (
                <Plus className="w-4 h-4" />
              )}
            </div>
            <div className="workspace-ready-action-body">
              <span className="workspace-ready-action-title">
                {workspaceQueryProfile.surface === "command"
                  ? t("workspace.ready.commandTitle")
                  : t("workspace.ready.queryTitle")}
              </span>
              <span className="workspace-ready-action-kicker">
                {workspaceQueryProfile.surface === "command"
                  ? t("workspace.ready.commandTerminal")
                  : t("workspace.ready.sqlEditor")}
              </span>
            </div>
            <kbd className="kbd">Ctrl+N</kbd>
          </button>

          <button
            type="button"
            className="workspace-ready-action-card"
            data-tone="explorer"
            onClick={onFocusExplorerSearch}
          >
            <div className="workspace-ready-action-icon">
              <Search className="w-4 h-4" />
            </div>
            <div className="workspace-ready-action-body">
              <span className="workspace-ready-action-title">
                {t("workspace.ready.explorerTitle")}
              </span>
              <span className="workspace-ready-action-kicker">
                {t("workspace.ready.explorerKicker")}
              </span>
            </div>
            <kbd className="kbd">Ctrl+B</kbd>
          </button>

          <button
            type="button"
            className="workspace-ready-action-card"
            data-tone="ai"
            onClick={() => onOpenAISlidePanel()}
          >
            <div className="workspace-ready-action-icon">
              <Sparkles className="w-4 h-4" />
            </div>
            <div className="workspace-ready-action-body">
              <span className="workspace-ready-action-title">{t("workspace.ready.aiTitle")}</span>
              <span className="workspace-ready-action-kicker">{t("workspace.ready.aiKicker")}</span>
            </div>
            <kbd className="kbd">Ctrl+Shift+P</kbd>
          </button>

          <button
            type="button"
            className="workspace-ready-action-card"
            data-tone="diagram"
            onClick={onOpenERDiagram}
          >
            <div className="workspace-ready-action-icon">
              <GitBranch className="w-4 h-4" />
            </div>
            <div className="workspace-ready-action-body">
              <span className="workspace-ready-action-title">ER Diagram</span>
              <span className="workspace-ready-action-kicker">{t("workspace.ready.database")}</span>
            </div>
            <kbd className="kbd">Ctrl+E</kbd>
          </button>
        </div>
      </div>
    </div>
  );
}
