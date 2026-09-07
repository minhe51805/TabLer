import { Eye, EyeOff } from "lucide-react";
import type { CommonFieldsProps } from "./engine-fields-types";

export function CommonFields({
  formData,
  showPassword,
  suggestedUsernamePlaceholder,
  strings,
  passwordDraftRef,
  onFieldChange,
  onTogglePasswordVisibility,
  onPasswordChange,
}: CommonFieldsProps) {
  return (
    <>
      <div className="connection-form-grid connection-form-grid-host">
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
            placeholder={String(formData.port || 3306)}
            className="input h-11"
          />
        </div>
      </div>

      <div className="connection-form-grid">
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
          <label className="form-label uppercase tracking-wide">{strings.password}</label>
          <div className="connection-form-password">
            <input
              type={showPassword ? "text" : "password"}
              defaultValue={passwordDraftRef.current}
              onChange={(e) => onPasswordChange(e.target.value)}
              placeholder={strings.enterPassword}
              className="input h-11 pr-11"
            />
            <button
              type="button"
              onClick={onTogglePasswordVisibility}
              className="connection-form-password-toggle"
            >
              {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </div>
      </div>

      <div className="connection-form-field">
        <label className="form-label uppercase tracking-wide">
          {strings.databaseOptional} <span className="opacity-60">({strings.optional})</span>
        </label>
        <input
          type="text"
          value={formData.database || ""}
          onChange={(e) => onFieldChange("database", e.target.value)}
          placeholder="my_database"
          className="input h-11"
        />
      </div>
    </>
  );
}
