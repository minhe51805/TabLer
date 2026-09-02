import {
  Database,
  Plus,
  PlugZap,
  RefreshCw,
  Search,
  Terminal,
  Bookmark,
  Save,
  Trash2,
  Filter,
  X,
  Check,
  Info,
  Eraser,
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
import { useRef, useEffect, useState } from "react";
import { createPortal } from "react-dom";

// ---------------------------------------------------------------------------
// Filter operator selector dropdown
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Filter operator selector (native <select> with optgroups — immune to
// z-index/stacking/clipping issues inside the portaled settings modal)
// ---------------------------------------------------------------------------
const OPERATOR_GROUPS: [string, FilterOperator[]][] = FILTER_OPERATOR_CATEGORIES.map(
  ({ category, operators }) => [category as string, operators as FilterOperator[]],
);

function operatorLabelText(op: FilterOperator): string {
  return FILTER_OPERATOR_LABELS[op]?.label ?? op;
}

// SSMS-style fixed property rows for the conditions grid. `key` matches
// FilterCondition.column ("" = object name, "schema" = owner, "type" = type).
const FILTER_PROPERTY_ROWS: { key: string; label: string; hint: string; placeholder: string }[] = [
  {
    key: "",
    label: "Name",
    hint: "Matches the object name (schema.table)",
    placeholder: "Filter by name...",
  },
  {
    key: "schema",
    label: "Owner",
    hint: "Schema that owns the object",
    placeholder: "Filter by owner...",
  },
  {
    key: "create_date",
    label: "Create Date",
    hint: "Date the object was created (click the value cell to open the calendar)",
    placeholder: "mm/dd/yyyy",
  },
];

function OperatorSelector({ value, onChange }: { value: FilterOperator; onChange: (op: FilterOperator) => void }) {
  return (
    <select
      className="filter-operator-trigger filter-operator-select"
      value={value}
      onChange={(e) => onChange(e.target.value as FilterOperator)}
      title={FILTER_OPERATOR_LABELS[value]?.hint ?? ""}
    >
      {OPERATOR_GROUPS.map(([category, operators]) => (
        <optgroup key={category} label={category}>
          {operators.map((op) => (
            <option key={op} value={op}>
              {operatorLabelText(op)}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
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
// Filter settings modal (SSMS-style dialog; keeps the sidebar explorer compact)
// ---------------------------------------------------------------------------

interface FilterToolbarProps {
  conditions: FilterCondition[];
  setConditions: (c: FilterCondition[]) => void;
  conditionLogic?: "AND" | "OR";
  setConditionLogic?: (l: "AND" | "OR") => void;
  onClear: () => void;
  onClose: () => void;
}

export function FilterSettingsModal({
  conditions, setConditions,
  onClear,
  onClose,
}: FilterToolbarProps) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  // Ensure exactly one condition per property row (SSMS fixed-row grid):
  // editing a row creates its condition on first change, the eraser removes it.
  const setConditionFor = (column: string, operator: FilterOperator, value: string) => {
    const existing = conditions.find((c) => (c.column ?? "") === column);
    if (existing) {
      setConditions(
        conditions.map((c) => (c.id === existing.id ? { ...c, operator, value } : c)),
      );
    } else {
      setConditions([...conditions, { id: crypto.randomUUID(), column, operator, value }]);
    }
  };

  const removeConditionFor = (column: string) => {
    setConditions(conditions.filter((c) => (c.column ?? "") !== column));
  };

  // Portal to <body> so `position: fixed` isn't trapped by transformed
  // sidebar ancestors (which anchored the dialog inside the explorer panel).
  return createPortal(
    <div className="filter-settings-overlay" onClick={onClose}>
      <div
        className="filter-settings-modal"
        role="dialog"
        aria-label="Filter settings"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="filter-settings-header">
          <span className="filter-settings-title">Filter Settings</span>
          <button type="button" className="filter-settings-close" onClick={onClose} title="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="filter-settings-body">
      {/* Conditions grid (SSMS-style: Property | Operator | Value) */}
      <div className="filter-section">
        <div className="filter-conditions-grid">
          <div className="filter-grid-row filter-grid-head">
            <span>Property</span>
            <span>Operator</span>
            <span>Value</span>
            <span aria-hidden="true" />
          </div>
          {FILTER_PROPERTY_ROWS.map((prop) => {
            const cond = conditions.find((c) => (c.column ?? "") === prop.key);
            return (
              <div key={prop.key || "name"} className="filter-grid-row">
                <span className="filter-grid-prop-label" title={prop.hint}>
                  {prop.label}
                  <Info className="filter-prop-info" />
                </span>
                <OperatorSelector
                  value={cond?.operator ?? (prop.key === "create_date" ? "equals" : "contains")}
                  onChange={(op) => setConditionFor(prop.key, op, cond?.value ?? "")}
                />
                {prop.key === "create_date" ? (
                  <input
                    type="date"
                    className="filter-condition-value filter-grid-value filter-grid-date"
                    value={cond?.value ?? ""}
                    disabled={cond?.operator === "is_empty" || cond?.operator === "is_not_empty"}
                    onChange={(e) => setConditionFor(prop.key, cond?.operator ?? "equals", e.target.value)}
                  />
                ) : (
                <input
                  type="text"
                  className="filter-condition-value filter-grid-value"
                  value={cond?.value ?? ""}
                  disabled={cond?.operator === "is_empty" || cond?.operator === "is_not_empty"}
                  onChange={(e) => setConditionFor(prop.key, cond?.operator ?? "contains", e.target.value)}
                  placeholder={prop.placeholder}
                />
                )}
                <button
                  type="button"
                  className="filter-condition-remove"
                  onClick={() => removeConditionFor(prop.key)}
                  title="Clear this condition"
                >
                  <Eraser className="w-3.5 h-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      </div>
        </div>

        <div className="filter-settings-footer">
          <button type="button" className="filter-settings-btn" onClick={onClear}>
            Clear
          </button>
          <button type="button" className="filter-settings-btn is-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

import { LinkedFoldersPanel } from "./LinkedFoldersPanel";
import { FolderSearch } from "lucide-react";
import { useConnectionCapabilities } from "../../hooks/useConnectionCapabilities";
import { isCapabilitySupported } from "../../types";

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

export function Sidebar() {
  const [activeSidebarTab, setActiveSidebarTab] = useState<"database" | "linked">("database");
  const { t } = useI18n();
  const {
    activeConnectionId,
    connectedIds,
    activeConnection,
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
    handleTableDoubleClick,
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
    tableOperator: _tableOperator,
    setTableOperator: _setTableOperator,
    schemaOperator: _schemaOperator,
    setSchemaOperator: _setSchemaOperator,
    columnModeActive,
    conditions,
    setConditions,
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
  const capabilityProfile = useConnectionCapabilities(activeConnectionId);
  const canEditSchema = isCapabilitySupported(capabilityProfile?.capabilities.schemaEdit);

  const [filterToolbarOpen, setFilterToolbarOpen] = useState(false);

  const renderDatabaseExplorer = () => {
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
      <div className="explorer-header">
        <div className="explorer-header-bar">
          <div className="explorer-header-identity">
            <div className="explorer-header-line">
              <span className="explorer-header-icon" aria-hidden="true">
                <Database className="w-4 h-4" />
              </span>
              <h2 className="explorer-header-title">{t("explorer.title")}</h2>
            </div>
          </div>

          <div className="explorer-header-actions">
            {supportsCreateWizard && canEditSchema && (
              <button
                type="button"
                onClick={() => setShowCreateWizard(true)}
                className="explorer-header-btn explorer-header-btn--primary"
                title={t("explorer.createTitle")}
                aria-label={t("explorer.createTitle")}
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
            )}

            <button
              type="button"
              onClick={() => void handleRefresh()}
              className="explorer-header-btn"
              title={t("explorer.refreshTitle")}
              aria-label={t("explorer.refreshTitle")}
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>

            <button
              type="button"
              onClick={() => void handleDisconnect()}
              className="explorer-header-btn danger"
              title={t("explorer.disconnectTitle")}
              aria-label={t("explorer.disconnectTitle")}
            >
              <PlugZap className="w-3.5 h-3.5" />
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
            onClick={() => setFilterToolbarOpen(true)}
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

        {/* Filter settings modal (SSMS-style; opened from the filter button) */}
        {filterToolbarOpen && (
          <FilterSettingsModal
            conditions={conditions}
            setConditions={setConditions}
            onClear={handleClearFilters}
            onClose={() => setFilterToolbarOpen(false)}
          />
        )}

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
        onTableDoubleClick={handleTableDoubleClick}
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

      {showCreateWizard && activeConnection && canEditSchema && (
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
  };

  return (
    <div className="sidebar-browser">
      <div className="sidebar-browser-tabs" role="tablist" aria-label="Sidebar views">
        <button
          type="button"
          role="tab"
          aria-selected={activeSidebarTab === "database"}
          className={`sidebar-browser-tab ${activeSidebarTab === "database" ? "active" : ""}`}
          onClick={() => setActiveSidebarTab('database')}
        >
          <Database className="w-3.5 h-3.5" />
          Databases
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeSidebarTab === "linked"}
          className={`sidebar-browser-tab ${activeSidebarTab === "linked" ? "active" : ""}`}
          onClick={() => setActiveSidebarTab('linked')}
        >
          <FolderSearch className="w-3.5 h-3.5" />
          Folders
        </button>
      </div>
      <div className="sidebar-browser-content">
        {activeSidebarTab === "database" ? renderDatabaseExplorer() : (
          <LinkedFoldersPanel
            activeConnectionId={activeConnectionId}
            currentDatabase={currentDatabase}
            addTab={addTab}
            language={language}
          />
        )}
      </div>
    </div>
  );
}
