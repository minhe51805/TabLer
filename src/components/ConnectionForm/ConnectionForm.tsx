import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { useConnectionStore } from "../../stores/connectionStore";
import { usePluginStore } from "../../stores/pluginStore";
import { useI18n } from "../../i18n";
import type { ConnectionConfig, DatabaseType } from "../../types";
import { emitAppToast } from "../../utils/app-toast";
import { splitSqlStatements } from "../../utils/sqlStatements";
import {
  resolvePluginHttpDrivers,
  resolveNativeSidecarDrivers,
  isPluginHttpProtocol,
  isPluginNativeProtocol,
  applyEngineRuntimeAvailability,
} from "../../utils/plugin-driver-runtime";
import { invokeWithTimeout } from "../../utils/tauri-utils";
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
import {
  createConnectionDraft,
  getBootstrapPresetSql,
  isLocalHost,
  type BootstrapPreset,
  type ConnectionTestResult,
} from "./connection-form-utils";
import { parseConnectionError } from "../../utils/connection-error";

interface PickerSection {
  key: string;
  title: string;
  caption: string;
  items: DbEntry[];
}

interface Props {
  onClose: () => void;
  editConnection?: ConnectionConfig;
  initialIntent?: "connect" | "bootstrap";
  embeddedInStartupShell?: boolean;
}

export function ConnectionForm({
  onClose,
  editConnection,
  initialIntent = "connect",
  embeddedInStartupShell = false,
}: Props) {
  const { language, t } = useI18n();
  const connectToDatabase = useConnectionStore((state) => state.connectToDatabase);
  const loadSavedConnections = useConnectionStore((state) => state.loadSavedConnections);
  const testConnection = useConnectionStore((state) => state.testConnection);
  const createLocalDatabase = useConnectionStore((state) => state.createLocalDatabase);
  const pickSqliteDatabasePath = useConnectionStore((state) => state.pickSqliteDatabasePath);
  const suggestSqliteDatabasePath = useConnectionStore((state) => state.suggestSqliteDatabasePath);
  const isConnecting = useConnectionStore((state) => state.isConnecting);
  const installedPlugins = usePluginStore((state) => state.plugins);
  const pluginsHaveLoaded = usePluginStore((state) => state.hasLoaded);
  const loadPlugins = usePluginStore((state) => state.loadPlugins);
  const installPlugin = usePluginStore((state) => state.installPlugin);
  const [isInstallingPlugin, setIsInstallingPlugin] = useState(false);
  const pluginHttpDrivers = useMemo(
    () => resolvePluginHttpDrivers(installedPlugins),
    [installedPlugins],
  );
  const nativeSidecarDrivers = useMemo(
    () => resolveNativeSidecarDrivers(installedPlugins),
    [installedPlugins],
  );
  // Which native-crate engines this build actually compiled in (Cargo features).
  // Starts undefined ("no report yet") and fails CLOSED: until the backend
  // answers, a native engine is treated as unavailable rather than offered as
  // ready and dead-ending at connect time.
  const [nativeDriverAvailability, setNativeDriverAvailability] = useState<
    Record<string, boolean> | undefined
  >(undefined);
  useEffect(() => {
    let cancelled = false;
    void invokeWithTimeout<Record<string, boolean>>(
      "get_native_driver_availability",
      {},
      5_000,
      "Checking installed database engines",
    )
      .then((availability) => {
        if (!cancelled && availability) setNativeDriverAvailability(availability);
      })
      .catch(() => {
        // Fail closed: an unreachable report leaves native engines unavailable
        // so the picker explains the missing driver instead of promising a
        // connect this build cannot perform.
      });
    return () => {
      cancelled = true;
    };
  }, []);
  // Single source of truth shared with the Plugin Manager (see
  // applyEngineRuntimeAvailability): PluginHttp engines gate on an
  // installed/enabled driver with a 4-state
  // "active"/"installed"/"incomplete"/"roadmap", native engines gate on the
  // compiled build + installed sidecars, and every other engine keeps its
  // static flag. Both surfaces can never disagree.
  const availableDatabases = useMemo(
    () => applyEngineRuntimeAvailability(ALL_DATABASES, installedPlugins, nativeDriverAvailability),
    [installedPlugins, nativeDriverAvailability],
  );

  // --- State ---
  const [step, setStep] = useState<"pick" | "form">(editConnection ? "form" : "pick");
  const [intentMode, setIntentMode] = useState<"connect" | "bootstrap">(
    editConnection ? "connect" : initialIntent,
  );
  const [pickerSearch, setPickerSearch] = useState("");
  const [selectedDb, setSelectedDb] = useState<DbEntry | null>(
    editConnection ? getDatabaseEngine(editConnection.db_type) : null,
  );
  const [formData, setFormData] = useState<ConnectionConfig>(
    editConnection
      ? { ...editConnection, password: undefined }
      : createConnectionDraft(
          initialIntent === "bootstrap" ? DEFAULT_BOOTSTRAP_ENGINE : DEFAULT_CONNECT_ENGINE,
        ),
  );
  const passwordDraftRef = useRef(editConnection?.password || "");
  const [showPassword, setShowPassword] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  const [isCreatingDatabase, setIsCreatingDatabase] = useState(false);
  const [bootstrapPreset, setBootstrapPreset] = useState<BootstrapPreset>("none");
  const [bootstrapSql, setBootstrapSql] = useState("");
  const [bootstrapFileName, setBootstrapFileName] = useState("");
  const [showSqliteAdvancedPath, setShowSqliteAdvancedPath] = useState(false);
  const [sqlitePathTouched, setSqlitePathTouched] = useState(false);
  const bootstrapFileInputRef = useRef<HTMLInputElement | null>(null);
  // Tracks whether the user manually picked a SQL Server authentication mode;
  // until then the auto-detection effect keeps it in sync with the host.
  const mssqlAuthTypeTouchedRef = useRef(false);

  // Runtime availability of the engine currently being configured. The picker
  // gates on `supported`, but editing a saved connection (or a pasted URL)
  // skips the picker — this keeps the same gate on the connect/test paths so
  // a plugin-gated engine without a usable driver fails here with an honest
  // message instead of a raw backend rejection.
  const selectedEngineAvailability = useMemo(
    () => availableDatabases.find((db) => db.key === formData.db_type),
    [availableDatabases, formData.db_type],
  );
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
  const sqliteDatabaseName =
    (formData.database || "").trim() || (formData.name || "").trim() || "local-database";
  const supportedCount = availableDatabases.filter((db) => db.supported).length;
  // Engines whose driver bundle is installed but not enabled yet — counted
  // separately so they are not mixed into the roadmap total.
  const installedDisabledCount = availableDatabases.filter(
    (db) => !db.supported && db.pluginHttpState === "installed",
  ).length;
  const roadmapCount = availableDatabases.length - supportedCount - installedDisabledCount;
  const localRoadmapCount = availableDatabases.filter(
    (db) => !LOCAL_BOOTSTRAP_READY.has(db.key),
  ).length;

  const suggestedUsernamePlaceholder = getSuggestedUsernamePlaceholder(
    selectedDb?.key || formData.db_type,
  );
  const hostPlaceholder = currentEngine?.hostPlaceholder || "127.0.0.1";
  const portPlaceholder = currentEngine?.defaultPort ? String(currentEngine.defaultPort) : "";
  const databasePlaceholder = currentEngine?.databasePlaceholder || "my_database";

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
        pickerSubtitle:
          "Chọn engine đã sẵn sàng ngay bây giờ, hoặc xem các tích hợp sắp tới đã có trong lộ trình.",
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
        pasteConnectionUrl: "Dán URL kết nối (vd. postgres://user:pass@host:5432/db)",
        emptySearch: "Không có loại cơ sở dữ liệu nào khớp tìm kiếm.",
        readyNow: "Sẵn sàng ngay",
        readyNowCaption: "Các engine bạn có thể cấu hình ngay trong bản build này.",
        installPlugin: "Cài plugin",
        installPluginSuccess: "Đã cài plugin",
        installedDisabled: "Đã cài · cần bật",
        installedDisabledCaption:
          "Bundle driver đã được cài nhưng đang tắt. Bật nó trong Trình quản lý plugin để kết nối.",
        installedIncomplete: "Đã cài · thiếu binary",
        installedIncompleteCaption:
          "Bundle driver đã được cài nhưng không có binary cho nền tảng này. Cần một bundle có thư mục bin/ phù hợp.",
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
        detailsCopy:
          "Nhập địa chỉ máy chủ, thông tin đăng nhập, và tên cơ sở dữ liệu tùy chọn cho engine này.",
        host: "Host",
        pasteUrlHint:
          "Dán URL kết nối (vd. postgres://user:pass@host:5432/db) để tự điền các trường.",
        port: "Cổng",
        username: "Tên người dùng",
        password: "Mật khẩu",
        enterPassword: "Nhập mật khẩu",
        authToken: "Auth token",
        enterAuthToken: "Nhập auth token",
        optional: "tùy chọn",
        localHostDetectedNamed:
          "Đã phát hiện host local. Tạo cơ sở dữ liệu này và vào workspace ngay.",
        localHostDetectedBlank:
          "Đã phát hiện host local. Hãy nhập tên cơ sở dữ liệu để bật create-and-open bootstrap.",
        engineNotLocalBootstrap: "Engine này chưa được nối cho local bootstrap trong TableR.",
        useSsl: "Dùng SSL/TLS",
        useSslNote:
          "Khuyên dùng cho các cơ sở dữ liệu cloud như Supabase, Neon, và PostgreSQL managed.",
        engineFields: "Field riêng theo engine",
        engineFieldsCopy:
          "Các field này phản ánh cách engine đó thường được cấu hình trong workflow kết nối thực tế.",
        bootstrap: "Bootstrap",
        starterSchemaSeedSql: "Schema khởi đầu và seed SQL",
        starterSchemaSeedSqlCopy:
          "Tùy chọn. Nạp trước schema khởi đầu, import tệp .sql local, hoặc dán thêm seed SQL trước khi workspace mở.",
        starterPreset: "Preset khởi đầu",
        importSql: "Import .sql",
        replaceSqlFile: "Thay tệp SQL",
        chooseSqlFile: "Chọn tệp SQL",
        additionalSql: "SQL bổ sung",
        additionalSqlPlaceholder:
          "Dán seed SQL tại đây. Nó sẽ chạy sau khi cơ sở dữ liệu được tạo.",
        additionalSqlHint:
          "Preset và SQL của bạn sẽ được tách thành từng statement rồi áp dụng trước khi workspace mới mở.",
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
        "Pick an engine that is ready now, or browse upcoming integrations on the roadmap.",
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
      pasteConnectionUrl: "Paste a connection URL (e.g. postgres://user:pass@host:5432/db)",
      readyNowCaption: "Engines you can configure immediately in this build.",
      installPlugin: "Install plugin",
      installPluginSuccess: "Plugin installed",
      installedDisabled: "Installed · needs enabling",
      installedDisabledCaption:
        "The driver bundle is installed but disabled. Enable it in Plugin Manager to connect.",
      installedIncomplete: "Installed · missing binary",
      installedIncompleteCaption:
        "The driver bundle is installed but has no binary for this platform. Install a bundle with a matching bin/ folder.",
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
        "Create a fresh local database, optionally bootstrap starter SQL, then open it.",
      profile: "Profile",
      connectionIdentity: "Connection identity",
      identityCopy: "Name this workspace and choose an accent color.",
      color: "Color",
      colorHint: "Used in tabs, badges, and workspace context",
      myDatabase: "My Database",
      storage: "Storage",
      databaseFile: "Database file",
      databaseFileBootstrapCopy:
        "Give the database a name and TableR will place the SQLite file in its default local folder.",
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
      detailsCopy:
        "Enter server endpoint, credentials, and optional database name for this engine.",
      host: "Host",
      pasteUrlHint:
        "Paste a connection URL (e.g. postgres://user:pass@host:5432/db) to fill the fields.",
      port: "Port",
      username: "Username",
      password: "Password",
      enterPassword: "Enter password",
      authToken: "Auth token",
      enterAuthToken: "Enter auth token",
      optional: "optional",
      databaseOptional: "Database",
      localHostDetectedNamed:
        "Local host detected. Create this database and jump straight into the workspace.",
      localHostDetectedBlank:
        "Local host detected. Enter a database name to enable create-and-open bootstrap.",
      engineNotLocalBootstrap: "This engine is not wired for local bootstrap yet in TableR.",
      useSsl: "Use SSL/TLS",
      useSslNote: "Recommended for cloud databases like Supabase, Neon, and managed PostgreSQL.",
      engineFields: "Engine-specific fields",
      engineFieldsCopy:
        "These fields mirror the extra connection metadata commonly required by this engine.",
      bootstrap: "Bootstrap",
      starterSchemaSeedSql: "Starter schema and seed SQL",
      starterSchemaSeedSqlCopy:
        "Optional. Preload a starter schema, import a local .sql file, or paste seed SQL.",
      starterPreset: "Starter preset",
      importSql: "Import .sql",
      replaceSqlFile: "Replace SQL File",
      chooseSqlFile: "Choose SQL File",
      additionalSql: "Additional SQL",
      additionalSqlPlaceholder: "Paste seed SQL here. It will run after the database is created.",
      additionalSqlHint:
        "Preset and your SQL are split into statements, then applied before the workspace opens.",
      testConnection: "Test Connection",
      createAndOpen: "Create & Open",
      emptyDatabase: "Empty database",
      starterAppSchema: "Starter app schema",
      commerceStarterSchema: "Commerce starter schema",
    };
  }, [language, sqliteDatabaseName, t]);

  const passwordLabel = currentEngine?.passwordKind === "token" ? copy.authToken : copy.password;
  const passwordPlaceholder =
    currentEngine?.passwordKind === "token" ? copy.enterAuthToken : copy.enterPassword;

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
    if (key === "auth_type") {
      // Once the user picks an authentication mode manually, stop overriding it.
      mssqlAuthTypeTouchedRef.current = true;
    }
    setFormData((prev) => ({
      ...prev,
      additional_fields: {
        ...(prev.additional_fields ?? {}),
        [key]: value,
      },
    }));
    setTestResult(null);
  };

  // The plugin binding a plugin-gated engine needs in `additional_fields` so
  // the backend can resolve its driver: HTTP engines use the installed
  // declarative-http driver, native engines the installed sidecar driver.
  const pluginDriverFields = useCallback(
    (key: string): Record<string, string> => {
      if (isPluginHttpProtocol(key) && pluginHttpDrivers[key]) {
        return {
          plugin_id: pluginHttpDrivers[key]!.pluginId,
          plugin_driver_id: pluginHttpDrivers[key]!.id,
        };
      }
      if (isPluginNativeProtocol(key) && nativeSidecarDrivers[key]) {
        return {
          plugin_id: nativeSidecarDrivers[key]!.pluginId,
          plugin_driver_id: nativeSidecarDrivers[key]!.id,
        };
      }
      return {};
    },
    [pluginHttpDrivers, nativeSidecarDrivers],
  );
  const handleSelectDb = (db: DbEntry) => setSelectedDb(db);

  // --- SSMS-style authentication auto-detection for SQL Server --------------
  // SERVER\INSTANCE / local servers default to Windows Authentication;
  // Azure SQL (*.database.windows.net) defaults to SQL Server Authentication.
  // The choice is only applied until the user picks one manually.
  useEffect(() => {
    if (formData.db_type !== "mssql") {
      mssqlAuthTypeTouchedRef.current = false;
      return;
    }
    const host = (formData.host ?? "").trim().toLowerCase();
    if (!host) return;
    const detected = host.includes("database.windows.net") ? "sql" : "windows";
    setFormData((prev) => {
      if (mssqlAuthTypeTouchedRef.current) return prev;
      if ((prev.additional_fields?.auth_type ?? "") === detected) return prev;
      return {
        ...prev,
        additional_fields: {
          ...(prev.additional_fields ?? {}),
          auth_type: detected,
        },
      };
    });
  }, [formData.db_type, formData.host]);

  // --- Pasted connection URL support ---------------------------------------
  // The backend builds the URI from the structured fields and deliberately
  // strips any embedded credentials/path from a URL pasted into the Host
  // field ("structured fields are authoritative") — a correctly pasted Atlas
  // URL therefore connected ANONYMOUSLY: ping passed, real commands failed.
  // Route every scheme-looking paste through the backend `parse_url_details`
  // parser so what the user pasted is what actually connects, for every engine
  // the URL grammar covers (postgres://, mysql://, mongodb+srv://, redis://, …)
  // — not just MongoDB.
  const urlPasteHandledRef = useRef<string | null>(null);
  useEffect(() => {
    const pastedHost = (formData.host ?? "").trim();
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(pastedHost)) return;
    if (urlPasteHandledRef.current === pastedHost) return; // manual edits win after the first fill
    let cancelled = false;
    void invokeWithTimeout<{
      db_type: DatabaseType;
      host: string;
      port?: number | null;
      username: string;
      password: string;
      database: string;
      use_ssl: boolean;
    }>("parse_url_details", { url: pastedHost }, 5_000, "Parsing connection URL")
      .then((parsed) => {
        if (cancelled) return;
        const engine = getDatabaseEngine(parsed.db_type);
        if (!engine) return;
        urlPasteHandledRef.current = pastedHost;
        // Engine-specific extras the generic parser does not model still come
        // from the URL itself: MongoDB's authSource/replicaSet query params and
        // Redis' logical database index from the path.
        const extraFields: Record<string, string> = {};
        if (parsed.db_type === "mongodb") {
          try {
            const url = new URL(pastedHost);
            const authSource = url.searchParams.get("authSource");
            const replicaSet = url.searchParams.get("replicaSet");
            if (authSource) extraFields.auth_source = authSource;
            if (replicaSet) extraFields.replica_set = replicaSet;
          } catch {
            // The backend already parsed the URL; extras are best-effort.
          }
        }
        if (parsed.db_type === "redis" && parsed.database) {
          extraFields.redis_database = parsed.database;
        }
        setSelectedDb(engine);
        setFormData((prev) => {
          const sameEngine = prev.db_type === parsed.db_type;
          return {
            ...prev,
            db_type: parsed.db_type,
            host: parsed.db_type === "sqlite" ? "" : parsed.host,
            port: parsed.port ?? engine.defaultPort,
            username: sameEngine ? prev.username || parsed.username : parsed.username,
            database:
              parsed.db_type === "sqlite" || parsed.db_type === "redis" ? "" : parsed.database,
            file_path: parsed.db_type === "sqlite" ? parsed.database : "",
            use_ssl: parsed.use_ssl,
            additional_fields: {
              ...(sameEngine ? (prev.additional_fields ?? {}) : {}),
              ...extraFields,
              ...pluginDriverFields(parsed.db_type),
            },
          };
        });
        if (parsed.password) {
          passwordDraftRef.current = parsed.password;
        }
        if (parsed.username || parsed.password) {
          emitAppToast({
            tone: "info",
            title:
              language === "vi" ? "Đã điền thông tin từ URL" : "Connection details filled from URL",
            description:
              language === "vi"
                ? "Tên đăng nhập, database xác thực và các tùy chọn được lấy từ URL bạn dán."
                : "Username, auth database and options were taken from the pasted URL.",
          });
        }
      })
      .catch(() => {
        // Not a parseable connection URL — leave the host text as typed.
      });
    return () => {
      cancelled = true;
    };
  }, [formData.host, formData.db_type, language, pluginDriverFields]);

  const handleSwitchIntent = (nextIntent: "connect" | "bootstrap") => {
    if (editConnection || nextIntent === intentMode) return;
    setIntentMode(nextIntent);
    setPickerSearch("");
    setSelectedDb(null);
  };

  const handleContinueFromPicker = (db: DbEntry) => {
    if (!db.supported) return;
    if (bootstrapMode && !LOCAL_BOOTSTRAP_READY.has(db.key)) return;

    passwordDraftRef.current = "";
    setFormData((prev) => {
      const switchedEngine = prev.db_type !== db.key;
      return {
        ...prev,
        db_type: db.key,
        host:
          db.connectionMode === "network"
            ? switchedEngine
              ? (db.defaultHost ?? "")
              : (prev.host ?? db.defaultHost ?? "")
            : "",
        port: db.defaultPort,
        database:
          db.databaseMode === "hidden"
            ? ""
            : bootstrapMode && db.connectionMode === "file"
              ? prev.database || prev.name || "local-database"
              : prev.database,
        username: db.usernameMode === "hidden" ? "" : switchedEngine ? "" : prev.username,
        file_path: db.connectionMode === "file" ? prev.file_path : "",
        use_ssl: db.supportsSsl ? prev.use_ssl : false,
        additional_fields: {
          ...(switchedEngine ? {} : (prev.additional_fields ?? {})),
          ...pluginDriverFields(db.key),
        },
      };
    });
    setStep("form");
  };

  // "Paste a connection URL" affordance in the picker: parse the full URL
  // through the backend `parse_connection_url` command (which returns a
  // complete ConnectionConfig, credentials included) and jump straight into
  // the details step with every field filled. Gated engines still require
  // their driver plugin — the same availability check the picker applies.
  const handleConnectionUrl = useCallback(
    async (rawUrl: string) => {
      const url = rawUrl.trim();
      if (!url) return;
      try {
        const parsed = await invokeWithTimeout<ConnectionConfig>(
          "parse_connection_url",
          { url },
          5_000,
          "Parsing connection URL",
        );
        const engine = availableDatabases.find((db) => db.key === parsed.db_type);
        if (!engine) {
          emitAppToast({
            tone: "error",
            title: language === "vi" ? "Engine không được hỗ trợ" : "Unsupported engine",
            description:
              language === "vi"
                ? `URL này trỏ tới ${parsed.db_type}, engine chưa có trong TableR.`
                : `This URL targets ${parsed.db_type}, which TableR does not support.`,
          });
          return;
        }
        if (!engine.supported) {
          emitAppToast({
            tone: "error",
            title:
              language === "vi" ? `${engine.label} chưa sẵn sàng` : `${engine.label} is not ready`,
            description:
              language === "vi"
                ? "Engine này cần plugin driver trước khi kết nối. Cài nó từ Trình quản lý plugin."
                : "This engine needs its driver plugin before connecting. Install it from Plugin Manager.",
          });
          return;
        }
        urlPasteHandledRef.current = parsed.host ?? url;
        passwordDraftRef.current = parsed.password ?? "";
        setSelectedDb(engine);
        setFormData({
          ...parsed,
          password: undefined,
          additional_fields: {
            ...(parsed.additional_fields ?? {}),
            ...pluginDriverFields(parsed.db_type),
          },
        });
        setStep("form");
      } catch (error) {
        emitAppToast({
          tone: "error",
          title: language === "vi" ? "URL không hợp lệ" : "Invalid connection URL",
          description: String(error),
        });
      }
    },
    [availableDatabases, language, pluginDriverFields],
  );

  const handleTest = async () => {
    if (selectedEngineAvailability && !selectedEngineAvailability.supported) {
      setTestResult({
        success: false,
        message:
          language === "vi"
            ? `${selectedEngineAvailability.label} chưa khả dụng trong bản build này — cần plugin driver trước khi kết nối.`
            : `${selectedEngineAvailability.label} is not available in this build — it needs its driver plugin before connecting.`,
      });
      return;
    }
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
      const details = parseConnectionError(e);
      setTestResult({
        success: false,
        message: details.message,
        stage: details.stage,
        hint: details.hint,
      });
    }
    setIsTesting(false);
  };

  const handleConnect = async () => {
    if (selectedEngineAvailability && !selectedEngineAvailability.supported) {
      setTestResult({
        success: false,
        message:
          language === "vi"
            ? `${selectedEngineAvailability.label} chưa khả dụng trong bản build này — cần plugin driver trước khi kết nối.`
            : `${selectedEngineAvailability.label} is not available in this build — it needs its driver plugin before connecting.`,
      });
      return;
    }
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
      const details = parseConnectionError(e);
      setTestResult({
        success: false,
        message: details.message,
        stage: details.stage,
        hint: details.hint,
      });
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
      const details = parseConnectionError(e);
      setTestResult({
        success: false,
        message: details.message,
        stage: details.stage,
        hint: details.hint,
      });
    }
  };

  const handleCreateDatabase = async () => {
    setIsCreatingDatabase(true);
    setTestResult(null);
    try {
      const presetSql = getBootstrapPresetSql(bootstrapPreset, formData.db_type);
      const combinedBootstrapSql = [presetSql, bootstrapSql.trim()]
        .filter((s) => s.trim().length > 0)
        .join("\n\n");
      const bootstrapStatements = splitSqlStatements(combinedBootstrapSql);
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
        const message = await createLocalDatabase(
          sqliteConfig,
          sqliteDatabaseName,
          bootstrapStatements,
        );
        setTestResult({
          success: true,
          message:
            language === "vi"
              ? `Đang tạo cơ sở dữ liệu SQLite từ ${resolvedFilePath}...`
              : `Creating SQLite database from ${resolvedFilePath}...`,
        });
        setTestResult({
          success: true,
          message:
            language === "vi"
              ? `${message} Dang mo workspace SQLite...`
              : `${message} Opening the SQLite workspace...`,
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
        setTestResult({
          success: false,
          message:
            language === "vi"
              ? "Hãy nhập tên cơ sở dữ liệu trước."
              : "Enter a database name first.",
        });
        return;
      }

      const bootstrapConfig = {
        ...formData,
        name:
          formData.name.trim() || `${selectedDb?.label || formData.db_type} ${requestedDatabase}`,
        database: requestedDatabase,
        password: showPasswordField ? passwordDraftRef.current : undefined,
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
      const details = parseConnectionError(e);
      setTestResult({
        success: false,
        message: details.message,
        stage: details.stage,
        hint: details.hint,
      });
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

  // --- Picker computed values ---
  const filteredDbs = pickerSearch
    ? availableDatabases.filter(
        (d) =>
          d.label.toLowerCase().includes(pickerSearch.toLowerCase()) ||
          d.key.toLowerCase().includes(pickerSearch.toLowerCase()),
      )
    : availableDatabases;

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
          key: "installed-disabled",
          title: copy.installedDisabled,
          caption: copy.installedDisabledCaption,
          items: filteredDbs.filter((db) => !db.supported && db.pluginHttpState === "installed"),
        },
        {
          key: "installed-incomplete",
          title: copy.installedIncomplete,
          caption: copy.installedIncompleteCaption,
          items: filteredDbs.filter((db) => !db.supported && db.pluginHttpState === "incomplete"),
        },
        {
          key: "roadmap",
          title: copy.roadmap,
          caption: copy.roadmapCaption,
          items: filteredDbs.filter((db) => !db.supported && db.pluginHttpState === "roadmap"),
        },
      ].filter((s) => s.items.length > 0);
    }
    return [
      {
        key: "local-ready",
        title: copy.localReady,
        caption: copy.localReadyCaption,
        items: filteredDbs.filter((db) => LOCAL_BOOTSTRAP_READY.has(db.key)),
      },
      {
        key: "local-roadmap",
        title: copy.localRoadmap,
        caption: copy.localRoadmapCaption,
        items: filteredDbs.filter((db) => !LOCAL_BOOTSTRAP_READY.has(db.key)),
      },
    ].filter((s) => s.items.length > 0);
  }, [bootstrapMode, copy, filteredDbs]);

  // --- Effects ---
  useEffect(() => {
    if (!pluginsHaveLoaded) void loadPlugins();
  }, [loadPlugins, pluginsHaveLoaded]);

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
        /* Keep existing manual entry on failure */
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
  const handleInstallPluginFromPicker = useCallback(async () => {
    setIsInstallingPlugin(true);
    try {
      const installed = await installPlugin();
      if (installed) {
        emitAppToast({
          tone: "success",
          title: copy.installPluginSuccess,
          description: `${installed.manifest.name} v${installed.manifest.version}`,
        });
      }
    } finally {
      setIsInstallingPlugin(false);
    }
  }, [copy.installPluginSuccess, installPlugin]);

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
    pasteConnectionUrl: copy.pasteConnectionUrl,
    readyNowCaption: copy.readyNowCaption,
    installPlugin: copy.installPlugin,
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
    pasteUrlHint: copy.pasteUrlHint,
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
        showCloseButton={!embeddedInStartupShell}
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
        onInstallPlugin={handleInstallPluginFromPicker}
        isInstallingPlugin={isInstallingPlugin}
        onConnectionUrl={handleConnectionUrl}
      />
    );

    if (embeddedInStartupShell) {
      return (
        <div className="connection-picker-shell">
          <div className="connection-picker-shell-viewport">{pickerContent}</div>
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
      showCloseButton={!embeddedInStartupShell}
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
      onPasswordChange={(v) => {
        passwordDraftRef.current = v;
      }}
      onBack={() => setStep("pick")}
      onClose={onClose}
      onTest={handleTest}
      onConnect={handleConnect}
      onCreateDatabase={handleCreateDatabase}
      onImportBootstrapFile={handleImportBootstrapFile}
      onToggleSqliteAdvancedPath={() => setShowSqliteAdvancedPath((v) => !v)}
      onResetSqlitePath={() => {
        setSqlitePathTouched(false);
        setShowSqliteAdvancedPath(false);
      }}
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
