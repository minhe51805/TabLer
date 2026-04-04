import {
  Copy,
  Edit3,
  Eye,
  EyeOff,
  Hash,
  Info,
  Search,
  X,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useI18n } from "../../i18n";
import { copyToClipboard } from "../../utils/sql-generator";
import type { ResolvedColumn } from "../DataGrid/hooks/useDataGrid";
import type { GridCellValue } from "../DataGrid/hooks/useDataGrid";
import {
  isBooleanColumn,
  isBlobColumn,
  isDateTimeColumn,
  isJSONColumn,
  isNumericColumn,
} from "../DataGrid/editors/cell-editor-registry";

export interface RowInspectorData {
  rowIndex: number; // absolute row number (1-based)
  row: (string | number | boolean | null)[];
  columns: ResolvedColumn[];
  primaryKeyValues: Record<string, GridCellValue>;
  tableName?: string;
  database?: string;
}

interface Props {
  isOpen: boolean;
  data: RowInspectorData | null;
  onClose: () => void;
  onEditCell: (columnName: string, value: GridCellValue) => void;
  isEditing?: boolean;
}

// ─── Value formatting ────────────────────────────────────────────────────────

function formatCellValue(
  value: string | number | boolean | null,
  _column: ResolvedColumn,
): string {
  if (value === null || value === undefined) {
    return "NULL";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    return String(value);
  }
  return String(value);
}

function isNullish(value: unknown): boolean {
  return value === null || value === undefined || String(value).toLowerCase() === "null";
}

function getTypeBadge(column: ResolvedColumn): string {
  const t = column.column_type || column.data_type || "";
  if (isBlobColumn(column)) return "BLOB";
  if (isJSONColumn(column)) return "JSON";
  if (isBooleanColumn(column)) return "BOOL";
  if (isNumericColumn(column)) return "NUM";
  if (isDateTimeColumn(column)) return "DATE";
  if (t.includes("text") || t.includes("char") || t.includes("varchar")) return "TEXT";
  if (t.includes("int") || t.includes("float") || t.includes("double") || t.includes("decimal")) return "NUM";
  if (t.includes("date") || t.includes("time")) return "DATE";
  return "VAL";
}

// ─── JSON viewer ─────────────────────────────────────────────────────────────

function JsonViewer({ value }: { value: string }) {
  const [expanded, setExpanded] = useState(false);

  let parsed: unknown = null;
  let isValid = false;
  let formatted = value;

  if (!isNullish(value)) {
    try {
      parsed = JSON.parse(String(value));
      isValid = true;
      formatted = JSON.stringify(parsed, null, 2);
    } catch {
      formatted = String(value);
    }
  }

  const preview = isValid && !expanded
    ? JSON.stringify(parsed).slice(0, 120) + (JSON.stringify(parsed).length > 120 ? "..." : "")
    : formatted;

  if (!isValid || !value) {
    return <span className="ri-field-value-text">{formatCellValue(value as GridCellValue, {} as ResolvedColumn)}</span>;
  }

  return (
    <div className="ri-json-viewer">
      <button
        type="button"
        className="ri-json-toggle"
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
        <span>{expanded ? "Collapse" : "Expand"}</span>
      </button>
      {expanded ? (
        <pre className="ri-json-content">{formatted}</pre>
      ) : (
        <code className="ri-json-preview">{preview}</code>
      )}
    </div>
  );
}

// ─── Field row ───────────────────────────────────────────────────────────────

interface FieldRowProps {
  column: ResolvedColumn;
  value: GridCellValue;
  isEditing: boolean;
  editDraft: string;
  onStartEdit: () => void;
  onEditChange: (v: string) => void;
  onCommitEdit: () => void;
  onCancelEdit: () => void;
  onCopy: (v: string) => void;
}

function FieldRow({
  column,
  value,
  isEditing,
  editDraft,
  onStartEdit,
  onEditChange,
  onCommitEdit,
  onCancelEdit,
  onCopy,
}: FieldRowProps) {
  const isNull = isNullish(value);
  const isJson = isJSONColumn(column);
  const isPk = column.is_primary_key;

  return (
    <div className={`ri-field ${isNull ? "is-null" : ""} ${isPk ? "is-pk" : ""}`}>
      <div className="ri-field-header">
        <div className="ri-field-label-group">
          {isPk && <Hash className="w-3 h-3 ri-pk-icon" />}
          <span className="ri-field-name">{column.name}</span>
        </div>
        <div className="ri-field-meta">
          <span className="ri-field-type-badge">{getTypeBadge(column)}</span>
          {column.is_nullable && <span className="ri-field-nullable">NULL</span>}
          {isPk && <span className="ri-field-pk">PK</span>}
        </div>
      </div>

      <div className="ri-field-body">
        {isEditing ? (
          <div className="ri-field-edit-row">
            <input
              type="text"
              className="ri-field-edit-input"
              value={editDraft}
              onChange={(e) => onEditChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onCommitEdit();
                if (e.key === "Escape") onCancelEdit();
              }}
              autoFocus
            />
            <button type="button" className="ri-edit-btn confirm" onClick={onCommitEdit} title="Commit">
              <span>OK</span>
            </button>
            <button type="button" className="ri-edit-btn cancel" onClick={onCancelEdit} title="Cancel">
              <X className="w-3 h-3" />
            </button>
          </div>
        ) : (
          <div className="ri-field-value-row">
            {isJson ? (
              <JsonViewer value={value as string} />
            ) : (
              <span className={`ri-field-value-text ${isNull ? "is-null" : ""}`}>
                {formatCellValue(value, column)}
              </span>
            )}
            {!isNull && (
              <div className="ri-field-actions">
                <button
                  type="button"
                  className="ri-field-action-btn"
                  onClick={() => onCopy(String(value ?? ""))}
                  title="Copy value"
                >
                  <Copy className="w-3 h-3" />
                </button>
                <button
                  type="button"
                  className="ri-field-action-btn"
                  onClick={onStartEdit}
                  title="Edit value"
                >
                  <Edit3 className="w-3 h-3" />
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main component ──────────────────────────────────────────────────────────

export function RowInspector({ isOpen, data, onClose, onEditCell }: Props) {
  const { language } = useI18n();
  const [editingColumn, setEditingColumn] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [activeTab, setActiveTab] = useState<"fields" | "json">("fields");
  const [searchQuery, setSearchQuery] = useState("");

  const closeLabel = language === "vi" ? "Đóng" : language === "zh" ? "关闭" : "Close";
  const fieldsLabel = language === "vi" ? "Trường" : language === "zh" ? "字段" : "Fields";
  const jsonLabel = language === "zh" ? "JSON" : "JSON";
  const searchPlaceholder = language === "vi" ? "Tìm trường..." : language === "zh" ? "搜索字段..." : "Search fields...";
  const copyAllLabel = language === "vi" ? "Sao chép JSON" : language === "zh" ? "复制 JSON" : "Copy JSON";
  const panelTitle = language === "vi" ? "Kiểm tra dòng" : language === "zh" ? "检查行" : "Inspect Row";

  const filteredColumns = useMemo(() => {
    if (!data) return [];
    if (!searchQuery.trim()) return data.columns;
    const q = searchQuery.toLowerCase();
    return data.columns.filter(
      (col) =>
        col.name.toLowerCase().includes(q) ||
        (col.column_type || col.data_type || "").toLowerCase().includes(q),
    );
  }, [data, searchQuery]);

  const fullRowJson = useMemo(() => {
    if (!data) return "{}";
    const obj: Record<string, unknown> = {};
    data.columns.forEach((col, i) => {
      obj[col.name] = data.row[i];
    });
    return JSON.stringify(obj, null, 2);
  }, [data]);

  const handleCopyJson = useCallback(() => {
    void copyToClipboard(fullRowJson);
  }, [fullRowJson]);

  const handleCopyValue = useCallback((value: string) => {
    void copyToClipboard(value);
  }, []);

  const handleStartEdit = useCallback((columnName: string, currentValue: GridCellValue) => {
    setEditingColumn(columnName);
    setEditDraft(currentValue === null ? "" : String(currentValue));
  }, []);

  const handleCommitEdit = useCallback(() => {
    if (!editingColumn) return;
    const col = data?.columns.find((c) => c.name === editingColumn);
    if (!col) return;

    let value: GridCellValue = editDraft;
    if (editDraft === "" || editDraft.toLowerCase() === "null") {
      value = null;
    } else if (isNumericColumn(col)) {
      const num = Number(editDraft);
      if (!Number.isNaN(num)) value = num;
    } else if (isBooleanColumn(col)) {
      value = editDraft.toLowerCase() === "true" || editDraft === "1";
    }
    onEditCell(editingColumn, value);
    setEditingColumn(null);
    setEditDraft("");
  }, [editingColumn, editDraft, data, onEditCell]);

  const handleCancelEdit = useCallback(() => {
    setEditingColumn(null);
    setEditDraft("");
  }, []);

  if (!isOpen || !data) {
    return null;
  }

  return (
    <div className="ri-overlay">
      <aside className="ri-panel">
        {/* Header */}
        <div className="ri-panel-header">
          <div className="ri-panel-title">
            <Info className="w-4 h-4" />
            <span>{panelTitle}</span>
            <span className="ri-row-badge">#{data.rowIndex}</span>
            {data.tableName && (
              <span className="ri-table-chip">{data.tableName}</span>
            )}
          </div>
          <div className="ri-panel-actions">
            <button
              type="button"
              className="ri-action-btn"
              onClick={handleCopyJson}
              title={copyAllLabel}
            >
              <Copy className="w-3.5 h-3.5" />
              <span>{copyAllLabel}</span>
            </button>
            <button type="button" className="ri-close-btn" onClick={onClose} title={closeLabel}>
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="ri-tabs">
          <button
            type="button"
            className={`ri-tab ${activeTab === "fields" ? "is-active" : ""}`}
            onClick={() => setActiveTab("fields")}
          >
            {fieldsLabel} <span className="ri-tab-count">{data.columns.length}</span>
          </button>
          <button
            type="button"
            className={`ri-tab ${activeTab === "json" ? "is-active" : ""}`}
            onClick={() => setActiveTab("json")}
          >
            {jsonLabel}
          </button>
        </div>

        {/* Content */}
        <div className="ri-content">
          {activeTab === "fields" ? (
            <>
              {/* Search */}
              <div className="ri-search-bar">
                <Search className="w-3.5 h-3.5 ri-search-icon" />
                <input
                  type="text"
                  className="ri-search-input"
                  placeholder={searchPlaceholder}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
                {searchQuery && (
                  <button type="button" className="ri-search-clear" onClick={() => setSearchQuery("")}>
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>

              {/* Field list */}
              <div className="ri-field-list">
                {filteredColumns.length === 0 ? (
                  <div className="ri-empty">
                    {searchQuery
                      ? (language === "vi" ? "Không tìm thấy trường nào." : language === "zh" ? "未找到字段。" : "No fields found.")
                      : (language === "vi" ? "Không có trường nào." : language === "zh" ? "无字段。" : "No fields.")}
                  </div>
                ) : (
                  filteredColumns.map((column, colIndex) => {
                    const value = data.row[colIndex];
                    const isColEditing = editingColumn === column.name;
                    return (
                      <FieldRow
                        key={column.name}
                        column={column}
                        value={value}
                        isEditing={isColEditing}
                        editDraft={editDraft}
                        onStartEdit={() => handleStartEdit(column.name, value)}
                        onEditChange={setEditDraft}
                        onCommitEdit={handleCommitEdit}
                        onCancelEdit={handleCancelEdit}
                        onCopy={handleCopyValue}
                      />
                    );
                  })
                )}
              </div>
            </>
          ) : (
            /* JSON tab */
            <div className="ri-json-panel">
              <pre className="ri-json-full">{fullRowJson}</pre>
            </div>
          )}
        </div>

        {/* Footer: PK info */}
        {Object.keys(data.primaryKeyValues).length > 0 && (
          <div className="ri-panel-footer">
            <Hash className="w-3 h-3 ri-footer-icon" />
            <span className="ri-footer-label">
              {language === "vi" ? "Khóa chính:" : language === "zh" ? "主键:" : "Primary key:"}
            </span>
            {Object.entries(data.primaryKeyValues).map(([col, val], i) => (
              <span key={col} className="ri-footer-pk-pair">
                {i > 0 && " · "}
                <strong>{col}</strong> = <code>{formatCellValue(val, {} as ResolvedColumn)}</code>
              </span>
            ))}
          </div>
        )}
      </aside>
    </div>
  );
}
