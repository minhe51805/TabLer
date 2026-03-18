import { useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties } from "react";
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
  FileUp,
} from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import type { ConnectionConfig, DatabaseType } from "../../types";
import { DatabaseBrandIcon } from "./DatabaseBrandIcon";
import { splitSqlStatements } from "../../utils/sqlStatements";

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
  { key: "mariadb", abbr: "Mr", label: "MariaDB", color: "#6c7a89", supported: true, defaultPort: 3306 },
  { key: "sqlite", abbr: "Sl", label: "SQLite", color: "#3498db", supported: true, defaultPort: 0, isFile: true },
  { key: "duckdb", abbr: "Du", label: "DuckDB", color: "#2c3e50", supported: false, defaultPort: 0, isFile: true },
  { key: "cassandra", abbr: "Cs", label: "Cassandra", color: "#27ae60", supported: false, defaultPort: 9042 },
  { key: "cockroachdb", abbr: "Cr", label: "CockroachDB", color: "#3ddc84", supported: true, defaultPort: 26257 },
  { key: "snowflake", abbr: "Nf", label: "Snowflake", color: "#29b5e8", supported: false, defaultPort: 443 },
  { key: "postgresql", abbr: "Pg", label: "PostgreSQL", color: "#336791", supported: true, defaultPort: 5432 },
  { key: "greenplum", abbr: "Gp", label: "Greenplum", color: "#2ecc71", supported: true, defaultPort: 5432 },
  { key: "redshift", abbr: "Rs", label: "Amazon Redshift", color: "#16a085", supported: true, defaultPort: 5439 },
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

type BootstrapPreset = "none" | "starter_core" | "starter_commerce";

const BOOTSTRAP_PRESET_LABELS: Record<BootstrapPreset, string> = {
  none: "Empty database",
  starter_core: "Starter app schema",
  starter_commerce: "Commerce starter schema",
};

function getBootstrapPresetSql(preset: BootstrapPreset, dbType: DatabaseType) {
  const timestampType = dbType === "mysql" || dbType === "mariadb" ? "DATETIME" : "TIMESTAMP";

  if (preset === "starter_core") {
    return [
      "CREATE TABLE IF NOT EXISTS users (",
      "  id BIGINT PRIMARY KEY,",
      "  email VARCHAR(255) NOT NULL,",
      "  full_name VARCHAR(255),",
      `  created_at ${timestampType} DEFAULT CURRENT_TIMESTAMP`,
      ");",
      "",
      "CREATE TABLE IF NOT EXISTS audit_log (",
      "  id BIGINT PRIMARY KEY,",
      "  entity_type VARCHAR(80) NOT NULL,",
      "  entity_id BIGINT,",
      "  action VARCHAR(80) NOT NULL,",
      `  created_at ${timestampType} DEFAULT CURRENT_TIMESTAMP`,
      ");",
    ].join("\n");
  }

  if (preset === "starter_commerce") {
    return [
      "CREATE TABLE IF NOT EXISTS customers (",
      "  id BIGINT PRIMARY KEY,",
      "  email VARCHAR(255) NOT NULL,",
      "  full_name VARCHAR(255),",
      `  created_at ${timestampType} DEFAULT CURRENT_TIMESTAMP`,
      ");",
      "",
      "CREATE TABLE IF NOT EXISTS products (",
      "  id BIGINT PRIMARY KEY,",
      "  name VARCHAR(255) NOT NULL,",
      "  sku VARCHAR(120),",
      "  price DECIMAL(12,2) NOT NULL",
      ");",
      "",
      "CREATE TABLE IF NOT EXISTS orders (",
      "  id BIGINT PRIMARY KEY,",
      "  customer_id BIGINT NOT NULL,",
      "  status VARCHAR(80) NOT NULL,",
      `  created_at ${timestampType} DEFAULT CURRENT_TIMESTAMP`,
      ");",
    ].join("\n");
  }

  return "";
}

interface Props {
  onClose: () => void;
  editConnection?: ConnectionConfig;
  initialIntent?: "connect" | "bootstrap";
}

interface PickerSection {
  key: string;
  title: string;
  caption: string;
  items: DbEntry[];
}

const LOCAL_BOOTSTRAP_READY = new Set<DatabaseType>(["postgresql", "mysql", "mariadb", "sqlite"]);
const LOCAL_BOOTSTRAP_SOON = new Set<DatabaseType>(["mongodb", "mssql"]);

function isLocalHost(host?: string) {
  const normalized = (host || "").trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1" || normalized === "[::1]";
}

function getPickerMetaLabel(db: DbEntry) {
  if (db.isFile) return "File-based workflow";
  if (db.defaultPort) return `Default port ${db.defaultPort}`;
  return "Cloud-native flow";
}

function getPickerDescription(db: DbEntry, bootstrapMode: boolean) {
  if (bootstrapMode) {
    if (LOCAL_BOOTSTRAP_READY.has(db.key as DatabaseType)) {
      return db.key === "sqlite"
        ? "Create a fresh local file database and open it instantly."
        : "Bootstrap a local workspace, then connect right into it.";
    }

    if (LOCAL_BOOTSTRAP_SOON.has(db.key as DatabaseType)) {
      return "Visible in the roadmap, but the local bootstrap flow is not wired yet.";
    }

    if (db.supported) {
      return "You can connect to this engine today, but local bootstrap is still pending.";
    }

    return "Not available in this build yet.";
  }

  return db.supported
    ? "Ready to configure with host, credentials, and database details."
    : "Shown in the product roadmap and not available in this build yet.";
}

function getPickerStatus(db: DbEntry, bootstrapMode: boolean) {
  if (bootstrapMode) {
    if (LOCAL_BOOTSTRAP_READY.has(db.key as DatabaseType)) {
      return { label: "Local Ready", tone: "supported", canContinue: true };
    }

    if (LOCAL_BOOTSTRAP_SOON.has(db.key as DatabaseType)) {
      return { label: "Local Soon", tone: "soon", canContinue: false };
    }

    if (db.supported) {
      return { label: "Connect Only", tone: "bridge", canContinue: false };
    }

    return { label: "Soon", tone: "soon", canContinue: false };
  }

  return db.supported
    ? { label: "Ready", tone: "supported", canContinue: true }
    : { label: "Soon", tone: "soon", canContinue: false };
}

export function ConnectionForm({ onClose, editConnection, initialIntent = "connect" }: Props) {
  const connectToDatabase = useAppStore((state) => state.connectToDatabase);
  const testConnection = useAppStore((state) => state.testConnection);
  const createLocalDatabase = useAppStore((state) => state.createLocalDatabase);
  const suggestSqliteDatabasePath = useAppStore((state) => state.suggestSqliteDatabasePath);
  const pickSqliteDatabasePath = useAppStore((state) => state.pickSqliteDatabasePath);
  const isConnecting = useAppStore((state) => state.isConnecting);
  const bootstrapMode = !editConnection && initialIntent === "bootstrap";

  const [step, setStep] = useState<"pick" | "form">(editConnection ? "form" : "pick");
  const [pickerSearch, setPickerSearch] = useState("");
  const [selectedDb, setSelectedDb] = useState<DbEntry | null>(
    editConnection
      ? ALL_DATABASES.find((d) => d.key === editConnection.db_type) || null
      : null,
  );

  const [formData, setFormData] = useState<ConnectionConfig>(
    editConnection ? { ...editConnection, password: undefined } : {
      id: crypto.randomUUID(),
      name: "",
      db_type: bootstrapMode ? "postgresql" : "mysql",
      host: "127.0.0.1",
      port: bootstrapMode ? 5432 : 3306,
      username: bootstrapMode ? "postgres" : "root",
      database: "",
      file_path: "",
      use_ssl: false,
      color: COLORS[0],
    },
  );
  const passwordDraftRef = useRef(editConnection?.password || "");

  const [showPassword, setShowPassword] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  const [isCreatingDatabase, setIsCreatingDatabase] = useState(false);
  const [bootstrapPreset, setBootstrapPreset] = useState<BootstrapPreset>("none");
  const [bootstrapSql, setBootstrapSql] = useState("");
  const [bootstrapFileName, setBootstrapFileName] = useState("");
  const [showSqliteAdvancedPath, setShowSqliteAdvancedPath] = useState(false);
  const [sqlitePathTouched, setSqlitePathTouched] = useState(false);
  const supportedCount = ALL_DATABASES.filter((db) => db.supported).length;
  const roadmapCount = ALL_DATABASES.length - supportedCount;
  const bootstrapFileInputRef = useRef<HTMLInputElement | null>(null);

  const isSqlite = formData.db_type === "sqlite";
  const isLocalBootstrapReady = LOCAL_BOOTSTRAP_READY.has(formData.db_type);
  const supportsLocalBootstrap =
    (formData.db_type === "postgresql" || formData.db_type === "mysql" || formData.db_type === "mariadb") &&
    isLocalHost(formData.host);
  const hasBootstrapDatabaseName = !!formData.database?.trim();
  const isBootstrappingWorkspace = isCreatingDatabase || isConnecting;
  const sqliteDatabaseName = (formData.database || "").trim() || (formData.name || "").trim() || "local-database";
  const connectionTitle = editConnection
    ? "Edit Connection"
    : bootstrapMode
      ? selectedDb
        ? `Create Local ${selectedDb.label} Database`
        : "Choose Local Database Engine"
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
    if (bootstrapMode && !LOCAL_BOOTSTRAP_READY.has(db.key as DatabaseType)) {
      return;
    }

      setFormData((prev) => ({
        ...prev,
        db_type: db.key as DatabaseType,
        port: db.defaultPort || prev.port,
        database:
          bootstrapMode && db.key === "sqlite"
            ? prev.database || prev.name || "local-database"
            : prev.database,
        username:
          db.key === "postgresql" || db.key === "cockroachdb" || db.key === "greenplum" || db.key === "redshift"
            ? "postgres"
          : db.key === "mysql" || db.key === "mariadb"
            ? "root"
            : prev.username,
    }));
    setStep("form");
  };

  const handleTest = async () => {
    setIsTesting(true);
    setTestResult(null);
    try {
      const resolvedSqlitePath =
        isSqlite && bootstrapMode
          ? formData.file_path?.trim() || (await suggestSqliteDatabasePath(sqliteDatabaseName))
          : formData.file_path;
      const msg = await testConnection({
        ...formData,
        database: isSqlite && bootstrapMode ? sqliteDatabaseName : formData.database,
        file_path: isSqlite ? resolvedSqlitePath : formData.file_path,
        password: isSqlite ? undefined : passwordDraftRef.current,
      });
      setTestResult({ success: true, message: msg });
    } catch (e) {
      setTestResult({ success: false, message: String(e) });
    }
    setIsTesting(false);
  };

  useEffect(() => {
    if (!bootstrapMode || !isSqlite || sqlitePathTouched) return;

    let cancelled = false;

    void suggestSqliteDatabasePath(sqliteDatabaseName)
      .then((suggestedPath) => {
        if (cancelled) return;
        setFormData((prev) => {
          if (prev.db_type !== "sqlite" || prev.file_path === suggestedPath) return prev;
          return { ...prev, file_path: suggestedPath };
        });
      })
      .catch(() => {
        // Keep the existing manual entry flow if path suggestion fails.
      });

    return () => {
      cancelled = true;
    };
  }, [bootstrapMode, isSqlite, sqliteDatabaseName, sqlitePathTouched, suggestSqliteDatabasePath]);

  const handleConnect = async () => {
    try {
      await connectToDatabase({
        ...formData,
        password: isSqlite ? undefined : passwordDraftRef.current,
      });
      onClose();
    } catch (e) {
      setTestResult({ success: false, message: String(e) });
    }
  };

  const handlePickSqlitePath = async () => {
    try {
      const selectedPath = await pickSqliteDatabasePath(sqliteDatabaseName);
      setShowSqliteAdvancedPath(true);
      if (!selectedPath) return;

      setSqlitePathTouched(true);
      updateField("file_path", selectedPath);
    } catch (e) {
      setTestResult({ success: false, message: String(e) });
    }
  };

  const handleCreateDatabase = async () => {
    setIsCreatingDatabase(true);
    setTestResult(null);
    try {
      if (isSqlite) {
        const resolvedFilePath =
          formData.file_path?.trim() || (await suggestSqliteDatabasePath(sqliteDatabaseName));

        if (!resolvedFilePath) {
          setTestResult({ success: false, message: "Choose a SQLite database name first." });
          return;
        }

        const sqliteConfig = {
          ...formData,
          database: sqliteDatabaseName,
          file_path: resolvedFilePath,
          name:
            formData.name.trim() ||
            `${selectedDb?.label || formData.db_type} ${sqliteDatabaseName}`,
          password: undefined,
        };

        setTestResult({
          success: true,
          message: `Creating SQLite database from ${resolvedFilePath}...`,
        });
        await connectToDatabase(sqliteConfig);
        onClose();
        return;
      }

      const requestedDatabase = formData.database?.trim();
      if (!requestedDatabase) {
        setTestResult({ success: false, message: "Enter a database name first." });
        return;
      }

      const presetSql = getBootstrapPresetSql(bootstrapPreset, formData.db_type);
      const combinedBootstrapSql = [presetSql, bootstrapSql.trim()]
        .filter((segment) => segment.trim().length > 0)
        .join("\n\n");
      const bootstrapStatements = splitSqlStatements(combinedBootstrapSql);
      const bootstrapConfig = {
        ...formData,
        name:
          formData.name.trim() ||
          `${selectedDb?.label || formData.db_type} ${requestedDatabase}`,
        database: requestedDatabase,
        password: isSqlite ? undefined : passwordDraftRef.current,
      };

      const message = await createLocalDatabase(
        bootstrapConfig,
        requestedDatabase,
        bootstrapStatements,
      );
      setTestResult({
        success: true,
        message: `${message} Connecting to ${requestedDatabase}...`,
      });
      await connectToDatabase(bootstrapConfig);
      onClose();
    } catch (e) {
      setTestResult({ success: false, message: String(e) });
    } finally {
      setIsCreatingDatabase(false);
    }
  };

  const handleImportBootstrapFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      setBootstrapSql(text);
      setBootstrapFileName(file.name);
      setTestResult(null);
    } catch (e) {
      setTestResult({
        success: false,
        message: `Could not read SQL file: ${String(e)}`,
      });
    } finally {
      event.target.value = "";
    }
  };

  const filteredDbs = pickerSearch
    ? ALL_DATABASES.filter((d) => d.label.toLowerCase().includes(pickerSearch.toLowerCase()))
    : ALL_DATABASES;
  const pickerSections = useMemo<PickerSection[]>(() => {
    if (!bootstrapMode) {
      return [
        {
          key: "ready",
          title: "Ready now",
          caption: "Engines you can configure immediately in this build.",
          items: filteredDbs.filter((db) => db.supported),
        },
        {
          key: "roadmap",
          title: "Roadmap",
          caption: "Upcoming engines already visible in the product direction.",
          items: filteredDbs.filter((db) => !db.supported),
        },
      ].filter((section) => section.items.length > 0);
    }

    return [
      {
        key: "local-ready",
        title: "Local ready",
        caption: "Bootstrap and open these engines directly from TableR.",
        items: filteredDbs.filter((db) => LOCAL_BOOTSTRAP_READY.has(db.key as DatabaseType)),
      },
      {
        key: "connect-only",
        title: "Connect only",
        caption: "Supported for normal connections, but local bootstrap is not wired yet.",
        items: filteredDbs.filter(
          (db) =>
            db.supported &&
            !LOCAL_BOOTSTRAP_READY.has(db.key as DatabaseType) &&
            !LOCAL_BOOTSTRAP_SOON.has(db.key as DatabaseType),
        ),
      },
      {
        key: "local-roadmap",
        title: "Local roadmap",
        caption: "Visible here so you can see what is planned next for local workflows.",
        items: filteredDbs.filter(
          (db) =>
            LOCAL_BOOTSTRAP_SOON.has(db.key as DatabaseType) ||
            (!db.supported && !LOCAL_BOOTSTRAP_READY.has(db.key as DatabaseType)),
        ),
      },
    ].filter((section) => section.items.length > 0);
  }, [bootstrapMode, filteredDbs]);
  const selectedStatus = selectedDb ? getPickerStatus(selectedDb, bootstrapMode) : null;
  const selectedMeta = selectedDb ? getPickerMetaLabel(selectedDb) : "";
  const selectedDescription = selectedDb ? getPickerDescription(selectedDb, bootstrapMode) : "";

  if (step === "pick") {
    return (
      <div className="connection-picker-overlay">
        <div className="connection-picker-modal">
          <div className="connection-picker-head">
            <div className="connection-picker-copy">
              <span className="panel-kicker">New connection</span>
              <h2 className="connection-picker-title">
                {bootstrapMode ? "Choose a local database engine" : "Choose a database engine"}
              </h2>
              <p className="connection-picker-subtitle">
                {bootstrapMode
                  ? "Bootstrap a local PostgreSQL, MySQL/MariaDB, or SQLite workspace. MongoDB and SQL Server stay visible as the next local targets."
                  : "Pick an engine that is ready now, or browse upcoming integrations that are already on the roadmap."}
              </p>
              <div className="connection-picker-stats">
                <span className="connection-picker-stat accent">
                  <strong>{bootstrapMode ? Array.from(LOCAL_BOOTSTRAP_READY).length : supportedCount}</strong>
                  <span>{bootstrapMode ? "Local ready" : "Ready"}</span>
                </span>
                <span className="connection-picker-stat">
                  <strong>{bootstrapMode ? Array.from(LOCAL_BOOTSTRAP_SOON).length : roadmapCount}</strong>
                  <span>{bootstrapMode ? "Local soon" : "Roadmap"}</span>
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
            <div className="connection-picker-layout">
              <div className="connection-picker-main">
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
                    pickerSections.map((section) => (
                      <section key={section.key} className="connection-picker-section">
                        <div className="connection-picker-section-head">
                          <div className="connection-picker-section-copy">
                            <h3 className="connection-picker-section-title">{section.title}</h3>
                            <p className="connection-picker-section-caption">{section.caption}</p>
                          </div>
                          <span className="connection-picker-section-count">{section.items.length}</span>
                        </div>

                        <div className="connection-picker-grid">
                          {section.items.map((db) => {
                            const brandStyle = { "--db-brand": db.color } as CSSProperties;
                            const isSelected = selectedDb?.key === db.key;
                            const status = getPickerStatus(db, bootstrapMode);

                            return (
                              <button
                                key={db.key}
                                type="button"
                                onClick={() => handleSelectDb(db)}
                                onDoubleClick={() => {
                                  if (status.canContinue) {
                                    handleContinueFromPicker(db);
                                  }
                                }}
                                className={[
                                  "connection-picker-card",
                                  status.tone,
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

                                  <span className={`connection-picker-card-status ${status.tone}`}>
                                    {status.label}
                                  </span>
                                </div>

                                <div className="connection-picker-card-copy">
                                  <span className="connection-picker-card-title">{db.label}</span>
                                  <span className="connection-picker-card-meta">{getPickerMetaLabel(db)}</span>
                                  <span className="connection-picker-card-note">
                                    {getPickerDescription(db, bootstrapMode)}
                                  </span>
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      </section>
                    ))
                  )}
                </div>
              </div>

              <aside className="connection-picker-aside">
                <div className={`connection-picker-selection-card ${selectedDb ? "has-selection" : ""}`}>
                  <span className="connection-picker-footer-label">Selection</span>

                  {selectedDb && selectedStatus ? (
                    <>
                      <div className="connection-picker-selection-head">
                        <div
                          className="connection-db-tile-icon connection-picker-selection-icon"
                          style={{ "--db-brand": selectedDb.color } as CSSProperties}
                        >
                          <DatabaseBrandIcon
                            dbKey={selectedDb.key}
                            label={selectedDb.label}
                            className="connection-db-brand-lg"
                            fallbackClassName="!w-6 !h-6 text-white"
                          />
                        </div>

                        <div className="connection-picker-selection-copy">
                          <strong>{selectedDb.label}</strong>
                          <span className={`connection-picker-footer-pill ${selectedStatus.tone}`}>
                            {selectedStatus.label}
                          </span>
                        </div>
                      </div>

                      <p className="connection-picker-selection-description">{selectedDescription}</p>

                      <div className="connection-picker-selection-meta">
                        <div className="connection-picker-selection-meta-item">
                          <span>Workflow</span>
                          <strong>{selectedMeta}</strong>
                        </div>
                        <div className="connection-picker-selection-meta-item">
                          <span>Mode</span>
                          <strong>{bootstrapMode ? "Local bootstrap" : "Connection setup"}</strong>
                        </div>
                      </div>

                      {bootstrapMode && (
                        <div className="connection-picker-selection-note">
                          Prisma is an ORM, so choose PostgreSQL, MySQL/MariaDB, or SQLite as the underlying engine.
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="connection-picker-selection-empty">
                      <strong>
                        {bootstrapMode
                          ? "Pick a local engine to bootstrap"
                          : "Pick a database type to continue"}
                      </strong>
                      <span>
                        The details and next step will appear here once you select an engine.
                      </span>
                    </div>
                  )}

                  <div className="connection-picker-footer-actions">
                    <button onClick={onClose} className="btn btn-secondary">Cancel</button>
                    <button
                      onClick={() => {
                        if (selectedDb && selectedStatus?.canContinue) {
                          handleContinueFromPicker(selectedDb);
                        }
                      }}
                      disabled={!selectedDb || !selectedStatus?.canContinue}
                      className="btn btn-primary"
                    >
                      Continue
                    </button>
                  </div>
                </div>
              </aside>
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
              {bootstrapMode && (
                <p className="connection-form-subtitle">
                  Create a fresh local database, optionally bootstrap starter SQL, then open it right away.
                </p>
              )}
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
                  {bootstrapMode
                    ? "Give the database a name and TableR will place the SQLite file in its default local storage folder for you."
                    : "Point to an existing SQLite file or enter a path for a new one."}
                </p>
              </div>

              {bootstrapMode ? (
                <div className="connection-form-sqlite-stack">
                  <div className="connection-form-field">
                    <label className="form-label uppercase tracking-wide">Database name</label>
                    <input
                      type="text"
                      value={formData.database || ""}
                      onChange={(e) => updateField("database", e.target.value)}
                      placeholder="my_local_db"
                      className="input h-11"
                    />
                    <span className="connection-form-field-hint">
                      TableR will create <code>{sqliteDatabaseName}.sqlite</code> for you automatically.
                    </span>
                  </div>

                  <div className="connection-form-sqlite-preview">
                    <span className="connection-form-sqlite-preview-label">Default location</span>
                    <code className="connection-form-sqlite-preview-path">
                      {formData.file_path || "Preparing SQLite file location..."}
                    </code>
                  </div>

                  <div className="connection-form-inline-actions">
                    <button
                      type="button"
                      className="btn btn-secondary connection-form-secondary-btn"
                      onClick={handlePickSqlitePath}
                    >
                      Choose location
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary connection-form-secondary-btn"
                      onClick={() => setShowSqliteAdvancedPath((value) => !value)}
                    >
                      {showSqliteAdvancedPath ? "Hide manual path" : "Manual path"}
                    </button>
                    {sqlitePathTouched && (
                      <button
                        type="button"
                        className="btn btn-secondary connection-form-secondary-btn"
                        onClick={() => {
                          setSqlitePathTouched(false);
                          setShowSqliteAdvancedPath(false);
                        }}
                      >
                        Use default location
                      </button>
                    )}
                  </div>

                  {showSqliteAdvancedPath && (
                    <div className="connection-form-field">
                      <label className="form-label uppercase tracking-wide">Custom file path</label>
                      <input
                        type="text"
                        value={formData.file_path || ""}
                        onChange={(e) => {
                          setSqlitePathTouched(true);
                          updateField("file_path", e.target.value);
                        }}
                        placeholder="C:\\Users\\you\\Documents\\my_local_db.sqlite"
                        className="input h-11"
                      />
                    </div>
                  )}
                </div>
              ) : (
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
              )}
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
                      defaultValue={passwordDraftRef.current}
                      onChange={(e) => {
                        passwordDraftRef.current = e.target.value;
                      }}
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
                {supportsLocalBootstrap && (
                  <span className="connection-form-field-hint">
                    {hasBootstrapDatabaseName
                      ? "Local host detected. Create this database and jump straight into the workspace."
                      : "Local host detected. Enter a database name to enable create-and-open bootstrap."}
                  </span>
                )}
                {bootstrapMode && !isLocalBootstrapReady && (
                  <span className="connection-form-field-hint">
                    This engine is not wired for local bootstrap yet in TableR.
                  </span>
                )}
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

              {(supportsLocalBootstrap || isSqlite) && (
                <section className="connection-form-section">
                  <div className="connection-form-section-head">
                    <div>
                      <span className="connection-form-section-kicker">Bootstrap</span>
                      <h3 className="connection-form-section-title">Starter schema and seed SQL</h3>
                    </div>
                    <p className="connection-form-section-copy">
                      Optional. Preload a starter schema, import a local <code>.sql</code> file, or paste extra seed SQL before the workspace opens.
                    </p>
                  </div>

                  <div className="connection-form-grid">
                    <div className="connection-form-field">
                      <label className="form-label uppercase tracking-wide">Starter preset</label>
                      <select
                        value={bootstrapPreset}
                        onChange={(e) => setBootstrapPreset(e.target.value as BootstrapPreset)}
                        className="input h-11"
                      >
                        {Object.entries(BOOTSTRAP_PRESET_LABELS).map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="connection-form-field">
                      <label className="form-label uppercase tracking-wide">Import .sql</label>
                      <div className="connection-form-inline-actions">
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={() => bootstrapFileInputRef.current?.click()}
                        >
                          <FileUp className="w-3.5 h-3.5" />
                          <span>{bootstrapFileName ? "Replace SQL File" : "Choose SQL File"}</span>
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
                        onChange={handleImportBootstrapFile}
                      />
                    </div>
                  </div>

                  <div className="connection-form-field">
                    <label className="form-label uppercase tracking-wide">
                      Additional SQL <span className="opacity-60">(optional)</span>
                    </label>
                    <textarea
                      value={bootstrapSql}
                      onChange={(e) => setBootstrapSql(e.target.value)}
                      placeholder="Paste seed SQL here. It will run after the database is created."
                      className="input connection-form-textarea"
                      rows={8}
                    />
                    <span className="connection-form-field-hint">
                      The preset and your SQL are split into statements, then applied before the new workspace opens.
                    </span>
                  </div>
                </section>
              )}
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
          <div className="connection-form-footer-left">
            <button onClick={handleTest} disabled={isTesting} className="btn btn-secondary">
              {isTesting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plug className="w-3.5 h-3.5" />}
              Test Connection
            </button>
            {(supportsLocalBootstrap || isSqlite) && (
              <button
                type="button"
                onClick={handleCreateDatabase}
                disabled={
                  isBootstrappingWorkspace ||
                  (!isSqlite && !hasBootstrapDatabaseName)
                }
                className="btn btn-secondary"
              >
                {isBootstrappingWorkspace ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <DatabaseBrandIcon
                    dbKey={formData.db_type}
                    label={selectedDb?.label || formData.db_type}
                    className="connection-db-brand-sm"
                    fallbackClassName="!w-3.5 !h-3.5 text-current"
                  />
                )}
                Create & Open
              </button>
            )}
          </div>

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
