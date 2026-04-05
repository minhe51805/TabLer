import { type ChangeEvent, type RefObject } from "react";
import { Eye, EyeOff, ArrowLeft, X, FileUp } from "lucide-react";
import { DatabaseBrandIcon } from "../DatabaseBrandIcon";
import type { ConnectionConfig } from "../../../types";
import type { AppLanguage } from "../../../i18n";
import type { DbEntry, EngineExtraField } from "../engine-registry";
import { resolveFieldWithMeta } from "../../../utils/env-resolve";

export interface ConnectionDetailsStepProps {
  language: AppLanguage;
  editConnection: boolean;
  bootstrapMode: boolean;
  formData: ConnectionConfig;
  selectedDb: DbEntry | null;
  isFileEngine: boolean;
  supportsLocalBootstrap: boolean;
  showBootstrapWorkflow: boolean;
  hasBootstrapDatabaseName: boolean;
  showPassword: boolean;
  showUsernameField: boolean;
  showPasswordField: boolean;
  showDatabaseField: boolean;
  showSslToggle: boolean;
  showSqliteAdvancedPath: boolean;
  sqlitePathTouched: boolean;
  bootstrapPreset: string;
  bootstrapPresetLabels: Record<string, string>;
  bootstrapSql: string;
  bootstrapFileName: string;
  engineExtraFields: EngineExtraField[];
  suggestedUsernamePlaceholder: string;
  hostPlaceholder: string;
  portPlaceholder: string;
  databasePlaceholder: string;
  passwordLabel: string;
  passwordPlaceholder: string;
  additionalFields: Record<string, string>;
  connectionTitle: string;
  testResult: { success: boolean; message: string } | null;
  isTesting: boolean;
  isConnecting: boolean;
  isBootstrappingWorkspace: boolean;
  strings: DetailsStrings;
  passwordDraftRef: RefObject<string>;
  bootstrapFileInputRef: RefObject<HTMLInputElement | null>;
  onFieldChange: <K extends keyof ConnectionConfig>(key: K, value: ConnectionConfig[K]) => void;
  onAdditionalFieldChange: (key: string, value: string) => void;
  onTogglePasswordVisibility: () => void;
  onPasswordChange: (value: string) => void;
  onBack: () => void;
  onClose: () => void;
  onTest: () => void;
  onConnect: () => void;
  onCreateDatabase: () => void;
  onImportBootstrapFile: (event: ChangeEvent<HTMLInputElement>) => void;
  onToggleSqliteAdvancedPath: () => void;
  onResetSqlitePath: () => void;
  onPickSqlitePath: () => void;
  onBootstrapPresetChange: (value: string) => void;
  onBootstrapSqlChange: (value: string) => void;
}

export interface DetailsStrings {
  back: string;
  close: string;
  editConnection: string;
  readyToConfigure: string;
  configureSubtitle: string;
  configureLocalSubtitle: string;
  profile: string;
  connectionIdentity: string;
  identityCopy: string;
  color: string;
  colorHint: string;
  name: string;
  myDatabase: string;
  storage: string;
  databaseFile: string;
  databaseFileBootstrapCopy: string;
  databaseFileConnectCopy: string;
  databaseName: string;
  databaseNamePlaceholder: string;
  databaseNameHint: string;
  defaultLocation: string;
  preparingSqliteLocation: string;
  chooseLocation: string;
  hideManualPath: string;
  manualPath: string;
  useDefaultLocation: string;
  customFilePath: string;
  network: string;
  connectionDetails: string;
  detailsCopy: string;
  host: string;
  port: string;
  username: string;
  password: string;
  enterPassword: string;
  optional: string;
  databaseOptional: string;
  localHostDetectedNamed: string;
  localHostDetectedBlank: string;
  engineNotLocalBootstrap: string;
  useSsl: string;
  useSslNote: string;
  engineFields: string;
  engineFieldsCopy: string;
  bootstrap: string;
  starterSchemaSeedSql: string;
  starterSchemaSeedSqlCopy: string;
  starterPreset: string;
  importSql: string;
  replaceSqlFile: string;
  chooseSqlFile: string;
  additionalSql: string;
  additionalSqlPlaceholder: string;
  additionalSqlHint: string;
  testConnection: string;
  createAndOpen: string;
  cancel: string;
  connect: string;
}

// ---------------------------------------------------------------------------
// ENV badge for fields with environment variable references
// ---------------------------------------------------------------------------

function EnvBadge({ value }: { value: string }) {
  const meta = resolveFieldWithMeta(value);
  if (!meta.hasEnvVar) return null;
  return (
    <span
      className="env-badge"
      title={meta.tooltipText || `Resolved: ${meta.resolved}`}
    >
      ENV
    </span>
  );
}

interface ColorPaletteProps {
  selectedColor: string;
  onSelectColor: (color: string) => void;
  label: string;
  hint?: string;
}

function ColorPalette({ selectedColor, onSelectColor, label, hint }: ColorPaletteProps) {
  const COLORS = [
    "#f38ba8", "#c49a78", "#b8ab86", "#7fb07f",
    "#6a8fc8", "#9b86c9", "#c49fbf", "#7fb7b7",
  ];

  return (
    <div className="connection-form-field">
      <div className="connection-form-color-head">
        <label className="form-label uppercase tracking-wide">{label}</label>
        <span className="connection-form-field-hint">{hint}</span>
      </div>
      <div className="connection-form-color-palette">
        {COLORS.map((color) => (
          <button
            key={color}
            type="button"
            onClick={() => onSelectColor(color)}
            className={`connection-form-color-swatch ${selectedColor === color ? "active" : ""}`}
            style={{ backgroundColor: color }}
            title={color}
          />
        ))}
      </div>
    </div>
  );
}

export function ConnectionDetailsStep({
  language,
  editConnection,
  bootstrapMode,
  formData,
  selectedDb,
  isFileEngine,
  supportsLocalBootstrap,
  showBootstrapWorkflow,
  hasBootstrapDatabaseName,
  showPassword,
  showUsernameField,
  showPasswordField,
  showDatabaseField,
  showSslToggle,
  showSqliteAdvancedPath,
  sqlitePathTouched,
  bootstrapPreset,
  bootstrapPresetLabels,
  bootstrapSql,
  bootstrapFileName,
  engineExtraFields,
  suggestedUsernamePlaceholder,
  hostPlaceholder,
  portPlaceholder,
  databasePlaceholder,
  passwordLabel,
  passwordPlaceholder,
  additionalFields,
  connectionTitle,
  testResult,
  isTesting,
  isConnecting,
  isBootstrappingWorkspace,
  strings,
  passwordDraftRef,
  bootstrapFileInputRef,
  onFieldChange,
  onAdditionalFieldChange,
  onTogglePasswordVisibility,
  onPasswordChange,
  onBack,
  onClose,
  onTest,
  onConnect,
  onCreateDatabase,
  onImportBootstrapFile,
  onToggleSqliteAdvancedPath,
  onResetSqlitePath,
  onPickSqlitePath,
  onBootstrapPresetChange,
  onBootstrapSqlChange,
}: ConnectionDetailsStepProps) {
  const getExtraFieldLabel = (field: EngineExtraField) =>
    language === "vi" ? field.labelVi || field.label : field.label;

  const getExtraFieldPlaceholder = (field: EngineExtraField) =>
    language === "vi" ? field.placeholderVi || field.placeholder || "" : field.placeholder || "";

  const getExtraFieldHint = (field: EngineExtraField) =>
    language === "vi" ? field.hintVi || field.hint || "" : field.hint || "";

  const showBootstrapSection = showBootstrapWorkflow && (!isFileEngine || bootstrapMode);
  const showCreateAndOpenAction = showBootstrapWorkflow && (!isFileEngine || bootstrapMode);

  return (
    <>
      <div className="connection-form-header">
        <div className="connection-form-header-main">
          {!editConnection && (
            <button
              type="button"
              onClick={onBack}
              className="connection-form-nav-btn"
              title={strings.back}
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
          )}

          {selectedDb && (
            <div
              className="connection-db-header-icon"
              style={{ "--db-brand": selectedDb.color } as React.CSSProperties}
            >
              <DatabaseBrandIcon
                dbKey={selectedDb.key}
                label={selectedDb.label}
                className="connection-db-brand-sm"
                fallbackClassName="!w-4.5 !h-4.5 text-white"
              />
            </div>
          )}

          <div className="connection-form-header-copy">
            <span className="panel-kicker">{editConnection ? strings.editConnection : strings.readyToConfigure}</span>
            <h2 className="connection-form-title">{connectionTitle}</h2>
            <p className="connection-form-subtitle">{strings.configureSubtitle}</p>
            {bootstrapMode && (
              <p className="connection-form-subtitle">{strings.configureLocalSubtitle}</p>
            )}
          </div>
        </div>

        <div className="connection-form-header-side">
          {selectedDb && <span className="connection-form-engine-pill">{selectedDb.label}</span>}
          <button
            type="button"
            onClick={onClose}
            className="connection-form-close"
            title={strings.close}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="connection-form-body">
        {/* Identity section */}
        <section className="connection-form-section">
          <div className="connection-form-section-head">
            <div>
              <span className="connection-form-section-kicker">{strings.profile}</span>
              <h3 className="connection-form-section-title">{strings.connectionIdentity}</h3>
            </div>
            <p className="connection-form-section-copy">{strings.identityCopy}</p>
          </div>

          <div className="connection-form-profile-grid">
            <div className="connection-form-field">
              <label className="form-label uppercase tracking-wide">{strings.name}</label>
              <input
                type="text"
                value={formData.name}
                onChange={(e) => onFieldChange("name", e.target.value)}
                placeholder={strings.myDatabase}
                className="input h-11"
              />
            </div>

            <ColorPalette
              selectedColor={formData.color ?? ""}
              onSelectColor={(color) => onFieldChange("color", color)}
              label={strings.color}
              hint={strings.colorHint}
            />
          </div>
        </section>

        {/* File DB section */}
        {isFileEngine ? (
          <section className="connection-form-section">
            <div className="connection-form-section-head">
              <div>
                <span className="connection-form-section-kicker">{strings.storage}</span>
                <h3 className="connection-form-section-title">{strings.databaseFile}</h3>
              </div>
              <p className="connection-form-section-copy">
                {bootstrapMode ? strings.databaseFileBootstrapCopy : strings.databaseFileConnectCopy}
              </p>
            </div>

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

                <div className="connection-form-inline-actions">
                  <button
                    type="button"
                    className="btn btn-secondary connection-form-secondary-btn"
                    onClick={onPickSqlitePath}
                  >
                    {strings.chooseLocation}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary connection-form-secondary-btn"
                    onClick={onToggleSqliteAdvancedPath}
                  >
                    {showSqliteAdvancedPath ? strings.hideManualPath : strings.manualPath}
                  </button>
                  {sqlitePathTouched && (
                    <button
                      type="button"
                      className="btn btn-secondary connection-form-secondary-btn"
                      onClick={onResetSqlitePath}
                    >
                      {strings.useDefaultLocation}
                    </button>
                  )}
                </div>

                {showSqliteAdvancedPath && (
                  <div className="connection-form-field">
                    <div className="connection-form-field-label-row">
                      <label className="form-label uppercase tracking-wide">{strings.customFilePath}</label>
                      <EnvBadge value={formData.file_path || ""} />
                    </div>
                    <input
                      type="text"
                      value={formData.file_path || ""}
                      onChange={(e) => {
                        onFieldChange("file_path", e.target.value);
                      }}
                      placeholder="C:\\Users\\you\\Documents\\my_local_db.sqlite"
                      className="input h-11"
                    />
                  </div>
                )}
              </div>
            ) : (
              <div className="connection-form-field">
                <div className="connection-form-field-label-row">
                  <label className="form-label uppercase tracking-wide">{strings.databaseFile}</label>
                  <EnvBadge value={formData.file_path || ""} />
                </div>
                <input
                  type="text"
                  value={formData.file_path || ""}
                  onChange={(e) => onFieldChange("file_path", e.target.value)}
                  placeholder="C:\\path\\to\\database.db"
                  className="input h-11"
                />
              </div>
            )}
          </section>
        ) : (
          /* Server DB section */
          <section className="connection-form-section">
            <div className="connection-form-section-head">
              <div>
                <span className="connection-form-section-kicker">{strings.network}</span>
                <h3 className="connection-form-section-title">{strings.connectionDetails}</h3>
              </div>
              <p className="connection-form-section-copy">{strings.detailsCopy}</p>
            </div>

            <div className="connection-form-grid connection-form-grid-host">
              <div className="connection-form-field">
                <div className="connection-form-field-label-row">
                  <label className="form-label uppercase tracking-wide">{strings.host}</label>
                  <EnvBadge value={formData.host || ""} />
                </div>
                <input
                  type="text"
                  value={formData.host || ""}
                  onChange={(e) => onFieldChange("host", e.target.value)}
                  placeholder={hostPlaceholder}
                  className="input h-11"
                />
              </div>

              <div className="connection-form-field">
                <div className="connection-form-field-label-row">
                  <label className="form-label uppercase tracking-wide">{strings.port}</label>
                  <EnvBadge value={String(formData.port ?? "")} />
                </div>
                <input
                  type="number"
                  value={formData.port || ""}
                  onChange={(e) => onFieldChange("port", parseInt(e.target.value) || undefined)}
                  placeholder={portPlaceholder}
                  className="input h-11"
                />
              </div>
            </div>

            {(showUsernameField || showPasswordField) && (
              <div className="connection-form-grid">
                {showUsernameField && (
                  <div className="connection-form-field">
                    <div className="connection-form-field-label-row">
                      <label className="form-label uppercase tracking-wide">{strings.username}</label>
                      <EnvBadge value={formData.username || ""} />
                    </div>
                    <input
                      type="text"
                      value={formData.username || ""}
                      onChange={(e) => onFieldChange("username", e.target.value)}
                      placeholder={suggestedUsernamePlaceholder}
                      className="input h-11"
                    />
                  </div>
                )}

                {showPasswordField && (
                  <div className="connection-form-field">
                    <div className="connection-form-field-label-row">
                      <label className="form-label uppercase tracking-wide">{passwordLabel}</label>
                      <EnvBadge value={passwordDraftRef.current} />
                    </div>
                    <div className="connection-form-password">
                      <input
                        type={showPassword ? "text" : "password"}
                        defaultValue={passwordDraftRef.current}
                        onChange={(e) => onPasswordChange(e.target.value)}
                        placeholder={passwordPlaceholder}
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
                )}
              </div>
            )}

            {showDatabaseField && (
              <div className="connection-form-field">
                <div className="connection-form-field-label-row">
                  <label className="form-label uppercase tracking-wide">
                    {strings.databaseOptional} <span className="opacity-60">({strings.optional})</span>
                  </label>
                  <EnvBadge value={formData.database || ""} />
                </div>
                <input
                  type="text"
                  value={formData.database || ""}
                  onChange={(e) => onFieldChange("database", e.target.value)}
                  placeholder={databasePlaceholder}
                  className="input h-11"
                />
                {supportsLocalBootstrap && (
                  <span className="connection-form-field-hint">
                    {hasBootstrapDatabaseName ? strings.localHostDetectedNamed : strings.localHostDetectedBlank}
                  </span>
                )}
              </div>
            )}

            {showSslToggle && (
              <div className="connection-form-toggle-row">
                <label className="connection-form-toggle-card">
                  <input
                    type="checkbox"
                    checked={formData.use_ssl}
                    onChange={(e) => onFieldChange("use_ssl", e.target.checked)}
                    className="sr-only"
                  />
                  <div className="connection-form-toggle-copy">
                    <span className="connection-form-toggle-title">{strings.useSsl}</span>
                    <span className="connection-form-toggle-note">{strings.useSslNote}</span>
                  </div>
                  <div className="connection-form-toggle-track" aria-hidden="true">
                    <div className="connection-form-toggle-thumb" />
                  </div>
                </label>
              </div>
            )}

            {/* Startup commands section */}
            <div className="connection-form-field">
              <div className="connection-form-field-label-row">
                <label className="form-label uppercase tracking-wide">
                  Startup Commands <span className="opacity-60">({strings.optional})</span>
                </label>
              </div>
              <textarea
                value={formData.startupCommands || ""}
                onChange={(e) => onFieldChange("startupCommands", e.target.value)}
                placeholder="SET search_path TO 'public';&#10;SET timezone = 'UTC';&#10;SELECT 1;"
                className="input connection-form-textarea"
                rows={4}
              />
              <span className="connection-form-field-hint">
                SQL executed automatically after connecting. Separate multiple commands with semicolons.
              </span>
            </div>

            {engineExtraFields.length > 0 && (
              <section className="connection-form-section">
                <div className="connection-form-section-head">
                  <div>
                    <span className="connection-form-section-kicker">{selectedDb?.label || "Engine"}</span>
                    <h3 className="connection-form-section-title">{strings.engineFields}</h3>
                  </div>
                  <p className="connection-form-section-copy">{strings.engineFieldsCopy}</p>
                </div>

                <div className="connection-form-grid">
                  {engineExtraFields.map((field) => (
                    <div key={field.key} className="connection-form-field">
                      <label className="form-label uppercase tracking-wide">
                        {getExtraFieldLabel(field)}
                        {!field.required && <span className="opacity-60"> ({strings.optional})</span>}
                      </label>
                      <input
                        type={field.type === "number" ? "number" : field.type === "password" ? "password" : "text"}
                        value={additionalFields[field.key] || ""}
                        onChange={(e) => onAdditionalFieldChange(field.key, e.target.value)}
                        placeholder={getExtraFieldPlaceholder(field)}
                        className="input h-11"
                      />
                      {getExtraFieldHint(field) && (
                        <span className="connection-form-field-hint">{getExtraFieldHint(field)}</span>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* Bootstrap section */}
            {showBootstrapSection && (
              <section className="connection-form-section">
                <div className="connection-form-section-head">
                  <div>
                    <span className="connection-form-section-kicker">{strings.bootstrap}</span>
                    <h3 className="connection-form-section-title">{strings.starterSchemaSeedSql}</h3>
                  </div>
                  <p className="connection-form-section-copy">{strings.starterSchemaSeedSqlCopy}</p>
                </div>

                <div className="connection-form-grid">
                  <div className="connection-form-field">
                    <label className="form-label uppercase tracking-wide">{strings.starterPreset}</label>
                    <select
                      value={bootstrapPreset}
                      onChange={(e) => onBootstrapPresetChange(e.target.value)}
                      className="input h-11"
                    >
                      {Object.entries(bootstrapPresetLabels).map(([value, label]) => (
                        <option key={value} value={value}>{label}</option>
                      ))}
                    </select>
                  </div>

                  <div className="connection-form-field">
                    <label className="form-label uppercase tracking-wide">{strings.importSql}</label>
                    <div className="connection-form-inline-actions">
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() => bootstrapFileInputRef.current?.click()}
                      >
                        <FileUp className="w-3.5 h-3.5" />
                        <span>{bootstrapFileName ? strings.replaceSqlFile : strings.chooseSqlFile}</span>
                      </button>
                      {bootstrapFileName && (
                        <span className="connection-form-field-hint">{bootstrapFileName}</span>
                      )}
                    </div>
                    <input
                      ref={bootstrapFileInputRef}
                      type="file"
                      accept=".sql,text/sql"
                      className="hidden"
                      onChange={onImportBootstrapFile}
                    />
                  </div>
                </div>

                <div className="connection-form-field">
                  <label className="form-label uppercase tracking-wide">
                    {strings.additionalSql} <span className="opacity-60">({strings.optional})</span>
                  </label>
                  <textarea
                    value={bootstrapSql}
                    onChange={(e) => onBootstrapSqlChange(e.target.value)}
                    placeholder={strings.additionalSqlPlaceholder}
                    className="input connection-form-textarea"
                    rows={8}
                  />
                  <span className="connection-form-field-hint">{strings.additionalSqlHint}</span>
                </div>
              </section>
            )}
          </section>
        )}

        {testResult && (
          <div className={`connection-form-alert ${testResult.success ? "success" : "error"}`}>
            <span className="break-words">{testResult.message}</span>
          </div>
        )}
      </div>

      <div className="connection-form-footer">
        <div className="connection-form-footer-left">
          <button onClick={onTest} disabled={isTesting} className="btn btn-secondary">
            {strings.testConnection}
          </button>
          {showCreateAndOpenAction && !bootstrapMode && (
            <button
              type="button"
              onClick={onCreateDatabase}
              disabled={isBootstrappingWorkspace || (!isFileEngine && !hasBootstrapDatabaseName)}
              className="btn btn-secondary"
            >
              {strings.createAndOpen}
            </button>
          )}
        </div>

        <div className="connection-form-footer-actions">
          <button onClick={onClose} className="btn btn-secondary">{strings.cancel}</button>
          {showCreateAndOpenAction && bootstrapMode ? (
            <button
              type="button"
              onClick={onCreateDatabase}
              disabled={isBootstrappingWorkspace || (!isFileEngine && !hasBootstrapDatabaseName)}
              className="btn btn-primary"
            >
              {strings.createAndOpen}
            </button>
          ) : (
            <button onClick={onConnect} disabled={isConnecting} className="btn btn-primary">
              {strings.connect}
            </button>
          )}
        </div>
      </div>
    </>
  );
}
