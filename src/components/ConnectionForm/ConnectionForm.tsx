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
  Database,
} from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import { useI18n, type AppLanguage } from "../../i18n";
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

function getPickerMetaLabel(db: DbEntry, language: AppLanguage) {
  if (db.isFile) return language === "vi" ? "Quy trình dựa trên tệp" : "File-based workflow";
  if (db.defaultPort) return language === "vi" ? `Cổng mặc định ${db.defaultPort}` : `Default port ${db.defaultPort}`;
  return language === "vi" ? "Quy trình cloud-native" : "Cloud-native flow";
}

function getPickerDescription(db: DbEntry, bootstrapMode: boolean, language: AppLanguage) {
  if (bootstrapMode) {
    if (LOCAL_BOOTSTRAP_READY.has(db.key as DatabaseType)) {
      return db.key === "sqlite"
        ? language === "vi"
          ? "Tạo một cơ sở dữ liệu tệp cục bộ mới và mở ngay."
          : "Create a fresh local file database and open it instantly."
        : language === "vi"
          ? "Khởi tạo một workspace cục bộ rồi kết nối thẳng vào đó."
          : "Bootstrap a local workspace, then connect right into it.";
    }

    if (LOCAL_BOOTSTRAP_SOON.has(db.key as DatabaseType)) {
      return language === "vi"
        ? "Đã hiển thị trong lộ trình, nhưng luồng bootstrap local chưa được nối xong."
        : "Visible in the roadmap, but the local bootstrap flow is not wired yet.";
    }

    if (db.supported) {
      return language === "vi"
        ? "Bạn có thể kết nối tới engine này ngay hôm nay, nhưng bootstrap local vẫn chưa sẵn sàng."
        : "You can connect to this engine today, but local bootstrap is still pending.";
    }

    return language === "vi" ? "Chưa khả dụng trong bản build này." : "Not available in this build yet.";
  }

  return db.supported
    ? language === "vi"
      ? "Sẵn sàng cấu hình host, thông tin đăng nhập và chi tiết cơ sở dữ liệu."
      : "Ready to configure with host, credentials, and database details."
    : language === "vi"
      ? "Đã hiển thị trong lộ trình sản phẩm và chưa khả dụng trong bản build này."
      : "Shown in the product roadmap and not available in this build yet.";
}

function getPickerCapabilities(db: DbEntry, bootstrapMode: boolean, language: AppLanguage) {
  const capabilities: string[] = [];

  if (bootstrapMode) {
    if (LOCAL_BOOTSTRAP_READY.has(db.key as DatabaseType)) {
      capabilities.push(language === "vi" ? "Bootstrap local" : "Local bootstrap");
    } else if (db.supported) {
      capabilities.push(language === "vi" ? "Chỉ kết nối" : "Connect only");
    } else {
      capabilities.push(language === "vi" ? "Lộ trình" : "Roadmap");
    }
  } else {
    capabilities.push(
      db.supported
        ? language === "vi"
          ? "Sẵn sàng"
          : "Ready now"
        : language === "vi"
          ? "Lộ trình"
          : "Roadmap",
    );
  }

  if (db.isFile) {
    capabilities.push(language === "vi" ? "Theo tệp" : "File based");
  } else if (db.defaultPort) {
    capabilities.push(language === "vi" ? `Cổng ${db.defaultPort}` : `Port ${db.defaultPort}`);
  }

  if (db.supported) {
    capabilities.push(language === "vi" ? "Workspace đã lưu" : "Saved workspace");
  }

  return capabilities.slice(0, 3);
}

function getPickerHighlights(db: DbEntry, bootstrapMode: boolean, language: AppLanguage) {
  if (bootstrapMode) {
    if (db.key === "sqlite") {
      return language === "vi"
        ? [
            "Tạo một cơ sở dữ liệu tệp cục bộ mới và mở ngay lập tức.",
            "Rất hợp cho prototype, demo, và làm việc offline.",
            "Có thể áp dụng SQL khởi tạo tùy chọn trong lúc bootstrap.",
          ]
        : [
            "Create a fresh local file database and open it immediately.",
            "Great for prototyping, demos, and offline work.",
            "Optional starter SQL can be applied during bootstrap.",
          ];
    }

    if (LOCAL_BOOTSTRAP_READY.has(db.key as DatabaseType)) {
      return language === "vi"
        ? [
            "Khởi tạo một cơ sở dữ liệu local rồi tự động kết nối vào workspace.",
            "Có thể áp dụng preset schema khởi đầu và import SQL ngay khi tạo.",
            "Phù hợp nhất khi bạn muốn một cơ sở dữ liệu local có server thật.",
          ]
        : [
            "Bootstraps a local database, then connects into the workspace automatically.",
            "Starter schema presets and SQL import can be applied on creation.",
            "Best fit when you want a real server-backed local dev database.",
          ];
    }

    if (db.supported) {
      return language === "vi"
        ? [
            "Kết nối thông thường đã được hỗ trợ trong bản build này.",
            "Bootstrap local chưa được nối xong, nên hãy dùng luồng kết nối tiêu chuẩn.",
            "Engine vẫn hiển thị ở đây để bạn có thể lên kế hoạch mà không mất ngữ cảnh.",
          ]
        : [
            "Normal connections are supported in this build.",
            "Local bootstrap is not wired yet, so use the standard connect flow.",
            "Visible here so you can plan your target engine without losing context.",
          ];
    }

    return language === "vi"
      ? [
          "Engine này đã có trong lộ trình nhưng chưa khả dụng trong bản build hiện tại.",
          "Hãy dùng nó như một mốc tham chiếu cho workflow local ở các bản sau.",
          "Chọn một engine local-ready nếu bạn muốn bootstrap ngay bây giờ.",
        ]
      : [
          "This engine is visible in the roadmap but not available in this build yet.",
          "Use it as a planning reference for future local workflows.",
          "Pick a local-ready engine if you want to bootstrap right now.",
        ];
  }

  if (db.isFile) {
    return language === "vi"
      ? [
          "Không cần host server, chỉ cần đường dẫn tới tệp cơ sở dữ liệu.",
          "Đây là cách nhanh nhất để dựng một workspace local với thiết lập tối thiểu.",
          "Rất hợp cho dữ liệu nhẹ, prototype, và kiểm thử offline.",
        ]
      : [
          "No server host is required, just a database file path.",
          "Fastest way to spin up a local workspace with minimal setup.",
          "Ideal for lightweight app data, prototypes, and offline testing.",
        ];
  }

  if (db.supported) {
    return language === "vi"
      ? [
          "Cấu hình host, thông tin đăng nhập, và chi tiết cơ sở dữ liệu tùy chọn.",
          "Kết nối đã lưu, query tabs, và object explorer đều khả dụng.",
          "Đây là lựa chọn mặc định tốt nếu engine này đã nằm trong stack của bạn.",
        ]
      : [
          "Configure host, credentials, and optional database details.",
          "Saved connections, query tabs, and object explorer are available.",
          "Good default choice if this is already part of your stack today.",
        ];
  }

  return language === "vi"
    ? [
        "Engine này đang được hiển thị như một phần của lộ trình sản phẩm.",
        "Nó chưa thể cấu hình trong bản build hiện tại.",
        "Hãy chọn một engine đã sẵn sàng nếu bạn muốn kết nối ngay.",
      ]
    : [
        "This engine is shown as part of the product roadmap.",
        "It is not configurable in the current build yet.",
        "Choose a ready engine if you want to connect right away.",
      ];
}

function getPickerStatus(db: DbEntry, bootstrapMode: boolean, language: AppLanguage) {
  if (bootstrapMode) {
    if (LOCAL_BOOTSTRAP_READY.has(db.key as DatabaseType)) {
      return { label: language === "vi" ? "Local sẵn sàng" : "Local Ready", tone: "supported", canContinue: true };
    }

    if (LOCAL_BOOTSTRAP_SOON.has(db.key as DatabaseType)) {
      return { label: language === "vi" ? "Local sắp có" : "Local Soon", tone: "soon", canContinue: false };
    }

    if (db.supported) {
      return { label: language === "vi" ? "Chỉ kết nối" : "Connect Only", tone: "bridge", canContinue: false };
    }

    return { label: language === "vi" ? "Sắp có" : "Soon", tone: "soon", canContinue: false };
  }

  return db.supported
    ? { label: language === "vi" ? "Sẵn sàng" : "Ready", tone: "supported", canContinue: true }
    : { label: language === "vi" ? "Sắp có" : "Soon", tone: "soon", canContinue: false };
}

export function ConnectionForm({ onClose, editConnection, initialIntent = "connect" }: Props) {
  const { language, t } = useI18n();
  const connectToDatabase = useAppStore((state) => state.connectToDatabase);
  const testConnection = useAppStore((state) => state.testConnection);
  const createLocalDatabase = useAppStore((state) => state.createLocalDatabase);
  const suggestSqliteDatabasePath = useAppStore((state) => state.suggestSqliteDatabasePath);
  const pickSqliteDatabasePath = useAppStore((state) => state.pickSqliteDatabasePath);
  const isConnecting = useAppStore((state) => state.isConnecting);
  const [intentMode, setIntentMode] = useState<"connect" | "bootstrap">(
    editConnection ? "connect" : initialIntent,
  );
  const bootstrapMode = !editConnection && intentMode === "bootstrap";

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
      username: "",
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
  const suggestedUsernamePlaceholder =
    selectedDb?.key === "postgresql" ||
    selectedDb?.key === "cockroachdb" ||
    selectedDb?.key === "greenplum" ||
    selectedDb?.key === "redshift"
      ? "postgres"
      : selectedDb?.key === "mysql" || selectedDb?.key === "mariadb"
        ? "root"
        : "db_user";
  const connectionTitle = editConnection
    ? language === "vi"
      ? "Sửa kết nối"
      : "Edit connection"
    : bootstrapMode
      ? selectedDb
        ? language === "vi"
          ? `Tạo Local DB ${selectedDb.label}`
          : `Local DB ${selectedDb.label}`
        : "Local DB"
      : selectedDb
        ? language === "vi"
          ? `Kết nối mới ${selectedDb.label}`
          : `New ${selectedDb.label}`
        : language === "vi"
          ? "Kết nối mới"
          : "New connection";

  const copy = useMemo(
    () => {
      const commonCopy = {
        pickerKicker: t("menu.item.newConnection"),
        cancel: t("common.cancel"),
        continue: t("common.continue"),
        close: t("titlebar.close"),
        name: t("common.name"),
        databaseOptional: t("common.database"),
        connect: t("common.connect"),
      };

      if (language === "vi") {
        return {
          ...commonCopy,
          pickerTitle: "Chọn một engine cơ sở dữ liệu",
          pickerLocalTitle: "Chọn một engine cơ sở dữ liệu local",
          pickerSubtitle:
            "Chọn engine đã sẵn sàng ngay bây giờ, hoặc xem các tích hợp sắp tới đã có trong lộ trình.",
          pickerLocalSubtitle:
            "Khởi tạo một workspace local PostgreSQL, MySQL/MariaDB, hoặc SQLite. MongoDB và SQL Server vẫn hiển thị như bước local tiếp theo.",
          flowLabel: "Luồng kết nối",
          remoteSaved: "Remote & đã lưu",
          localDb: "Local DB",
          ready: "Sẵn sàng",
          roadmap: "Lộ trình",
          shown: "Đang hiển thị",
          localReady: "Local sẵn sàng",
          localSoon: "Local sắp có",
          searchPlaceholder: "Tìm loại cơ sở dữ liệu...",
          emptySearch: "Không có loại cơ sở dữ liệu nào khớp tìm kiếm.",
          readyNow: "Sẵn sàng ngay",
          readyNowCaption: "Các engine bạn có thể cấu hình ngay trong bản build này.",
          roadmapCaption: "Các engine sắp tới đã hiển thị trong định hướng sản phẩm.",
          localReadyCaption: "Khởi tạo và mở các engine này trực tiếp từ TabLer.",
          connectOnly: "Chỉ kết nối",
          connectOnlyCaption: "Đã hỗ trợ kết nối thông thường, nhưng local bootstrap chưa được nối.",
          localRoadmap: "Lộ trình local",
          localRoadmapCaption: "Hiển thị để bạn thấy phần workflow local sẽ được bổ sung tiếp theo.",
          selection: "Lựa chọn",
          workflow: "Workflow",
          mode: "Chế độ",
          availability: "Khả dụng",
          engineType: "Loại engine",
          connectionSetup: "Thiết lập kết nối",
          localBootstrap: "Bootstrap local",
          fileDatabase: "Cơ sở dữ liệu theo tệp",
          serverDatabase: "Cơ sở dữ liệu máy chủ",
          createFreshLocalInstead: "Tạo một workspace local mới thay thế",
          prismaNote:
            "Prisma là một ORM, vì vậy hãy chọn PostgreSQL, MySQL/MariaDB, hoặc SQLite làm engine nền.",
          pickLocalEngine: "Chọn một engine local để bootstrap",
          pickDatabaseType: "Chọn một loại cơ sở dữ liệu để tiếp tục",
          selectionHint: "Chi tiết và bước tiếp theo sẽ xuất hiện ở đây sau khi bạn chọn một engine.",
          previewOnly: "Chỉ xem trước",
          doubleClickContinue: "Nhấp đúp để tiếp tục",
          back: "Quay lại",
          editConnection: "Sửa kết nối",
          readyToConfigure: "Sẵn sàng cấu hình",
          configureSubtitle: "Cấu hình kết nối cơ sở dữ liệu",
          configureLocalSubtitle:
            "Tạo một cơ sở dữ liệu local mới, tùy chọn bootstrap starter SQL, rồi mở ngay sau đó.",
          profile: "Hồ sơ",
          connectionIdentity: "Nhận diện kết nối",
          identityCopy: "Đặt tên workspace và chọn màu nhấn để dễ nhận ra trong tab và badge.",
          color: "Màu",
          colorHint: "Được dùng trong tab, badge, và ngữ cảnh workspace",
          myDatabase: "Cơ sở dữ liệu của tôi",
          storage: "Lưu trữ",
          databaseFile: "Tệp cơ sở dữ liệu",
          databaseFileBootstrapCopy:
            "Đặt tên cho cơ sở dữ liệu và TableR sẽ tạo tệp SQLite trong thư mục local mặc định cho bạn.",
          databaseFileConnectCopy: "Trỏ tới một tệp SQLite có sẵn hoặc nhập đường dẫn cho tệp mới.",
          databaseName: "Tên cơ sở dữ liệu",
          databaseNamePlaceholder: "co_so_du_lieu_local",
          databaseNameHint: `TableR sẽ tự động tạo ${sqliteDatabaseName}.sqlite cho bạn.`,
          defaultLocation: "Vị trí mặc định",
          preparingSqliteLocation: "Đang chuẩn bị vị trí tệp SQLite...",
          chooseLocation: "Chọn vị trí",
          hideManualPath: "Ẩn đường dẫn thủ công",
          manualPath: "Đường dẫn thủ công",
          useDefaultLocation: "Dùng vị trí mặc định",
          customFilePath: "Đường dẫn tệp tùy chỉnh",
          network: "Mạng",
          connectionDetails: "Chi tiết kết nối",
          detailsCopy: "Nhập địa chỉ máy chủ, thông tin đăng nhập, và tên cơ sở dữ liệu tùy chọn cho engine này.",
          host: "Host",
          port: "Cổng",
          username: "Tên người dùng",
          password: "Mật khẩu",
          enterPassword: "Nhập mật khẩu",
          optional: "tùy chọn",
          localHostDetectedNamed: "Đã phát hiện host local. Tạo cơ sở dữ liệu này và vào workspace ngay.",
          localHostDetectedBlank: "Đã phát hiện host local. Hãy nhập tên cơ sở dữ liệu để bật create-and-open bootstrap.",
          engineNotLocalBootstrap: "Engine này chưa được nối cho local bootstrap trong TableR.",
          useSsl: "Dùng SSL/TLS",
          useSslNote: "Khuyên dùng cho các cơ sở dữ liệu cloud như Supabase, Neon, và PostgreSQL managed.",
          bootstrap: "Bootstrap",
          starterSchemaSeedSql: "Schema khởi đầu và seed SQL",
          starterSchemaSeedSqlCopy:
            "Tùy chọn. Nạp trước schema khởi đầu, import tệp .sql local, hoặc dán thêm seed SQL trước khi workspace mở.",
          starterPreset: "Preset khởi đầu",
          importSql: "Import .sql",
          replaceSqlFile: "Thay tệp SQL",
          chooseSqlFile: "Chọn tệp SQL",
          additionalSql: "SQL bổ sung",
          additionalSqlPlaceholder: "Dán seed SQL tại đây. Nó sẽ chạy sau khi cơ sở dữ liệu được tạo.",
          additionalSqlHint: "Preset và SQL của bạn sẽ được tách thành từng statement rồi áp dụng trước khi workspace mới mở.",
          testConnection: "Kiểm tra kết nối",
          createAndOpen: "Tạo & Mở",
          emptyDatabase: "Cơ sở dữ liệu trống",
          starterAppSchema: "Schema ứng dụng mẫu",
          commerceStarterSchema: "Schema thương mại mẫu",
        };
      }

      return {
        ...commonCopy,
        pickerTitle: "Choose a database engine",
        pickerLocalTitle: "Choose a local database engine",
        pickerSubtitle:
          "Pick an engine that is ready now, or browse upcoming integrations that are already on the roadmap.",
        pickerLocalSubtitle:
          "Bootstrap a local PostgreSQL, MySQL/MariaDB, or SQLite workspace. MongoDB and SQL Server stay visible as the next local.",
        flowLabel: "Connection flow",
        remoteSaved: "Remote & saved",
        localDb: "Local DB",
        ready: "Ready",
        roadmap: "Roadmap",
        shown: "Shown",
        localReady: "Local ready",
        localSoon: "Local soon",
        searchPlaceholder: "Search database type...",
        emptySearch: "No database types match that search.",
        readyNow: "Ready now",
        readyNowCaption: "Engines you can configure immediately in this build.",
        roadmapCaption: "Upcoming engines already visible in the product direction.",
        localReadyCaption: "Bootstrap and open these engines directly from TableR.",
        connectOnly: "Connect only",
        connectOnlyCaption: "Supported for normal connections, but local bootstrap is not wired yet.",
        localRoadmap: "Local roadmap",
        localRoadmapCaption: "Visible here so you can see what is planned next for local workflows.",
        selection: "Selection",
        workflow: "Workflow",
        mode: "Mode",
        availability: "Availability",
        engineType: "Engine type",
        connectionSetup: "Connection setup",
        localBootstrap: "Local bootstrap",
        fileDatabase: "File database",
        serverDatabase: "Server database",
        createFreshLocalInstead: "Create a fresh local workspace instead",
        prismaNote:
          "Prisma is an ORM, so choose PostgreSQL, MySQL/MariaDB, or SQLite as the underlying engine.",
        pickLocalEngine: "Pick a local engine to bootstrap",
        pickDatabaseType: "Pick a database type to continue",
        selectionHint: "The details and next step will appear here once you select an engine.",
        previewOnly: "Preview only",
        doubleClickContinue: "Double-click to continue",
        back: "Back",
        editConnection: "Edit connection",
        readyToConfigure: "Ready to configure",
        configureSubtitle: "Configure database connection",
        configureLocalSubtitle:
          "Create a fresh local database, optionally bootstrap starter SQL, then open it right away.",
        profile: "Profile",
        connectionIdentity: "Connection identity",
        identityCopy:
          "Name this workspace and choose an accent so it stays recognizable in tabs and badges.",
        color: "Color",
        colorHint: "Used in tabs, badges, and workspace context",
        myDatabase: "My Database",
        storage: "Storage",
        databaseFile: "Database file",
        databaseFileBootstrapCopy:
          "Give the database a name and TabLer will place the SQLite file in its default local storage folder for you.",
        databaseFileConnectCopy: "Point to an existing SQLite file or enter a path for a new one.",
        databaseName: "Database name",
        databaseNamePlaceholder: "my_local_db",
        databaseNameHint: `TabLer will create ${sqliteDatabaseName}.sqlite for you automatically.`,
        defaultLocation: "Default location",
        preparingSqliteLocation: "Preparing SQLite file location...",
        chooseLocation: "Choose location",
        hideManualPath: "Hide manual path",
        manualPath: "Manual path",
        useDefaultLocation: "Use default location",
        customFilePath: "Custom file path",
        network: "Network",
        connectionDetails: "Connection details",
        detailsCopy:
          "Enter the server endpoint, credentials, and optional database name for this engine.",
        host: "Host",
        port: "Port",
        username: "Username",
        password: "Password",
        enterPassword: "Enter password",
        optional: "optional",
        localHostDetectedNamed:
          "Local host detected. Create this database and jump straight into the workspace.",
        localHostDetectedBlank:
          "Local host detected. Enter a database name to enable create-and-open bootstrap.",
        engineNotLocalBootstrap: "This engine is not wired for local bootstrap yet in TabLer.",
        useSsl: "Use SSL/TLS",
        useSslNote:
          "Recommended for cloud databases like Supabase, Neon, and managed PostgreSQL.",
        bootstrap: "Bootstrap",
        starterSchemaSeedSql: "Starter schema and seed SQL",
        starterSchemaSeedSqlCopy:
          "Optional. Preload a starter schema, import a local .sql file, or paste extra seed SQL before the workspace opens.",
        starterPreset: "Starter preset",
        importSql: "Import .sql",
        replaceSqlFile: "Replace SQL File",
        chooseSqlFile: "Choose SQL File",
        additionalSql: "Additional SQL",
        additionalSqlPlaceholder: "Paste seed SQL here. It will run after the database is created.",
        additionalSqlHint:
          "The preset and your SQL are split into statements, then applied before the new workspace opens.",
        testConnection: "Test Connection",
        createAndOpen: "Create & Open",
        emptyDatabase: "Empty database",
        starterAppSchema: "Starter app schema",
        commerceStarterSchema: "Commerce starter schema",
      };
    },
    [language, sqliteDatabaseName, t],
  );

  const bootstrapPresetLabels: Record<BootstrapPreset, string> = useMemo(
    () => ({
      none: copy.emptyDatabase,
      starter_core: copy.starterAppSchema,
      starter_commerce: copy.commerceStarterSchema,
    }),
    [copy],
  );

  const updateField = <K extends keyof ConnectionConfig>(key: K, value: ConnectionConfig[K]) => {
    setFormData((prev) => ({ ...prev, [key]: value }));
    setTestResult(null);
  };

  const handleSelectDb = (db: DbEntry) => {
    setSelectedDb(db);
  };

  const handleSwitchIntent = (nextIntent: "connect" | "bootstrap") => {
    if (editConnection || nextIntent === intentMode) return;

    setIntentMode(nextIntent);
    setPickerSearch("");
    setSelectedDb(null);
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
        username: db.key === "sqlite" ? prev.username : "",
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

  useEffect(() => {
    return () => {
      passwordDraftRef.current = "";
    };
  }, []);

  const handleConnect = async () => {
    try {
      await connectToDatabase({
        ...formData,
        password: isSqlite ? undefined : passwordDraftRef.current,
      });
      passwordDraftRef.current = "";
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
          setTestResult({
            success: false,
            message:
              language === "vi"
                ? "Hãy chọn tên cơ sở dữ liệu SQLite trước."
                : "Choose a SQLite database name first.",
          });
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
          message:
            language === "vi"
              ? `Đang tạo cơ sở dữ liệu SQLite từ ${resolvedFilePath}...`
              : `Creating SQLite database from ${resolvedFilePath}...`,
        });
        await connectToDatabase(sqliteConfig);
        passwordDraftRef.current = "";
        onClose();
        return;
      }

      const requestedDatabase = formData.database?.trim();
      if (!requestedDatabase) {
        setTestResult({
          success: false,
          message: language === "vi" ? "Hãy nhập tên cơ sở dữ liệu trước." : "Enter a database name first.",
        });
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
        message:
          language === "vi"
            ? `${message} Đang kết nối tới ${requestedDatabase}...`
            : `${message} Connecting to ${requestedDatabase}...`,
      });
      await connectToDatabase(bootstrapConfig);
      passwordDraftRef.current = "";
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
        message:
          language === "vi"
            ? `Không thể đọc tệp SQL: ${String(e)}`
            : `Could not read SQL file: ${String(e)}`,
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
          title: copy.readyNow,
          caption: copy.readyNowCaption,
          items: filteredDbs.filter((db) => db.supported),
        },
        {
          key: "roadmap",
          title: copy.roadmap,
          caption: copy.roadmapCaption,
          items: filteredDbs.filter((db) => !db.supported),
        },
      ].filter((section) => section.items.length > 0);
    }

    return [
      {
        key: "local-ready",
        title: copy.localReady,
        caption: copy.localReadyCaption,
        items: filteredDbs.filter((db) => LOCAL_BOOTSTRAP_READY.has(db.key as DatabaseType)),
      },
      {
        key: "connect-only",
        title: copy.connectOnly,
        caption: copy.connectOnlyCaption,
        items: filteredDbs.filter(
          (db) =>
            db.supported &&
            !LOCAL_BOOTSTRAP_READY.has(db.key as DatabaseType) &&
            !LOCAL_BOOTSTRAP_SOON.has(db.key as DatabaseType),
        ),
      },
      {
        key: "local-roadmap",
        title: copy.localRoadmap,
        caption: copy.localRoadmapCaption,
        items: filteredDbs.filter(
          (db) =>
            LOCAL_BOOTSTRAP_SOON.has(db.key as DatabaseType) ||
            (!db.supported && !LOCAL_BOOTSTRAP_READY.has(db.key as DatabaseType)),
        ),
      },
    ].filter((section) => section.items.length > 0);
  }, [bootstrapMode, copy, filteredDbs]);
  const selectedStatus = selectedDb ? getPickerStatus(selectedDb, bootstrapMode, language) : null;
  const selectedMeta = selectedDb ? getPickerMetaLabel(selectedDb, language) : "";
  const selectedDescription = selectedDb ? getPickerDescription(selectedDb, bootstrapMode, language) : "";
  const selectedCapabilities = selectedDb ? getPickerCapabilities(selectedDb, bootstrapMode, language) : [];
  const selectedHighlights = selectedDb ? getPickerHighlights(selectedDb, bootstrapMode, language) : [];

  useEffect(() => {
    if (step !== "pick") return;

    const visibleItems = pickerSections.flatMap((section) => section.items);
    if (visibleItems.length === 0) {
      if (selectedDb) {
        setSelectedDb(null);
      }
      return;
    }

    if (!selectedDb || !visibleItems.some((item) => item.key === selectedDb.key)) {
      setSelectedDb(visibleItems[0]);
    }
  }, [pickerSections, selectedDb, step]);

  if (step === "pick") {
    return (
      <div className="connection-picker-overlay">
        <div className="connection-picker-modal">
          <div className="connection-picker-head">
            <div className="connection-picker-copy">
              <span className="panel-kicker">{copy.pickerKicker}</span>
              <h2 className="connection-picker-title">
                {bootstrapMode ? copy.pickerLocalTitle : copy.pickerTitle}
              </h2>
              <p className="connection-picker-subtitle">
                {bootstrapMode
                  ? copy.pickerLocalSubtitle
                  : copy.pickerSubtitle}
              </p>
              {!editConnection && (
                <div className="connection-picker-mode-switch" role="group" aria-label={copy.flowLabel}>
                  <button
                    type="button"
                    className={`connection-picker-mode-btn ${!bootstrapMode ? "active" : ""}`}
                    onClick={() => handleSwitchIntent("connect")}
                    aria-pressed={!bootstrapMode}
                  >
                    <Plug className="w-3.5 h-3.5" />
                    <span>{copy.remoteSaved}</span>
                  </button>
                  <button
                    type="button"
                    className={`connection-picker-mode-btn ${bootstrapMode ? "active" : ""}`}
                    onClick={() => handleSwitchIntent("bootstrap")}
                    aria-pressed={bootstrapMode}
                  >
                    <Database className="w-3.5 h-3.5" />
                    <span>{copy.localDb}</span>
                  </button>
                </div>
              )}
              <div className="connection-picker-stats">
                <span className="connection-picker-stat accent">
                  <strong>{bootstrapMode ? Array.from(LOCAL_BOOTSTRAP_READY).length : supportedCount}</strong>
                  <span>{bootstrapMode ? copy.localReady : copy.ready}</span>
                </span>
                <span className="connection-picker-stat">
                  <strong>{bootstrapMode ? Array.from(LOCAL_BOOTSTRAP_SOON).length : roadmapCount}</strong>
                  <span>{bootstrapMode ? copy.localSoon : copy.roadmap}</span>
                </span>
                <span className="connection-picker-stat">
                  <strong>{filteredDbs.length}</strong>
                  <span>{copy.shown}</span>
                </span>
              </div>
            </div>

            <button
              type="button"
              onClick={onClose}
              className="connection-picker-close"
              title={copy.close}
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="connection-picker-body">
            <div className="connection-picker-layout">
              <div className="connection-picker-main">
                <div className="connection-picker-browser">
                  <div className="connection-picker-toolbar">
                    <div className="connection-picker-searchbar">
                      <Search className="connection-picker-search-icon h-4 w-4 shrink-0" />
                      <input
                        type="text"
                        value={pickerSearch}
                        onChange={(e) => setPickerSearch(e.target.value)}
                        placeholder={copy.searchPlaceholder}
                        className="connection-picker-search-input"
                        autoFocus
                      />
                    </div>

                    <div className="connection-picker-filter-row">
                      {pickerSections.map((section) => (
                        <span key={section.key} className="connection-picker-filter-pill">
                          <strong>{section.items.length}</strong>
                          <span>{section.title}</span>
                        </span>
                      ))}
                    </div>
                  </div>

                  <div className="connection-picker-grid-shell">
                    {filteredDbs.length === 0 ? (
                      <div className="connection-picker-empty">
                        <Search className="w-4 h-4" />
                        <span>{copy.emptySearch}</span>
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
                              const status = getPickerStatus(db, bootstrapMode, language);

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

                                    <div className="connection-picker-card-copy">
                                      <div className="connection-picker-card-head">
                                        <span className="connection-picker-card-title">{db.label}</span>
                                        <span className={`connection-picker-card-status ${status.tone}`}>
                                          {status.label}
                                        </span>
                                      </div>
                                      <span className="connection-picker-card-meta">{getPickerMetaLabel(db, language)}</span>
                                      <span className="connection-picker-card-note">
                                        {getPickerDescription(db, bootstrapMode, language)}
                                      </span>
                                    </div>
                                  </div>

                                  <div className="connection-picker-card-footer">
                                    <div className="connection-picker-card-tags">
                                      {getPickerCapabilities(db, bootstrapMode, language).map((capability) => (
                                        <span key={`${db.key}-${capability}`} className="connection-picker-card-tag">
                                          {capability}
                                        </span>
                                      ))}
                                    </div>
                                    <span className="connection-picker-card-hint">
                                      {status.canContinue ? copy.doubleClickContinue : copy.previewOnly}
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
              </div>

              <aside className="connection-picker-aside">
                <div className={`connection-picker-selection-card ${selectedDb ? "has-selection" : ""}`}>
                  <span className="connection-picker-footer-label">{copy.selection}</span>

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

                      <div className="connection-picker-selection-tags">
                        {selectedCapabilities.map((capability) => (
                          <span key={capability} className="connection-picker-selection-tag">
                            {capability}
                          </span>
                        ))}
                      </div>

                      <div className="connection-picker-selection-meta">
                        <div className="connection-picker-selection-meta-item">
                          <span>{copy.workflow}</span>
                          <strong>{selectedMeta}</strong>
                        </div>
                        <div className="connection-picker-selection-meta-item">
                          <span>{copy.mode}</span>
                          <strong>{bootstrapMode ? copy.localBootstrap : copy.connectionSetup}</strong>
                        </div>
                        <div className="connection-picker-selection-meta-item">
                          <span>{copy.availability}</span>
                          <strong>{selectedStatus.label}</strong>
                        </div>
                        <div className="connection-picker-selection-meta-item">
                          <span>{copy.engineType}</span>
                          <strong>{selectedDb.isFile ? copy.fileDatabase : copy.serverDatabase}</strong>
                        </div>
                      </div>

                      <div className="connection-picker-selection-list">
                        {selectedHighlights.map((highlight) => (
                          <div key={highlight} className="connection-picker-selection-list-item">
                            {highlight}
                          </div>
                        ))}
                      </div>

                      {!bootstrapMode && LOCAL_BOOTSTRAP_READY.has(selectedDb.key as DatabaseType) && (
                        <button
                          type="button"
                          className="connection-picker-selection-switch"
                          onClick={() => handleSwitchIntent("bootstrap")}
                        >
                          <Database className="w-3.5 h-3.5" />
                          <span>{copy.createFreshLocalInstead}</span>
                        </button>
                      )}

                      {bootstrapMode && (
                        <div className="connection-picker-selection-note">
                          {copy.prismaNote}
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="connection-picker-selection-empty">
                      <strong>
                        {bootstrapMode
                          ? copy.pickLocalEngine
                          : copy.pickDatabaseType}
                      </strong>
                      <span>
                        {copy.selectionHint}
                      </span>
                    </div>
                  )}

                  <div className="connection-picker-footer-actions">
                    <button onClick={onClose} className="btn btn-secondary">{copy.cancel}</button>
                    <button
                      onClick={() => {
                        if (selectedDb && selectedStatus?.canContinue) {
                          handleContinueFromPicker(selectedDb);
                        }
                      }}
                      disabled={!selectedDb || !selectedStatus?.canContinue}
                      className="btn btn-primary"
                    >
                      {copy.continue}
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
                title={copy.back}
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
              <span className="panel-kicker">{editConnection ? copy.editConnection : copy.readyToConfigure}</span>
              <h2 className="connection-form-title">{connectionTitle}</h2>
              <p className="connection-form-subtitle">{copy.configureSubtitle}</p>
              {bootstrapMode && (
                <p className="connection-form-subtitle">
                  {copy.configureLocalSubtitle}
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
              title={copy.close}
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="connection-form-body">
          <section className="connection-form-section">
            <div className="connection-form-section-head">
              <div>
                <span className="connection-form-section-kicker">{copy.profile}</span>
                <h3 className="connection-form-section-title">{copy.connectionIdentity}</h3>
              </div>
              <p className="connection-form-section-copy">
                {copy.identityCopy}
              </p>
            </div>

            <div className="connection-form-profile-grid">
              <div className="connection-form-field">
                <label className="form-label uppercase tracking-wide">{copy.name}</label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => updateField("name", e.target.value)}
                  placeholder={copy.myDatabase}
                  className="input h-11"
                />
              </div>

              <div className="connection-form-field">
                <div className="connection-form-color-head">
                  <label className="form-label uppercase tracking-wide">{copy.color}</label>
                  <span className="connection-form-field-hint">{copy.colorHint}</span>
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
                  <span className="connection-form-section-kicker">{copy.storage}</span>
                  <h3 className="connection-form-section-title">{copy.databaseFile}</h3>
                </div>
                <p className="connection-form-section-copy">
                  {bootstrapMode
                    ? copy.databaseFileBootstrapCopy
                    : copy.databaseFileConnectCopy}
                </p>
              </div>

              {bootstrapMode ? (
                <div className="connection-form-sqlite-stack">
                  <div className="connection-form-field">
                    <label className="form-label uppercase tracking-wide">{copy.databaseName}</label>
                    <input
                      type="text"
                      value={formData.database || ""}
                      onChange={(e) => updateField("database", e.target.value)}
                      placeholder={copy.databaseNamePlaceholder}
                      className="input h-11"
                    />
                    <span className="connection-form-field-hint">
                      {copy.databaseNameHint}
                    </span>
                  </div>

                  <div className="connection-form-sqlite-preview">
                    <span className="connection-form-sqlite-preview-label">{copy.defaultLocation}</span>
                    <code className="connection-form-sqlite-preview-path">
                      {formData.file_path || copy.preparingSqliteLocation}
                    </code>
                  </div>

                  <div className="connection-form-inline-actions">
                    <button
                      type="button"
                      className="btn btn-secondary connection-form-secondary-btn"
                      onClick={handlePickSqlitePath}
                    >
                      {copy.chooseLocation}
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary connection-form-secondary-btn"
                      onClick={() => setShowSqliteAdvancedPath((value) => !value)}
                    >
                      {showSqliteAdvancedPath ? copy.hideManualPath : copy.manualPath}
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
                        {copy.useDefaultLocation}
                      </button>
                    )}
                  </div>

                  {showSqliteAdvancedPath && (
                    <div className="connection-form-field">
                      <label className="form-label uppercase tracking-wide">{copy.customFilePath}</label>
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
                  <label className="form-label uppercase tracking-wide">{copy.databaseFile}</label>
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
                  <span className="connection-form-section-kicker">{copy.network}</span>
                  <h3 className="connection-form-section-title">{copy.connectionDetails}</h3>
                </div>
                <p className="connection-form-section-copy">
                  {copy.detailsCopy}
                </p>
              </div>

              <div className="connection-form-grid connection-form-grid-host">
                <div className="connection-form-field">
                  <label className="form-label uppercase tracking-wide">{copy.host}</label>
                  <input
                    type="text"
                    value={formData.host || ""}
                    onChange={(e) => updateField("host", e.target.value)}
                    placeholder="127.0.0.1"
                    className="input h-11"
                  />
                </div>

                <div className="connection-form-field">
                  <label className="form-label uppercase tracking-wide">{copy.port}</label>
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
                  <label className="form-label uppercase tracking-wide">{copy.username}</label>
                  <input
                    type="text"
                    value={formData.username || ""}
                    onChange={(e) => updateField("username", e.target.value)}
                    placeholder={suggestedUsernamePlaceholder}
                    className="input h-11"
                  />
                </div>

                <div className="connection-form-field">
                  <label className="form-label uppercase tracking-wide">{copy.password}</label>
                  <div className="connection-form-password">
                    <input
                      type={showPassword ? "text" : "password"}
                      defaultValue={passwordDraftRef.current}
                      onChange={(e) => {
                        passwordDraftRef.current = e.target.value;
                      }}
                      placeholder={copy.enterPassword}
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
                  {copy.databaseOptional} <span className="opacity-60">({copy.optional})</span>
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
                      ? copy.localHostDetectedNamed
                      : copy.localHostDetectedBlank}
                  </span>
                )}
                {bootstrapMode && !isLocalBootstrapReady && (
                  <span className="connection-form-field-hint">
                    {copy.engineNotLocalBootstrap}
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
                    <span className="connection-form-toggle-title">{copy.useSsl}</span>
                    <span className="connection-form-toggle-note">
                      {copy.useSslNote}
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
                      <span className="connection-form-section-kicker">{copy.bootstrap}</span>
                      <h3 className="connection-form-section-title">{copy.starterSchemaSeedSql}</h3>
                    </div>
                    <p className="connection-form-section-copy">
                      {copy.starterSchemaSeedSqlCopy}
                    </p>
                  </div>

                  <div className="connection-form-grid">
                    <div className="connection-form-field">
                      <label className="form-label uppercase tracking-wide">{copy.starterPreset}</label>
                      <select
                        value={bootstrapPreset}
                        onChange={(e) => setBootstrapPreset(e.target.value as BootstrapPreset)}
                        className="input h-11"
                      >
                        {Object.entries(bootstrapPresetLabels).map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="connection-form-field">
                      <label className="form-label uppercase tracking-wide">{copy.importSql}</label>
                      <div className="connection-form-inline-actions">
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={() => bootstrapFileInputRef.current?.click()}
                        >
                          <FileUp className="w-3.5 h-3.5" />
                          <span>{bootstrapFileName ? copy.replaceSqlFile : copy.chooseSqlFile}</span>
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
                      {copy.additionalSql} <span className="opacity-60">({copy.optional})</span>
                    </label>
                    <textarea
                      value={bootstrapSql}
                      onChange={(e) => setBootstrapSql(e.target.value)}
                      placeholder={copy.additionalSqlPlaceholder}
                      className="input connection-form-textarea"
                      rows={8}
                    />
                    <span className="connection-form-field-hint">
                      {copy.additionalSqlHint}
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
              {copy.testConnection}
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
                {copy.createAndOpen}
              </button>
            )}
          </div>

          <div className="connection-form-footer-actions">
            <button onClick={onClose} className="btn btn-secondary">{copy.cancel}</button>
            <button onClick={handleConnect} disabled={isConnecting} className="btn btn-primary">
              {isConnecting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {copy.connect}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
