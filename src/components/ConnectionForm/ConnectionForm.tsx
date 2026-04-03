import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { useAppStore } from "../../stores/appStore";
import { useI18n } from "../../i18n";
import type { ConnectionConfig, DatabaseType } from "../../types";
import { emitAppToast } from "../../utils/app-toast";
import { splitSqlStatements } from "../../utils/sqlStatements";
import { ConnectionPickerStep } from "./steps/ConnectionPickerStep";
import { ConnectionDetailsStep, type DetailsStrings } from "./steps/ConnectionDetailsStep";
import {
  ALL_DATABASES,
  DEFAULT_BOOTSTRAP_ENGINE,
  DEFAULT_CONNECT_ENGINE,
  LOCAL_BOOTSTRAP_READY,
  getDatabaseEngine,
  getSuggestedUsernamePlaceholder,
  type DbEntry,
} from "./engine-registry";

interface PickerSection {
  key: string;
  title: string;
  caption: string;
  items: DbEntry[];
}

type BootstrapPreset = "none" | "starter_core" | "starter_commerce";

interface Props {
  onClose: () => void;
  editConnection?: ConnectionConfig;
  initialIntent?: "connect" | "bootstrap";
  embeddedInStartupShell?: boolean;
}

const COLORS = [
  "#f38ba8", "#c49a78", "#b8ab86", "#7fb07f",
  "#6a8fc8", "#9b86c9", "#c49fbf", "#7fb7b7",
];

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

function isLocalHost(host?: string) {
  const normalized = (host || "").trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1" || normalized === "[::1]";
}

function createConnectionDraft(dbType: DatabaseType): ConnectionConfig {
  const engine = getDatabaseEngine(dbType);

  return {
    id: crypto.randomUUID(),
    name: "",
    db_type: dbType,
    host: engine?.connectionMode === "network" ? (engine.defaultHost ?? "") : "",
    port: engine?.defaultPort,
    username: "",
    database: "",
    file_path: "",
    use_ssl: false,
    color: COLORS[0],
    additional_fields: {},
  };
}

export function ConnectionForm({
  onClose,
  editConnection,
  initialIntent = "connect",
  embeddedInStartupShell = false,
}: Props) {
  const { language, t } = useI18n();
  const connectToDatabase = useAppStore((state) => state.connectToDatabase);
  const loadSavedConnections = useAppStore((state) => state.loadSavedConnections);
  const testConnection = useAppStore((state) => state.testConnection);
  const createLocalDatabase = useAppStore((state) => state.createLocalDatabase);
  const suggestSqliteDatabasePath = useAppStore((state) => state.suggestSqliteDatabasePath);
  const pickSqliteDatabasePath = useAppStore((state) => state.pickSqliteDatabasePath);
  const isConnecting = useAppStore((state) => state.isConnecting);

  // --- State ---
  const [step, setStep] = useState<"pick" | "form">(editConnection ? "form" : "pick");
  const [intentMode, setIntentMode] = useState<"connect" | "bootstrap">(
    editConnection ? "connect" : initialIntent,
  );
  const [pickerSearch, setPickerSearch] = useState("");
  const [selectedDb, setSelectedDb] = useState<DbEntry | null>(
    editConnection
      ? getDatabaseEngine(editConnection.db_type)
      : null,
  );
  const [formData, setFormData] = useState<ConnectionConfig>(
    editConnection
      ? { ...editConnection, password: undefined }
      : createConnectionDraft(initialIntent === "bootstrap" ? DEFAULT_BOOTSTRAP_ENGINE : DEFAULT_CONNECT_ENGINE),
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
  const bootstrapFileInputRef = useRef<HTMLInputElement | null>(null);

  // --- Derived ---
  const bootstrapMode = !editConnection && intentMode === "bootstrap";
  const currentEngine = getDatabaseEngine(formData.db_type) ?? selectedDb;
  const isSqlite = formData.db_type === "sqlite";
  const isFileEngine = currentEngine?.connectionMode === "file";
  const supportsLocalBootstrap =
    !!currentEngine &&
    currentEngine.localBootstrap === "ready" &&
    (currentEngine.connectionMode === "file" || isLocalHost(formData.host));
  const showBootstrapWorkflow = supportsLocalBootstrap || isSqlite;
  const showUsernameField = (currentEngine?.usernameMode ?? "required") !== "hidden";
  const showPasswordField = (currentEngine?.passwordMode ?? "optional") !== "hidden";
  const showDatabaseField = (currentEngine?.databaseMode ?? "optional") !== "hidden";
  const showSslToggle = !!currentEngine?.supportsSsl;
  const engineExtraFields = currentEngine?.extraFields ?? [];
  const additionalFields = formData.additional_fields ?? {};
  const hasBootstrapDatabaseName = !!formData.database?.trim();
  const isBootstrappingWorkspace = isCreatingDatabase || isConnecting;
  const sqliteDatabaseName = (formData.database || "").trim() || (formData.name || "").trim() || "local-database";
  const supportedCount = ALL_DATABASES.filter((db) => db.supported).length;
  const roadmapCount = ALL_DATABASES.length - supportedCount;
  const localRoadmapCount = ALL_DATABASES.filter(
    (db) => !LOCAL_BOOTSTRAP_READY.has(db.key),
  ).length;

  const suggestedUsernamePlaceholder = getSuggestedUsernamePlaceholder(selectedDb?.key || formData.db_type);
  const hostPlaceholder = currentEngine?.hostPlaceholder || "127.0.0.1";
  const portPlaceholder = currentEngine?.defaultPort ? String(currentEngine.defaultPort) : "";
  const databasePlaceholder = currentEngine?.databasePlaceholder || "my_database";

  const connectionTitle = editConnection
    ? language === "vi" ? "Sửa kết nối" : "Edit connection"
    : bootstrapMode
      ? selectedDb
        ? language === "vi" ? `Tạo Local DB ${selectedDb.label}` : `Local DB ${selectedDb.label}`
        : "Local DB"
      : selectedDb
        ? language === "vi" ? `Kết nối mới ${selectedDb.label}` : `New ${selectedDb.label}`
        : language === "vi" ? "Kết nối mới" : "New connection";

  // --- Copy strings ---
  const copy = useMemo(() => {
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
        pickerSubtitle: "Chọn engine đã sẵn sàng ngay bây giờ, hoặc xem các tích hợp sắp tới đã có trong lộ trình.",
        pickerLocalSubtitle: "Khởi tạo một workspace local PostgreSQL, MySQL/MariaDB, hoặc SQLite.",
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
        localReadyCaption: "Khởi tạo và mở các engine này trực tiếp từ TableR.",
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
        prismaNote: "Prisma là một ORM, vì vậy hãy chọn PostgreSQL, MySQL/MariaDB, hoặc SQLite làm engine nền.",
        pickLocalEngine: "Chọn một engine local để bootstrap",
        pickDatabaseType: "Chọn một loại cơ sở dữ liệu để tiếp tục",
        selectionHint: "Chi tiết và bước tiếp theo sẽ xuất hiện ở đây sau khi bạn chọn một engine.",
        previewOnly: "Chỉ xem trước",
        doubleClickContinue: "Nhấp đúp để tiếp tục",
        back: "Quay lại",
        editConnection: "Sửa kết nối",
        readyToConfigure: "Sẵn sàng cấu hình",
        configureSubtitle: "Cấu hình kết nối cơ sở dữ liệu",
        configureLocalSubtitle: "Tạo một cơ sở dữ liệu local mới, tùy chọn bootstrap starter SQL, rồi mở ngay sau đó.",
        profile: "Hồ sơ",
        connectionIdentity: "Nhận diện kết nối",
        identityCopy: "Đặt tên workspace và chọn màu nhấn để dễ nhận ra trong tab và badge.",
        color: "Màu",
        colorHint: "Được dùng trong tab, badge, và ngữ cảnh workspace",
        myDatabase: "Cơ sở dữ liệu của tôi",
        storage: "Lưu trữ",
        databaseFile: "Tệp cơ sở dữ liệu",
        databaseFileBootstrapCopy: "Đặt tên cho cơ sở dữ liệu và TableR sẽ tạo tệp SQLite trong thư mục local mặc định cho bạn.",
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
        authToken: "Auth token",
        enterAuthToken: "Nhập auth token",
        optional: "tùy chọn",
        localHostDetectedNamed: "Đã phát hiện host local. Tạo cơ sở dữ liệu này và vào workspace ngay.",
        localHostDetectedBlank: "Đã phát hiện host local. Hãy nhập tên cơ sở dữ liệu để bật create-and-open bootstrap.",
        engineNotLocalBootstrap: "Engine này chưa được nối cho local bootstrap trong TableR.",
        useSsl: "Dùng SSL/TLS",
        useSslNote: "Khuyên dùng cho các cơ sở dữ liệu cloud như Supabase, Neon, và PostgreSQL managed.",
        engineFields: "Field riêng theo engine",
        engineFieldsCopy: "Các field này phản ánh cách engine đó thường được cấu hình trong workflow kết nối thực tế.",
        bootstrap: "Bootstrap",
        starterSchemaSeedSql: "Schema khởi đầu và seed SQL",
        starterSchemaSeedSqlCopy: "Tùy chọn. Nạp trước schema khởi đầu, import tệp .sql local, hoặc dán thêm seed SQL trước khi workspace mở.",
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
      pickerSubtitle: "Pick an engine that is ready now, or browse upcoming integrations on the roadmap.",
      pickerLocalSubtitle: "Bootstrap a local PostgreSQL, MySQL/MariaDB, or SQLite workspace.",
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
      roadmapCaption: "Upcoming engines visible in the product direction.",
      localReadyCaption: "Bootstrap and open these engines directly from TableR.",
      connectOnly: "Connect only",
      connectOnlyCaption: "Supported for normal connections, but local bootstrap is not wired yet.",
      localRoadmap: "Local roadmap",
      localRoadmapCaption: "Visible here so you can see what is planned for local workflows.",
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
      prismaNote: "Prisma is an ORM, so choose PostgreSQL, MySQL/MariaDB, or SQLite as the underlying engine.",
      pickLocalEngine: "Pick a local engine to bootstrap",
      pickDatabaseType: "Pick a database type to continue",
      selectionHint: "The details and next step will appear here once you select an engine.",
      previewOnly: "Preview only",
      doubleClickContinue: "Double-click to continue",
      back: "Back",
      editConnection: "Edit connection",
      readyToConfigure: "Ready to configure",
      configureSubtitle: "Configure database connection",
      configureLocalSubtitle: "Create a fresh local database, optionally bootstrap starter SQL, then open it.",
      profile: "Profile",
      connectionIdentity: "Connection identity",
      identityCopy: "Name this workspace and choose an accent color.",
      color: "Color",
      colorHint: "Used in tabs, badges, and workspace context",
      myDatabase: "My Database",
      storage: "Storage",
      databaseFile: "Database file",
      databaseFileBootstrapCopy: "Give the database a name and TableR will place the SQLite file in its default local folder.",
      databaseFileConnectCopy: "Point to an existing SQLite file or enter a path for a new one.",
      databaseName: "Database name",
      databaseNamePlaceholder: "my_local_db",
      databaseNameHint: `TableR will create ${sqliteDatabaseName}.sqlite for you automatically.`,
      defaultLocation: "Default location",
      preparingSqliteLocation: "Preparing SQLite file location...",
      chooseLocation: "Choose location",
      hideManualPath: "Hide manual path",
      manualPath: "Manual path",
      useDefaultLocation: "Use default location",
      customFilePath: "Custom file path",
      network: "Network",
      connectionDetails: "Connection details",
      detailsCopy: "Enter server endpoint, credentials, and optional database name for this engine.",
      host: "Host",
      port: "Port",
      username: "Username",
      password: "Password",
      enterPassword: "Enter password",
      authToken: "Auth token",
      enterAuthToken: "Enter auth token",
      optional: "optional",
      databaseOptional: "Database",
      localHostDetectedNamed: "Local host detected. Create this database and jump straight into the workspace.",
      localHostDetectedBlank: "Local host detected. Enter a database name to enable create-and-open bootstrap.",
      engineNotLocalBootstrap: "This engine is not wired for local bootstrap yet in TableR.",
      useSsl: "Use SSL/TLS",
      useSslNote: "Recommended for cloud databases like Supabase, Neon, and managed PostgreSQL.",
      engineFields: "Engine-specific fields",
      engineFieldsCopy: "These fields mirror the extra connection metadata commonly required by this engine.",
      bootstrap: "Bootstrap",
      starterSchemaSeedSql: "Starter schema and seed SQL",
      starterSchemaSeedSqlCopy: "Optional. Preload a starter schema, import a local .sql file, or paste seed SQL.",
      starterPreset: "Starter preset",
      importSql: "Import .sql",
      replaceSqlFile: "Replace SQL File",
      chooseSqlFile: "Choose SQL File",
      additionalSql: "Additional SQL",
      additionalSqlPlaceholder: "Paste seed SQL here. It will run after the database is created.",
      additionalSqlHint: "Preset and your SQL are split into statements, then applied before the workspace opens.",
      testConnection: "Test Connection",
      createAndOpen: "Create & Open",
      emptyDatabase: "Empty database",
      starterAppSchema: "Starter app schema",
      commerceStarterSchema: "Commerce starter schema",
    };
  }, [language, sqliteDatabaseName, t]);

  const passwordLabel = currentEngine?.passwordKind === "token" ? copy.authToken : copy.password;
  const passwordPlaceholder = currentEngine?.passwordKind === "token" ? copy.enterAuthToken : copy.enterPassword;

  const getConnectionFeedbackLabel = useCallback(
    (config: ConnectionConfig, databaseName?: string) => {
      const explicitName = config.name.trim();
      if (explicitName) return explicitName;

      const engineLabel = selectedDb?.label || currentEngine?.label || config.db_type.toUpperCase();
      const targetLabel = (databaseName || config.database || "").trim();
      return targetLabel ? `${engineLabel} ${targetLabel}` : engineLabel;
    },
    [currentEngine?.label, selectedDb?.label],
  );

  const bootstrapPresetLabels = useMemo(
    () => ({
      none: copy.emptyDatabase,
      starter_core: copy.starterAppSchema,
      starter_commerce: copy.commerceStarterSchema,
    }),
    [copy],
  );

  // --- Callbacks ---
  const updateField = <K extends keyof ConnectionConfig>(key: K, value: ConnectionConfig[K]) => {
    setFormData((prev) => ({ ...prev, [key]: value }));
    setTestResult(null);
  };

  const updateAdditionalField = (key: string, value: string) => {
    setFormData((prev) => ({
      ...prev,
      additional_fields: {
        ...(prev.additional_fields ?? {}),
        [key]: value,
      },
    }));
    setTestResult(null);
  };

  const handleSelectDb = (db: DbEntry) => setSelectedDb(db);

  const handleSwitchIntent = (nextIntent: "connect" | "bootstrap") => {
    if (editConnection || nextIntent === intentMode) return;
    setIntentMode(nextIntent);
    setPickerSearch("");
    setSelectedDb(null);
  };

  const handleContinueFromPicker = (db: DbEntry) => {
    if (bootstrapMode && !LOCAL_BOOTSTRAP_READY.has(db.key)) return;

    passwordDraftRef.current = "";
    setFormData((prev) => {
      const switchedEngine = prev.db_type !== db.key;
      return {
        ...prev,
        db_type: db.key,
        host: db.connectionMode === "network"
          ? (switchedEngine ? (db.defaultHost ?? "") : (prev.host ?? db.defaultHost ?? ""))
          : "",
        port: db.defaultPort,
        database: db.databaseMode === "hidden"
          ? ""
          : bootstrapMode && db.connectionMode === "file"
            ? prev.database || prev.name || "local-database"
            : prev.database,
        username: db.usernameMode === "hidden"
          ? ""
          : switchedEngine
            ? ""
            : prev.username,
        file_path: db.connectionMode === "file" ? prev.file_path : "",
        use_ssl: db.supportsSsl ? prev.use_ssl : false,
        additional_fields: switchedEngine ? {} : (prev.additional_fields ?? {}),
      };
    });
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
        file_path: isFileEngine ? resolvedSqlitePath : formData.file_path,
        password: showPasswordField ? passwordDraftRef.current : undefined,
      });
      setTestResult({ success: true, message: msg });
    } catch (e) {
      setTestResult({ success: false, message: String(e) });
    }
    setIsTesting(false);
  };

  const handleConnect = async () => {
    if (bootstrapMode && showBootstrapWorkflow) {
      await handleCreateDatabase();
      return;
    }

    try {
      const connectionConfig = {
        ...formData,
        password: showPasswordField ? passwordDraftRef.current : undefined,
      };
      await connectToDatabase(connectionConfig);
      await loadSavedConnections();
      emitAppToast({
        tone: "success",
        title: language === "vi" ? "Da ket noi thanh cong" : "Connection ready",
        description:
          language === "vi"
            ? `Da mo workspace ${getConnectionFeedbackLabel(connectionConfig)}.`
            : `Opened workspace ${getConnectionFeedbackLabel(connectionConfig)}.`,
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
      const presetSql = getBootstrapPresetSql(bootstrapPreset, formData.db_type);
      const combinedBootstrapSql = [presetSql, bootstrapSql.trim()].filter((s) => s.trim().length > 0).join("\n\n");
      const bootstrapStatements = splitSqlStatements(combinedBootstrapSql);
      if (isSqlite) {
        const resolvedFilePath = formData.file_path?.trim() || (await suggestSqliteDatabasePath(sqliteDatabaseName));
        if (!resolvedFilePath) {
          setTestResult({ success: false, message: language === "vi" ? "Hãy chọn tên cơ sở dữ liệu SQLite trước." : "Choose a SQLite database name first." });
          return;
        }
        const sqliteConfig = {
          ...formData,
          database: sqliteDatabaseName,
          file_path: resolvedFilePath,
          name: formData.name.trim() || `${selectedDb?.label || formData.db_type} ${sqliteDatabaseName}`,
          password: undefined,
        };
        const message = await createLocalDatabase(sqliteConfig, sqliteDatabaseName, bootstrapStatements);
        setTestResult({ success: true, message: language === "vi" ? `Đang tạo cơ sở dữ liệu SQLite từ ${resolvedFilePath}...` : `Creating SQLite database from ${resolvedFilePath}...` });
        setTestResult({
          success: true,
          message: language === "vi" ? `${message} Dang mo workspace SQLite...` : `${message} Opening the SQLite workspace...`,
        });
        await connectToDatabase(sqliteConfig);
        await loadSavedConnections();
        emitAppToast({
          tone: "success",
          title: language === "vi" ? "Da import va mo SQLite" : "SQLite workspace ready",
          description:
            language === "vi"
              ? `${getConnectionFeedbackLabel(sqliteConfig, sqliteDatabaseName)} da duoc tao va mo.`
              : `${getConnectionFeedbackLabel(sqliteConfig, sqliteDatabaseName)} was created and opened.`,
        });
        passwordDraftRef.current = "";
        onClose();
        return;
      }

      const requestedDatabase = formData.database?.trim();
      if (!requestedDatabase) {
        setTestResult({ success: false, message: language === "vi" ? "Hãy nhập tên cơ sở dữ liệu trước." : "Enter a database name first." });
        return;
      }

      const bootstrapConfig = {
        ...formData,
        name: formData.name.trim() || `${selectedDb?.label || formData.db_type} ${requestedDatabase}`,
        database: requestedDatabase,
        password: showPasswordField ? passwordDraftRef.current : undefined,
      };
      const message = await createLocalDatabase(bootstrapConfig, requestedDatabase, bootstrapStatements);
      setTestResult({ success: true, message: language === "vi" ? `${message} Đang kết nối tới ${requestedDatabase}...` : `${message} Connecting to ${requestedDatabase}...` });
      await connectToDatabase(bootstrapConfig);
      await loadSavedConnections();
      emitAppToast({
        tone: "success",
        title: language === "vi" ? "Da import va mo database" : "Database workspace ready",
        description:
          language === "vi"
            ? `${getConnectionFeedbackLabel(bootstrapConfig, requestedDatabase)} da san sang de su dung.`
            : `${getConnectionFeedbackLabel(bootstrapConfig, requestedDatabase)} is ready to use.`,
      });
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
      setTestResult({ success: false, message: language === "vi" ? `Không thể đọc tệp SQL: ${String(e)}` : `Could not read SQL file: ${String(e)}` });
    } finally {
      event.target.value = "";
    }
  };

  // --- Picker computed values ---
  const filteredDbs = pickerSearch
    ? ALL_DATABASES.filter((d) =>
      d.label.toLowerCase().includes(pickerSearch.toLowerCase()) ||
      d.key.toLowerCase().includes(pickerSearch.toLowerCase()),
    )
    : ALL_DATABASES;

  const pickerSections = useMemo<PickerSection[]>(() => {
    if (!bootstrapMode) {
      return [
        { key: "ready", title: copy.readyNow, caption: copy.readyNowCaption, items: filteredDbs.filter((db) => db.supported) },
        { key: "roadmap", title: copy.roadmap, caption: copy.roadmapCaption, items: filteredDbs.filter((db) => !db.supported) },
      ].filter((s) => s.items.length > 0);
    }
    return [
      { key: "local-ready", title: copy.localReady, caption: copy.localReadyCaption, items: filteredDbs.filter((db) => LOCAL_BOOTSTRAP_READY.has(db.key)) },
      { key: "local-roadmap", title: copy.localRoadmap, caption: copy.localRoadmapCaption, items: filteredDbs.filter((db) => !LOCAL_BOOTSTRAP_READY.has(db.key)) },
    ].filter((s) => s.items.length > 0);
  }, [bootstrapMode, copy, filteredDbs]);

  // --- Effects ---
  useEffect(() => {
    if (!bootstrapMode || !isSqlite || sqlitePathTouched) return;
    let cancelled = false;
    void suggestSqliteDatabasePath(sqliteDatabaseName).then((suggestedPath) => {
      if (cancelled) return;
      setFormData((prev) => {
        if (prev.db_type !== "sqlite" || prev.file_path === suggestedPath) return prev;
        return { ...prev, file_path: suggestedPath };
      });
    }).catch(() => { /* Keep existing manual entry on failure */ });
    return () => { cancelled = true; };
  }, [bootstrapMode, isSqlite, sqliteDatabaseName, sqlitePathTouched, suggestSqliteDatabasePath]);

  useEffect(() => {
    return () => { passwordDraftRef.current = ""; };
  }, []);

  useEffect(() => {
    if (step !== "pick") return;
    const visibleItems = pickerSections.flatMap((s) => s.items);
    if (visibleItems.length === 0) {
      if (selectedDb) setSelectedDb(null);
      return;
    }
    if (!selectedDb || !visibleItems.some((item) => item.key === selectedDb.key)) {
      setSelectedDb(visibleItems[0]);
    }
  }, [pickerSections, selectedDb, step]);

  // --- Picker strings for child ---
  const pickerStrings = {
    pickerKicker: copy.pickerKicker,
    pickerLocalTitle: copy.pickerLocalTitle,
    pickerTitle: copy.pickerTitle,
    pickerLocalSubtitle: copy.pickerLocalSubtitle,
    pickerSubtitle: copy.pickerSubtitle,
    flowLabel: copy.flowLabel,
    remoteSaved: copy.remoteSaved,
    localDb: copy.localDb,
    ready: copy.ready,
    roadmap: copy.roadmap,
    shown: copy.shown,
    localReady: copy.localReady,
    localSoon: copy.localSoon,
    searchPlaceholder: copy.searchPlaceholder,
    emptySearch: copy.emptySearch,
    readyNow: copy.readyNow,
    readyNowCaption: copy.readyNowCaption,
    roadmapCaption: copy.roadmapCaption,
    localReadyCaption: copy.localReadyCaption,
    localRoadmap: copy.localRoadmap,
    localRoadmapCaption: copy.localRoadmapCaption,
    selection: copy.selection,
    workflow: copy.workflow,
    mode: copy.mode,
    availability: copy.availability,
    engineType: copy.engineType,
    connectionSetup: copy.connectionSetup,
    localBootstrap: copy.localBootstrap,
    fileDatabase: copy.fileDatabase,
    serverDatabase: copy.serverDatabase,
    createFreshLocalInstead: copy.createFreshLocalInstead,
    prismaNote: copy.prismaNote,
    pickLocalEngine: copy.pickLocalEngine,
    pickDatabaseType: copy.pickDatabaseType,
    selectionHint: copy.selectionHint,
    previewOnly: copy.previewOnly,
    doubleClickContinue: copy.doubleClickContinue,
    cancel: copy.cancel,
    continue: copy.continue,
    close: copy.close,
    back: copy.back,
  };

  // --- Details strings for child ---
  const detailsStrings: DetailsStrings = {
    back: copy.back,
    close: copy.close,
    editConnection: copy.editConnection,
    readyToConfigure: copy.readyToConfigure,
    configureSubtitle: copy.configureSubtitle,
    configureLocalSubtitle: copy.configureLocalSubtitle,
    profile: copy.profile,
    connectionIdentity: copy.connectionIdentity,
    identityCopy: copy.identityCopy,
    color: copy.color,
    colorHint: copy.colorHint,
    name: copy.name,
    myDatabase: copy.myDatabase,
    storage: copy.storage,
    databaseFile: copy.databaseFile,
    databaseFileBootstrapCopy: copy.databaseFileBootstrapCopy,
    databaseFileConnectCopy: copy.databaseFileConnectCopy,
    databaseName: copy.databaseName,
    databaseNamePlaceholder: copy.databaseNamePlaceholder,
    databaseNameHint: copy.databaseNameHint,
    defaultLocation: copy.defaultLocation,
    preparingSqliteLocation: copy.preparingSqliteLocation,
    chooseLocation: copy.chooseLocation,
    hideManualPath: copy.hideManualPath,
    manualPath: copy.manualPath,
    useDefaultLocation: copy.useDefaultLocation,
    customFilePath: copy.customFilePath,
    network: copy.network,
    connectionDetails: copy.connectionDetails,
    detailsCopy: copy.detailsCopy,
    host: copy.host,
    port: copy.port,
    username: copy.username,
    password: copy.password,
    enterPassword: copy.enterPassword,
    optional: copy.optional,
    databaseOptional: copy.databaseOptional,
    localHostDetectedNamed: copy.localHostDetectedNamed,
    localHostDetectedBlank: copy.localHostDetectedBlank,
    engineNotLocalBootstrap: copy.engineNotLocalBootstrap,
    useSsl: copy.useSsl,
    useSslNote: copy.useSslNote,
    engineFields: copy.engineFields,
    engineFieldsCopy: copy.engineFieldsCopy,
    bootstrap: copy.bootstrap,
    starterSchemaSeedSql: copy.starterSchemaSeedSql,
    starterSchemaSeedSqlCopy: copy.starterSchemaSeedSqlCopy,
    starterPreset: copy.starterPreset,
    importSql: copy.importSql,
    replaceSqlFile: copy.replaceSqlFile,
    chooseSqlFile: copy.chooseSqlFile,
    additionalSql: copy.additionalSql,
    additionalSqlPlaceholder: copy.additionalSqlPlaceholder,
    additionalSqlHint: copy.additionalSqlHint,
    testConnection: copy.testConnection,
    createAndOpen: copy.createAndOpen,
    cancel: copy.cancel,
    connect: copy.connect,
  };

  // --- Render ---
  if (step === "pick") {
    const pickerContent = (
      <ConnectionPickerStep
        language={language}
        bootstrapMode={bootstrapMode}
        editConnection={!!editConnection}
        selectedDb={selectedDb}
        pickerSearch={pickerSearch}
        pickerSections={pickerSections}
        filteredDbs={filteredDbs}
        supportedCount={supportedCount}
        roadmapCount={roadmapCount}
        localRoadmapCount={localRoadmapCount}
        strings={pickerStrings}
        onSearchChange={setPickerSearch}
        onSelectDb={handleSelectDb}
        onDoubleClickDb={handleContinueFromPicker}
        onSwitchIntent={handleSwitchIntent}
        onClose={onClose}
        onContinue={() => selectedDb && handleContinueFromPicker(selectedDb)}
        onBack={() => setStep("pick")}
      />
    );

    if (embeddedInStartupShell) {
      return (
        <div className="connection-picker-shell">
          <div className="connection-picker-shell-viewport">
            {pickerContent}
          </div>
        </div>
      );
    }
    return (
      <div className="connection-picker-overlay">
        <div className="connection-picker-modal">{pickerContent}</div>
      </div>
    );
  }

  const formContent = (
    <ConnectionDetailsStep
      language={language}
      editConnection={!!editConnection}
      bootstrapMode={bootstrapMode}
      formData={formData}
      selectedDb={selectedDb}
      isFileEngine={!!isFileEngine}
      supportsLocalBootstrap={supportsLocalBootstrap}
      showBootstrapWorkflow={showBootstrapWorkflow}
      hasBootstrapDatabaseName={hasBootstrapDatabaseName}
      showPassword={showPassword}
      showUsernameField={showUsernameField}
      showPasswordField={showPasswordField}
      showDatabaseField={showDatabaseField}
      showSslToggle={showSslToggle}
      showSqliteAdvancedPath={showSqliteAdvancedPath}
      sqlitePathTouched={sqlitePathTouched}
      bootstrapPreset={bootstrapPreset}
      bootstrapPresetLabels={bootstrapPresetLabels}
      bootstrapSql={bootstrapSql}
      bootstrapFileName={bootstrapFileName}
      engineExtraFields={engineExtraFields}
      suggestedUsernamePlaceholder={suggestedUsernamePlaceholder}
      hostPlaceholder={hostPlaceholder}
      portPlaceholder={portPlaceholder}
      databasePlaceholder={databasePlaceholder}
      passwordLabel={passwordLabel}
      passwordPlaceholder={passwordPlaceholder}
      additionalFields={additionalFields}
      connectionTitle={connectionTitle}
      testResult={testResult}
      isTesting={isTesting}
      isConnecting={isConnecting}
      isBootstrappingWorkspace={isBootstrappingWorkspace}
      strings={detailsStrings}
      passwordDraftRef={passwordDraftRef}
      bootstrapFileInputRef={bootstrapFileInputRef}
      onFieldChange={updateField}
      onAdditionalFieldChange={updateAdditionalField}
      onTogglePasswordVisibility={() => setShowPassword((v) => !v)}
      onPasswordChange={(v) => { passwordDraftRef.current = v; }}
      onBack={() => setStep("pick")}
      onClose={onClose}
      onTest={handleTest}
      onConnect={handleConnect}
      onCreateDatabase={handleCreateDatabase}
      onImportBootstrapFile={handleImportBootstrapFile}
      onToggleSqliteAdvancedPath={() => setShowSqliteAdvancedPath((v) => !v)}
      onResetSqlitePath={() => { setSqlitePathTouched(false); setShowSqliteAdvancedPath(false); }}
      onPickSqlitePath={handlePickSqlitePath}
      onBootstrapPresetChange={(v) => setBootstrapPreset(v as BootstrapPreset)}
      onBootstrapSqlChange={setBootstrapSql}
    />
  );

  if (embeddedInStartupShell) {
    return (
      <div className="connection-form-shell">
        <div className="connection-form-shell-viewport">
          <div className="connection-form-shell-frame">{formContent}</div>
        </div>
      </div>
    );
  }
  return (
    <div className="connection-form-overlay">
      <div className="connection-form-modal">{formContent}</div>
    </div>
  );
}
