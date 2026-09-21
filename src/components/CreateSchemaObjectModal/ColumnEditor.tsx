import { Plus, Trash2 } from "lucide-react";
import { useI18n } from "../../i18n";

export interface ColumnDraft {
  id: string;
  name: string;
  dataType: string;
  nullable: boolean;
  primaryKey: boolean;
  defaultValue: string;
}

interface ColumnEditorProps {
  columns: ColumnDraft[];
  onAddColumn: () => void;
  onRemoveColumn: (columnId: string) => void;
  onColumnChange: (columnId: string, field: keyof ColumnDraft, value: string | boolean) => void;
}

// Factory helper shared by the modal form; not a component.
// eslint-disable-next-line react-refresh/only-export-components
export function createEmptyColumn(): ColumnDraft {
  return {
    id: crypto.randomUUID(),
    name: "",
    dataType: "text",
    nullable: true,
    primaryKey: false,
    defaultValue: "",
  };
}

export function ColumnEditor({
  columns,
  onAddColumn,
  onRemoveColumn,
  onColumnChange,
}: ColumnEditorProps) {
  const { t } = useI18n();
  return (
    <div className="schema-wizard-section">
      <div className="schema-wizard-section-head">
        <div>
          <h3>{t("schemaWizard.columnsTitle")}</h3>
          <p>{t("schemaWizard.columnsHint")}</p>
        </div>
        <button type="button" className="btn btn-secondary" onClick={onAddColumn}>
          <Plus className="w-4 h-4" />
          {t("schemaWizard.addColumn")}
        </button>
      </div>

      <div className="schema-wizard-column-list">
        {columns.map((column) => (
          <div key={column.id} className="schema-wizard-column-card">
            <div className="schema-wizard-grid compact">
              <label className="field-group">
                <span className="field-label">{t("schemaWizard.columnName")}</span>
                <input
                  value={column.name}
                  onChange={(event) => onColumnChange(column.id, "name", event.target.value)}
                  placeholder="id"
                  className="schema-wizard-input"
                />
              </label>
              <label className="field-group">
                <span className="field-label">{t("schemaWizard.columnType")}</span>
                <input
                  value={column.dataType}
                  onChange={(event) => onColumnChange(column.id, "dataType", event.target.value)}
                  placeholder="uuid"
                  className="schema-wizard-input"
                />
              </label>
              <label className="field-group">
                <span className="field-label">{t("schemaWizard.columnDefault")}</span>
                <input
                  value={column.defaultValue}
                  onChange={(event) =>
                    onColumnChange(column.id, "defaultValue", event.target.value)
                  }
                  placeholder="now()"
                  className="schema-wizard-input"
                />
              </label>
            </div>

            <div className="schema-wizard-column-flags">
              <label className="schema-wizard-checkbox">
                <input
                  type="checkbox"
                  checked={!column.nullable}
                  onChange={(event) => onColumnChange(column.id, "nullable", !event.target.checked)}
                />
                <span>{t("schemaWizard.notNull")}</span>
              </label>
              <label className="schema-wizard-checkbox">
                <input
                  type="checkbox"
                  checked={column.primaryKey}
                  onChange={(event) =>
                    onColumnChange(column.id, "primaryKey", event.target.checked)
                  }
                />
                <span>{t("schemaWizard.primaryKey")}</span>
              </label>
              <button
                type="button"
                onClick={() => onRemoveColumn(column.id)}
                className="schema-wizard-remove"
                disabled={columns.length <= 1}
                title={t("schemaWizard.removeColumn")}
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
