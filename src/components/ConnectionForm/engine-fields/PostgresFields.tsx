import type { PostgresFieldsProps } from "./engine-fields-types";

export function PostgresFields({
  formData,
  suggestedUsernamePlaceholder,
  strings,
  onFieldChange,
}: PostgresFieldsProps) {
  return (
    <>
      <div className="connection-form-field">
        <label className="form-label uppercase tracking-wide">{strings.host}</label>
        <input
          type="text"
          value={formData.host || ""}
          onChange={(e) => onFieldChange("host", e.target.value)}
          placeholder="127.0.0.1"
          className="input h-11"
        />
      </div>

      <div className="connection-form-field">
        <label className="form-label uppercase tracking-wide">{strings.port}</label>
        <input
          type="number"
          value={formData.port || ""}
          onChange={(e) => onFieldChange("port", parseInt(e.target.value) || undefined)}
          placeholder="5432"
          className="input h-11"
        />
      </div>

      <div className="connection-form-field">
        <label className="form-label uppercase tracking-wide">{strings.username}</label>
        <input
          type="text"
          value={formData.username || ""}
          onChange={(e) => onFieldChange("username", e.target.value)}
          placeholder={suggestedUsernamePlaceholder}
          className="input h-11"
        />
      </div>

      <div className="connection-form-field">
        <label className="form-label uppercase tracking-wide">{strings.databaseOptional} <span className="opacity-60">({strings.optional})</span></label>
        <input
          type="text"
          value={formData.database || ""}
          onChange={(e) => onFieldChange("database", e.target.value)}
          placeholder="postgres"
          className="input h-11"
        />
      </div>
    </>
  );
}
