import {
  Database,
  Plus,
  PlugZap,
  RefreshCw,
  Search,
  Terminal,
  ChevronDown,
  Bookmark,
  Save,
  Trash2,
  Filter,
  Columns,
  X,
  Check,
} from "lucide-react";
import { useI18n } from "../../i18n";
import { useSidebar } from "./hooks/use-sidebar";
import { DatabaseTree } from "./components/DatabaseTree";
import { ContextMenu } from "./components/ContextMenu";
import { CreateSchemaObjectModal } from "../CreateSchemaObjectModal/CreateSchemaObjectModal";
import {
  FILTER_OPERATOR_LABELS,
  FILTER_OPERATOR_CATEGORIES,
  type FilterOperator,
  type FilterCondition,
} from "../../types/filter-presets";
import { useRef, useEffect, useCallback } from "react";

// ---------------------------------------------------------------------------
// Filter operator selector dropdown
// ---------------------------------------------------------------------------

interface OperatorSelectorProps {
  value: FilterOperator;
  onChange: (op: FilterOperator) => void;
  isOpen: boolean;
  onToggle: () => void;
}

function OperatorSelector({ value, onChange, isOpen, onToggle }: OperatorSelectorProps) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => onToggle(), [onToggle]);

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) {
        close();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [isOpen, close]);

  return (
    <div className="filter-operator-selector" ref={ref}>
      <button
        type="button"
        className="filter-operator-trigger"
        onClick={onToggle}
        title={FILTER_OPERATOR_LABELS[value]?.hint ?? ""}
      >
        <span className="filter-operator-label">{FILTER_OPERATOR_LABELS[value]?.label ?? value}</span>
        <ChevronDown className="w-3 h-3" />
      </button>
      {isOpen && (
        <div className="filter-operator-menu">
          {FILTER_OPERATOR_CATEGORIES.map(({ category, operators }) => (
            <div key={category} className="filter-operator-group">
              <div className="filter-operator-group-label">{category}</div>
              {operators.map((op) => (
                <button
                  key={op}
                  type="button"
                  className={`filter-operator-option ${value === op ? "active" : ""}`}
                  onClick={() => { onChange(op); onToggle(); }}
                  title={FILTER_OPERATOR_LABELS[op]?.hint ?? ""}
                >
                  <span>{FILTER_OPERATOR_LABELS[op]?.label ?? op}</span>
                  {value === op && <Check className="w-3 h-3 shrink-0" />}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Preset menu
// ---------------------------------------------------------------------------

interface PresetMenuProps {
  isOpen: boolean;
  onClose: () => void;
  presets: Array<{ id: string; name: string }>;
  activePresetId: string | null;
  onLoad: (id: string) => void;
  onDelete: (id: string) => void;
  onSaveNew: () => void;
}

function PresetMenu({ isOpen, onClose, presets, activePresetId, onLoad, onDelete, onSaveNew }: PresetMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [isOpen, onClose]);

  return (
    <div className="filter-preset-menu" ref={ref}>
      {isOpen && (
        <div className="filter-preset-panel">
          <div className="filter-preset-panel-header">
            <span className="filter-preset-panel-title">Filter Presets</span>
            <button
              type="button"
              className="filter-preset-save-btn"
              onClick={() => { onSaveNew(); onClose(); }}
              title="Save current filter as preset"
            >
              <Save className="w-3.5 h-3.5" />
              <span>Save</span>
            </button>
          </div>
          {presets.length === 0 ? (
            <div className="filter-preset-empty">No saved presets</div>
          ) : (
            <div className="filter-preset-list">
              {presets.map((preset) => (
                <div
                  key={preset.id}
                  className={`filter-preset-item ${activePresetId === preset.id ? "active" : ""}`}
                >
                  <button
                    type="button"
                    className="filter-preset-item-load"
                    onClick={() => { onLoad(preset.id); onClose(); }}
                  >
                    <Bookmark className="w-3.5 h-3.5 shrink-0" />
                    <span>{preset.name}</span>
                  </button>
                  <button
                    type="button"
                    className="filter-preset-item-delete"
                    onClick={() => onDelete(preset.id)}
                    title="Delete preset"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Save preset dialog
// ---------------------------------------------------------------------------

interface SavePresetDialogProps {
  isOpen: boolean;
  value: string;
  onChange: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
}

function SavePresetDialog({ isOpen, value, onChange, onSave, onCancel }: SavePresetDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      inputRef.current?.focus();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className="filter-save-dialog-overlay" onClick={onCancel}>
      <div className="filter-save-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="filter-save-dialog-header">
          <span className="filter-save-dialog-title">Save Filter Preset</span>
          <button type="button" className="filter-save-dialog-close" onClick={onCancel}>
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="filter-save-dialog-body">
          <label className="filter-save-dialog-label">
            <span>Preset name</span>
            <input
              ref={inputRef}
              type="text"
              className="filter-save-dialog-input"
              value={value}
              onChange={(e) => onChange(e.target.value)}
              placeholder="e.g. My Active Tables"
              onKeyDown={(e) => {
                if (e.key === "Enter" && value.trim()) onSave();
                if (e.key === "Escape") onCancel();
              }}
            />
          </label>
        </div>
        <div className="filter-save-dialog-footer">
          <button type="button" className="filter-save-dialog-btn" onClick={onCancel}>Cancel</button>
          <button
            type="button"
            className="filter-save-dialog-btn is-primary"
            onClick={onSave}
            disabled={!value.trim()}
          >
            <Check className="w-3.5 h-3.5" />
            Save Preset
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filter toolbar (collapsed into search bar)
// ---------------------------------------------------------------------------

interface FilterToolbarProps {
  tableOperator: FilterOperator;
  setTableOperator: (op: FilterOperator) => void;
  columnModeActive: boolean;
  setColumnModeActive: (v: boolean) => void;
  columnPattern: string;
  setColumnPattern: (v: string) => void;
  columnOperator: "name_contains" | "name_equals" | "name_matches_regex";
  setColumnOperator: (op: "name_contains" | "name_equals" | "name_matches_regex") => void;
  conditions: FilterCondition[];
  setConditions: (c: FilterCondition[]) => void;
  conditionLogic: "AND" | "OR";
  setConditionLogic: (l: "AND" | "OR") => void;
  operatorSelectorOpen: boolean;
  setOperatorSelectorOpen: (v: boolean) => void;
  onClose: () => void;
}

function FilterToolbar({
  tableOperator, setTableOperator,
  columnModeActive, setColumnModeActive,
  columnPattern, setColumnPattern,
  columnOperator, setColumnOperator,
  conditions, setConditions,
  conditionLogic, setConditionLogic,
  operatorSelectorOpen, setOperatorSelectorOpen,
  onClose: _onClose,
}: FilterToolbarProps) {
  const addCondition = () => {
    setConditions([
      ...conditions,
      { id: crypto.randomUUID(), operator: "contains", value: "" },
    ]);
  };

  const removeCondition = (id: string) => {
    setConditions(conditions.filter((c) => c.id !== id));
  };

  const updateCondition = (id: string, updates: Partial<FilterCondition>) => {
    setConditions(conditions.map((c) => c.id === id ? { ...c, ...updates } : c));
  };

  return (
    <div className="filter-toolbar">
      <div className="filter-toolbar-row">
        <div className="filter-toolbar-label">Filter mode</div>
        <button
          type="button"
          className={`filter-toolbar-toggle ${!columnModeActive ? "active" : ""}`}
          onClick={() => setColumnModeActive(false)}
        >
          Table name
        </button>
        <button
          type="button"
          className={`filter-toolbar-toggle ${columnModeActive ? "active" : ""}`}
          onClick={() => setColumnModeActive(true)}
        >
          <Columns className="w-3.5 h-3.5" />
          Column name
        </button>
      </div>

      {!columnModeActive && (
        <div className="filter-toolbar-row">
          <div className="filter-toolbar-label">Operator</div>
          <OperatorSelector
            value={tableOperator}
            onChange={setTableOperator}
            isOpen={operatorSelectorOpen}
            onToggle={() => setOperatorSelectorOpen(!operatorSelectorOpen)}
          />
        </div>
      )}

      {columnModeActive && (
        <div className="filter-toolbar-row">
          <div className="filter-toolbar-label">Column</div>
          <select
            className="filter-toolbar-select"
            value={columnOperator}
            onChange={(e) => setColumnOperator(e.target.value as typeof columnOperator)}
          >
            <option value="name_contains">Contains</option>
            <option value="name_equals">Equals</option>
            <option value="name_matches_regex">Regex</option>
          </select>
          <input
            type="text"
            className="filter-toolbar-input"
            value={columnPattern}
            onChange={(e) => setColumnPattern(e.target.value)}
            placeholder="Column name pattern..."
          />
        </div>
      )}

      <div className="filter-toolbar-row filter-conditions-row">
        <div className="filter-toolbar-label">Conditions</div>
        <div className="filter-conditions-list">
          <button
            type="button"
            className="filter-conditions-logic"
            onClick={() => setConditionLogic(conditionLogic === "AND" ? "OR" : "AND")}
            title={`Current: ${conditionLogic}. Click to toggle.`}
          >
            {conditionLogic}
          </button>
          {conditions.map((cond) => (
            <div key={cond.id} className="filter-condition-row">
              <input
                type="text"
                className="filter-condition-value"
                value={cond.value}
                onChange={(e) => updateCondition(cond.id, { value: e.target.value })}
                placeholder="Value..."
              />
              <button
                type="button"
                className="filter-condition-remove"
                onClick={() => removeCondition(cond.id)}
                title="Remove condition"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="filter-condition-add"
            onClick={addCondition}
          >
            + Add condition
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

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
    hasSearch,
    visibleTableCount,
    visibleObjectCount,
    language,
    autocompleteItems,
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
    // Filter preset props
    filterPresetMenuOpen,
    setFilterPresetMenuOpen,
    savePresetDialogOpen,
    setSavePresetDialogOpen,
    presetNameInput,
    setPresetNameInput,
    operatorSelectorOpen,
    setOperatorSelectorOpen,
    tableOperator,
    setTableOperator,
    schemaOperator: _schemaOperator,
    setSchemaOperator: _setSchemaOperator,
    columnModeActive,
    setColumnModeActive,
    columnPattern,
    setColumnPattern,
    columnOperator,
    setColumnOperator,
    conditions,
    setConditions,
    conditionLogic,
    setConditionLogic,
    mixedStateFilter,
    handleMixedStateToggle,
    getMixedStateFilterForTable,
    presets,
    activePresetId,
    handleSavePreset,
    handleLoadPreset,
    handleDeletePreset,
    handleClearFilters,
  } = useSidebar();

  const [filterToolbarOpen, setFilterToolbarOpen] = useState(false);

  if (!activeConnectionId || !connectedIds.has(activeConnectionId)) {
    return (
      <div className="flex flex-col items-center justify-center h-full px-6 text-center text-[var(--text-muted)]">
        <Database className="w-12 h-12 mb-4 opacity-15" />
        <p className="text-sm font-medium opacity-60">{t("explorer.noActiveConnection")}</p>
        <p className="text-xs mt-1.5 opacity-40">{t("explorer.connectToExplore")}</p>
      </div>
    );
  }

  const hasActiveFilter = hasSearch || conditions.length > 0 || columnModeActive || mixedStateFilter.isActive;

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

      {/* Filter / Search bar */}
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
          {/* Filter button */}
          <button
            type="button"
            className={`sidebar-filter-btn ${hasActiveFilter ? "active" : ""}`}
            onClick={() => setFilterToolbarOpen((v) => !v)}
            title="Advanced filter"
          >
            <Filter className="w-3.5 h-3.5" />
          </button>
          {/* Preset button */}
          <div className="sidebar-preset-wrapper">
            <button
              type="button"
              className={`sidebar-preset-btn ${activePresetId ? "has-preset" : ""}`}
              onClick={() => setFilterPresetMenuOpen((v) => !v)}
              title="Filter presets"
            >
              <Bookmark className="w-3.5 h-3.5" />
            </button>
            <PresetMenu
              isOpen={filterPresetMenuOpen}
              onClose={() => setFilterPresetMenuOpen(false)}
              presets={presets}
              activePresetId={activePresetId}
              onLoad={handleLoadPreset}
              onDelete={handleDeletePreset}
              onSaveNew={() => setSavePresetDialogOpen(true)}
            />
          </div>
          {/* Clear filters */}
          {hasActiveFilter && (
            <button
              type="button"
              className="sidebar-clear-btn"
              onClick={handleClearFilters}
              title="Clear all filters"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Expanded filter toolbar */}
        {filterToolbarOpen && (
          <FilterToolbar
            tableOperator={tableOperator}
            setTableOperator={setTableOperator}
            columnModeActive={columnModeActive}
            setColumnModeActive={setColumnModeActive}
            columnPattern={columnPattern}
            setColumnPattern={setColumnPattern}
            columnOperator={columnOperator}
            setColumnOperator={setColumnOperator}
            conditions={conditions}
            setConditions={setConditions}
            conditionLogic={conditionLogic}
            setConditionLogic={setConditionLogic}
            operatorSelectorOpen={operatorSelectorOpen}
            setOperatorSelectorOpen={setOperatorSelectorOpen}
            onClose={() => setFilterToolbarOpen(false)}
          />
        )}

        {!hasSearch && <div className="explorer-search-hint">{t("explorer.browseHint")}</div>}
        {autocompleteItems.length > 0 && (
          <div className="sidebar-search-autocomplete">
            {autocompleteItems.map((item) => (
              <button
                key={item}
                type="button"
                className="sidebar-search-autocomplete-item"
                onClick={() => {
                  setSearch(item);
                  searchInputRef.current?.focus();
                }}
              >
                <Terminal className="w-3 h-3 shrink-0 opacity-50" />
                <span>{item}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Save preset dialog */}
      <SavePresetDialog
        isOpen={savePresetDialogOpen}
        value={presetNameInput}
        onChange={setPresetNameInput}
        onSave={handleSavePreset}
        onCancel={() => { setSavePresetDialogOpen(false); setPresetNameInput(""); }}
      />

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
        mixedStateFilter={mixedStateFilter}
        onMixedStateToggle={handleMixedStateToggle}
        getMixedStateFilterForTable={getMixedStateFilterForTable}
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

// Need useState for local component state
import { useState } from "react";
