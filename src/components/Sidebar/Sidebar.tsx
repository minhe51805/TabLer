import {
  Database,
  PlugZap,
  Plus,
  RefreshCw,
  Search,
} from "lucide-react";
import { useI18n } from "../../i18n";
import { formatCountLabel } from "../../i18n";
import { useSidebar } from "./hooks/use-sidebar";
import { DatabaseTree } from "./components/DatabaseTree";
import { ContextMenu } from "./components/ContextMenu";
import { CreateSchemaObjectModal } from "../CreateSchemaObjectModal/CreateSchemaObjectModal";

export function Sidebar() {
  const { t } = useI18n();
  const {
    activeConnectionId,
    connectedIds,
    activeConnection,
    compactDatabaseName,
    supportsCreateWizard,
    databases,
    currentDatabase,
    tables,
    schemaObjects,
    isLoadingTables,
    expandedDbs,
    search,
    setSearch,
    activeSchemaFilter,
    setActiveSchemaFilter,
    isSchemaPickerOpen,
    setIsSchemaPickerOpen,
    showCreateWizard,
    setShowCreateWizard,
    tableContextMenu,
    activeContextSubmenuKey,
    setActiveContextSubmenuKey,
    searchInputRef,
    schemaPickerRef,
    filteredSchemaSections,
    availableSchemaNames,
    schemaFilterOptions,
    summaryLabel,
    hasSearch,
    visibleTableCount,
    visibleObjectCount,
    language,
    tableContextMenuItems,
    addTab,
    toggleDb,
    handleTableClick,
    handleStructureClick,
    handleObjectSqlClick,
    handleTableContextMenu,
    handleRefresh,
    handleDisconnect,
    closeTableContextMenu,
  } = useSidebar();

  if (!activeConnectionId || !connectedIds.has(activeConnectionId)) {
    return (
      <div className="flex flex-col items-center justify-center h-full px-6 text-center text-[var(--text-muted)]">
        <Database className="w-12 h-12 mb-4 opacity-15" />
        <p className="text-sm font-medium opacity-60">{t("explorer.noActiveConnection")}</p>
        <p className="text-xs mt-1.5 opacity-40">{t("explorer.connectToExplore")}</p>
      </div>
    );
  }

  return (
    <div className="explorer-shell">
      <div className="panel-header panel-header-rich explorer-header">
        <div className="explorer-header-bar">
          <div className="explorer-header-identity">
            <div className="explorer-header-line">
              <h2 className="explorer-header-title">{t("explorer.title")}</h2>
            </div>

            <div className="explorer-header-context">
              <div className="explorer-workspace-pill" title={currentDatabase || undefined}>
                <span className="explorer-workspace-dot" />
                <span className="explorer-workspace-label">{compactDatabaseName || t("explorer.workspace")}</span>
              </div>
              <span className="explorer-header-summary-text">{summaryLabel}</span>
            </div>
          </div>

          <div className="explorer-header-actions">
            {supportsCreateWizard && (
              <button
                type="button"
                onClick={() => setShowCreateWizard(true)}
                className="explorer-header-btn"
                title={t("explorer.createTitle")}
              >
                <Plus className="w-3.5 h-3.5" />
                <span>{t("explorer.create")}</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => void handleDisconnect()}
              className="explorer-header-btn danger"
              title={t("explorer.disconnectTitle")}
            >
              <PlugZap className="w-3.5 h-3.5" />
              <span>{t("explorer.disconnect")}</span>
            </button>

            <button
              type="button"
              onClick={() => void handleRefresh()}
              className="panel-header-action explorer-refresh-btn"
              title={t("explorer.refreshTitle")}
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      <div className="explorer-search-panel">
        <div className="sidebar-search explorer-searchbar">
          <Search className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />
          <input
            ref={searchInputRef}
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("explorer.searchPlaceholder")}
            className="sidebar-search-input"
          />
        </div>
        <div className="explorer-search-hint">
          <span>
            {hasSearch
              ? `${formatCountLabel(language, filteredSchemaSections.reduce((total, section) => total + section.tables.length + section.views.length + section.triggers.length + section.routines.length, 0), {
                  one: "match",
                  other: "matches",
                  vi: "kết quả",
                })} | ${formatCountLabel(language, filteredSchemaSections.length, {
                  one: "schema",
                  other: "schemas",
                  vi: "schema",
                })}`
              : t("explorer.browseHint")}
          </span>
        </div>
      </div>

      <DatabaseTree
        databases={databases}
        currentDatabase={currentDatabase}
        tables={tables}
        schemaObjects={schemaObjects}
        isLoadingTables={isLoadingTables}
        expandedDbs={expandedDbs}
        filteredSchemaSections={filteredSchemaSections}
        activeSchemaFilter={activeSchemaFilter}
        availableSchemaNames={availableSchemaNames}
        schemaFilterOptions={schemaFilterOptions}
        activeConnectionDbType={activeConnection?.db_type}
        hasSearch={hasSearch}
        visibleTableCount={visibleTableCount}
        visibleObjectCount={visibleObjectCount}
        language={language}
        t={t}
        onToggleDb={toggleDb}
        onTableClick={handleTableClick}
        onStructureClick={handleStructureClick}
        onObjectSqlClick={handleObjectSqlClick}
        onTableContextMenu={handleTableContextMenu}
        onSchemaFilterChange={setActiveSchemaFilter}
        onSchemaPickerToggle={() => setIsSchemaPickerOpen((prev) => !prev)}
        onSchemaPickerClose={() => setIsSchemaPickerOpen(false)}
        isSchemaPickerOpen={isSchemaPickerOpen}
        schemaPickerRef={schemaPickerRef}
        tableContextMenu={tableContextMenu}
      />

      <ContextMenu
        tableContextMenu={tableContextMenu}
        tableContextMenuItems={tableContextMenuItems}
        activeContextSubmenuKey={activeContextSubmenuKey}
        onClose={closeTableContextMenu}
        onSubmenuChange={setActiveContextSubmenuKey}
      />

      {showCreateWizard && activeConnection && (
        <CreateSchemaObjectModal
          dbType={activeConnection.db_type}
          database={currentDatabase || undefined}
          tables={tables}
          onClose={() => setShowCreateWizard(false)}
          onCreateDraft={(title, sql) => {
            if (!activeConnectionId) return;
            addTab({
              id: `query-${crypto.randomUUID()}`,
              type: "query",
              title,
              connectionId: activeConnectionId,
              database: currentDatabase || undefined,
              content: sql,
            });
          }}
        />
      )}
    </div>
  );
}
