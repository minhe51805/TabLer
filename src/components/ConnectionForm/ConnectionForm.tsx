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

export function ConnectionForm({ onClose, editConnection }: Props) {
  const { connectToDatabase, testConnection, isConnecting } = useAppStore();

  const [step, setStep] = useState<"pick" | "form">(editConnection ? "form" : "pick");
  const [pickerSearch, setPickerSearch] = useState("");
  const [selectedDb, setSelectedDb] = useState<DbEntry | null>(
    editConnection ? ALL_DATABASES.find((d) => d.key === editConnection.db_type) || null : null
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
    }
  );

  const [showPassword, setShowPassword] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [isTesting, setIsTesting] = useState(false);

  const isSqlite = formData.db_type === "sqlite";

  const updateField = <K extends keyof ConnectionConfig>(key: K, value: ConnectionConfig[K]) => {
    setFormData((prev) => ({ ...prev, [key]: value }));
    setTestResult(null);
  };

  const handlePickDb = (db: DbEntry) => {
    if (!db.supported) return;
    setSelectedDb(db);
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
      <div className="fixed inset-0 z-50 flex items-center justify-center px-14 py-12 bg-[rgba(2,8,23,0.72)] backdrop-blur-md">
        <div className="w-full max-w-[860px] bg-[var(--bg-secondary)] border border-white/10 rounded-md !p-4 flex flex-col gap-3 shadow-[0_30px_80px_rgba(0,0,0,0.55)] max-h-[84vh]">
          <div className="!mx-4 !mt4 flex items-center gap-3 rounded-md border border-white/10 bg-[rgba(255,255,255,0.02)] pl-4 pr-4 py-2.5">
            <Search className="h-4 w-4 ml-3! shrink-0 text-[var(--text-muted)]" />
            <input
              type="text"
              value={pickerSearch}
              onChange={(e) => setPickerSearch(e.target.value)}
              placeholder="Search database type..."
              className="h-9 flex-1 bg-transparent border-none outline-none text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
              autoFocus
            />
          </div>

          <div className="flex-1 overflow-y-auto !px-2 !py-1">
            <div className="grid grid-cols-6 gap-4">
              {filteredDbs.map((db) => {
                const brandStyle = { "--db-brand": db.color } as CSSProperties;
                return (
                  <button
                    key={db.key}
                    onClick={() => handlePickDb(db)}
                    disabled={!db.supported}
                    className={[
                      "group flex flex-col items-center gap-2.5 !py-3.5 !px-2 rounded-md border transition-all",
                      db.supported
                        ? "border-white/10 hover:border-[var(--accent)]/45 hover:bg-[rgba(255,255,255,0.03)] cursor-pointer"
                        : "border-white/6 opacity-50 cursor-not-allowed",
                      selectedDb?.key === db.key ? "border-[var(--accent)]! bg-[var(--accent-dim)]" : "",
                    ].join(" ")}
                  >
                    <div className="connection-db-tile-icon" style={brandStyle}>
                      <DatabaseBrandIcon
                        dbKey={db.key}
                        label={db.label}
                        className="connection-db-brand-lg"
                        fallbackClassName="!w-6 !h-6 text-white"
                      />
                    </div>
                    <span className="text-[11px] text-[var(--text-secondary)] text-center leading-tight whitespace-nowrap font-semibold">
                      {db.label}
                    </span>
                    {!db.supported && <span className="text-[9px] text-[var(--text-muted)]">Soon</span>}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex items-center justify-between px-4 py-3 border border-white/10 rounded-md bg-[rgba(255,255,255,0.02)]">
            <button onClick={onClose} className="btn btn-secondary">Cancel</button>
            <button
              onClick={() => selectedDb && handlePickDb(selectedDb)}
              disabled={!selectedDb}
              className="btn btn-primary"
            >
              Continue
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-8 py-8 bg-[rgba(2,8,23,0.72)] backdrop-blur-md">
      <div className="w-full max-w-[760px] bg-[var(--bg-secondary)] border border-white/15 rounded-md overflow-hidden flex flex-col shadow-[0_30px_80px_rgba(0,0,0,0.55)] max-h-[86vh]">
        <div className="flex items-center justify-between !px-5 py-3 border-b border-white/10 bg-[rgba(255,255,255,0.02)]">
          <div className="flex items-center gap-3 min-w-0 ">
            {!editConnection && (
              <button
                onClick={() => setStep("pick")}
                className="p-1.5 -ml-1 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[rgba(255,255,255,0.06)] transition-colors"
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
            <div className="min-w-0 py-4!">
              <h2 className="text-[24px] leading-none font-semibold text-[var(--text-primary)] truncate">
                {editConnection ? "Edit Connection" : `New ${selectedDb?.label || ""} Connection`}
              </h2>
              <p className="text-[12px] mt-1 text-[var(--text-muted)]">Configure database connection</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[rgba(255,255,255,0.06)] transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="!px-5 !py-6 space-y-3.5 flex-1 overflow-y-auto" >
          <div className="grid grid-cols-12 gap-3 items-end mb-4!">
            <div className="col-span-8">
              <label className="form-label uppercase tracking-wide">Name</label>
              <input
                type="text"
                value={formData.name}
                onChange={(e) => updateField("name", e.target.value)}
                placeholder="My Database"
                className="input h-10"
              />
            </div>
            <div className="col-span-4">
              <label className="form-label uppercase tracking-wide">Color</label>
              <div className="flex gap-2">
                {COLORS.map((color) => (
                  <button
                    key={color}
                    onClick={() => updateField("color", color)}
                    className={`w-5 h-5 rounded-full transition-all ${formData.color === color
                        ? "ring-2 ring-offset-2 ring-offset-[var(--bg-secondary)] ring-[var(--accent)] scale-105"
                        : "hover:scale-105 opacity-80 hover:opacity-100"
                      }`}
                    style={{ backgroundColor: color }}
                  />
                ))}
              </div>
            </div>
          </div>

          {isSqlite ? (
            <div>
              <label className="form-label uppercase tracking-wide">Database File</label>
              <input
                type="text"
                value={formData.file_path || ""}
                onChange={(e) => updateField("file_path", e.target.value)}
                placeholder="/path/to/database.db"
                className="input h-10"
              />
            </div>
          ) : (
            <>
              <div className="grid grid-cols-12 gap-3">
                <div className="col-span-10 mb-4!">
                  <label className="form-label uppercase tracking-wide">Host</label>
                  <input
                    type="text"
                    value={formData.host || ""}
                    onChange={(e) => updateField("host", e.target.value)}
                    placeholder="127.0.0.1"
                    className="input h-10"
                  />
                </div>
                <div className="col-span-2 ">
                  <label className="form-label uppercase tracking-wide">Port</label>
                  <input
                    type="number"
                    value={formData.port || ""}
                    onChange={(e) => updateField("port", parseInt(e.target.value) || undefined)}
                    placeholder={String(selectedDb?.defaultPort || 3306)}
                    className="input h-10"
                  />
                </div>
              </div>

              <div className="grid grid-cols-12 gap-3">
                <div className="col-span-6 mb-4!">
                  <label className="form-label uppercase tracking-wide">Username</label>
                  <input
                    type="text"
                    value={formData.username || ""}
                    onChange={(e) => updateField("username", e.target.value)}
                    placeholder="root"
                    className="input h-10"
                  />
                </div>
                <div className="col-span-6">
                  <label className="form-label uppercase tracking-wide">Password</label>
                  <div className="relative">
                    <input
                      type={showPassword ? "text" : "password"}
                      value={formData.password || ""}
                      onChange={(e) => updateField("password", e.target.value)}
                      placeholder="••••••"
                      className="input h-10 pr-10"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
                    >
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
              </div>

              <div>
                <label className="form-label uppercase tracking-wide">
                  Database <span className="opacity-60">(optional)</span>
                </label>
                <input
                  type="text"
                  value={formData.database || ""}
                  onChange={(e) => updateField("database", e.target.value)}
                  placeholder="my_database"
                  className="input h-10"
                />
              </div>

              {!isSqlite && (
                <div className="flex items-center gap-3 py-2">
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={formData.use_ssl}
                      onChange={(e) => updateField("use_ssl", e.target.checked)}
                      className="sr-only peer"
                    />
                    <div className="w-9 h-5 bg-[var(--bg-surface)] peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-[var(--accent)]/50 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-[var(--accent)]"></div>
                    <span className="ml-3 text-sm font-medium text-[var(--text-secondary)]">Use SSL/TLS</span>
                  </label>
                  <span className="text-xs text-[var(--text-muted)]">
                    (Recommended for cloud databases like Supabase, Neon, etc.)
                  </span>
                </div>
              )}
            </>
          )}

          {testResult && (
            <div
              className={`flex items-start gap-2.5 px-3 py-2.5 rounded-md text-[12px] ${testResult.success
                  ? "bg-[rgba(102,217,163,0.1)] text-[var(--success)] border border-[rgba(102,217,163,0.2)]"
                  : "bg-[rgba(255,137,167,0.1)] text-[var(--error)] border border-[rgba(255,137,167,0.2)]"
                }`}
            >
              {testResult.success ? <CheckCircle className="w-4 h-4 shrink-0 mt-0.5" /> : <XCircle className="w-4 h-4 shrink-0 mt-0.5" />}
              <span className="break-words">{testResult.message}</span>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between px-5 py-3 border-t border-white/10 bg-[rgba(255,255,255,0.02)]">
          <button onClick={handleTest} disabled={isTesting} className="btn btn-secondary">
            {isTesting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plug className="w-3.5 h-3.5" />}
            Test Connection
          </button>
          <div className="flex gap-2.5">
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
