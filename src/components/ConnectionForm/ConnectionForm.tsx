import { useState, type CSSProperties } from "react";
import {
  Eye,
  EyeOff,
  Loader2,
  CheckCircle,
  XCircle,
  X,
  Search,
  ArrowLeft,
  Plug,
} from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import type { ConnectionConfig, DatabaseType } from "../../types";
import { DatabaseBrandIcon } from "./DatabaseBrandIcon";

interface DbEntry {
  key: string;
  abbr: string;
  label: string;
  color: string;
  supported: boolean;
  defaultPort: number;
  isFile?: boolean;
}

const ALL_DATABASES: DbEntry[] = [
  { key: "mysql", abbr: "Ms", label: "MySQL", color: "#c0392b", supported: true, defaultPort: 3306 },
  { key: "mariadb", abbr: "Mr", label: "MariaDB", color: "#6c7a89", supported: false, defaultPort: 3306 },
  { key: "sqlite", abbr: "Sl", label: "SQLite", color: "#3498db", supported: true, defaultPort: 0, isFile: true },
  { key: "duckdb", abbr: "Du", label: "DuckDB", color: "#2c3e50", supported: false, defaultPort: 0, isFile: true },
  { key: "cassandra", abbr: "Cs", label: "Cassandra", color: "#27ae60", supported: false, defaultPort: 9042 },
  { key: "cockroachdb", abbr: "Cr", label: "CockroachDB", color: "#3ddc84", supported: false, defaultPort: 26257 },
  { key: "snowflake", abbr: "Nf", label: "Snowflake", color: "#29b5e8", supported: false, defaultPort: 443 },
  { key: "postgresql", abbr: "Pg", label: "PostgreSQL", color: "#336791", supported: true, defaultPort: 5432 },
  { key: "greenplum", abbr: "Gp", label: "Greenplum", color: "#2ecc71", supported: false, defaultPort: 5432 },
  { key: "redshift", abbr: "Rs", label: "Amazon Redshift", color: "#16a085", supported: false, defaultPort: 5439 },
  { key: "mssql", abbr: "Ss", label: "SQL Server", color: "#7f8c8d", supported: false, defaultPort: 1433 },
  { key: "redis", abbr: "Re", label: "Redis", color: "#e74c3c", supported: false, defaultPort: 6379 },
  { key: "mongodb", abbr: "Mg", label: "MongoDB", color: "#27ae60", supported: false, defaultPort: 27017 },
  { key: "vertica", abbr: "Ve", label: "Vertica", color: "#95a5a6", supported: false, defaultPort: 5433 },
  { key: "clickhouse", abbr: "Ch", label: "ClickHouse", color: "#5b9bd5", supported: false, defaultPort: 8123 },
  { key: "bigquery", abbr: "Bq", label: "BigQuery", color: "#8e44ad", supported: false, defaultPort: 0 },
  { key: "libsql", abbr: "Ls", label: "LibSQL", color: "#2ecc71", supported: false, defaultPort: 8080 },
  { key: "cloudflared1", abbr: "D1", label: "Cloudflare D1", color: "#f39c12", supported: false, defaultPort: 0 },
];

const COLORS = [
  "#f38ba8", "#c49a78", "#b8ab86", "#7fb07f",
  "#6a8fc8", "#9b86c9", "#c49fbf", "#7fb7b7",
];

interface Props {
  onClose: () => void;
  editConnection?: ConnectionConfig;
}

function isSupportedDatabase(db: DbEntry | null): db is DbEntry {
  return Boolean(db?.supported);
}

export function ConnectionForm({ onClose, editConnection }: Props) {
  const { connectToDatabase, testConnection, isConnecting } = useAppStore();

  const [step, setStep] = useState<"pick" | "form">(editConnection ? "form" : "pick");
  const [pickerSearch, setPickerSearch] = useState("");
  const [selectedDb, setSelectedDb] = useState<DbEntry | null>(
    editConnection ? ALL_DATABASES.find((d) => d.key === editConnection.db_type) || null : null,
  );

  const [formData, setFormData] = useState<ConnectionConfig>(
    editConnection || {
      id: crypto.randomUUID(),
      name: "",
      db_type: "mysql",
      host: "127.0.0.1",
      port: 3306,
      username: "root",
      password: "",
      database: "",
      file_path: "",
      use_ssl: false,
      color: COLORS[0],
    },
  );

  const [showPassword, setShowPassword] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  const supportedCount = ALL_DATABASES.filter((db) => db.supported).length;
  const roadmapCount = ALL_DATABASES.length - supportedCount;

  const isSqlite = formData.db_type === "sqlite";
  const connectionTitle = editConnection
    ? "Edit Connection"
    : selectedDb
      ? `New ${selectedDb.label} Connection`
      : "New Connection";

  const updateField = <K extends keyof ConnectionConfig>(key: K, value: ConnectionConfig[K]) => {
    setFormData((prev) => ({ ...prev, [key]: value }));
    setTestResult(null);
  };

  const handleSelectDb = (db: DbEntry) => {
    setSelectedDb(db);
  };

  const handleContinueFromPicker = (db: DbEntry) => {
    setFormData((prev) => ({
      ...prev,
      db_type: db.key as DatabaseType,
      port: db.defaultPort || prev.port,
    }));
    setStep("form");
  };

  const handleTest = async () => {
    setIsTesting(true);
    setTestResult(null);
    try {
      const msg = await testConnection(formData);
      setTestResult({ success: true, message: msg });
    } catch (e) {
      setTestResult({ success: false, message: String(e) });
    }
    setIsTesting(false);
  };

  const handleConnect = async () => {
    try {
      await connectToDatabase(formData);
      onClose();
    } catch (e) {
      setTestResult({ success: false, message: String(e) });
    }
  };

  const filteredDbs = pickerSearch
    ? ALL_DATABASES.filter((d) => d.label.toLowerCase().includes(pickerSearch.toLowerCase()))
    : ALL_DATABASES;

  if (step === "pick") {
    return (
      <div className="connection-picker-overlay">
        <div className="connection-picker-modal">
          <div className="connection-picker-head">
            <div className="connection-picker-copy">
              <span className="panel-kicker">New connection</span>
              <h2 className="connection-picker-title">Choose a database engine</h2>
              <p className="connection-picker-subtitle">
                Pick an engine that is ready now, or browse upcoming integrations that are already on the roadmap.
              </p>
              <div className="connection-picker-stats">
                <span className="connection-picker-stat accent">
                  <strong>{supportedCount}</strong>
                  <span>Ready</span>
                </span>
                <span className="connection-picker-stat">
                  <strong>{roadmapCount}</strong>
                  <span>Roadmap</span>
                </span>
                <span className="connection-picker-stat">
                  <strong>{filteredDbs.length}</strong>
                  <span>Shown</span>
                </span>
              </div>
            </div>

            <button
              type="button"
              onClick={onClose}
              className="connection-picker-close"
              title="Close"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="connection-picker-body">
            <div className="connection-picker-searchbar">
              <Search className="connection-picker-search-icon h-4 w-4 shrink-0" />
              <input
                type="text"
                value={pickerSearch}
                onChange={(e) => setPickerSearch(e.target.value)}
                placeholder="Search database type..."
                className="connection-picker-search-input"
                autoFocus
              />
            </div>

            <div className="connection-picker-grid-shell">
              {filteredDbs.length === 0 ? (
                <div className="connection-picker-empty">
                  <Search className="w-4 h-4" />
                  <span>No database types match that search.</span>
                </div>
              ) : (
                <div className="connection-picker-grid">
                  {filteredDbs.map((db) => {
                    const brandStyle = { "--db-brand": db.color } as CSSProperties;
                    const isSelected = selectedDb?.key === db.key;
                    const statusLabel = db.supported ? "Ready" : "Soon";
                    const metaLabel = db.isFile
                      ? "File-based workflow"
                      : db.defaultPort
                        ? `Default port ${db.defaultPort}`
                        : "Cloud-native flow";

                    return (
                      <button
                        key={db.key}
                        type="button"
                        onClick={() => handleSelectDb(db)}
                        onDoubleClick={() => {
                          if (db.supported) {
                            handleContinueFromPicker(db);
                          }
                        }}
                        className={[
                          "connection-picker-card",
                          db.supported ? "supported" : "coming-soon",
                          isSelected ? "selected" : "",
                        ].join(" ")}
                      >
                        <div className="connection-picker-card-top">
                          <div className="connection-db-tile-icon" style={brandStyle}>
                            <DatabaseBrandIcon
                              dbKey={db.key}
                              label={db.label}
                              className="connection-db-brand-lg"
                              fallbackClassName="!w-6 !h-6 text-white"
                            />
                          </div>

                          <span
                            className={`connection-picker-card-status ${db.supported ? "supported" : "soon"}`}
                          >
                            {statusLabel}
                          </span>
                        </div>

                        <div className="connection-picker-card-copy">
                          <span className="connection-picker-card-title">{db.label}</span>
                          <span className="connection-picker-card-meta">{metaLabel}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          <div className="connection-picker-footer">
            <div className="connection-picker-footer-copy">
              {selectedDb ? (
                <>
                  <span className="connection-picker-footer-label">Selected engine</span>
                  <div className="connection-picker-footer-selection">
                    <strong>{selectedDb.label}</strong>
                    <span
                      className={`connection-picker-footer-pill ${selectedDb.supported ? "supported" : "soon"}`}
                    >
                      {selectedDb.supported ? "Ready now" : "Coming soon"}
                    </span>
                  </div>
                </>
              ) : (
                <>
                  <span className="connection-picker-footer-label">Selection</span>
                  <div className="connection-picker-footer-selection muted">
                    <strong>Pick a database type to continue</strong>
                  </div>
                </>
              )}
            </div>

            <div className="connection-picker-footer-actions">
              <button onClick={onClose} className="btn btn-secondary">Cancel</button>
              <button
                onClick={() => {
                  if (isSupportedDatabase(selectedDb)) {
                    handleContinueFromPicker(selectedDb);
                  }
                }}
                disabled={!isSupportedDatabase(selectedDb)}
                className="btn btn-primary"
              >
                Continue
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="connection-form-overlay">
      <div className="connection-form-modal">
        <div className="connection-form-header">
          <div className="connection-form-header-main">
            {!editConnection && (
              <button
                type="button"
                onClick={() => setStep("pick")}
                className="connection-form-nav-btn"
                title="Back"
              >
                <ArrowLeft className="w-4 h-4" />
              </button>
            )}

            {selectedDb && (
              <div
                className="connection-db-header-icon"
                style={{ "--db-brand": selectedDb.color } as CSSProperties}
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
              <span className="panel-kicker">{editConnection ? "Edit connection" : "Ready to configure"}</span>
              <h2 className="connection-form-title">{connectionTitle}</h2>
              <p className="connection-form-subtitle">Configure database connection</p>
            </div>
          </div>

          <div className="connection-form-header-side">
            {selectedDb && <span className="connection-form-engine-pill">{selectedDb.label}</span>}
            <button
              type="button"
              onClick={onClose}
              className="connection-form-close"
              title="Close"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="connection-form-body">
          <section className="connection-form-section">
            <div className="connection-form-section-head">
              <div>
                <span className="connection-form-section-kicker">Profile</span>
                <h3 className="connection-form-section-title">Connection identity</h3>
              </div>
              <p className="connection-form-section-copy">
                Name this workspace and choose an accent so it stays recognizable in tabs and badges.
              </p>
            </div>

            <div className="connection-form-profile-grid">
              <div className="connection-form-field">
                <label className="form-label uppercase tracking-wide">Name</label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => updateField("name", e.target.value)}
                  placeholder="My Database"
                  className="input h-11"
                />
              </div>

              <div className="connection-form-field">
                <div className="connection-form-color-head">
                  <label className="form-label uppercase tracking-wide">Color</label>
                  <span className="connection-form-field-hint">Used in tabs, badges, and workspace context</span>
                </div>
                <div className="connection-form-color-palette">
                  {COLORS.map((color) => (
                    <button
                      key={color}
                      type="button"
                      onClick={() => updateField("color", color)}
                      className={`connection-form-color-swatch ${formData.color === color ? "active" : ""}`}
                      style={{ backgroundColor: color }}
                      title={color}
                    />
                  ))}
                </div>
              </div>
            </div>
          </section>

          {isSqlite ? (
            <section className="connection-form-section">
              <div className="connection-form-section-head">
                <div>
                  <span className="connection-form-section-kicker">Storage</span>
                  <h3 className="connection-form-section-title">Database file</h3>
                </div>
                <p className="connection-form-section-copy">
                  Point to an existing SQLite file or enter a path for a new one.
                </p>
              </div>

              <div className="connection-form-field">
                <label className="form-label uppercase tracking-wide">Database File</label>
                <input
                  type="text"
                  value={formData.file_path || ""}
                  onChange={(e) => updateField("file_path", e.target.value)}
                  placeholder="/path/to/database.db"
                  className="input h-11"
                />
              </div>
            </section>
          ) : (
            <section className="connection-form-section">
              <div className="connection-form-section-head">
                <div>
                  <span className="connection-form-section-kicker">Network</span>
                  <h3 className="connection-form-section-title">Connection details</h3>
                </div>
                <p className="connection-form-section-copy">
                  Enter the server endpoint, credentials, and optional database name for this engine.
                </p>
              </div>

              <div className="connection-form-grid connection-form-grid-host">
                <div className="connection-form-field">
                  <label className="form-label uppercase tracking-wide">Host</label>
                  <input
                    type="text"
                    value={formData.host || ""}
                    onChange={(e) => updateField("host", e.target.value)}
                    placeholder="127.0.0.1"
                    className="input h-11"
                  />
                </div>

                <div className="connection-form-field">
                  <label className="form-label uppercase tracking-wide">Port</label>
                  <input
                    type="number"
                    value={formData.port || ""}
                    onChange={(e) => updateField("port", parseInt(e.target.value) || undefined)}
                    placeholder={String(selectedDb?.defaultPort || 3306)}
                    className="input h-11"
                  />
                </div>
              </div>

              <div className="connection-form-grid">
                <div className="connection-form-field">
                  <label className="form-label uppercase tracking-wide">Username</label>
                  <input
                    type="text"
                    value={formData.username || ""}
                    onChange={(e) => updateField("username", e.target.value)}
                    placeholder="root"
                    className="input h-11"
                  />
                </div>

                <div className="connection-form-field">
                  <label className="form-label uppercase tracking-wide">Password</label>
                  <div className="connection-form-password">
                    <input
                      type={showPassword ? "text" : "password"}
                      value={formData.password || ""}
                      onChange={(e) => updateField("password", e.target.value)}
                      placeholder="Enter password"
                      className="input h-11 pr-11"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="connection-form-password-toggle"
                    >
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
              </div>

              <div className="connection-form-field">
                <label className="form-label uppercase tracking-wide">
                  Database <span className="opacity-60">(optional)</span>
                </label>
                <input
                  type="text"
                  value={formData.database || ""}
                  onChange={(e) => updateField("database", e.target.value)}
                  placeholder="my_database"
                  className="input h-11"
                />
              </div>

              <div className="connection-form-toggle-row">
                <label className="connection-form-toggle-card">
                  <input
                    type="checkbox"
                    checked={formData.use_ssl}
                    onChange={(e) => updateField("use_ssl", e.target.checked)}
                    className="sr-only"
                  />
                  <div className="connection-form-toggle-copy">
                    <span className="connection-form-toggle-title">Use SSL/TLS</span>
                    <span className="connection-form-toggle-note">
                      Recommended for cloud databases like Supabase, Neon, and managed PostgreSQL.
                    </span>
                  </div>
                  <div className="connection-form-toggle-track" aria-hidden="true">
                    <div className="connection-form-toggle-thumb" />
                  </div>
                </label>
              </div>
            </section>
          )}

          {testResult && (
            <div className={`connection-form-alert ${testResult.success ? "success" : "error"}`}>
              {testResult.success ? (
                <CheckCircle className="w-4 h-4 shrink-0 mt-0.5" />
              ) : (
                <XCircle className="w-4 h-4 shrink-0 mt-0.5" />
              )}
              <span className="break-words">{testResult.message}</span>
            </div>
          )}
        </div>

        <div className="connection-form-footer">
          <button onClick={handleTest} disabled={isTesting} className="btn btn-secondary">
            {isTesting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plug className="w-3.5 h-3.5" />}
            Test Connection
          </button>

          <div className="connection-form-footer-actions">
            <button onClick={onClose} className="btn btn-secondary">Cancel</button>
            <button onClick={handleConnect} disabled={isConnecting} className="btn btn-primary">
              {isConnecting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Connect
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
