import type { SQLiteFieldsProps } from "./engine-fields-types";

export function SQLiteFields({
  formData,
  bootstrapMode,
  strings,
  onFieldChange,
}: SQLiteFieldsProps) {
  return (
    <>
      {bootstrapMode ? (
        <div className="connection-form-sqlite-stack">
          <div className="connection-form-field">
            <label className="form-label uppercase tracking-wide">{strings.databaseName}</label>
            <input
              type="text"
              value={formData.database || ""}
              onChange={(e) => onFieldChange("database", e.target.value)}
              placeholder={strings.databaseNamePlaceholder}
              className="input h-11"
            />
            <span className="connection-form-field-hint">{strings.databaseNameHint}</span>
          </div>

          <div className="connection-form-sqlite-preview">
            <span className="connection-form-sqlite-preview-label">{strings.defaultLocation}</span>
            <code className="connection-form-sqlite-preview-path">
              {formData.file_path || strings.preparingSqliteLocation}
            </code>
          </div>
        </div>
      ) : (
        <div className="connection-form-field">
          <label className="form-label uppercase tracking-wide">{strings.databaseFile}</label>
          <input
            type="text"
            value={formData.file_path || ""}
            onChange={(e) => onFieldChange("file_path", e.target.value)}
            placeholder="/path/to/database.db"
            className="input h-11"
          />
        </div>
      )}
    </>
  );
}
