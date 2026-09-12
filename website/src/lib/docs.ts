import type { SiteLanguage } from "./i18n";

/**
 * Structured, language-aware documentation content for the /docs section.
 *
 * The content is authored from the TableR desktop application (README,
 * feature set, keyboard shortcuts, supported engines, and architecture) so the
 * public docs stay close to what the app actually ships.
 */

export type DocBlock =
  | { type: "p"; text: string }
  | { type: "h2"; text: string }
  | { type: "h3"; text: string }
  | { type: "ul"; items: string[] }
  | { type: "ol"; items: string[] }
  | { type: "code"; lang?: string; code: string }
  | { type: "table"; head: string[]; rows: string[][] }
  | { type: "callout"; tone: "info" | "tip" | "warn"; title?: string; text?: string; steps?: string[] }
  | { type: "steps"; items: { title: string; text: string }[] }
  | { type: "cards"; items: { title: string; text: string; href?: string }[] }
  | { type: "image"; src: string; alt: string; width: number; height: number };

export type DocPage = {
  /** Empty string renders at /docs (the introduction page). */
  slug: string;
  /** lucide-react icon name resolved in the sidebar component. */
  icon: string;
  title: string;
  description: string;
  blocks: DocBlock[];
};

export type DocGroup = {
  /** Localized section heading rendered above its links in the sidebar. */
  label: string;
  /** Ordered slugs belonging to this group (must exist in `pages`). */
  slugs: string[];
};

export type DocHeading = {
  id: string;
  text: string;
  level: 2 | 3;
};

export type DocsBundle = {
  label: string;
  tagline: string;
  homeLabel: string;
  downloadLabel: string;
  githubLabel: string;
  onThisSection: string;
  previous: string;
  next: string;
  menu: string;
  groups: DocGroup[];
  pages: DocPage[];
};

/** Canonical ordering of doc slugs. Also consumed by the sitemap. */
export const docsSlugs = [
  "",
  "getting-started",
  "connections",
  "postgresql",
  "mysql",
  "mariadb",
  "cockroachdb",
  "greenplum",
  "amazon-redshift",
  "sql-server",
  "vertica",
  "clickhouse",
  "snowflake",
  "bigquery",
  "sqlite",
  "duckdb",
  "cassandra",
  "redis",
  "mongodb",
  "libsql",
  "cloudflare-d1",
  "plugins",
  "sql-workspace",
  "exploring-data",
  "visualize",
  "ai-agent",
  "shortcuts",
  "architecture",
  "faq",
] as const;

export function docHref(slug: string): string {
  return slug ? `/docs/${slug}` : "/docs";
}

/**
 * Ordered list of the supported engines, used to build the "Connections &
 * databases" sub-navigation. Labels are proper nouns, so they are shared
 * across languages. Each `key` doubles as the anchor id on the connections
 * overview page and as the slug for a dedicated engine page once one exists.
 */
export const engineOrder: { key: string; label: string }[] = [
  { key: "postgresql", label: "PostgreSQL" },
  { key: "mysql", label: "MySQL" },
  { key: "mariadb", label: "MariaDB" },
  { key: "cockroachdb", label: "CockroachDB" },
  { key: "greenplum", label: "Greenplum" },
  { key: "amazon-redshift", label: "Amazon Redshift" },
  { key: "sql-server", label: "SQL Server" },
  { key: "vertica", label: "Vertica" },
  { key: "clickhouse", label: "ClickHouse" },
  { key: "snowflake", label: "Snowflake" },
  { key: "bigquery", label: "BigQuery" },
  { key: "sqlite", label: "SQLite" },
  { key: "duckdb", label: "DuckDB" },
  { key: "cassandra", label: "Cassandra" },
  { key: "redis", label: "Redis" },
  { key: "mongodb", label: "MongoDB" },
  { key: "libsql", label: "LibSQL" },
  { key: "cloudflare-d1", label: "Cloudflare D1" },
];

/**
 * Resolve where an engine link should point. If a dedicated page exists for
 * the engine (its slug matches the engine key) we link to that page; otherwise
 * we fall back to the matching anchor on the connections overview page. This
 * lets engines migrate to their own page one at a time with no other changes.
 */
export function engineHref(docs: DocsBundle, key: string): string {
  const hasPage = docs.pages.some((page) => page.slug === key);
  return hasPage ? `/docs/${key}` : `/docs/connections#${key}`;
}

/**
 * Slugify a heading into a stable, URL-safe anchor id. Handles Vietnamese
 * diacritics (including đ) so anchors work for both languages.
 */
export function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/đ/g, "d")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Extract the on-this-page headings (h2/h3) for a doc page and the anchor id
 * assigned to each heading block. `idByIndex` is keyed by the block's position
 * so the article renderer and the table of contents stay perfectly in sync.
 */
export function getDocHeadings(page: DocPage): {
  headings: DocHeading[];
  idByIndex: Record<number, string>;
} {
  const headings: DocHeading[] = [];
  const idByIndex: Record<number, string> = {};
  const seen = new Map<string, number>();

  page.blocks.forEach((block, index) => {
    if (block.type !== "h2" && block.type !== "h3") return;
    const base = slugifyHeading(block.text) || "section";
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    const id = count === 0 ? base : `${base}-${count + 1}`;
    idByIndex[index] = id;
    headings.push({
      id,
      text: block.text,
      level: block.type === "h2" ? 2 : 3,
    });
  });

  return { headings, idByIndex };
}

/* ------------------------------------------------------------------ */
/* Language-neutral snippets shared across EN and VI                   */
/* ------------------------------------------------------------------ */

const CODE_CLONE = `git clone https://github.com/minhe51805/TabLer.git
cd TabLer
npm install
npm run tauri -- dev`;

const CODE_QUALITY = `npm run typecheck
npm run test:run
npm run build`;

const MACOS_QUARANTINE = `xattr -dr com.apple.quarantine /Applications/TableR.app`;

const ARCH_DIAGRAM = `React workspace
    |
    |  Tauri commands and events
    v
Rust application services
    |
    |  connection pools and engine adapters
    v
PostgreSQL / MySQL / SQLite / SQL Server / NoSQL / cloud databases`;

const PROJECT_LAYOUT = `TableR/
├─ src/          React + TypeScript UI (components, hooks, stores, utils)
├─ src-tauri/    Rust backend, Tauri config, command handlers, drivers
├─ docs/         Architecture, security, product, and release docs
├─ website/      Next.js product website (this site)
└─ package.json  Frontend scripts and dependencies`;

const SHORTCUT_KEYS = [
  "Ctrl + N",
  "Ctrl + Enter",
  "Ctrl + Space",
  "Ctrl + P",
  "Ctrl + Shift + P",
  "Ctrl + B",
  "Ctrl + `",
  "Ctrl + Shift + `",
  "Ctrl + H",
  "Ctrl + Shift + S",
  "Ctrl + Shift + F",
];

const shortcutRows = (actions: string[]): string[][] =>
  SHORTCUT_KEYS.map((key, index) => [key, actions[index]]);

const TECH_STACK = [
  "Tauri 2",
  "React 19, TypeScript 5, Vite",
  "Tailwind CSS 4",
  "Rust, Tokio",
  "SQLx + engine-specific Rust drivers",
  "Monaco Editor, Xterm.js",
  "TanStack Table, Recharts, XYFlow",
  "Zustand",
];

const COMMANDS = [
  "npm run dev",
  "npm run tauri -- dev",
  "npm run typecheck",
  "npm run test:run",
  "npm run build",
  "npm run tauri -- build",
  "cd website && npm run dev",
];

/* ------------------------------------------------------------------ */
/* Shared engine-page builder                                          */
/* ------------------------------------------------------------------ */

/**
 * Localized, engine-independent labels for a dedicated engine page. One set
 * exists per language and is shared across every engine, so section headings,
 * table headers, and the fixed "Next steps" cards stay perfectly consistent.
 */
type EnginePageLabels = {
  overview: string;
  beforeYouStart: string;
  connectionFields: string;
  connectWithForm: string;
  useConnectionString: string;
  localBootstrap: string;
  sslTls: string;
  verifyConnection: string;
  troubleshooting: string;
  nextSteps: string;
  noServerTitle: string;
  secretsTitle: string;
  secretsText: string;
  verifyLead: string;
  verifyTrail: string;
  fieldHead: string[];
  troubleHead: string[];
  nextStepsCards: { title: string; text: string; href: string }[];
};

/**
 * Per-engine, per-language content for a dedicated engine page. Everything an
 * engine page needs beyond the shared labels above. `connString`, `bootstrap`,
 * `sslIntro`/`sslBullets`, and `verifyCode` are optional so engines that do not
 * support a section (for example file-based or HTTPS-only cloud engines) simply
 * omit it. `verifyLang`/`verifyLead`/`verifyTrail` let a non-SQL engine (Redis,
 * MongoDB) override the verification snippet's language and surrounding copy.
 */
type EngineSpec = {
  slug: string;
  icon: string;
  title: string;
  description: string;
  intro: string;
  overviewText: string;
  overviewBullets: string[];
  beforeYouStart: string[];
  connFieldsIntro: string;
  fieldRows: string[][];
  formSteps: { title: string; text: string }[];
  connString?: { intro: string; code: string; bullets: string[] };
  bootstrap?: {
    noServerText: string;
    intro: string;
    steps: { title: string; text: string }[];
    /** File engines (SQLite, DuckDB) have no credentials, so skip the keyring callout. */
    skipSecretsCallout?: boolean;
  };
  sslIntro?: string;
  sslBullets?: string[];
  verifyCode?: string;
  verifyLang?: string;
  verifyLead?: string;
  verifyTrail?: string;
  troubleshootRows: string[][];
};

/**
 * Assemble a full DocPage for a database engine from its localized spec and the
 * shared labels for that language. This keeps every engine page structurally
 * identical (same sections, in the same order) while letting the wording differ
 * per engine and per language.
 */
function buildEnginePage(labels: EnginePageLabels, spec: EngineSpec): DocPage {
  const blocks: DocBlock[] = [{ type: "p", text: spec.intro }];

  if (spec.bootstrap) {
    blocks.push({
      type: "callout",
      tone: "tip",
      title: labels.noServerTitle,
      text: spec.bootstrap.noServerText,
    });
  }

  blocks.push(
    { type: "h2", text: labels.overview },
    { type: "p", text: spec.overviewText },
    { type: "ul", items: spec.overviewBullets },
    { type: "h2", text: labels.beforeYouStart },
    { type: "ul", items: spec.beforeYouStart },
    { type: "h2", text: labels.connectionFields },
    { type: "p", text: spec.connFieldsIntro },
    { type: "table", head: labels.fieldHead, rows: spec.fieldRows },
    { type: "h2", text: labels.connectWithForm },
    { type: "steps", items: spec.formSteps },
  );

  if (spec.connString) {
    blocks.push(
      { type: "h2", text: labels.useConnectionString },
      { type: "p", text: spec.connString.intro },
      { type: "code", lang: "text", code: spec.connString.code },
      { type: "ul", items: spec.connString.bullets },
    );
  }

  if (spec.bootstrap) {
    blocks.push(
      { type: "h2", text: labels.localBootstrap },
      { type: "p", text: spec.bootstrap.intro },
      { type: "steps", items: spec.bootstrap.steps },
    );
    if (!spec.bootstrap.skipSecretsCallout) {
      blocks.push({
        type: "callout",
        tone: "info",
        title: labels.secretsTitle,
        text: labels.secretsText,
      });
    }
  }

  if (spec.sslIntro) {
    blocks.push(
      { type: "h2", text: labels.sslTls },
      { type: "p", text: spec.sslIntro },
      { type: "ul", items: spec.sslBullets ?? [] },
    );
  }

  if (spec.verifyCode) {
    blocks.push(
      { type: "h2", text: labels.verifyConnection },
      { type: "p", text: spec.verifyLead ?? labels.verifyLead },
      { type: "code", lang: spec.verifyLang ?? "sql", code: spec.verifyCode },
      { type: "p", text: spec.verifyTrail ?? labels.verifyTrail },
    );
  }

  blocks.push(
    { type: "h2", text: labels.troubleshooting },
    { type: "table", head: labels.troubleHead, rows: spec.troubleshootRows },
    { type: "h2", text: labels.nextSteps },
    { type: "cards", items: labels.nextStepsCards },
  );

  return {
    slug: spec.slug,
    icon: spec.icon,
    title: spec.title,
    description: spec.description,
    blocks,
  };
}

const EN_ENGINE_LABELS: EnginePageLabels = {
  overview: "Overview",
  beforeYouStart: "Before you start",
  connectionFields: "Connection fields",
  connectWithForm: "Connect with the form",
  useConnectionString: "Use a connection string",
  localBootstrap: "Local bootstrap",
  sslTls: "SSL/TLS",
  verifyConnection: "Verify the connection",
  troubleshooting: "Troubleshooting",
  nextSteps: "Next steps",
  noServerTitle: "No server? Start here",
  secretsTitle: "Secrets stay local",
  secretsText: "Bootstrapped credentials, like all connection secrets, are kept in the OS keyring rather than in the interface or configuration files.",
  verifyLead: "Once connected, open a SQL tab and run a quick check:",
  verifyTrail: "If both statements return rows, the connection and credentials are working.",
  fieldHead: ["Field", "Required", "Default", "Notes"],
  troubleHead: ["Symptom", "Likely cause", "Fix"],
  nextStepsCards: [
    { title: "SQL workspace", text: "Write and run queries, manage tabs, and read results.", href: "/docs/sql-workspace" },
    { title: "Exploring data", text: "Browse schemas, tables, and columns, and search across databases.", href: "/docs/exploring-data" },
    { title: "All engines", text: "Back to the connections overview and the full engine list.", href: "/docs/connections" },
  ],
};

const VI_ENGINE_LABELS: EnginePageLabels = {
  overview: "Tổng quan",
  beforeYouStart: "Trước khi bắt đầu",
  connectionFields: "Các trường kết nối",
  connectWithForm: "Kết nối bằng form",
  useConnectionString: "Dùng connection string",
  localBootstrap: "Bootstrap local",
  sslTls: "SSL/TLS",
  verifyConnection: "Kiểm tra kết nối",
  troubleshooting: "Khắc phục sự cố",
  nextSteps: "Bước tiếp theo",
  noServerTitle: "Chưa có server? Bắt đầu ở đây",
  secretsTitle: "Bí mật nằm ở máy bạn",
  secretsText: "Credential đã bootstrap, cũng như mọi bí mật kết nối, được giữ trong keyring của hệ điều hành thay vì trên giao diện hay tệp cấu hình.",
  verifyLead: "Sau khi kết nối, mở tab SQL và chạy nhanh một truy vấn kiểm tra:",
  verifyTrail: "Nếu cả hai câu lệnh trả về dòng, kết nối và credential đang hoạt động tốt.",
  fieldHead: ["Trường", "Bắt buộc", "Mặc định", "Ghi chú"],
  troubleHead: ["Triệu chứng", "Nguyên nhân thường gặp", "Cách xử lý"],
  nextStepsCards: [
    { title: "Không gian SQL", text: "Viết và chạy truy vấn, quản lý tab và đọc kết quả.", href: "/docs/sql-workspace" },
    { title: "Khám phá dữ liệu", text: "Duyệt schema, bảng, cột và tìm kiếm xuyên nhiều database.", href: "/docs/exploring-data" },
    { title: "Tất cả engine", text: "Quay lại tổng quan kết nối và danh sách engine đầy đủ.", href: "/docs/connections" },
  ],
};

const EN_POSTGRESQL: EngineSpec = {
  slug: "postgresql",
  icon: "PlugZap",
  title: "PostgreSQL",
  description: "Connect TableR to any PostgreSQL server — or bootstrap one locally — with connection fields, connection strings, SSL/TLS, and troubleshooting.",
  intro: "PostgreSQL is a network SQL engine. Point TableR at an existing server by filling the connection form, or let TableR start a local PostgreSQL for you with the built-in bootstrap when you do not have a server yet.",
  overviewText: "TableR speaks the native PostgreSQL wire protocol, so it works with a local install, a container, a managed service (RDS, Cloud SQL, Azure Database, Supabase, Neon, and similar), or a bootstrapped local server. Because these are all PostgreSQL, the same connection fields below apply everywhere; only the values change.",
  overviewBullets: [
    "Local development — connect to 127.0.0.1:5432, or bootstrap a local server.",
    "Remote / managed — use the provider endpoint and enable SSL/TLS.",
    "PostgreSQL-compatible engines — CockroachDB, Greenplum, and Amazon Redshift use the same protocol and similar fields.",
  ],
  beforeYouStart: [
    "A reachable PostgreSQL server (host and port), or use Local bootstrap instead.",
    "A database user (role) name — this is required.",
    "The user's password, if the server requires one.",
    "Optionally, the specific database to open on connect.",
    "For remote servers: network access to the port and, usually, SSL/TLS enabled.",
  ],
  connFieldsIntro: "These defaults match TableR's PostgreSQL connection form. Secrets are written to the operating system keyring, never to plain configuration files.",
  fieldRows: [
    ["Host", "Yes", "127.0.0.1", "Hostname or IP of the server. Use the provider endpoint for managed databases."],
    ["Port", "Yes", "5432", "PostgreSQL's default port. Change it only if your server listens elsewhere."],
    ["Username", "Yes", "—", "The role used to authenticate."],
    ["Password", "No", "—", "Optional; stored in the OS keyring. Leave empty for trust/peer auth."],
    ["Database", "No", "—", "Optional. When empty, PostgreSQL uses the default database for the role."],
    ["SSL/TLS", "No", "Off", "Enable for remote servers; many managed providers require it."],
  ],
  formSteps: [
    { title: "Choose PostgreSQL", text: "Open the launcher and pick the PostgreSQL card." },
    { title: "Enter host and port", text: "Use 127.0.0.1 and 5432 for a local server, or your provider's endpoint for a remote one." },
    { title: "Add credentials", text: "Type the username, and the password if required. The password is saved to the OS keyring." },
    { title: "Pick a database (optional)", text: "Set a database to open it directly, or leave it blank to use the role's default." },
    { title: "Enable SSL/TLS for remote", text: "Turn on SSL/TLS when connecting to a remote or managed server." },
    { title: "Save and connect", text: "Save the profile so it reappears in the launcher, then connect." },
  ],
  connString: {
    intro: "Instead of filling every field, you can paste a PostgreSQL connection URI. Both postgres:// and postgresql:// schemes are accepted.",
    code: "postgresql://username:password@host:5432/database?sslmode=require",
    bullets: [
      "Omit the password from the URI and let TableR store it in the keyring instead.",
      "Append sslmode=require (or verify-full) for remote servers.",
      "URL-encode special characters in the password (for example @ becomes %40).",
    ],
  },
  bootstrap: {
    noServerText: "You do not need to install PostgreSQL to try it. Choose PostgreSQL in the launcher and use Local bootstrap — TableR creates and starts a local server, and keeps its secrets in the OS keyring.",
    intro: "If you do not have a server, TableR can start a local PostgreSQL for you — no separate install required.",
    steps: [
      { title: "Select PostgreSQL", text: "Pick PostgreSQL in the launcher." },
      { title: "Choose Local bootstrap", text: "TableR provisions and starts a local server on your machine." },
      { title: "Start querying", text: "A connection is created for you; open a SQL tab and run a query." },
    ],
  },
  sslIntro: "Local servers on 127.0.0.1 usually need no encryption. For anything over a network, enable SSL/TLS. If you connect with a URI, control the behaviour with the sslmode parameter.",
  sslBullets: [
    "disable — no encryption (local only).",
    "require — encrypt, but do not verify the server certificate.",
    "verify-ca / verify-full — encrypt and verify the certificate (most secure).",
  ],
  verifyCode: "SELECT version();\nSELECT current_database(), current_user;",
  troubleshootRows: [
    ["Connection refused", "Server not running, wrong host/port, or a firewall.", "Confirm the server is up and the port is reachable; re-check host and port."],
    ["password authentication failed", "Wrong username or password.", "Re-check the credentials and update the saved password (it lives in the keyring)."],
    ["SSL / encryption required", "The server requires TLS.", "Enable SSL/TLS, or add sslmode=require to the connection string."],
    ["database 'name' does not exist", "The Database field names a database that is missing.", "Leave Database empty, or enter one that exists."],
    ["too many clients already", "The server hit its connection limit.", "Close idle connections, or raise max_connections on the server."],
  ],
};

const EN_MYSQL: EngineSpec = {
  slug: "mysql",
  icon: "PlugZap",
  title: "MySQL",
  description: "Connect TableR to any MySQL server — or bootstrap one locally — with connection fields, connection strings, SSL/TLS, and troubleshooting.",
  intro: "MySQL is a network SQL engine and the engine TableR selects by default for a new connection. Point TableR at an existing server by filling the connection form, or let TableR start a local MySQL for you with the built-in bootstrap when you do not have a server yet.",
  overviewText: "TableR speaks the native MySQL wire protocol, so it works with a local install, a container, a managed service (RDS, Cloud SQL, Azure Database for MySQL, PlanetScale, and similar), or a bootstrapped local server. Because these are all MySQL, the same connection fields below apply everywhere; only the values change.",
  overviewBullets: [
    "Local development — connect to 127.0.0.1:3306, or bootstrap a local server.",
    "Remote / managed — use the provider endpoint and enable SSL/TLS.",
    "MySQL-compatible engines — MariaDB uses the same wire protocol and identical fields.",
  ],
  beforeYouStart: [
    "A reachable MySQL server (host and port), or use Local bootstrap instead.",
    "A database user name — this is required.",
    "The user's password, if the server requires one.",
    "Optionally, the specific database (schema) to open on connect.",
    "For remote servers: network access to the port and, usually, SSL/TLS enabled.",
  ],
  connFieldsIntro: "These defaults match TableR's MySQL connection form. Secrets are written to the operating system keyring, never to plain configuration files.",
  fieldRows: [
    ["Host", "Yes", "127.0.0.1", "Hostname or IP of the server. Use the provider endpoint for managed databases."],
    ["Port", "Yes", "3306", "MySQL's default port. Change it only if your server listens elsewhere."],
    ["Username", "Yes", "—", "The user used to authenticate."],
    ["Password", "No", "—", "Optional; stored in the OS keyring. Leave empty for socket/no-password auth."],
    ["Database", "No", "—", "Optional. When empty, no schema is selected until you choose one."],
    ["SSL/TLS", "No", "Off", "Enable for remote servers; many managed providers require it."],
  ],
  formSteps: [
    { title: "Choose MySQL", text: "Open the launcher and pick the MySQL card — it is the default selection." },
    { title: "Enter host and port", text: "Use 127.0.0.1 and 3306 for a local server, or your provider's endpoint for a remote one." },
    { title: "Add credentials", text: "Type the username, and the password if required. The password is saved to the OS keyring." },
    { title: "Pick a database (optional)", text: "Set a database to open it directly, or leave it blank and choose one after connecting." },
    { title: "Enable SSL/TLS for remote", text: "Turn on SSL/TLS when connecting to a remote or managed server." },
    { title: "Save and connect", text: "Save the profile so it reappears in the launcher, then connect." },
  ],
  connString: {
    intro: "Instead of filling every field, you can paste a MySQL connection URI.",
    code: "mysql://username:password@host:3306/database?ssl-mode=REQUIRED",
    bullets: [
      "Omit the password from the URI and let TableR store it in the keyring instead.",
      "Append ssl-mode=REQUIRED (or VERIFY_IDENTITY) for remote servers.",
      "URL-encode special characters in the password (for example @ becomes %40).",
    ],
  },
  bootstrap: {
    noServerText: "You do not need to install MySQL to try it. Choose MySQL in the launcher and use Local bootstrap — TableR creates and starts a local server, and keeps its secrets in the OS keyring.",
    intro: "If you do not have a server, TableR can start a local MySQL for you — no separate install required.",
    steps: [
      { title: "Select MySQL", text: "Pick MySQL in the launcher." },
      { title: "Choose Local bootstrap", text: "TableR provisions and starts a local server on your machine." },
      { title: "Start querying", text: "A connection is created for you; open a SQL tab and run a query." },
    ],
  },
  sslIntro: "Local servers on 127.0.0.1 usually need no encryption. For anything over a network, enable SSL/TLS. If you connect with a URI, control the behaviour with the ssl-mode parameter.",
  sslBullets: [
    "DISABLED — no encryption (local only).",
    "REQUIRED — encrypt, but do not verify the server certificate.",
    "VERIFY_CA / VERIFY_IDENTITY — encrypt and verify the certificate (most secure).",
  ],
  verifyCode: "SELECT VERSION();\nSELECT DATABASE(), CURRENT_USER();",
  troubleshootRows: [
    ["Can't connect to MySQL server", "Server not running, wrong host/port, or a firewall.", "Confirm the server is up and the port is reachable; re-check host and port."],
    ["Access denied for user", "Wrong username or password, or the user lacks host access.", "Re-check the credentials and update the saved password (it lives in the keyring)."],
    ["SSL connection error", "The server requires TLS, or the certificate is not trusted.", "Enable SSL/TLS, or add ssl-mode=REQUIRED to the connection string."],
    ["Unknown database 'name'", "The Database field names a schema that is missing.", "Leave Database empty, or enter one that exists."],
    ["Too many connections", "The server hit its connection limit.", "Close idle connections, or raise max_connections on the server."],
  ],
};

const EN_MARIADB: EngineSpec = {
  slug: "mariadb",
  icon: "PlugZap",
  title: "MariaDB",
  description: "Connect TableR to any MariaDB server — or bootstrap one locally. MariaDB speaks the MySQL wire protocol, so the fields, connection strings, and behaviour match MySQL.",
  intro: "MariaDB is a network SQL engine that speaks the MySQL wire protocol, so TableR connects to it exactly like MySQL. Point TableR at an existing server by filling the connection form, or let TableR start a local MariaDB for you with the built-in bootstrap when you do not have a server yet.",
  overviewText: "Because MariaDB uses the MySQL wire protocol, the same connection fields and connection strings as MySQL apply. It works with a local install, a container, a managed service (SkySQL, Amazon RDS, and similar), or a bootstrapped local server.",
  overviewBullets: [
    "Local development — connect to 127.0.0.1:3306, or bootstrap a local server.",
    "Remote / managed — use the provider endpoint and enable SSL/TLS.",
    "MySQL-compatible — fields, connection strings, and behaviour match MySQL; see the MySQL guide for anything not covered here.",
  ],
  beforeYouStart: [
    "A reachable MariaDB server (host and port), or use Local bootstrap instead.",
    "A database user name — this is required.",
    "The user's password, if the server requires one.",
    "Optionally, the specific database (schema) to open on connect.",
    "For remote servers: network access to the port and, usually, SSL/TLS enabled.",
  ],
  connFieldsIntro: "These defaults match TableR's MariaDB connection form, which is identical to MySQL. Secrets are written to the operating system keyring, never to plain configuration files.",
  fieldRows: [
    ["Host", "Yes", "127.0.0.1", "Hostname or IP of the server. Use the provider endpoint for managed databases."],
    ["Port", "Yes", "3306", "MariaDB and MySQL share port 3306. Change it only if your server listens elsewhere."],
    ["Username", "Yes", "—", "The user used to authenticate."],
    ["Password", "No", "—", "Optional; stored in the OS keyring. Leave empty for socket/no-password auth."],
    ["Database", "No", "—", "Optional. When empty, no schema is selected until you choose one."],
    ["SSL/TLS", "No", "Off", "Enable for remote servers; many managed providers require it."],
  ],
  formSteps: [
    { title: "Choose MariaDB", text: "Open the launcher and pick the MariaDB card." },
    { title: "Enter host and port", text: "Use 127.0.0.1 and 3306 for a local server, or your provider's endpoint for a remote one." },
    { title: "Add credentials", text: "Type the username, and the password if required. The password is saved to the OS keyring." },
    { title: "Pick a database (optional)", text: "Set a database to open it directly, or leave it blank and choose one after connecting." },
    { title: "Enable SSL/TLS for remote", text: "Turn on SSL/TLS when connecting to a remote or managed server." },
    { title: "Save and connect", text: "Save the profile so it reappears in the launcher, then connect." },
  ],
  connString: {
    intro: "MariaDB uses MySQL's connection URI format, so you can paste a MySQL-style connection string.",
    code: "mysql://username:password@host:3306/database?ssl-mode=REQUIRED",
    bullets: [
      "Omit the password from the URI and let TableR store it in the keyring instead.",
      "Append ssl-mode=REQUIRED (or VERIFY_IDENTITY) for remote servers.",
      "URL-encode special characters in the password (for example @ becomes %40).",
    ],
  },
  bootstrap: {
    noServerText: "You do not need to install MariaDB to try it. Choose MariaDB in the launcher and use Local bootstrap — TableR creates and starts a local server, and keeps its secrets in the OS keyring.",
    intro: "If you do not have a server, TableR can start a local MariaDB for you — no separate install required.",
    steps: [
      { title: "Select MariaDB", text: "Pick MariaDB in the launcher." },
      { title: "Choose Local bootstrap", text: "TableR provisions and starts a local server on your machine." },
      { title: "Start querying", text: "A connection is created for you; open a SQL tab and run a query." },
    ],
  },
  sslIntro: "Local servers on 127.0.0.1 usually need no encryption. For anything over a network, enable SSL/TLS. If you connect with a URI, control the behaviour with the ssl-mode parameter.",
  sslBullets: [
    "DISABLED — no encryption (local only).",
    "REQUIRED — encrypt, but do not verify the server certificate.",
    "VERIFY_CA / VERIFY_IDENTITY — encrypt and verify the certificate (most secure).",
  ],
  verifyCode: "SELECT VERSION();\nSELECT DATABASE(), CURRENT_USER();",
  troubleshootRows: [
    ["Can't connect to server", "Server not running, wrong host/port, or a firewall.", "Confirm the server is up and the port is reachable; re-check host and port."],
    ["Access denied for user", "Wrong username or password, or the user lacks host access.", "Re-check the credentials and update the saved password (it lives in the keyring)."],
    ["SSL connection error", "The server requires TLS, or the certificate is not trusted.", "Enable SSL/TLS, or add ssl-mode=REQUIRED to the connection string."],
    ["Unknown database 'name'", "The Database field names a schema that is missing.", "Leave Database empty, or enter one that exists."],
    ["Too many connections", "The server hit its connection limit.", "Close idle connections, or raise max_connections on the server."],
  ],
};

const EN_SQL_SERVER: EngineSpec = {
  slug: "sql-server",
  icon: "PlugZap",
  title: "SQL Server",
  description: "Connect TableR to Microsoft SQL Server with Windows or SQL authentication — or bootstrap one locally — with connection fields, encryption, and troubleshooting.",
  intro: "SQL Server is Microsoft's network SQL engine. TableR connects with Windows or SQL Server authentication, auto-detected from the host. Point TableR at an existing server by filling the connection form, or let TableR start a local SQL Server for you with the built-in bootstrap when you do not have a server yet.",
  overviewText: "TableR speaks the native SQL Server protocol (TDS), so it works with a local install, a container, a managed service (Azure SQL Database, Amazon RDS for SQL Server, and similar), or a bootstrapped local server. The authentication mode — Windows or SQL Server — is detected from the host you enter.",
  overviewBullets: [
    "Local development — connect to localhost,1433, or bootstrap a local server.",
    "Named instances — use SERVER\\INSTANCE, or set the instance name field.",
    "Remote / managed — use the provider endpoint and set Encrypt appropriately.",
  ],
  beforeYouStart: [
    "A reachable SQL Server (host and port), or use Local bootstrap instead.",
    "For SQL authentication: a login name and password.",
    "For Windows authentication: leave the username empty to use the current Windows account.",
    "Optionally, the specific database to open on connect.",
    "For remote servers: network access to the port and appropriate Encrypt settings.",
  ],
  connFieldsIntro: "These defaults match TableR's SQL Server connection form. Secrets are written to the operating system keyring, never to plain configuration files.",
  fieldRows: [
    ["Host", "Yes", "127.0.0.1", "Use localhost,1433 or SERVER\\INSTANCE. The authentication mode is auto-detected from the host."],
    ["Port", "Yes", "1433", "SQL Server's default port. Change it only if your server listens elsewhere."],
    ["Username", "No", "—", "Used for SQL Server authentication. Leave empty to use Windows authentication."],
    ["Password", "No", "—", "Optional; stored in the OS keyring."],
    ["Database", "No", "—", "Optional. When empty, the login's default database is used."],
    ["Instance name", "No", "—", "Optional, or embed SERVER\\INSTANCE in the Host field."],
    ["Encrypt", "No", "Optional", "Optional or Mandatory. Trust server certificate is on by default for local self-signed certificates."],
  ],
  formSteps: [
    { title: "Choose SQL Server", text: "Open the launcher and pick the SQL Server card." },
    { title: "Enter host and port", text: "Use localhost,1433 for a local server, SERVER\\INSTANCE for a named instance, or your provider's endpoint for a remote one." },
    { title: "Pick an authentication mode", text: "Leave the username empty for Windows authentication, or enter a login and password for SQL Server authentication." },
    { title: "Pick a database (optional)", text: "Set a database to open it directly, or leave it blank to use the login's default." },
    { title: "Set encryption for remote", text: "Set Encrypt to Mandatory for remote servers; keep Trust server certificate on for local self-signed certificates." },
    { title: "Save and connect", text: "Save the profile so it reappears in the launcher, then connect." },
  ],
  bootstrap: {
    noServerText: "You do not need to install SQL Server to try it. Choose SQL Server in the launcher and use Local bootstrap — TableR creates and starts a local server, and keeps its secrets in the OS keyring.",
    intro: "If you do not have a server, TableR can start a local SQL Server for you — no separate install required.",
    steps: [
      { title: "Select SQL Server", text: "Pick SQL Server in the launcher." },
      { title: "Choose Local bootstrap", text: "TableR provisions and starts a local server on your machine." },
      { title: "Start querying", text: "A connection is created for you; open a SQL tab and run a query." },
    ],
  },
  sslIntro: "SQL Server controls encryption with the Encrypt setting rather than a URI parameter. Local servers usually need no encryption; for anything over a network, set Encrypt to Mandatory.",
  sslBullets: [
    "Encrypt: Optional — encrypt only if the server negotiates it (typical for local development).",
    "Encrypt: Mandatory — always encrypt the connection (use for remote and managed servers).",
    "Trust server certificate — on by default for local self-signed certificates; turn it off to validate the server's certificate chain.",
  ],
  verifyCode: "SELECT @@VERSION;\nSELECT DB_NAME(), SYSTEM_USER;",
  troubleshootRows: [
    ["Login failed for user", "Wrong username/password, or the login lacks access.", "Re-check the credentials, or leave the username empty to use Windows authentication."],
    ["Encryption / certificate error", "Encrypt or Trust server certificate does not match the server.", "Set Encrypt to Optional, or keep Trust server certificate on for local self-signed certificates."],
    ["Cannot open database 'name'", "The Database field names a database that is missing.", "Leave Database empty, or enter one that exists."],
    ["Server was not found or was not accessible", "Wrong host/instance/port, server stopped, or a firewall.", "Confirm the server is up, and check the host (localhost,1433 or SERVER\\INSTANCE) and port."],
  ],
};

const EN_COCKROACHDB: EngineSpec = {
  slug: "cockroachdb",
  icon: "PlugZap",
  title: "CockroachDB",
  description: "Connect TableR to CockroachDB — a self-hosted node or CockroachDB Cloud. It speaks the PostgreSQL wire protocol, so the fields, connection strings, and SSL/TLS work like PostgreSQL.",
  intro: "CockroachDB is a distributed SQL engine that speaks the PostgreSQL wire protocol, so TableR connects to it exactly like PostgreSQL. Fill the connection form to point at a node or a CockroachDB Cloud cluster.",
  overviewText: "Because CockroachDB uses the PostgreSQL wire protocol, the same connection fields and connection strings as PostgreSQL apply. It works with a local node, a self-hosted cluster, or CockroachDB Cloud; only the values change.",
  overviewBullets: [
    "Local / self-hosted — connect to a node on 127.0.0.1:26257.",
    "CockroachDB Cloud — use the cluster endpoint and enable SSL/TLS (usually required).",
    "PostgreSQL-compatible — fields, connection strings, and behaviour match PostgreSQL; see the PostgreSQL guide for anything not covered here.",
  ],
  beforeYouStart: [
    "A reachable CockroachDB node or cluster (host and port).",
    "A database user name — this is required.",
    "The user's password, if the cluster requires one.",
    "Optionally, the specific database to open on connect.",
    "For CockroachDB Cloud: network access to the port and SSL/TLS enabled.",
  ],
  connFieldsIntro: "These defaults match TableR's CockroachDB connection form, which mirrors PostgreSQL. Secrets are written to the operating system keyring, never to plain configuration files.",
  fieldRows: [
    ["Host", "Yes", "127.0.0.1", "Hostname or IP of your node, or your CockroachDB Cloud host."],
    ["Port", "Yes", "26257", "CockroachDB's default port. Change it only if your node listens elsewhere."],
    ["Username", "Yes", "—", "The database user used to authenticate."],
    ["Password", "No", "—", "Optional; stored in the OS keyring."],
    ["Database", "No", "—", "Optional. When empty, the user's default database is used."],
    ["SSL/TLS", "No", "Off", "Enable for remote clusters; CockroachDB Cloud usually requires it."],
  ],
  formSteps: [
    { title: "Choose CockroachDB", text: "Open the launcher and pick the CockroachDB card." },
    { title: "Enter host and port", text: "Use 127.0.0.1 and 26257 for a local node, or your CockroachDB Cloud endpoint for a remote cluster." },
    { title: "Add credentials", text: "Type the username, and the password if required. The password is saved to the OS keyring." },
    { title: "Pick a database (optional)", text: "Set a database to open it directly, or leave it blank to use the user's default." },
    { title: "Enable SSL/TLS for remote", text: "Turn on SSL/TLS when connecting to CockroachDB Cloud or any remote cluster." },
    { title: "Save and connect", text: "Save the profile so it reappears in the launcher, then connect." },
  ],
  connString: {
    intro: "Because CockroachDB speaks the PostgreSQL protocol, you can paste a PostgreSQL connection URI. Both postgres:// and postgresql:// schemes are accepted.",
    code: "postgresql://username:password@host:26257/database?sslmode=verify-full",
    bullets: [
      "Omit the password from the URI and let TableR store it in the keyring instead.",
      "Append sslmode=verify-full for CockroachDB Cloud, or sslmode=require for other remote clusters.",
      "URL-encode special characters in the password (for example @ becomes %40).",
    ],
  },
  sslIntro: "Local nodes on 127.0.0.1 usually need no encryption. For anything over a network — and always for CockroachDB Cloud — enable SSL/TLS. If you connect with a URI, control the behaviour with the sslmode parameter.",
  sslBullets: [
    "disable — no encryption (local only).",
    "require — encrypt, but do not verify the server certificate.",
    "verify-ca / verify-full — encrypt and verify the certificate (required by CockroachDB Cloud).",
  ],
  verifyCode: "SELECT version();\nSELECT current_database(), current_user;",
  troubleshootRows: [
    ["Connection refused", "Node not running, wrong host/port, or a firewall.", "Confirm the node is up and the port is reachable; re-check host and port."],
    ["password authentication failed", "Wrong username or password.", "Re-check the credentials and update the saved password (it lives in the keyring)."],
    ["SSL / certificate required", "The cluster requires TLS (typical for CockroachDB Cloud).", "Enable SSL/TLS, or add sslmode=verify-full to the connection string."],
    ["database 'name' does not exist", "The Database field names a database that is missing.", "Leave Database empty, or enter one that exists."],
  ],
};

const EN_GREENPLUM: EngineSpec = {
  slug: "greenplum",
  icon: "PlugZap",
  title: "Greenplum",
  description: "Connect TableR to Greenplum, a PostgreSQL-compatible analytics warehouse. The fields, connection strings, and SSL/TLS work like PostgreSQL.",
  intro: "Greenplum is a massively parallel analytics warehouse built on PostgreSQL, so TableR connects to it exactly like PostgreSQL. Fill the connection form to point at your Greenplum coordinator.",
  overviewText: "Because Greenplum is PostgreSQL-compatible, the same connection fields and connection strings as PostgreSQL apply. You connect through the coordinator host, and Greenplum spreads the query across its segments.",
  overviewBullets: [
    "Connect through the coordinator — TableR talks to the coordinator host on port 5432.",
    "Remote / managed — use the provider endpoint and enable SSL/TLS.",
    "PostgreSQL-compatible — fields, connection strings, and behaviour match PostgreSQL; see the PostgreSQL guide for anything not covered here.",
  ],
  beforeYouStart: [
    "A reachable Greenplum coordinator (host and port).",
    "A database user name — this is required.",
    "The user's password, if the warehouse requires one.",
    "Optionally, the specific database to open on connect.",
    "For remote warehouses: network access to the port and, usually, SSL/TLS enabled.",
  ],
  connFieldsIntro: "These defaults match TableR's Greenplum connection form, which mirrors PostgreSQL. Secrets are written to the operating system keyring, never to plain configuration files.",
  fieldRows: [
    ["Host", "Yes", "127.0.0.1", "Hostname or IP of the Greenplum coordinator."],
    ["Port", "Yes", "5432", "Greenplum's default port (shared with PostgreSQL)."],
    ["Username", "Yes", "—", "The database user used to authenticate."],
    ["Password", "No", "—", "Optional; stored in the OS keyring."],
    ["Database", "No", "—", "Optional. When empty, the user's default database is used."],
    ["SSL/TLS", "No", "Off", "Enable for remote warehouses; many managed providers require it."],
  ],
  formSteps: [
    { title: "Choose Greenplum", text: "Open the launcher and pick the Greenplum card." },
    { title: "Enter host and port", text: "Use 127.0.0.1 and 5432 for a local coordinator, or your coordinator endpoint for a remote warehouse." },
    { title: "Add credentials", text: "Type the username, and the password if required. The password is saved to the OS keyring." },
    { title: "Pick a database (optional)", text: "Set a database to open it directly, or leave it blank to use the user's default." },
    { title: "Enable SSL/TLS for remote", text: "Turn on SSL/TLS when connecting to a remote or managed warehouse." },
    { title: "Save and connect", text: "Save the profile so it reappears in the launcher, then connect." },
  ],
  connString: {
    intro: "Because Greenplum is PostgreSQL-compatible, you can paste a PostgreSQL connection URI. Both postgres:// and postgresql:// schemes are accepted.",
    code: "postgresql://username:password@coordinator:5432/database?sslmode=require",
    bullets: [
      "Omit the password from the URI and let TableR store it in the keyring instead.",
      "Append sslmode=require (or verify-full) for remote warehouses.",
      "URL-encode special characters in the password (for example @ becomes %40).",
    ],
  },
  sslIntro: "Local coordinators on 127.0.0.1 usually need no encryption. For anything over a network, enable SSL/TLS. If you connect with a URI, control the behaviour with the sslmode parameter.",
  sslBullets: [
    "disable — no encryption (local only).",
    "require — encrypt, but do not verify the server certificate.",
    "verify-ca / verify-full — encrypt and verify the certificate (most secure).",
  ],
  verifyCode: "SELECT version();\nSELECT current_database(), current_user;",
  troubleshootRows: [
    ["Connection refused", "Coordinator not running, wrong host/port, or a firewall.", "Confirm the coordinator is up and the port is reachable; re-check host and port."],
    ["password authentication failed", "Wrong username or password.", "Re-check the credentials and update the saved password (it lives in the keyring)."],
    ["SSL / encryption required", "The warehouse requires TLS.", "Enable SSL/TLS, or add sslmode=require to the connection string."],
    ["database 'name' does not exist", "The Database field names a database that is missing.", "Leave Database empty, or enter one that exists."],
  ],
};

const EN_AMAZON_REDSHIFT: EngineSpec = {
  slug: "amazon-redshift",
  icon: "PlugZap",
  title: "Amazon Redshift",
  description: "Connect TableR to Amazon Redshift, a PostgreSQL-compatible cloud data warehouse. The fields, connection strings, and SSL/TLS work like PostgreSQL.",
  intro: "Amazon Redshift is AWS's PostgreSQL-compatible cloud data warehouse, so TableR connects to it exactly like PostgreSQL. Fill the connection form to point at your cluster endpoint.",
  overviewText: "Because Redshift is PostgreSQL-compatible, the same connection fields and connection strings as PostgreSQL apply. You connect to the cluster endpoint over the network — there is no local Redshift.",
  overviewBullets: [
    "Cluster endpoint — use cluster.region.redshift.amazonaws.com on port 5439.",
    "SSL/TLS — enable it; Redshift connections travel over the network.",
    "PostgreSQL-compatible — fields, connection strings, and behaviour match PostgreSQL; see the PostgreSQL guide for anything not covered here.",
  ],
  beforeYouStart: [
    "Your Redshift cluster endpoint (host and port).",
    "A database user name — this is required.",
    "The user's password, if required.",
    "Optionally, the specific database to open on connect.",
    "Network access to the cluster (security group / VPC) and SSL/TLS enabled.",
  ],
  connFieldsIntro: "These defaults match TableR's Amazon Redshift connection form, which mirrors PostgreSQL. Secrets are written to the operating system keyring, never to plain configuration files.",
  fieldRows: [
    ["Host", "Yes", "—", "Your cluster endpoint, e.g. cluster.region.redshift.amazonaws.com."],
    ["Port", "Yes", "5439", "Redshift's default port. Change it only if your cluster listens elsewhere."],
    ["Username", "Yes", "—", "The database user used to authenticate."],
    ["Password", "No", "—", "Optional; stored in the OS keyring."],
    ["Database", "No", "—", "Optional. When empty, the user's default database is used."],
    ["SSL/TLS", "No", "Off", "Enable it — Redshift traffic crosses the network."],
  ],
  formSteps: [
    { title: "Choose Amazon Redshift", text: "Open the launcher and pick the Amazon Redshift card." },
    { title: "Enter the endpoint and port", text: "Use your cluster endpoint (cluster.region.redshift.amazonaws.com) and 5439." },
    { title: "Add credentials", text: "Type the username, and the password if required. The password is saved to the OS keyring." },
    { title: "Pick a database (optional)", text: "Set a database to open it directly, or leave it blank to use the user's default." },
    { title: "Enable SSL/TLS", text: "Turn on SSL/TLS — Redshift connections travel over the network." },
    { title: "Save and connect", text: "Save the profile so it reappears in the launcher, then connect." },
  ],
  connString: {
    intro: "Because Redshift is PostgreSQL-compatible, you can paste a PostgreSQL connection URI. Both postgres:// and postgresql:// schemes are accepted.",
    code: "postgresql://username:password@cluster.region.redshift.amazonaws.com:5439/database?sslmode=require",
    bullets: [
      "Omit the password from the URI and let TableR store it in the keyring instead.",
      "Append sslmode=require (or verify-full) — Redshift connections cross the network.",
      "URL-encode special characters in the password (for example @ becomes %40).",
    ],
  },
  sslIntro: "Redshift is always reached over the network, so enable SSL/TLS. If you connect with a URI, control the behaviour with the sslmode parameter.",
  sslBullets: [
    "require — encrypt, but do not verify the server certificate.",
    "verify-ca / verify-full — encrypt and verify the certificate (most secure).",
    "Leave SSL/TLS on for every Redshift connection.",
  ],
  verifyCode: "SELECT version();\nSELECT current_database(), current_user;",
  troubleshootRows: [
    ["Connection timed out", "The security group or VPC does not allow access, or the endpoint/port is wrong.", "Allow your IP in the cluster's security group and re-check the endpoint and port 5439."],
    ["password authentication failed", "Wrong username or password.", "Re-check the credentials and update the saved password (it lives in the keyring)."],
    ["SSL / encryption required", "The cluster requires TLS.", "Enable SSL/TLS, or add sslmode=require to the connection string."],
    ["database 'name' does not exist", "The Database field names a database that is missing.", "Leave Database empty, or enter one that exists."],
  ],
};

const EN_VERTICA: EngineSpec = {
  slug: "vertica",
  icon: "PlugZap",
  title: "Vertica",
  description: "Connect TableR to Vertica, a columnar analytics database, with connection fields, SSL/TLS, verifying the connection, and troubleshooting.",
  intro: "Vertica is a columnar analytics database built for large-scale queries. Point TableR at your Vertica host by filling the connection form.",
  overviewText: "TableR connects to Vertica over its native protocol. It works with a self-hosted cluster or a managed Vertica service; the columnar storage is designed for analytical (OLAP) workloads over large datasets.",
  overviewBullets: [
    "Self-hosted — connect to your Vertica host on port 5433.",
    "Remote / managed — use the provider endpoint and enable SSL/TLS.",
    "Columnar analytics — optimized for large scans and aggregations rather than single-row lookups.",
  ],
  beforeYouStart: [
    "A reachable Vertica host (host and port).",
    "A database user name — this is required.",
    "The user's password, if the database requires one.",
    "Optionally, the specific database to open on connect.",
    "For remote hosts: network access to the port and, usually, SSL/TLS enabled.",
  ],
  connFieldsIntro: "These defaults match TableR's Vertica connection form. Secrets are written to the operating system keyring, never to plain configuration files.",
  fieldRows: [
    ["Host", "Yes", "127.0.0.1", "Hostname or IP of your Vertica host."],
    ["Port", "Yes", "5433", "Vertica's default port. Change it only if your host listens elsewhere."],
    ["Username", "Yes", "—", "The database user used to authenticate."],
    ["Password", "No", "—", "Optional; stored in the OS keyring."],
    ["Database", "No", "—", "Optional. When empty, the user's default database is used."],
    ["SSL/TLS", "No", "Off", "Enable for remote hosts; many managed providers require it."],
  ],
  formSteps: [
    { title: "Choose Vertica", text: "Open the launcher and pick the Vertica card." },
    { title: "Enter host and port", text: "Use 127.0.0.1 and 5433 for a local host, or your provider's endpoint for a remote one." },
    { title: "Add credentials", text: "Type the username, and the password if required. The password is saved to the OS keyring." },
    { title: "Pick a database (optional)", text: "Set a database to open it directly, or leave it blank to use the user's default." },
    { title: "Enable SSL/TLS for remote", text: "Turn on SSL/TLS when connecting to a remote or managed host." },
    { title: "Save and connect", text: "Save the profile so it reappears in the launcher, then connect." },
  ],
  sslIntro: "Local hosts on 127.0.0.1 usually need no encryption. For anything over a network, enable SSL/TLS so credentials and results are protected in transit.",
  sslBullets: [
    "Off — no encryption (local or trusted networks only).",
    "On — encrypt the connection to the Vertica host.",
    "Enable it for any remote or managed host.",
  ],
  verifyCode: "SELECT version();\nSELECT current_database(), current_user;",
  troubleshootRows: [
    ["Connection refused", "Host not running, wrong host/port, or a firewall.", "Confirm the host is up and the port is reachable; re-check host and port."],
    ["Authentication failed", "Wrong username or password.", "Re-check the credentials and update the saved password (it lives in the keyring)."],
    ["SSL / encryption required", "The host requires TLS.", "Enable SSL/TLS for the connection."],
    ["Database does not exist", "The Database field names a database that is missing.", "Leave Database empty, or enter one that exists."],
  ],
};

const EN_CLICKHOUSE: EngineSpec = {
  slug: "clickhouse",
  icon: "PlugZap",
  title: "ClickHouse",
  description: "Connect TableR to ClickHouse over its HTTP interface, with connection fields, SSL/TLS, verifying the connection, and troubleshooting.",
  intro: "ClickHouse is a columnar database for real-time analytics. TableR connects over the ClickHouse HTTP interface; fill the connection form to point at your ClickHouse host.",
  overviewText: "TableR talks to ClickHouse over its HTTP interface (default port 8123). It works with a self-hosted server, a container, or ClickHouse Cloud. The columnar engine is built for fast aggregations over very large tables.",
  overviewBullets: [
    "Self-hosted — connect to your ClickHouse host on the HTTP port 8123.",
    "ClickHouse Cloud / remote — use the provider endpoint and enable SSL/TLS (HTTPS).",
    "Columnar analytics — optimized for large scans and aggregations rather than single-row lookups.",
  ],
  beforeYouStart: [
    "A reachable ClickHouse host and its HTTP port.",
    "A user name — this is required.",
    "The user's password, if the server requires one.",
    "Optionally, the specific database to open on connect.",
    "For remote servers: network access to the HTTP(S) port and, usually, SSL/TLS enabled.",
  ],
  connFieldsIntro: "These defaults match TableR's ClickHouse connection form. Secrets are written to the operating system keyring, never to plain configuration files.",
  fieldRows: [
    ["Host", "Yes", "127.0.0.1", "Hostname or IP of your ClickHouse host."],
    ["Port", "Yes", "8123", "The ClickHouse HTTP interface port. Use 8443 for the HTTPS interface."],
    ["Username", "Yes", "—", "The user used to authenticate."],
    ["Password", "No", "—", "Optional; stored in the OS keyring."],
    ["Database", "No", "—", "Optional. When empty, the default database is used."],
    ["SSL/TLS", "No", "Off", "Enable for remote servers (HTTPS); ClickHouse Cloud requires it."],
  ],
  formSteps: [
    { title: "Choose ClickHouse", text: "Open the launcher and pick the ClickHouse card." },
    { title: "Enter host and port", text: "Use 127.0.0.1 and 8123 for a local server, 8443 for HTTPS, or your provider's endpoint for a remote one." },
    { title: "Add credentials", text: "Type the username, and the password if required. The password is saved to the OS keyring." },
    { title: "Pick a database (optional)", text: "Set a database to open it directly, or leave it blank to use the default." },
    { title: "Enable SSL/TLS for remote", text: "Turn on SSL/TLS (HTTPS) when connecting to ClickHouse Cloud or any remote server." },
    { title: "Save and connect", text: "Save the profile so it reappears in the launcher, then connect." },
  ],
  sslIntro: "Local servers usually need no encryption. For anything over a network — and always for ClickHouse Cloud — enable SSL/TLS, which uses the HTTPS interface (default port 8443).",
  sslBullets: [
    "Off — plain HTTP (local or trusted networks only).",
    "On — HTTPS to the ClickHouse host.",
    "ClickHouse Cloud requires TLS; use the HTTPS port.",
  ],
  verifyCode: "SELECT version();\nSELECT currentDatabase(), currentUser();",
  troubleshootRows: [
    ["Connection refused", "Server not running, wrong host/port, or a firewall.", "Confirm the server is up and the HTTP port is reachable; re-check host and port."],
    ["Authentication failed", "Wrong username or password.", "Re-check the credentials and update the saved password (it lives in the keyring)."],
    ["SSL / HTTPS required", "The server requires TLS (typical for ClickHouse Cloud).", "Enable SSL/TLS and use the HTTPS port (8443)."],
    ["Database does not exist", "The Database field names a database that is missing.", "Leave Database empty, or enter one that exists."],
  ],
};

const EN_SNOWFLAKE: EngineSpec = {
  slug: "snowflake",
  icon: "PlugZap",
  title: "Snowflake",
  description: "Connect TableR to Snowflake over HTTPS with your account host, warehouse, role, connection fields, verifying the connection, and troubleshooting.",
  intro: "Snowflake is a cloud data warehouse reached over HTTPS at your account host. Fill the connection form with your account URL and credentials to start querying.",
  overviewText: "TableR connects to Snowflake through its HTTPS endpoint, so the connection is always encrypted. It works with any Snowflake account; queries run on the warehouse you select, and your role controls what you can see.",
  overviewBullets: [
    "Cloud warehouse — reached at account.region.snowflakecomputing.com over HTTPS (port 443).",
    "Compute — a warehouse must be available; set one when the session has no default.",
    "Access — the role determines the databases, schemas, and objects you can query.",
  ],
  beforeYouStart: [
    "Your Snowflake account host (account.region.snowflakecomputing.com).",
    "A username and its password or token.",
    "A warehouse name, if your user has no default warehouse.",
    "Optionally, a default role, database, and schema.",
  ],
  connFieldsIntro: "These fields match TableR's Snowflake connection form. The connection uses HTTPS, and secrets are written to the operating system keyring, never to plain configuration files.",
  fieldRows: [
    ["Host", "Yes", "—", "account.region.snowflakecomputing.com."],
    ["Port", "Yes", "443", "HTTPS; the connection is always encrypted."],
    ["Credential", "Yes", "—", "Your Snowflake password or token; stored in the OS keyring."],
    ["Warehouse", "No", "—", "Required when the session has no default warehouse."],
    ["Role", "No", "—", "Optional; the default role is used when empty."],
    ["Database", "No", "—", "Optional default database."],
    ["Schema", "No", "—", "Optional default schema."],
  ],
  formSteps: [
    { title: "Choose Snowflake", text: "Open the launcher and pick the Snowflake card." },
    { title: "Enter the account host", text: "Use your account URL, account.region.snowflakecomputing.com." },
    { title: "Add your credential", text: "Type the username and password or token; it is saved to the OS keyring." },
    { title: "Set a warehouse (if needed)", text: "Provide a warehouse when your user has no default." },
    { title: "Pick role, database, schema (optional)", text: "Leave these blank to use your account defaults." },
    { title: "Save and connect", text: "Save the profile so it reappears in the launcher, then connect." },
  ],
  verifyCode: "SELECT CURRENT_VERSION();\nSELECT CURRENT_ACCOUNT(), CURRENT_USER(), CURRENT_WAREHOUSE();",
  troubleshootRows: [
    ["Could not connect to host", "Wrong account host or no network access.", "Re-check the account URL (account.region.snowflakecomputing.com) and your connection."],
    ["Authentication failed", "Wrong username, password, or token.", "Re-check the credential and update the saved secret (it lives in the keyring)."],
    ["No active warehouse selected", "The session has no warehouse.", "Set the Warehouse field, or assign a default warehouse to the user."],
    ["Object does not exist or not authorized", "The role cannot see the object.", "Use a role with access, or set the correct default role."],
  ],
};

const EN_BIGQUERY: EngineSpec = {
  slug: "bigquery",
  icon: "PlugZap",
  title: "BigQuery",
  description: "Connect TableR to Google BigQuery with a service account, project and dataset fields, verifying the connection, and troubleshooting.",
  intro: "BigQuery is Google Cloud's serverless data warehouse. TableR connects over HTTPS and authenticates with a service account; provide your project and dataset to start querying.",
  overviewText: "TableR talks to BigQuery through the Google Cloud APIs over HTTPS. There is no host or port to manage — you authenticate with a service-account key and point TableR at a project and dataset.",
  overviewBullets: [
    "Serverless — no server, host, or port to run; reached at bigquery.googleapis.com over HTTPS.",
    "Authentication — a Google Cloud service-account key (JSON) or token.",
    "Scope — a project holds datasets, and a dataset holds tables.",
  ],
  beforeYouStart: [
    "A Google Cloud project ID.",
    "A service-account key (JSON) or token with BigQuery access.",
    "The dataset you want to browse.",
    "The dataset location (region), if it is not the default.",
  ],
  connFieldsIntro: "These fields match TableR's BigQuery connection form. The service-account key is stored in the operating system keyring, never in plain configuration files.",
  fieldRows: [
    ["Host", "Yes", "bigquery.googleapis.com", "HTTPS endpoint; the connection is always encrypted."],
    ["Credential", "Yes", "—", "A service-account key (JSON) or token; stored in the OS keyring."],
    ["Project ID", "Yes", "—", "Your Google Cloud project."],
    ["Dataset", "No", "—", "The dataset to browse."],
    ["Location", "No", "—", "The dataset region (for example US or EU)."],
  ],
  formSteps: [
    { title: "Choose BigQuery", text: "Open the launcher and pick the BigQuery card." },
    { title: "Add the service account", text: "Paste or select the service-account key (JSON); it is saved to the OS keyring." },
    { title: "Enter the project ID", text: "Use the Google Cloud project that owns the data." },
    { title: "Choose a dataset and location (optional)", text: "Set the dataset to browse and its region." },
    { title: "Save and connect", text: "Save the profile so it reappears in the launcher, then connect." },
  ],
  verifyCode: "SELECT CURRENT_TIMESTAMP();\nSELECT SESSION_USER();",
  troubleshootRows: [
    ["Invalid credentials / permission denied", "The service account lacks access, or the key is wrong.", "Grant BigQuery roles to the service account and re-check the key."],
    ["Project not found", "Wrong project ID.", "Re-check the project ID in the Google Cloud console."],
    ["Dataset not found", "The dataset does not exist in the project or location.", "Re-check the dataset name and its location."],
    ["Not found: location", "Wrong dataset region.", "Set the Location to match the dataset's region."],
  ],
};

const EN_SQLITE: EngineSpec = {
  slug: "sqlite",
  icon: "PlugZap",
  title: "SQLite",
  description: "Open or create a SQLite database file in TableR — no server, host, or credentials — with local bootstrap and troubleshooting.",
  intro: "SQLite is embedded and file-based, so there is no server to run. Point TableR at an existing database file, or let it create a new one locally.",
  overviewText: "TableR opens a SQLite database directly from a file on disk. There is no host, port, or credential — the file is the database. This makes SQLite ideal for local development, prototypes, and inspecting shipped .sqlite/.db files.",
  overviewBullets: [
    "File-based — open a .sqlite or .db file; there is no server.",
    "No credentials — access is controlled by file permissions on disk.",
    "Local bootstrap — TableR can create a new empty database file for you.",
  ],
  beforeYouStart: [
    "The path to a .sqlite or .db file, or a folder where you want to create one.",
    "Read/write permission on the file if you plan to modify it.",
  ],
  connFieldsIntro: "SQLite needs only a database file — there is no host, port, or credential to enter.",
  fieldRows: [
    ["Database file", "Yes", "—", "Path to an existing .sqlite/.db file, or a new file to create."],
    ["Host / Port", "No", "—", "Not used; SQLite has no server."],
    ["Credentials", "No", "—", "Not used; access is by file permissions."],
  ],
  formSteps: [
    { title: "Choose SQLite", text: "Open the launcher and pick the SQLite card." },
    { title: "Select a database file", text: "Browse to an existing .sqlite or .db file." },
    { title: "Or create a new file", text: "Choose a location and name to start an empty database." },
    { title: "Save and connect", text: "Save the profile so it reappears in the launcher, then connect." },
  ],
  bootstrap: {
    noServerText: "SQLite has no server. Choose SQLite in the launcher and either pick an existing file or create a new local database file to start immediately.",
    intro: "Local bootstrap for SQLite simply creates a new database file on your machine — no install or server required.",
    steps: [
      { title: "Select SQLite", text: "Pick SQLite in the launcher." },
      { title: "Create a new database file", text: "Choose a folder and file name; TableR creates an empty SQLite database." },
      { title: "Start querying", text: "A connection opens on the new file; create a table and insert rows." },
    ],
    skipSecretsCallout: true,
  },
  verifyCode: "SELECT sqlite_version();\nSELECT name FROM sqlite_master WHERE type = 'table';",
  verifyTrail: "The first statement returns the SQLite version; the second lists tables (empty on a new database).",
  troubleshootRows: [
    ["Unable to open database file", "Wrong path, or no permission to the file/folder.", "Re-check the path and file permissions; pick a folder you can write to."],
    ["File is not a database", "The file is not a valid SQLite database.", "Open a real .sqlite/.db file, or create a new one."],
    ["Attempt to write a readonly database", "The file or folder is read-only.", "Grant write permission, or copy the file somewhere writable."],
    ["Database is locked", "Another process is writing to the file.", "Close other tools using the file and retry."],
  ],
};

const EN_DUCKDB: EngineSpec = {
  slug: "duckdb",
  icon: "PlugZap",
  title: "DuckDB",
  description: "Open or create a DuckDB database file in TableR — an embedded analytical database with read/write or read-only mode — and troubleshooting.",
  intro: "DuckDB is an embedded analytical database that lives in a single file. Point TableR at a .duckdb file, or create a new one, and choose whether to open it read/write or read-only.",
  overviewText: "TableR opens DuckDB directly from a file on disk — there is no server, host, port, or credential. DuckDB's columnar engine is built for fast analytics over local files.",
  overviewBullets: [
    "File-based — open or create a single .duckdb file; there is no server.",
    "Open mode — read_write to modify, or read_only to inspect a file safely.",
    "No credentials — access is controlled by file permissions on disk.",
  ],
  beforeYouStart: [
    "The path to a .duckdb file, or a folder where you want to create one.",
    "Read/write permission if you plan to modify the database.",
    "Decide whether to open it read/write or read-only.",
  ],
  connFieldsIntro: "DuckDB needs only a database file and an open mode — there is no host, port, or credential.",
  fieldRows: [
    ["Database file", "Yes", "—", "Path to an existing .duckdb file, or a new file to create."],
    ["Open mode", "No", "read_write", "read_write to modify, or read_only to inspect safely."],
    ["Host / Port", "No", "—", "Not used; DuckDB has no server."],
    ["Credentials", "No", "—", "Not used; access is by file permissions."],
  ],
  formSteps: [
    { title: "Choose DuckDB", text: "Open the launcher and pick the DuckDB card." },
    { title: "Select or create a file", text: "Browse to a .duckdb file, or choose a location to create a new one." },
    { title: "Choose the open mode", text: "Pick read_write to modify, or read_only to inspect without changes." },
    { title: "Save and connect", text: "Save the profile so it reappears in the launcher, then connect." },
  ],
  verifyCode: "SELECT version();\nSHOW TABLES;",
  verifyTrail: "The first statement returns the DuckDB version; SHOW TABLES lists tables (empty on a new database).",
  troubleshootRows: [
    ["Unable to open database file", "Wrong path, or no permission to the file/folder.", "Re-check the path and permissions; pick a writable location."],
    ["File is not a valid DuckDB database", "The file was not created by DuckDB, or is a different version.", "Open a real .duckdb file, or create a new one."],
    ["Cannot write in read_only mode", "The database was opened read-only.", "Reopen with read_write to make changes."],
    ["File is being used by another process", "Another process holds the file open.", "Close other tools using the file and retry."],
  ],
};

const EN_CASSANDRA: EngineSpec = {
  slug: "cassandra",
  icon: "PlugZap",
  title: "Cassandra",
  description: "Connect TableR to Apache Cassandra over CQL with contact points, keyspace, optional authentication and SSL/TLS, verifying the connection, and troubleshooting.",
  intro: "Cassandra is a wide-column store reached over CQL. Point TableR at one or more contact points and, if the cluster requires it, add credentials.",
  overviewText: "TableR connects to a Cassandra cluster using the CQL native protocol (default port 9042). You can give one or more contact points; the driver discovers the rest of the cluster. A keyspace scopes the tables you browse.",
  overviewBullets: [
    "Cluster — connect to one or more contact points on port 9042.",
    "Auth — a cluster username is required; a password when the cluster enforces it.",
    "Keyspace — optional scope for the tables you browse (the Database field).",
  ],
  beforeYouStart: [
    "One or more reachable contact points (host and port).",
    "A cluster username — this is required.",
    "The user's password, if the cluster enforces authentication.",
    "Optionally, a keyspace and the local datacenter name.",
    "For remote clusters: network access to the port and, usually, SSL/TLS.",
  ],
  connFieldsIntro: "These defaults match TableR's Cassandra connection form. Secrets are written to the operating system keyring, never to plain configuration files.",
  fieldRows: [
    ["Host", "Yes", "127.0.0.1", "One or more contact points (comma-separated)."],
    ["Port", "Yes", "9042", "The CQL native protocol port."],
    ["Username", "Yes", "—", "The cluster user used to authenticate."],
    ["Password", "No", "—", "Optional; required when the cluster enforces auth. Stored in the OS keyring."],
    ["Keyspace", "No", "—", "Optional (the Database field); scopes browsing to one keyspace."],
    ["Datacenter", "No", "—", "Optional local datacenter name for routing."],
    ["SSL/TLS", "No", "Off", "Enable for remote clusters."],
  ],
  formSteps: [
    { title: "Choose Cassandra", text: "Open the launcher and pick the Cassandra card." },
    { title: "Enter contact points and port", text: "Use 127.0.0.1 and 9042 locally, or your cluster's hosts." },
    { title: "Add credentials", text: "Type the username, and the password if the cluster requires it." },
    { title: "Set a keyspace (optional)", text: "Use the Database field to scope browsing to one keyspace." },
    { title: "Set the datacenter (optional)", text: "Provide the local datacenter name for routing." },
    { title: "Enable SSL/TLS for remote", text: "Turn on SSL/TLS when connecting to a remote cluster." },
    { title: "Save and connect", text: "Save the profile so it reappears in the launcher, then connect." },
  ],
  sslIntro: "Local clusters usually need no encryption. For a remote cluster, enable SSL/TLS so credentials and data are protected in transit.",
  sslBullets: [
    "Off — no encryption (local or trusted networks only).",
    "On — encrypt the connection to the cluster.",
    "Enable it for any remote or managed cluster.",
  ],
  verifyLead: "Once connected, open a query tab and run CQL against the system keyspace:",
  verifyCode: "SELECT release_version FROM system.local;\nSELECT cluster_name FROM system.local;",
  verifyTrail: "If both statements return a row, the connection and credentials are working.",
  troubleshootRows: [
    ["All host(s) tried for query failed", "No reachable contact point, wrong port, or a firewall.", "Confirm at least one contact point is up and 9042 is reachable."],
    ["Authentication error", "Wrong username or password.", "Re-check the credentials and update the saved password (it lives in the keyring)."],
    ["Keyspace does not exist", "The Keyspace field names a missing keyspace.", "Leave Keyspace empty, or enter one that exists."],
    ["No host available in datacenter", "Wrong local datacenter name.", "Re-check the Datacenter value, or leave it blank."],
  ],
};

const EN_REDIS: EngineSpec = {
  slug: "redis",
  icon: "PlugZap",
  title: "Redis",
  description: "Connect TableR to Redis, an in-memory key-value store, with host, port, ACL user, database index, optional TLS, verifying the connection, and troubleshooting.",
  intro: "Redis is an in-memory key-value store. Point TableR at your Redis host and, if needed, add an ACL user, password, and database index.",
  overviewText: "TableR connects to a Redis server on port 6379 by default. Authentication is optional: older servers may need only a password, while Redis 6+ supports ACL users. A logical database index selects which numbered database you work in.",
  overviewBullets: [
    "In-memory — connect to your Redis host on port 6379.",
    "Auth — an optional password, plus an ACL username on Redis 6+.",
    "Database index — a logical database number, usually 0.",
  ],
  beforeYouStart: [
    "A reachable Redis host (host and port).",
    "A password, if the server requires AUTH.",
    "An ACL username, if the server uses Redis 6+ ACLs.",
    "The database index you want to work in (usually 0).",
    "For remote servers: network access and, usually, TLS.",
  ],
  connFieldsIntro: "These defaults match TableR's Redis connection form. Secrets are written to the operating system keyring, never to plain configuration files.",
  fieldRows: [
    ["Host", "Yes", "127.0.0.1", "Hostname or IP of your Redis server."],
    ["Port", "Yes", "6379", "Redis's default port."],
    ["Username", "No", "—", "Optional; a Redis 6+ ACL user."],
    ["Password", "No", "—", "Optional; stored in the OS keyring."],
    ["Database index", "No", "0", "The logical database number to select."],
    ["SSL/TLS", "No", "Off", "Enable for remote servers that require TLS."],
  ],
  formSteps: [
    { title: "Choose Redis", text: "Open the launcher and pick the Redis card." },
    { title: "Enter host and port", text: "Use 127.0.0.1 and 6379 locally, or your server's endpoint." },
    { title: "Add credentials (optional)", text: "Add a password, and an ACL username on Redis 6+." },
    { title: "Set the database index", text: "Usually 0; change it to work in another logical database." },
    { title: "Enable TLS for remote", text: "Turn on SSL/TLS when the remote server requires it." },
    { title: "Save and connect", text: "Save the profile so it reappears in the launcher, then connect." },
  ],
  sslIntro: "Local servers usually need no encryption. For a remote server that supports it, enable SSL/TLS so the connection and credentials are protected in transit.",
  sslBullets: [
    "Off — no encryption (local or trusted networks only).",
    "On — TLS to the Redis server.",
    "Enable it for any remote or managed server.",
  ],
  verifyLead: "Once connected, open a query tab and run a couple of Redis commands:",
  verifyLang: "text",
  verifyCode: "PING\nINFO server",
  verifyTrail: "PING should return PONG, and INFO server prints the server version and details.",
  troubleshootRows: [
    ["Connection refused", "Server not running, wrong host/port, or a firewall.", "Confirm the server is up and 6379 is reachable; re-check host and port."],
    ["NOAUTH Authentication required", "The server requires a password.", "Add the password; it is saved to the keyring."],
    ["WRONGPASS invalid username-password", "Wrong ACL username or password.", "Re-check the credentials (Redis 6+ ACL) and update the saved password."],
    ["Connection reset / TLS required", "The server expects a TLS connection.", "Enable SSL/TLS for the connection."],
  ],
};

const EN_MONGODB: EngineSpec = {
  slug: "mongodb",
  icon: "PlugZap",
  title: "MongoDB",
  description: "Connect TableR to MongoDB — Atlas SRV or a direct host — with connection discovery, auth source, replica set, SSL/TLS, connection strings, and troubleshooting.",
  intro: "MongoDB is a document database. TableR connects to a standalone server, a replica set, or Atlas; use the form fields or paste a MongoDB connection string.",
  overviewText: "TableR speaks the MongoDB wire protocol. Connection discovery can auto-detect the topology, use an SRV record (typical for Atlas), or connect directly to a host and port. Authentication is optional and can target a specific auth database.",
  overviewBullets: [
    "Standalone / replica set — connect on port 27017, optionally naming the replica set.",
    "Atlas — use an SRV connection (mongodb+srv) or paste the Atlas URI.",
    "Direct — connect to one host:port; use it for PrivateLink (pl-*.mongodb.net) or self-hosted servers.",
  ],
  beforeYouStart: [
    "A reachable MongoDB host, or an Atlas hostname / SRV URI.",
    "A username and password, if the deployment requires auth.",
    "The auth source database, if it is not admin.",
    "The replica set name, for a replica-set deployment.",
    "For Atlas / remote: network access and SSL/TLS.",
  ],
  connFieldsIntro: "These defaults match TableR's MongoDB connection form. Secrets are written to the operating system keyring, never to plain configuration files.",
  fieldRows: [
    ["Host", "Yes", "127.0.0.1", "Hostname, or an Atlas hostname."],
    ["Port", "Yes", "27017", "MongoDB's default port (ignored for SRV)."],
    ["Connection discovery", "No", "Auto-detect", "Auto-detect, SRV (Atlas), or Direct (host:port)."],
    ["Username", "No", "—", "Optional; required when the deployment enforces auth."],
    ["Password", "No", "—", "Optional; stored in the OS keyring."],
    ["Database", "No", "—", "Optional default database."],
    ["Auth source", "No", "admin", "The database that holds the user's credentials."],
    ["Replica set", "No", "—", "Optional; the replica-set name."],
    ["SSL/TLS", "No", "Off", "Supported; required by Atlas and most remote servers."],
  ],
  formSteps: [
    { title: "Choose MongoDB", text: "Open the launcher and pick the MongoDB card." },
    { title: "Pick connection discovery", text: "Auto-detect, SRV (Atlas), or Direct. Use Direct for PrivateLink (pl-*.mongodb.net) or self-hosted servers." },
    { title: "Enter host and port", text: "Use 127.0.0.1 and 27017 locally, or the Atlas hostname." },
    { title: "Add credentials (optional)", text: "Add username/password and the auth source when the deployment requires auth." },
    { title: "Set database / replica set (optional)", text: "Provide a default database and, for replica sets, the set name." },
    { title: "Enable SSL/TLS for Atlas / remote", text: "Turn on SSL/TLS for Atlas or any remote deployment." },
    { title: "Save and connect", text: "Save the profile so it reappears in the launcher, then connect." },
  ],
  connString: {
    intro: "Instead of filling every field, you can paste a MongoDB connection string. Both mongodb:// and mongodb+srv:// (Atlas) schemes are accepted.",
    code: "mongodb+srv://username:password@cluster.mongodb.net/?retryWrites=true&w=majority",
    bullets: [
      "Use mongodb+srv:// for Atlas, or mongodb://host:27017 for a direct or self-hosted server.",
      "Omit the password from the URI and let TableR store it in the keyring instead.",
      "Add authSource=admin (or your auth database) when the user lives outside the target database.",
      "URL-encode special characters in the password (for example @ becomes %40).",
    ],
  },
  sslIntro: "Local servers usually need no encryption. Atlas and most remote deployments require TLS — enable SSL/TLS, or include tls=true in the connection string.",
  sslBullets: [
    "Off — no encryption (local or trusted networks only).",
    "On — TLS to the server (required by Atlas).",
    "SRV / Atlas connections use TLS by default.",
  ],
  verifyLead: "Once connected, open a query tab and run a couple of MongoDB commands:",
  verifyLang: "javascript",
  verifyCode: "db.runCommand({ ping: 1 })\ndb.version()",
  verifyTrail: "ping should return { ok: 1 }, and db.version() prints the server version.",
  troubleshootRows: [
    ["Connection refused / timed out", "Server not running, wrong host/port, or a firewall.", "Confirm the server is reachable; for Atlas, allow your IP in the access list."],
    ["Authentication failed", "Wrong credentials, or wrong auth source.", "Re-check username/password and set the correct Auth source (often admin)."],
    ["DNS / SRV lookup failed", "Wrong SRV hostname or no DNS access.", "Re-check the Atlas hostname, or switch discovery to Direct."],
    ["TLS required", "Atlas or the server requires TLS.", "Enable SSL/TLS, or add tls=true to the connection string."],
  ],
};

const EN_LIBSQL: EngineSpec = {
  slug: "libsql",
  icon: "PlugZap",
  title: "LibSQL",
  description: "Connect TableR to libSQL and remote Turso databases with a URL and auth token, connection fields, verifying the connection, and troubleshooting.",
  intro: "libSQL is SQLite-compatible and can run locally or as a remote Turso database. Point TableR at a libSQL URL and, for remote databases, add an auth token.",
  overviewText: "TableR connects to libSQL over its URL. A remote Turso database is reached at your-db.turso.io and authenticated with a token; a local libSQL server uses a local URL. Because libSQL is SQLite-compatible, the SQL you already know applies.",
  overviewBullets: [
    "Remote Turso — connect to your-db.turso.io with an auth token.",
    "Local libSQL — connect to a local libSQL URL.",
    "SQLite-compatible — the same SQL dialect and functions as SQLite.",
  ],
  beforeYouStart: [
    "A libSQL URL — your-db.turso.io for Turso, or a local libSQL URL.",
    "An auth token, for a remote / Turso database.",
    "The port, if your local server does not use 8080.",
  ],
  connFieldsIntro: "These defaults match TableR's libSQL connection form. The auth token is stored in the operating system keyring, never in plain configuration files.",
  fieldRows: [
    ["Host", "Yes", "—", "your-db.turso.io, or a local libSQL URL."],
    ["Port", "No", "8080", "Used by local libSQL servers."],
    ["Credential", "No", "—", "An auth token for remote / Turso databases; stored in the OS keyring."],
    ["Database", "No", "—", "Optional."],
  ],
  formSteps: [
    { title: "Choose LibSQL", text: "Open the launcher and pick the LibSQL card." },
    { title: "Enter the libSQL URL", text: "Use your-db.turso.io for Turso, or your local libSQL URL." },
    { title: "Add the auth token", text: "Required for remote / Turso databases; saved to the OS keyring." },
    { title: "Set the port (local)", text: "Local servers use 8080 by default." },
    { title: "Save and connect", text: "Save the profile so it reappears in the launcher, then connect." },
  ],
  connString: {
    intro: "You can also connect with a libSQL URL. Remote Turso databases use the libsql:// scheme with an auth token.",
    code: "libsql://your-db.turso.io?authToken=YOUR_TOKEN",
    bullets: [
      "Use libsql:// for remote Turso databases.",
      "Prefer storing the token in the keyring over embedding it in the URL.",
      "For a local server, use its libSQL or http(s) URL.",
    ],
  },
  verifyCode: "SELECT sqlite_version();\nSELECT name FROM sqlite_master WHERE type = 'table';",
  verifyTrail: "The first statement returns the SQLite-compatible version; the second lists tables.",
  troubleshootRows: [
    ["Could not connect to URL", "Wrong libSQL URL or no network access.", "Re-check the URL (your-db.turso.io) and your connection."],
    ["Unauthorized / invalid token", "Missing or wrong auth token.", "Add a valid auth token; it is saved to the keyring."],
    ["Token expired", "The Turso token is no longer valid.", "Generate a new token and update the saved credential."],
    ["Connection refused (local)", "Local libSQL server not running, or wrong port.", "Start the server and confirm the port (default 8080)."],
  ],
};

const EN_CLOUDFLARE_D1: EngineSpec = {
  slug: "cloudflare-d1",
  icon: "PlugZap",
  title: "Cloudflare D1",
  description: "Connect TableR to Cloudflare D1, serverless SQLite, with an account ID, database ID, and API token, verifying the connection, and troubleshooting.",
  intro: "Cloudflare D1 is serverless SQLite reached through the Cloudflare API. Provide your account ID, the target database ID, and an API token with D1 access.",
  overviewText: "TableR reaches D1 through the Cloudflare API over HTTPS — there is no host or port to run. You authenticate with an API token and identify the database by account ID and database ID. D1 is SQLite under the hood, so the SQL you know applies.",
  overviewBullets: [
    "Serverless — reached at api.cloudflare.com over HTTPS; no server to run.",
    "Authentication — a Cloudflare API token with D1 access.",
    "Identity — an account ID and a database ID select the target D1 database.",
  ],
  beforeYouStart: [
    "Your Cloudflare account ID.",
    "The database ID of the target D1 database.",
    "An API token with D1 read/write access.",
  ],
  connFieldsIntro: "These fields match TableR's Cloudflare D1 connection form. The API token is stored in the operating system keyring, never in plain configuration files.",
  fieldRows: [
    ["Host", "Yes", "api.cloudflare.com", "HTTPS endpoint; the connection is always encrypted."],
    ["Credential", "Yes", "—", "A Cloudflare API token with D1 access; stored in the OS keyring."],
    ["Account ID", "Yes", "—", "Your Cloudflare account."],
    ["Database ID", "Yes", "—", "The target D1 database."],
  ],
  formSteps: [
    { title: "Choose Cloudflare D1", text: "Open the launcher and pick the Cloudflare D1 card." },
    { title: "Add the API token", text: "Paste a token with D1 access; it is saved to the OS keyring." },
    { title: "Enter the account ID", text: "Use your Cloudflare account ID." },
    { title: "Enter the database ID", text: "Identify the target D1 database." },
    { title: "Save and connect", text: "Save the profile so it reappears in the launcher, then connect." },
  ],
  verifyCode: "SELECT sqlite_version();\nSELECT name FROM sqlite_master WHERE type = 'table';",
  verifyTrail: "The first statement returns the SQLite version D1 runs; the second lists tables.",
  troubleshootRows: [
    ["Authentication error (403)", "Missing or wrong API token, or insufficient scope.", "Use a token with D1 access and re-check it; it is saved to the keyring."],
    ["Account not found", "Wrong account ID.", "Re-check the account ID in the Cloudflare dashboard."],
    ["Database not found", "Wrong database ID.", "Re-check the D1 database ID."],
    ["Rate limited (429)", "Too many API requests.", "Wait and retry; reduce the request frequency."],
  ],
};

const VI_POSTGRESQL: EngineSpec = {
  slug: "postgresql",
  icon: "PlugZap",
  title: "PostgreSQL",
  description: "Kết nối TableR tới bất kỳ server PostgreSQL nào — hoặc bootstrap ngay tại máy — kèm các trường kết nối, connection string, SSL/TLS và khắc phục sự cố.",
  intro: "PostgreSQL là engine SQL qua mạng. Trỏ TableR tới một server sẵn có bằng cách điền form kết nối, hoặc để TableR tự khởi tạo một PostgreSQL local qua bootstrap tích hợp khi bạn chưa có server.",
  overviewText: "TableR dùng giao thức wire gốc của PostgreSQL, nên hoạt động với bản cài local, container, dịch vụ quản lý (RDS, Cloud SQL, Azure Database, Supabase, Neon và tương tự), hay một server local đã bootstrap. Vì tất cả đều là PostgreSQL nên các trường kết nối bên dưới áp dụng cho mọi trường hợp; chỉ giá trị thay đổi.",
  overviewBullets: [
    "Phát triển local — kết nối tới 127.0.0.1:5432, hoặc bootstrap một server local.",
    "Remote / managed — dùng endpoint của nhà cung cấp và bật SSL/TLS.",
    "Engine tương thích PostgreSQL — CockroachDB, Greenplum và Amazon Redshift dùng cùng giao thức và các trường tương tự.",
  ],
  beforeYouStart: [
    "Một server PostgreSQL truy cập được (host và port), hoặc dùng Bootstrap local thay thế.",
    "Tên user (role) của database — bắt buộc.",
    "Mật khẩu của user, nếu server yêu cầu.",
    "Tùy chọn: database cụ thể muốn mở khi kết nối.",
    "Với server từ xa: cần truy cập mạng tới port và thường phải bật SSL/TLS.",
  ],
  connFieldsIntro: "Các mặc định dưới đây khớp với form kết nối PostgreSQL của TableR. Bí mật được ghi vào keyring của hệ điều hành, không bao giờ vào tệp cấu hình dạng văn bản.",
  fieldRows: [
    ["Host", "Có", "127.0.0.1", "Hostname hoặc IP của server. Dùng endpoint nhà cung cấp cho database quản lý."],
    ["Port", "Có", "5432", "Port mặc định của PostgreSQL. Chỉ đổi nếu server lắng nghe ở cổng khác."],
    ["Username", "Có", "—", "Role dùng để xác thực."],
    ["Password", "Không", "—", "Tùy chọn; lưu trong keyring. Để trống nếu dùng trust/peer auth."],
    ["Database", "Không", "—", "Tùy chọn. Để trống thì PostgreSQL dùng database mặc định của role."],
    ["SSL/TLS", "Không", "Tắt", "Bật cho server từ xa; nhiều nhà cung cấp quản lý bắt buộc."],
  ],
  formSteps: [
    { title: "Chọn PostgreSQL", text: "Mở trình khởi chạy và chọn thẻ PostgreSQL." },
    { title: "Nhập host và port", text: "Dùng 127.0.0.1 và 5432 cho server local, hoặc endpoint của nhà cung cấp cho server từ xa." },
    { title: "Thêm credential", text: "Nhập username, và password nếu cần. Password được lưu vào keyring." },
    { title: "Chọn database (tùy chọn)", text: "Đặt một database để mở trực tiếp, hoặc để trống để dùng mặc định của role." },
    { title: "Bật SSL/TLS cho remote", text: "Bật SSL/TLS khi kết nối tới server từ xa hoặc quản lý." },
    { title: "Lưu và kết nối", text: "Lưu profile để nó xuất hiện lại trong trình khởi chạy, rồi kết nối." },
  ],
  connString: {
    intro: "Thay vì điền từng trường, bạn có thể dán một URI kết nối PostgreSQL. Chấp nhận cả scheme postgres:// và postgresql://.",
    code: "postgresql://username:password@host:5432/database?sslmode=require",
    bullets: [
      "Bỏ password khỏi URI và để TableR lưu vào keyring.",
      "Thêm sslmode=require (hoặc verify-full) cho server từ xa.",
      "URL-encode ký tự đặc biệt trong password (ví dụ @ thành %40).",
    ],
  },
  bootstrap: {
    noServerText: "Bạn không cần cài PostgreSQL để dùng thử. Chọn PostgreSQL trong trình khởi chạy và dùng Bootstrap local — TableR tạo và khởi động một server local, giữ bí mật trong keyring của hệ điều hành.",
    intro: "Nếu chưa có server, TableR có thể khởi tạo một PostgreSQL local cho bạn — không cần cài riêng.",
    steps: [
      { title: "Chọn PostgreSQL", text: "Chọn PostgreSQL trong trình khởi chạy." },
      { title: "Chọn Bootstrap local", text: "TableR cấp phát và khởi động một server local trên máy bạn." },
      { title: "Bắt đầu truy vấn", text: "Một kết nối được tạo sẵn; mở tab SQL và chạy truy vấn." },
    ],
  },
  sslIntro: "Server local trên 127.0.0.1 thường không cần mã hóa. Với bất cứ kết nối qua mạng nào, hãy bật SSL/TLS. Nếu dùng URI, điều khiển hành vi bằng tham số sslmode.",
  sslBullets: [
    "disable — không mã hóa (chỉ dùng local).",
    "require — mã hóa nhưng không xác minh chứng chỉ server.",
    "verify-ca / verify-full — mã hóa và xác minh chứng chỉ (an toàn nhất).",
  ],
  verifyCode: "SELECT version();\nSELECT current_database(), current_user;",
  troubleshootRows: [
    ["Connection refused", "Server chưa chạy, sai host/port, hoặc firewall.", "Xác nhận server đang chạy và port truy cập được; kiểm tra lại host và port."],
    ["password authentication failed", "Sai username hoặc password.", "Kiểm tra lại credential và cập nhật password đã lưu (nằm trong keyring)."],
    ["Yêu cầu SSL / mã hóa", "Server bắt buộc TLS.", "Bật SSL/TLS, hoặc thêm sslmode=require vào connection string."],
    ["database 'name' does not exist", "Trường Database trỏ tới database không tồn tại.", "Để trống Database, hoặc nhập một database có thật."],
    ["too many clients already", "Server đã đạt giới hạn kết nối.", "Đóng các kết nối rảnh, hoặc tăng max_connections trên server."],
  ],
};

const VI_MYSQL: EngineSpec = {
  slug: "mysql",
  icon: "PlugZap",
  title: "MySQL",
  description: "Kết nối TableR tới bất kỳ server MySQL nào — hoặc bootstrap ngay tại máy — kèm các trường kết nối, connection string, SSL/TLS và khắc phục sự cố.",
  intro: "MySQL là engine SQL qua mạng và là engine TableR chọn mặc định khi tạo kết nối mới. Trỏ TableR tới một server sẵn có bằng cách điền form kết nối, hoặc để TableR tự khởi tạo một MySQL local qua bootstrap tích hợp khi bạn chưa có server.",
  overviewText: "TableR dùng giao thức wire gốc của MySQL, nên hoạt động với bản cài local, container, dịch vụ quản lý (RDS, Cloud SQL, Azure Database for MySQL, PlanetScale và tương tự), hay một server local đã bootstrap. Vì tất cả đều là MySQL nên các trường kết nối bên dưới áp dụng cho mọi trường hợp; chỉ giá trị thay đổi.",
  overviewBullets: [
    "Phát triển local — kết nối tới 127.0.0.1:3306, hoặc bootstrap một server local.",
    "Remote / managed — dùng endpoint của nhà cung cấp và bật SSL/TLS.",
    "Engine tương thích MySQL — MariaDB dùng cùng giao thức wire và các trường giống hệt.",
  ],
  beforeYouStart: [
    "Một server MySQL truy cập được (host và port), hoặc dùng Bootstrap local thay thế.",
    "Tên user của database — bắt buộc.",
    "Mật khẩu của user, nếu server yêu cầu.",
    "Tùy chọn: database (schema) cụ thể muốn mở khi kết nối.",
    "Với server từ xa: cần truy cập mạng tới port và thường phải bật SSL/TLS.",
  ],
  connFieldsIntro: "Các mặc định dưới đây khớp với form kết nối MySQL của TableR. Bí mật được ghi vào keyring của hệ điều hành, không bao giờ vào tệp cấu hình dạng văn bản.",
  fieldRows: [
    ["Host", "Có", "127.0.0.1", "Hostname hoặc IP của server. Dùng endpoint nhà cung cấp cho database quản lý."],
    ["Port", "Có", "3306", "Port mặc định của MySQL. Chỉ đổi nếu server lắng nghe ở cổng khác."],
    ["Username", "Có", "—", "User dùng để xác thực."],
    ["Password", "Không", "—", "Tùy chọn; lưu trong keyring. Để trống nếu dùng socket/không mật khẩu."],
    ["Database", "Không", "—", "Tùy chọn. Để trống thì chưa chọn schema nào cho tới khi bạn chọn."],
    ["SSL/TLS", "Không", "Tắt", "Bật cho server từ xa; nhiều nhà cung cấp quản lý bắt buộc."],
  ],
  formSteps: [
    { title: "Chọn MySQL", text: "Mở trình khởi chạy và chọn thẻ MySQL — đây là lựa chọn mặc định." },
    { title: "Nhập host và port", text: "Dùng 127.0.0.1 và 3306 cho server local, hoặc endpoint của nhà cung cấp cho server từ xa." },
    { title: "Thêm credential", text: "Nhập username, và password nếu cần. Password được lưu vào keyring." },
    { title: "Chọn database (tùy chọn)", text: "Đặt một database để mở trực tiếp, hoặc để trống rồi chọn sau khi kết nối." },
    { title: "Bật SSL/TLS cho remote", text: "Bật SSL/TLS khi kết nối tới server từ xa hoặc quản lý." },
    { title: "Lưu và kết nối", text: "Lưu profile để nó xuất hiện lại trong trình khởi chạy, rồi kết nối." },
  ],
  connString: {
    intro: "Thay vì điền từng trường, bạn có thể dán một URI kết nối MySQL.",
    code: "mysql://username:password@host:3306/database?ssl-mode=REQUIRED",
    bullets: [
      "Bỏ password khỏi URI và để TableR lưu vào keyring.",
      "Thêm ssl-mode=REQUIRED (hoặc VERIFY_IDENTITY) cho server từ xa.",
      "URL-encode ký tự đặc biệt trong password (ví dụ @ thành %40).",
    ],
  },
  bootstrap: {
    noServerText: "Bạn không cần cài MySQL để dùng thử. Chọn MySQL trong trình khởi chạy và dùng Bootstrap local — TableR tạo và khởi động một server local, giữ bí mật trong keyring của hệ điều hành.",
    intro: "Nếu chưa có server, TableR có thể khởi tạo một MySQL local cho bạn — không cần cài riêng.",
    steps: [
      { title: "Chọn MySQL", text: "Chọn MySQL trong trình khởi chạy." },
      { title: "Chọn Bootstrap local", text: "TableR cấp phát và khởi động một server local trên máy bạn." },
      { title: "Bắt đầu truy vấn", text: "Một kết nối được tạo sẵn; mở tab SQL và chạy truy vấn." },
    ],
  },
  sslIntro: "Server local trên 127.0.0.1 thường không cần mã hóa. Với bất cứ kết nối qua mạng nào, hãy bật SSL/TLS. Nếu dùng URI, điều khiển hành vi bằng tham số ssl-mode.",
  sslBullets: [
    "DISABLED — không mã hóa (chỉ dùng local).",
    "REQUIRED — mã hóa nhưng không xác minh chứng chỉ server.",
    "VERIFY_CA / VERIFY_IDENTITY — mã hóa và xác minh chứng chỉ (an toàn nhất).",
  ],
  verifyCode: "SELECT VERSION();\nSELECT DATABASE(), CURRENT_USER();",
  troubleshootRows: [
    ["Can't connect to MySQL server", "Server chưa chạy, sai host/port, hoặc firewall.", "Xác nhận server đang chạy và port truy cập được; kiểm tra lại host và port."],
    ["Access denied for user", "Sai username hoặc password, hoặc user không có quyền theo host.", "Kiểm tra lại credential và cập nhật password đã lưu (nằm trong keyring)."],
    ["SSL connection error", "Server bắt buộc TLS, hoặc chứng chỉ không được tin cậy.", "Bật SSL/TLS, hoặc thêm ssl-mode=REQUIRED vào connection string."],
    ["Unknown database 'name'", "Trường Database trỏ tới schema không tồn tại.", "Để trống Database, hoặc nhập một database có thật."],
    ["Too many connections", "Server đã đạt giới hạn kết nối.", "Đóng các kết nối rảnh, hoặc tăng max_connections trên server."],
  ],
};

const VI_MARIADB: EngineSpec = {
  slug: "mariadb",
  icon: "PlugZap",
  title: "MariaDB",
  description: "Kết nối TableR tới bất kỳ server MariaDB nào — hoặc bootstrap ngay tại máy. MariaDB dùng giao thức wire của MySQL nên các trường, connection string và cách hoạt động đều giống MySQL.",
  intro: "MariaDB là engine SQL qua mạng dùng giao thức wire của MySQL, nên TableR kết nối y hệt MySQL. Trỏ TableR tới một server sẵn có bằng cách điền form kết nối, hoặc để TableR tự khởi tạo một MariaDB local qua bootstrap tích hợp khi bạn chưa có server.",
  overviewText: "Vì MariaDB dùng giao thức wire của MySQL nên áp dụng cùng các trường kết nối và connection string như MySQL. Nó hoạt động với bản cài local, container, dịch vụ quản lý (SkySQL, Amazon RDS và tương tự), hay một server local đã bootstrap.",
  overviewBullets: [
    "Phát triển local — kết nối tới 127.0.0.1:3306, hoặc bootstrap một server local.",
    "Remote / managed — dùng endpoint của nhà cung cấp và bật SSL/TLS.",
    "Tương thích MySQL — các trường, connection string và cách hoạt động giống MySQL; xem hướng dẫn MySQL cho phần chưa đề cập ở đây.",
  ],
  beforeYouStart: [
    "Một server MariaDB truy cập được (host và port), hoặc dùng Bootstrap local thay thế.",
    "Tên user của database — bắt buộc.",
    "Mật khẩu của user, nếu server yêu cầu.",
    "Tùy chọn: database (schema) cụ thể muốn mở khi kết nối.",
    "Với server từ xa: cần truy cập mạng tới port và thường phải bật SSL/TLS.",
  ],
  connFieldsIntro: "Các mặc định dưới đây khớp với form kết nối MariaDB của TableR, vốn giống hệt MySQL. Bí mật được ghi vào keyring của hệ điều hành, không bao giờ vào tệp cấu hình dạng văn bản.",
  fieldRows: [
    ["Host", "Có", "127.0.0.1", "Hostname hoặc IP của server. Dùng endpoint nhà cung cấp cho database quản lý."],
    ["Port", "Có", "3306", "MariaDB và MySQL dùng chung port 3306. Chỉ đổi nếu server lắng nghe ở cổng khác."],
    ["Username", "Có", "—", "User dùng để xác thực."],
    ["Password", "Không", "—", "Tùy chọn; lưu trong keyring. Để trống nếu dùng socket/không mật khẩu."],
    ["Database", "Không", "—", "Tùy chọn. Để trống thì chưa chọn schema nào cho tới khi bạn chọn."],
    ["SSL/TLS", "Không", "Tắt", "Bật cho server từ xa; nhiều nhà cung cấp quản lý bắt buộc."],
  ],
  formSteps: [
    { title: "Chọn MariaDB", text: "Mở trình khởi chạy và chọn thẻ MariaDB." },
    { title: "Nhập host và port", text: "Dùng 127.0.0.1 và 3306 cho server local, hoặc endpoint của nhà cung cấp cho server từ xa." },
    { title: "Thêm credential", text: "Nhập username, và password nếu cần. Password được lưu vào keyring." },
    { title: "Chọn database (tùy chọn)", text: "Đặt một database để mở trực tiếp, hoặc để trống rồi chọn sau khi kết nối." },
    { title: "Bật SSL/TLS cho remote", text: "Bật SSL/TLS khi kết nối tới server từ xa hoặc quản lý." },
    { title: "Lưu và kết nối", text: "Lưu profile để nó xuất hiện lại trong trình khởi chạy, rồi kết nối." },
  ],
  connString: {
    intro: "MariaDB dùng định dạng URI kết nối của MySQL, nên bạn có thể dán một connection string kiểu MySQL.",
    code: "mysql://username:password@host:3306/database?ssl-mode=REQUIRED",
    bullets: [
      "Bỏ password khỏi URI và để TableR lưu vào keyring.",
      "Thêm ssl-mode=REQUIRED (hoặc VERIFY_IDENTITY) cho server từ xa.",
      "URL-encode ký tự đặc biệt trong password (ví dụ @ thành %40).",
    ],
  },
  bootstrap: {
    noServerText: "Bạn không cần cài MariaDB để dùng thử. Chọn MariaDB trong trình khởi chạy và dùng Bootstrap local — TableR tạo và khởi động một server local, giữ bí mật trong keyring của hệ điều hành.",
    intro: "Nếu chưa có server, TableR có thể khởi tạo một MariaDB local cho bạn — không cần cài riêng.",
    steps: [
      { title: "Chọn MariaDB", text: "Chọn MariaDB trong trình khởi chạy." },
      { title: "Chọn Bootstrap local", text: "TableR cấp phát và khởi động một server local trên máy bạn." },
      { title: "Bắt đầu truy vấn", text: "Một kết nối được tạo sẵn; mở tab SQL và chạy truy vấn." },
    ],
  },
  sslIntro: "Server local trên 127.0.0.1 thường không cần mã hóa. Với bất cứ kết nối qua mạng nào, hãy bật SSL/TLS. Nếu dùng URI, điều khiển hành vi bằng tham số ssl-mode.",
  sslBullets: [
    "DISABLED — không mã hóa (chỉ dùng local).",
    "REQUIRED — mã hóa nhưng không xác minh chứng chỉ server.",
    "VERIFY_CA / VERIFY_IDENTITY — mã hóa và xác minh chứng chỉ (an toàn nhất).",
  ],
  verifyCode: "SELECT VERSION();\nSELECT DATABASE(), CURRENT_USER();",
  troubleshootRows: [
    ["Can't connect to server", "Server chưa chạy, sai host/port, hoặc firewall.", "Xác nhận server đang chạy và port truy cập được; kiểm tra lại host và port."],
    ["Access denied for user", "Sai username hoặc password, hoặc user không có quyền theo host.", "Kiểm tra lại credential và cập nhật password đã lưu (nằm trong keyring)."],
    ["SSL connection error", "Server bắt buộc TLS, hoặc chứng chỉ không được tin cậy.", "Bật SSL/TLS, hoặc thêm ssl-mode=REQUIRED vào connection string."],
    ["Unknown database 'name'", "Trường Database trỏ tới schema không tồn tại.", "Để trống Database, hoặc nhập một database có thật."],
    ["Too many connections", "Server đã đạt giới hạn kết nối.", "Đóng các kết nối rảnh, hoặc tăng max_connections trên server."],
  ],
};

const VI_SQL_SERVER: EngineSpec = {
  slug: "sql-server",
  icon: "PlugZap",
  title: "SQL Server",
  description: "Kết nối TableR tới Microsoft SQL Server bằng xác thực Windows hoặc SQL — hoặc bootstrap ngay tại máy — kèm các trường kết nối, mã hóa và khắc phục sự cố.",
  intro: "SQL Server là engine SQL qua mạng của Microsoft. TableR kết nối bằng xác thực Windows hoặc SQL Server, tự nhận theo host. Trỏ TableR tới một server sẵn có bằng cách điền form kết nối, hoặc để TableR tự khởi tạo một SQL Server local qua bootstrap tích hợp khi bạn chưa có server.",
  overviewText: "TableR dùng giao thức gốc của SQL Server (TDS), nên hoạt động với bản cài local, container, dịch vụ quản lý (Azure SQL Database, Amazon RDS for SQL Server và tương tự), hay một server local đã bootstrap. Chế độ xác thực — Windows hay SQL Server — được nhận từ host bạn nhập.",
  overviewBullets: [
    "Phát triển local — kết nối tới localhost,1433, hoặc bootstrap một server local.",
    "Named instance — dùng SERVER\\INSTANCE, hoặc đặt trường instance name.",
    "Remote / managed — dùng endpoint của nhà cung cấp và đặt Encrypt phù hợp.",
  ],
  beforeYouStart: [
    "Một SQL Server truy cập được (host và port), hoặc dùng Bootstrap local thay thế.",
    "Với xác thực SQL: tên login và mật khẩu.",
    "Với xác thực Windows: để trống username để dùng tài khoản Windows hiện tại.",
    "Tùy chọn: database cụ thể muốn mở khi kết nối.",
    "Với server từ xa: cần truy cập mạng tới port và thiết lập Encrypt phù hợp.",
  ],
  connFieldsIntro: "Các mặc định dưới đây khớp với form kết nối SQL Server của TableR. Bí mật được ghi vào keyring của hệ điều hành, không bao giờ vào tệp cấu hình dạng văn bản.",
  fieldRows: [
    ["Host", "Có", "127.0.0.1", "Dùng localhost,1433 hoặc SERVER\\INSTANCE. Chế độ xác thực tự nhận theo host."],
    ["Port", "Có", "1433", "Port mặc định của SQL Server. Chỉ đổi nếu server lắng nghe ở cổng khác."],
    ["Username", "Không", "—", "Dùng cho xác thực SQL Server. Để trống để dùng xác thực Windows."],
    ["Password", "Không", "—", "Tùy chọn; lưu trong keyring."],
    ["Database", "Không", "—", "Tùy chọn. Để trống thì dùng database mặc định của login."],
    ["Instance name", "Không", "—", "Tùy chọn, hoặc điền SERVER\\INSTANCE vào ô Host."],
    ["Encrypt", "Không", "Optional", "Optional hoặc Mandatory. Trust server certificate bật sẵn cho cert tự ký ở local."],
  ],
  formSteps: [
    { title: "Chọn SQL Server", text: "Mở trình khởi chạy và chọn thẻ SQL Server." },
    { title: "Nhập host và port", text: "Dùng localhost,1433 cho server local, SERVER\\INSTANCE cho named instance, hoặc endpoint của nhà cung cấp cho server từ xa." },
    { title: "Chọn chế độ xác thực", text: "Để trống username cho xác thực Windows, hoặc nhập login và password cho xác thực SQL Server." },
    { title: "Chọn database (tùy chọn)", text: "Đặt một database để mở trực tiếp, hoặc để trống để dùng mặc định của login." },
    { title: "Đặt mã hóa cho remote", text: "Đặt Encrypt thành Mandatory cho server từ xa; giữ Trust server certificate bật cho cert tự ký ở local." },
    { title: "Lưu và kết nối", text: "Lưu profile để nó xuất hiện lại trong trình khởi chạy, rồi kết nối." },
  ],
  bootstrap: {
    noServerText: "Bạn không cần cài SQL Server để dùng thử. Chọn SQL Server trong trình khởi chạy và dùng Bootstrap local — TableR tạo và khởi động một server local, giữ bí mật trong keyring của hệ điều hành.",
    intro: "Nếu chưa có server, TableR có thể khởi tạo một SQL Server local cho bạn — không cần cài riêng.",
    steps: [
      { title: "Chọn SQL Server", text: "Chọn SQL Server trong trình khởi chạy." },
      { title: "Chọn Bootstrap local", text: "TableR cấp phát và khởi động một server local trên máy bạn." },
      { title: "Bắt đầu truy vấn", text: "Một kết nối được tạo sẵn; mở tab SQL và chạy truy vấn." },
    ],
  },
  sslIntro: "SQL Server điều khiển mã hóa bằng thiết lập Encrypt thay vì tham số URI. Server local thường không cần mã hóa; với kết nối qua mạng, đặt Encrypt thành Mandatory.",
  sslBullets: [
    "Encrypt: Optional — chỉ mã hóa nếu server thương lượng (thường dùng khi phát triển local).",
    "Encrypt: Mandatory — luôn mã hóa kết nối (dùng cho server từ xa và quản lý).",
    "Trust server certificate — bật sẵn cho cert tự ký ở local; tắt để xác minh chuỗi chứng chỉ của server.",
  ],
  verifyCode: "SELECT @@VERSION;\nSELECT DB_NAME(), SYSTEM_USER;",
  troubleshootRows: [
    ["Login failed for user", "Sai username/password, hoặc login không có quyền truy cập.", "Kiểm tra lại credential, hoặc để trống username để dùng xác thực Windows."],
    ["Lỗi mã hóa / chứng chỉ", "Thiết lập Encrypt hoặc Trust server certificate không khớp với server.", "Đặt Encrypt thành Optional, hoặc giữ Trust server certificate bật cho cert tự ký ở local."],
    ["Cannot open database 'name'", "Trường Database trỏ tới database không tồn tại.", "Để trống Database, hoặc nhập một database có thật."],
    ["Không tìm thấy server hoặc không truy cập được", "Sai host/instance/port, server dừng, hoặc firewall.", "Xác nhận server đang chạy và kiểm tra host (localhost,1433 hoặc SERVER\\INSTANCE) và port."],
  ],
};

const VI_COCKROACHDB: EngineSpec = {
  slug: "cockroachdb",
  icon: "PlugZap",
  title: "CockroachDB",
  description: "Kết nối TableR tới CockroachDB — node tự vận hành hoặc CockroachDB Cloud. Nó dùng giao thức wire của PostgreSQL, nên các trường, connection string và SSL/TLS hoạt động như PostgreSQL.",
  intro: "CockroachDB là engine SQL phân tán dùng giao thức wire của PostgreSQL, nên TableR kết nối y hệt PostgreSQL. Điền form kết nối để trỏ tới một node hoặc một cụm CockroachDB Cloud.",
  overviewText: "Vì CockroachDB dùng giao thức wire của PostgreSQL, các trường kết nối và connection string như PostgreSQL đều áp dụng. Nó hoạt động với node local, cụm tự vận hành, hay CockroachDB Cloud; chỉ giá trị thay đổi.",
  overviewBullets: [
    "Local / tự vận hành — kết nối tới node trên 127.0.0.1:26257.",
    "CockroachDB Cloud — dùng endpoint của cụm và bật SSL/TLS (thường bắt buộc).",
    "Tương thích PostgreSQL — trường, connection string và hành vi khớp PostgreSQL; xem hướng dẫn PostgreSQL cho những gì chưa nêu ở đây.",
  ],
  beforeYouStart: [
    "Một node hoặc cụm CockroachDB truy cập được (host và port).",
    "Tên user của database — bắt buộc.",
    "Mật khẩu của user, nếu cụm yêu cầu.",
    "Tùy chọn: database cụ thể muốn mở khi kết nối.",
    "Với CockroachDB Cloud: cần truy cập mạng tới port và bật SSL/TLS.",
  ],
  connFieldsIntro: "Các mặc định dưới đây khớp với form kết nối CockroachDB của TableR, vốn giống PostgreSQL. Bí mật được ghi vào keyring của hệ điều hành, không bao giờ vào tệp cấu hình dạng văn bản.",
  fieldRows: [
    ["Host", "Có", "127.0.0.1", "Hostname hoặc IP của node, hoặc host CockroachDB Cloud của bạn."],
    ["Port", "Có", "26257", "Port mặc định của CockroachDB. Chỉ đổi nếu node lắng nghe ở cổng khác."],
    ["Username", "Có", "—", "User database dùng để xác thực."],
    ["Password", "Không", "—", "Tùy chọn; lưu trong keyring."],
    ["Database", "Không", "—", "Tùy chọn. Để trống thì dùng database mặc định của user."],
    ["SSL/TLS", "Không", "Tắt", "Bật cho cụm từ xa; CockroachDB Cloud thường bắt buộc."],
  ],
  formSteps: [
    { title: "Chọn CockroachDB", text: "Mở trình khởi chạy và chọn thẻ CockroachDB." },
    { title: "Nhập host và port", text: "Dùng 127.0.0.1 và 26257 cho node local, hoặc endpoint CockroachDB Cloud cho cụm từ xa." },
    { title: "Thêm credential", text: "Nhập username, và password nếu cần. Password được lưu vào keyring." },
    { title: "Chọn database (tùy chọn)", text: "Đặt một database để mở trực tiếp, hoặc để trống để dùng mặc định của user." },
    { title: "Bật SSL/TLS cho remote", text: "Bật SSL/TLS khi kết nối tới CockroachDB Cloud hoặc bất kỳ cụm từ xa nào." },
    { title: "Lưu và kết nối", text: "Lưu profile để nó xuất hiện lại trong trình khởi chạy, rồi kết nối." },
  ],
  connString: {
    intro: "Vì CockroachDB dùng giao thức PostgreSQL, bạn có thể dán một URI kết nối PostgreSQL. Chấp nhận cả scheme postgres:// và postgresql://.",
    code: "postgresql://username:password@host:26257/database?sslmode=verify-full",
    bullets: [
      "Bỏ password khỏi URI và để TableR lưu vào keyring.",
      "Thêm sslmode=verify-full cho CockroachDB Cloud, hoặc sslmode=require cho các cụm từ xa khác.",
      "URL-encode ký tự đặc biệt trong password (ví dụ @ thành %40).",
    ],
  },
  sslIntro: "Node local trên 127.0.0.1 thường không cần mã hóa. Với bất cứ kết nối qua mạng nào — và luôn với CockroachDB Cloud — hãy bật SSL/TLS. Nếu dùng URI, điều khiển hành vi bằng tham số sslmode.",
  sslBullets: [
    "disable — không mã hóa (chỉ dùng local).",
    "require — mã hóa nhưng không xác minh chứng chỉ server.",
    "verify-ca / verify-full — mã hóa và xác minh chứng chỉ (CockroachDB Cloud bắt buộc).",
  ],
  verifyCode: "SELECT version();\nSELECT current_database(), current_user;",
  troubleshootRows: [
    ["Connection refused", "Node chưa chạy, sai host/port, hoặc firewall.", "Xác nhận node đang chạy và port truy cập được; kiểm tra lại host và port."],
    ["password authentication failed", "Sai username hoặc password.", "Kiểm tra lại credential và cập nhật password đã lưu (nằm trong keyring)."],
    ["Yêu cầu SSL / chứng chỉ", "Cụm bắt buộc TLS (thường gặp với CockroachDB Cloud).", "Bật SSL/TLS, hoặc thêm sslmode=verify-full vào connection string."],
    ["database 'name' does not exist", "Trường Database trỏ tới database không tồn tại.", "Để trống Database, hoặc nhập một database có thật."],
  ],
};

const VI_GREENPLUM: EngineSpec = {
  slug: "greenplum",
  icon: "PlugZap",
  title: "Greenplum",
  description: "Kết nối TableR tới Greenplum, một kho phân tích tương thích PostgreSQL. Các trường, connection string và SSL/TLS hoạt động như PostgreSQL.",
  intro: "Greenplum là kho phân tích song song quy mô lớn xây trên PostgreSQL, nên TableR kết nối y hệt PostgreSQL. Điền form kết nối để trỏ tới coordinator Greenplum của bạn.",
  overviewText: "Vì Greenplum tương thích PostgreSQL, các trường kết nối và connection string như PostgreSQL đều áp dụng. Bạn kết nối qua host coordinator, và Greenplum phân tán truy vấn trên các segment.",
  overviewBullets: [
    "Kết nối qua coordinator — TableR nói chuyện với host coordinator trên port 5432.",
    "Remote / managed — dùng endpoint của nhà cung cấp và bật SSL/TLS.",
    "Tương thích PostgreSQL — trường, connection string và hành vi khớp PostgreSQL; xem hướng dẫn PostgreSQL cho những gì chưa nêu ở đây.",
  ],
  beforeYouStart: [
    "Một coordinator Greenplum truy cập được (host và port).",
    "Tên user của database — bắt buộc.",
    "Mật khẩu của user, nếu kho yêu cầu.",
    "Tùy chọn: database cụ thể muốn mở khi kết nối.",
    "Với kho từ xa: cần truy cập mạng tới port và thường phải bật SSL/TLS.",
  ],
  connFieldsIntro: "Các mặc định dưới đây khớp với form kết nối Greenplum của TableR, vốn giống PostgreSQL. Bí mật được ghi vào keyring của hệ điều hành, không bao giờ vào tệp cấu hình dạng văn bản.",
  fieldRows: [
    ["Host", "Có", "127.0.0.1", "Hostname hoặc IP của coordinator Greenplum."],
    ["Port", "Có", "5432", "Port mặc định của Greenplum (dùng chung với PostgreSQL)."],
    ["Username", "Có", "—", "User database dùng để xác thực."],
    ["Password", "Không", "—", "Tùy chọn; lưu trong keyring."],
    ["Database", "Không", "—", "Tùy chọn. Để trống thì dùng database mặc định của user."],
    ["SSL/TLS", "Không", "Tắt", "Bật cho kho từ xa; nhiều nhà cung cấp quản lý bắt buộc."],
  ],
  formSteps: [
    { title: "Chọn Greenplum", text: "Mở trình khởi chạy và chọn thẻ Greenplum." },
    { title: "Nhập host và port", text: "Dùng 127.0.0.1 và 5432 cho coordinator local, hoặc endpoint coordinator cho kho từ xa." },
    { title: "Thêm credential", text: "Nhập username, và password nếu cần. Password được lưu vào keyring." },
    { title: "Chọn database (tùy chọn)", text: "Đặt một database để mở trực tiếp, hoặc để trống để dùng mặc định của user." },
    { title: "Bật SSL/TLS cho remote", text: "Bật SSL/TLS khi kết nối tới kho từ xa hoặc quản lý." },
    { title: "Lưu và kết nối", text: "Lưu profile để nó xuất hiện lại trong trình khởi chạy, rồi kết nối." },
  ],
  connString: {
    intro: "Vì Greenplum tương thích PostgreSQL, bạn có thể dán một URI kết nối PostgreSQL. Chấp nhận cả scheme postgres:// và postgresql://.",
    code: "postgresql://username:password@coordinator:5432/database?sslmode=require",
    bullets: [
      "Bỏ password khỏi URI và để TableR lưu vào keyring.",
      "Thêm sslmode=require (hoặc verify-full) cho kho từ xa.",
      "URL-encode ký tự đặc biệt trong password (ví dụ @ thành %40).",
    ],
  },
  sslIntro: "Coordinator local trên 127.0.0.1 thường không cần mã hóa. Với bất cứ kết nối qua mạng nào, hãy bật SSL/TLS. Nếu dùng URI, điều khiển hành vi bằng tham số sslmode.",
  sslBullets: [
    "disable — không mã hóa (chỉ dùng local).",
    "require — mã hóa nhưng không xác minh chứng chỉ server.",
    "verify-ca / verify-full — mã hóa và xác minh chứng chỉ (an toàn nhất).",
  ],
  verifyCode: "SELECT version();\nSELECT current_database(), current_user;",
  troubleshootRows: [
    ["Connection refused", "Coordinator chưa chạy, sai host/port, hoặc firewall.", "Xác nhận coordinator đang chạy và port truy cập được; kiểm tra lại host và port."],
    ["password authentication failed", "Sai username hoặc password.", "Kiểm tra lại credential và cập nhật password đã lưu (nằm trong keyring)."],
    ["Yêu cầu SSL / mã hóa", "Kho bắt buộc TLS.", "Bật SSL/TLS, hoặc thêm sslmode=require vào connection string."],
    ["database 'name' does not exist", "Trường Database trỏ tới database không tồn tại.", "Để trống Database, hoặc nhập một database có thật."],
  ],
};

const VI_AMAZON_REDSHIFT: EngineSpec = {
  slug: "amazon-redshift",
  icon: "PlugZap",
  title: "Amazon Redshift",
  description: "Kết nối TableR tới Amazon Redshift, một kho dữ liệu đám mây tương thích PostgreSQL. Các trường, connection string và SSL/TLS hoạt động như PostgreSQL.",
  intro: "Amazon Redshift là kho dữ liệu đám mây tương thích PostgreSQL của AWS, nên TableR kết nối y hệt PostgreSQL. Điền form kết nối để trỏ tới endpoint cụm của bạn.",
  overviewText: "Vì Redshift tương thích PostgreSQL, các trường kết nối và connection string như PostgreSQL đều áp dụng. Bạn kết nối tới endpoint cụm qua mạng — không có Redshift local.",
  overviewBullets: [
    "Endpoint cụm — dùng cluster.region.redshift.amazonaws.com trên port 5439.",
    "SSL/TLS — hãy bật; kết nối Redshift đi qua mạng.",
    "Tương thích PostgreSQL — trường, connection string và hành vi khớp PostgreSQL; xem hướng dẫn PostgreSQL cho những gì chưa nêu ở đây.",
  ],
  beforeYouStart: [
    "Endpoint cụm Redshift của bạn (host và port).",
    "Tên user của database — bắt buộc.",
    "Mật khẩu của user, nếu cần.",
    "Tùy chọn: database cụ thể muốn mở khi kết nối.",
    "Truy cập mạng tới cụm (security group / VPC) và bật SSL/TLS.",
  ],
  connFieldsIntro: "Các mặc định dưới đây khớp với form kết nối Amazon Redshift của TableR, vốn giống PostgreSQL. Bí mật được ghi vào keyring của hệ điều hành, không bao giờ vào tệp cấu hình dạng văn bản.",
  fieldRows: [
    ["Host", "Có", "—", "Endpoint cụm của bạn, ví dụ cluster.region.redshift.amazonaws.com."],
    ["Port", "Có", "5439", "Port mặc định của Redshift. Chỉ đổi nếu cụm lắng nghe ở cổng khác."],
    ["Username", "Có", "—", "User database dùng để xác thực."],
    ["Password", "Không", "—", "Tùy chọn; lưu trong keyring."],
    ["Database", "Không", "—", "Tùy chọn. Để trống thì dùng database mặc định của user."],
    ["SSL/TLS", "Không", "Tắt", "Hãy bật — lưu lượng Redshift đi qua mạng."],
  ],
  formSteps: [
    { title: "Chọn Amazon Redshift", text: "Mở trình khởi chạy và chọn thẻ Amazon Redshift." },
    { title: "Nhập endpoint và port", text: "Dùng endpoint cụm (cluster.region.redshift.amazonaws.com) và 5439." },
    { title: "Thêm credential", text: "Nhập username, và password nếu cần. Password được lưu vào keyring." },
    { title: "Chọn database (tùy chọn)", text: "Đặt một database để mở trực tiếp, hoặc để trống để dùng mặc định của user." },
    { title: "Bật SSL/TLS", text: "Bật SSL/TLS — kết nối Redshift đi qua mạng." },
    { title: "Lưu và kết nối", text: "Lưu profile để nó xuất hiện lại trong trình khởi chạy, rồi kết nối." },
  ],
  connString: {
    intro: "Vì Redshift tương thích PostgreSQL, bạn có thể dán một URI kết nối PostgreSQL. Chấp nhận cả scheme postgres:// và postgresql://.",
    code: "postgresql://username:password@cluster.region.redshift.amazonaws.com:5439/database?sslmode=require",
    bullets: [
      "Bỏ password khỏi URI và để TableR lưu vào keyring.",
      "Thêm sslmode=require (hoặc verify-full) — kết nối Redshift đi qua mạng.",
      "URL-encode ký tự đặc biệt trong password (ví dụ @ thành %40).",
    ],
  },
  sslIntro: "Redshift luôn được truy cập qua mạng, nên hãy bật SSL/TLS. Nếu dùng URI, điều khiển hành vi bằng tham số sslmode.",
  sslBullets: [
    "require — mã hóa nhưng không xác minh chứng chỉ server.",
    "verify-ca / verify-full — mã hóa và xác minh chứng chỉ (an toàn nhất).",
    "Giữ SSL/TLS bật cho mọi kết nối Redshift.",
  ],
  verifyCode: "SELECT version();\nSELECT current_database(), current_user;",
  troubleshootRows: [
    ["Connection timed out", "Security group hoặc VPC không cho truy cập, hoặc sai endpoint/port.", "Cho phép IP của bạn trong security group của cụm và kiểm tra lại endpoint và port 5439."],
    ["password authentication failed", "Sai username hoặc password.", "Kiểm tra lại credential và cập nhật password đã lưu (nằm trong keyring)."],
    ["Yêu cầu SSL / mã hóa", "Cụm bắt buộc TLS.", "Bật SSL/TLS, hoặc thêm sslmode=require vào connection string."],
    ["database 'name' does not exist", "Trường Database trỏ tới database không tồn tại.", "Để trống Database, hoặc nhập một database có thật."],
  ],
};

const VI_VERTICA: EngineSpec = {
  slug: "vertica",
  icon: "PlugZap",
  title: "Vertica",
  description: "Kết nối TableR tới Vertica, một cơ sở dữ liệu phân tích dạng cột, kèm các trường kết nối, SSL/TLS, kiểm tra kết nối và khắc phục sự cố.",
  intro: "Vertica là cơ sở dữ liệu phân tích dạng cột xây cho truy vấn quy mô lớn. Trỏ TableR tới host Vertica của bạn bằng cách điền form kết nối.",
  overviewText: "TableR kết nối tới Vertica qua giao thức gốc của nó. Nó hoạt động với cụm tự vận hành hoặc dịch vụ Vertica quản lý; lưu trữ dạng cột được thiết kế cho tải phân tích (OLAP) trên tập dữ liệu lớn.",
  overviewBullets: [
    "Tự vận hành — kết nối tới host Vertica trên port 5433.",
    "Remote / managed — dùng endpoint của nhà cung cấp và bật SSL/TLS.",
    "Phân tích dạng cột — tối ưu cho quét lớn và tổng hợp thay vì tra cứu từng dòng.",
  ],
  beforeYouStart: [
    "Một host Vertica truy cập được (host và port).",
    "Tên user của database — bắt buộc.",
    "Mật khẩu của user, nếu database yêu cầu.",
    "Tùy chọn: database cụ thể muốn mở khi kết nối.",
    "Với host từ xa: cần truy cập mạng tới port và thường phải bật SSL/TLS.",
  ],
  connFieldsIntro: "Các mặc định dưới đây khớp với form kết nối Vertica của TableR. Bí mật được ghi vào keyring của hệ điều hành, không bao giờ vào tệp cấu hình dạng văn bản.",
  fieldRows: [
    ["Host", "Có", "127.0.0.1", "Hostname hoặc IP của host Vertica."],
    ["Port", "Có", "5433", "Port mặc định của Vertica. Chỉ đổi nếu host lắng nghe ở cổng khác."],
    ["Username", "Có", "—", "User database dùng để xác thực."],
    ["Password", "Không", "—", "Tùy chọn; lưu trong keyring."],
    ["Database", "Không", "—", "Tùy chọn. Để trống thì dùng database mặc định của user."],
    ["SSL/TLS", "Không", "Tắt", "Bật cho host từ xa; nhiều nhà cung cấp quản lý bắt buộc."],
  ],
  formSteps: [
    { title: "Chọn Vertica", text: "Mở trình khởi chạy và chọn thẻ Vertica." },
    { title: "Nhập host và port", text: "Dùng 127.0.0.1 và 5433 cho host local, hoặc endpoint của nhà cung cấp cho host từ xa." },
    { title: "Thêm credential", text: "Nhập username, và password nếu cần. Password được lưu vào keyring." },
    { title: "Chọn database (tùy chọn)", text: "Đặt một database để mở trực tiếp, hoặc để trống để dùng mặc định của user." },
    { title: "Bật SSL/TLS cho remote", text: "Bật SSL/TLS khi kết nối tới host từ xa hoặc quản lý." },
    { title: "Lưu và kết nối", text: "Lưu profile để nó xuất hiện lại trong trình khởi chạy, rồi kết nối." },
  ],
  sslIntro: "Host local trên 127.0.0.1 thường không cần mã hóa. Với bất cứ kết nối qua mạng nào, hãy bật SSL/TLS để credential và kết quả được bảo vệ trên đường truyền.",
  sslBullets: [
    "Tắt — không mã hóa (chỉ dùng local hoặc mạng tin cậy).",
    "Bật — mã hóa kết nối tới host Vertica.",
    "Bật cho bất kỳ host từ xa hoặc quản lý nào.",
  ],
  verifyCode: "SELECT version();\nSELECT current_database(), current_user;",
  troubleshootRows: [
    ["Connection refused", "Host chưa chạy, sai host/port, hoặc firewall.", "Xác nhận host đang chạy và port truy cập được; kiểm tra lại host và port."],
    ["Xác thực thất bại", "Sai username hoặc password.", "Kiểm tra lại credential và cập nhật password đã lưu (nằm trong keyring)."],
    ["Yêu cầu SSL / mã hóa", "Host bắt buộc TLS.", "Bật SSL/TLS cho kết nối."],
    ["Database không tồn tại", "Trường Database trỏ tới database không tồn tại.", "Để trống Database, hoặc nhập một database có thật."],
  ],
};

const VI_CLICKHOUSE: EngineSpec = {
  slug: "clickhouse",
  icon: "PlugZap",
  title: "ClickHouse",
  description: "Kết nối TableR tới ClickHouse qua giao diện HTTP, kèm các trường kết nối, SSL/TLS, kiểm tra kết nối và khắc phục sự cố.",
  intro: "ClickHouse là cơ sở dữ liệu dạng cột cho phân tích thời gian thực. TableR kết nối qua giao diện HTTP của ClickHouse; điền form kết nối để trỏ tới host ClickHouse của bạn.",
  overviewText: "TableR nói chuyện với ClickHouse qua giao diện HTTP (port mặc định 8123). Nó hoạt động với server tự vận hành, container, hay ClickHouse Cloud. Engine dạng cột được xây cho tổng hợp nhanh trên bảng rất lớn.",
  overviewBullets: [
    "Tự vận hành — kết nối tới host ClickHouse trên port HTTP 8123.",
    "ClickHouse Cloud / từ xa — dùng endpoint của nhà cung cấp và bật SSL/TLS (HTTPS).",
    "Phân tích dạng cột — tối ưu cho quét lớn và tổng hợp thay vì tra cứu từng dòng.",
  ],
  beforeYouStart: [
    "Một host ClickHouse truy cập được và port HTTP của nó.",
    "Tên user — bắt buộc.",
    "Mật khẩu của user, nếu server yêu cầu.",
    "Tùy chọn: database cụ thể muốn mở khi kết nối.",
    "Với server từ xa: cần truy cập mạng tới port HTTP(S) và thường phải bật SSL/TLS.",
  ],
  connFieldsIntro: "Các mặc định dưới đây khớp với form kết nối ClickHouse của TableR. Bí mật được ghi vào keyring của hệ điều hành, không bao giờ vào tệp cấu hình dạng văn bản.",
  fieldRows: [
    ["Host", "Có", "127.0.0.1", "Hostname hoặc IP của host ClickHouse."],
    ["Port", "Có", "8123", "Port giao diện HTTP của ClickHouse. Dùng 8443 cho giao diện HTTPS."],
    ["Username", "Có", "—", "User dùng để xác thực."],
    ["Password", "Không", "—", "Tùy chọn; lưu trong keyring."],
    ["Database", "Không", "—", "Tùy chọn. Để trống thì dùng database mặc định."],
    ["SSL/TLS", "Không", "Tắt", "Bật cho server từ xa (HTTPS); ClickHouse Cloud bắt buộc."],
  ],
  formSteps: [
    { title: "Chọn ClickHouse", text: "Mở trình khởi chạy và chọn thẻ ClickHouse." },
    { title: "Nhập host và port", text: "Dùng 127.0.0.1 và 8123 cho server local, 8443 cho HTTPS, hoặc endpoint của nhà cung cấp cho server từ xa." },
    { title: "Thêm credential", text: "Nhập username, và password nếu cần. Password được lưu vào keyring." },
    { title: "Chọn database (tùy chọn)", text: "Đặt một database để mở trực tiếp, hoặc để trống để dùng mặc định." },
    { title: "Bật SSL/TLS cho remote", text: "Bật SSL/TLS (HTTPS) khi kết nối tới ClickHouse Cloud hoặc bất kỳ server từ xa nào." },
    { title: "Lưu và kết nối", text: "Lưu profile để nó xuất hiện lại trong trình khởi chạy, rồi kết nối." },
  ],
  sslIntro: "Server local thường không cần mã hóa. Với bất cứ kết nối qua mạng nào — và luôn với ClickHouse Cloud — hãy bật SSL/TLS, vốn dùng giao diện HTTPS (port mặc định 8443).",
  sslBullets: [
    "Tắt — HTTP thuần (chỉ dùng local hoặc mạng tin cậy).",
    "Bật — HTTPS tới host ClickHouse.",
    "ClickHouse Cloud bắt buộc TLS; dùng port HTTPS.",
  ],
  verifyCode: "SELECT version();\nSELECT currentDatabase(), currentUser();",
  troubleshootRows: [
    ["Connection refused", "Server chưa chạy, sai host/port, hoặc firewall.", "Xác nhận server đang chạy và port HTTP truy cập được; kiểm tra lại host và port."],
    ["Xác thực thất bại", "Sai username hoặc password.", "Kiểm tra lại credential và cập nhật password đã lưu (nằm trong keyring)."],
    ["Yêu cầu SSL / HTTPS", "Server bắt buộc TLS (thường gặp với ClickHouse Cloud).", "Bật SSL/TLS và dùng port HTTPS (8443)."],
    ["Database không tồn tại", "Trường Database trỏ tới database không tồn tại.", "Để trống Database, hoặc nhập một database có thật."],
  ],
};

const VI_SNOWFLAKE: EngineSpec = {
  slug: "snowflake",
  icon: "PlugZap",
  title: "Snowflake",
  description: "Kết nối TableR tới Snowflake qua HTTPS bằng host tài khoản, warehouse, role, các trường kết nối, kiểm tra kết nối và khắc phục sự cố.",
  intro: "Snowflake là kho dữ liệu đám mây truy cập qua HTTPS tại host tài khoản của bạn. Điền form kết nối với URL tài khoản và credential để bắt đầu truy vấn.",
  overviewText: "TableR kết nối tới Snowflake qua endpoint HTTPS của nó, nên kết nối luôn được mã hóa. Nó hoạt động với mọi tài khoản Snowflake; truy vấn chạy trên warehouse bạn chọn, và role quyết định những gì bạn thấy được.",
  overviewBullets: [
    "Kho đám mây — truy cập tại account.region.snowflakecomputing.com qua HTTPS (port 443).",
    "Tính toán — cần có một warehouse; hãy đặt một cái khi session chưa có mặc định.",
    "Truy cập — role quyết định database, schema và đối tượng bạn có thể truy vấn.",
  ],
  beforeYouStart: [
    "Host tài khoản Snowflake của bạn (account.region.snowflakecomputing.com).",
    "Một username cùng password hoặc token của nó.",
    "Tên warehouse, nếu user của bạn chưa có warehouse mặc định.",
    "Tùy chọn: role, database và schema mặc định.",
  ],
  connFieldsIntro: "Các trường dưới đây khớp với form kết nối Snowflake của TableR. Kết nối dùng HTTPS, và bí mật được ghi vào keyring của hệ điều hành, không bao giờ vào tệp cấu hình dạng văn bản.",
  fieldRows: [
    ["Host", "Có", "—", "account.region.snowflakecomputing.com."],
    ["Port", "Có", "443", "HTTPS; kết nối luôn được mã hóa."],
    ["Credential", "Có", "—", "Password hoặc token Snowflake của bạn; lưu trong keyring."],
    ["Warehouse", "Không", "—", "Bắt buộc khi session chưa có warehouse mặc định."],
    ["Role", "Không", "—", "Tùy chọn; để trống thì dùng role mặc định."],
    ["Database", "Không", "—", "Database mặc định tùy chọn."],
    ["Schema", "Không", "—", "Schema mặc định tùy chọn."],
  ],
  formSteps: [
    { title: "Chọn Snowflake", text: "Mở trình khởi chạy và chọn thẻ Snowflake." },
    { title: "Nhập host tài khoản", text: "Dùng URL tài khoản của bạn, account.region.snowflakecomputing.com." },
    { title: "Thêm credential", text: "Nhập username cùng password hoặc token; nó được lưu vào keyring." },
    { title: "Đặt warehouse (nếu cần)", text: "Cung cấp warehouse khi user của bạn chưa có mặc định." },
    { title: "Chọn role, database, schema (tùy chọn)", text: "Để trống để dùng mặc định của tài khoản." },
    { title: "Lưu và kết nối", text: "Lưu profile để nó xuất hiện lại trong trình khởi chạy, rồi kết nối." },
  ],
  verifyCode: "SELECT CURRENT_VERSION();\nSELECT CURRENT_ACCOUNT(), CURRENT_USER(), CURRENT_WAREHOUSE();",
  troubleshootRows: [
    ["Could not connect to host", "Sai host tài khoản hoặc không có mạng.", "Kiểm tra lại URL tài khoản (account.region.snowflakecomputing.com) và kết nối của bạn."],
    ["Xác thực thất bại", "Sai username, password hoặc token.", "Kiểm tra lại credential và cập nhật bí mật đã lưu (nằm trong keyring)."],
    ["No active warehouse selected", "Session chưa có warehouse.", "Đặt trường Warehouse, hoặc gán warehouse mặc định cho user."],
    ["Object does not exist or not authorized", "Role không thấy được đối tượng.", "Dùng role có quyền truy cập, hoặc đặt đúng role mặc định."],
  ],
};

const VI_BIGQUERY: EngineSpec = {
  slug: "bigquery",
  icon: "PlugZap",
  title: "BigQuery",
  description: "Kết nối TableR tới Google BigQuery bằng service account, trường project và dataset, kiểm tra kết nối và khắc phục sự cố.",
  intro: "BigQuery là kho dữ liệu serverless của Google Cloud. TableR kết nối qua HTTPS và xác thực bằng service account; cung cấp project và dataset để bắt đầu truy vấn.",
  overviewText: "TableR giao tiếp với BigQuery qua các API của Google Cloud trên HTTPS. Không có host hay port để quản lý — bạn xác thực bằng service-account key và trỏ TableR tới một project và dataset.",
  overviewBullets: [
    "Serverless — không có server, host hay port để chạy; truy cập tại bigquery.googleapis.com qua HTTPS.",
    "Xác thực — một service-account key (JSON) hoặc token của Google Cloud.",
    "Phạm vi — một project chứa các dataset, và một dataset chứa các bảng.",
  ],
  beforeYouStart: [
    "Một project ID của Google Cloud.",
    "Một service-account key (JSON) hoặc token có quyền BigQuery.",
    "Dataset bạn muốn duyệt.",
    "Vùng (region) của dataset, nếu không phải mặc định.",
  ],
  connFieldsIntro: "Các trường dưới đây khớp với form kết nối BigQuery của TableR. Service-account key được lưu trong keyring của hệ điều hành, không bao giờ vào tệp cấu hình dạng văn bản.",
  fieldRows: [
    ["Host", "Có", "bigquery.googleapis.com", "Endpoint HTTPS; kết nối luôn được mã hóa."],
    ["Credential", "Có", "—", "Một service-account key (JSON) hoặc token; lưu trong keyring."],
    ["Project ID", "Có", "—", "Project Google Cloud của bạn."],
    ["Dataset", "Không", "—", "Dataset cần duyệt."],
    ["Location", "Không", "—", "Vùng của dataset (ví dụ US hoặc EU)."],
  ],
  formSteps: [
    { title: "Chọn BigQuery", text: "Mở trình khởi chạy và chọn thẻ BigQuery." },
    { title: "Thêm service account", text: "Dán hoặc chọn service-account key (JSON); nó được lưu vào keyring." },
    { title: "Nhập project ID", text: "Dùng project Google Cloud sở hữu dữ liệu." },
    { title: "Chọn dataset và location (tùy chọn)", text: "Đặt dataset cần duyệt và vùng của nó." },
    { title: "Lưu và kết nối", text: "Lưu profile để nó xuất hiện lại trong trình khởi chạy, rồi kết nối." },
  ],
  verifyCode: "SELECT CURRENT_TIMESTAMP();\nSELECT SESSION_USER();",
  troubleshootRows: [
    ["Invalid credentials / permission denied", "Service account thiếu quyền, hoặc key sai.", "Cấp role BigQuery cho service account và kiểm tra lại key."],
    ["Project not found", "Sai project ID.", "Kiểm tra lại project ID trong Google Cloud console."],
    ["Dataset not found", "Dataset không tồn tại trong project hoặc location.", "Kiểm tra lại tên dataset và location của nó."],
    ["Not found: location", "Sai vùng dataset.", "Đặt Location khớp với vùng của dataset."],
  ],
};

const VI_SQLITE: EngineSpec = {
  slug: "sqlite",
  icon: "PlugZap",
  title: "SQLite",
  description: "Mở hoặc tạo tệp database SQLite trong TableR — không server, không host, không credential — kèm bootstrap local và khắc phục sự cố.",
  intro: "SQLite là dạng nhúng và dựa trên tệp, nên không có server để chạy. Trỏ TableR tới một tệp database sẵn có, hoặc để nó tạo một tệp mới ở máy bạn.",
  overviewText: "TableR mở database SQLite trực tiếp từ một tệp trên đĩa. Không có host, port hay credential — tệp chính là database. Điều này khiến SQLite lý tưởng cho phát triển local, prototype, và kiểm tra các tệp .sqlite/.db được đóng gói.",
  overviewBullets: [
    "Dạng tệp — mở một tệp .sqlite hoặc .db; không có server.",
    "Không credential — truy cập được kiểm soát bằng quyền tệp trên đĩa.",
    "Bootstrap local — TableR có thể tạo cho bạn một tệp database rỗng mới.",
  ],
  beforeYouStart: [
    "Đường dẫn tới một tệp .sqlite hoặc .db, hoặc một thư mục nơi bạn muốn tạo tệp.",
    "Quyền đọc/ghi trên tệp nếu bạn định chỉnh sửa nó.",
  ],
  connFieldsIntro: "SQLite chỉ cần một tệp database — không có host, port hay credential để nhập.",
  fieldRows: [
    ["Tệp database", "Có", "—", "Đường dẫn tới tệp .sqlite/.db sẵn có, hoặc một tệp mới để tạo."],
    ["Host / Port", "Không", "—", "Không dùng; SQLite không có server."],
    ["Credential", "Không", "—", "Không dùng; truy cập theo quyền tệp."],
  ],
  formSteps: [
    { title: "Chọn SQLite", text: "Mở trình khởi chạy và chọn thẻ SQLite." },
    { title: "Chọn một tệp database", text: "Duyệt tới một tệp .sqlite hoặc .db sẵn có." },
    { title: "Hoặc tạo tệp mới", text: "Chọn vị trí và tên để bắt đầu một database rỗng." },
    { title: "Lưu và kết nối", text: "Lưu profile để nó xuất hiện lại trong trình khởi chạy, rồi kết nối." },
  ],
  bootstrap: {
    noServerText: "SQLite không có server. Chọn SQLite trong trình khởi chạy và hoặc chọn một tệp sẵn có hoặc tạo một tệp database local mới để bắt đầu ngay.",
    intro: "Bootstrap local cho SQLite đơn giản là tạo một tệp database mới trên máy bạn — không cần cài đặt hay server.",
    steps: [
      { title: "Chọn SQLite", text: "Chọn SQLite trong trình khởi chạy." },
      { title: "Tạo tệp database mới", text: "Chọn thư mục và tên tệp; TableR tạo một database SQLite rỗng." },
      { title: "Bắt đầu truy vấn", text: "Một kết nối mở trên tệp mới; tạo bảng và chèn dòng." },
    ],
    skipSecretsCallout: true,
  },
  verifyCode: "SELECT sqlite_version();\nSELECT name FROM sqlite_master WHERE type = 'table';",
  verifyTrail: "Câu lệnh đầu trả về phiên bản SQLite; câu thứ hai liệt kê các bảng (rỗng trên database mới).",
  troubleshootRows: [
    ["Unable to open database file", "Sai đường dẫn, hoặc không có quyền với tệp/thư mục.", "Kiểm tra lại đường dẫn và quyền tệp; chọn thư mục bạn ghi được."],
    ["File is not a database", "Tệp không phải database SQLite hợp lệ.", "Mở một tệp .sqlite/.db thật, hoặc tạo tệp mới."],
    ["Attempt to write a readonly database", "Tệp hoặc thư mục ở chế độ chỉ đọc.", "Cấp quyền ghi, hoặc sao chép tệp tới nơi ghi được."],
    ["Database is locked", "Tiến trình khác đang ghi vào tệp.", "Đóng công cụ khác đang dùng tệp và thử lại."],
  ],
};

const VI_DUCKDB: EngineSpec = {
  slug: "duckdb",
  icon: "PlugZap",
  title: "DuckDB",
  description: "Mở hoặc tạo tệp database DuckDB trong TableR — một cơ sở dữ liệu phân tích nhúng với chế độ đọc/ghi hoặc chỉ đọc — kèm khắc phục sự cố.",
  intro: "DuckDB là cơ sở dữ liệu phân tích nhúng nằm trong một tệp duy nhất. Trỏ TableR tới một tệp .duckdb, hoặc tạo tệp mới, và chọn mở ở chế độ đọc/ghi hay chỉ đọc.",
  overviewText: "TableR mở DuckDB trực tiếp từ một tệp trên đĩa — không có server, host, port hay credential. Engine dạng cột của DuckDB được xây cho phân tích nhanh trên các tệp local.",
  overviewBullets: [
    "Dạng tệp — mở hoặc tạo một tệp .duckdb duy nhất; không có server.",
    "Chế độ mở — read_write để chỉnh sửa, hoặc read_only để xem tệp an toàn.",
    "Không credential — truy cập được kiểm soát bằng quyền tệp trên đĩa.",
  ],
  beforeYouStart: [
    "Đường dẫn tới một tệp .duckdb, hoặc một thư mục nơi bạn muốn tạo tệp.",
    "Quyền đọc/ghi nếu bạn định chỉnh sửa database.",
    "Quyết định mở ở chế độ đọc/ghi hay chỉ đọc.",
  ],
  connFieldsIntro: "DuckDB chỉ cần một tệp database và một chế độ mở — không có host, port hay credential.",
  fieldRows: [
    ["Tệp database", "Có", "—", "Đường dẫn tới tệp .duckdb sẵn có, hoặc một tệp mới để tạo."],
    ["Open mode", "Không", "read_write", "read_write để chỉnh sửa, hoặc read_only để xem an toàn."],
    ["Host / Port", "Không", "—", "Không dùng; DuckDB không có server."],
    ["Credential", "Không", "—", "Không dùng; truy cập theo quyền tệp."],
  ],
  formSteps: [
    { title: "Chọn DuckDB", text: "Mở trình khởi chạy và chọn thẻ DuckDB." },
    { title: "Chọn hoặc tạo tệp", text: "Duyệt tới một tệp .duckdb, hoặc chọn vị trí để tạo tệp mới." },
    { title: "Chọn chế độ mở", text: "Chọn read_write để chỉnh sửa, hoặc read_only để xem mà không thay đổi." },
    { title: "Lưu và kết nối", text: "Lưu profile để nó xuất hiện lại trong trình khởi chạy, rồi kết nối." },
  ],
  verifyCode: "SELECT version();\nSHOW TABLES;",
  verifyTrail: "Câu lệnh đầu trả về phiên bản DuckDB; SHOW TABLES liệt kê các bảng (rỗng trên database mới).",
  troubleshootRows: [
    ["Unable to open database file", "Sai đường dẫn, hoặc không có quyền với tệp/thư mục.", "Kiểm tra lại đường dẫn và quyền; chọn vị trí ghi được."],
    ["File is not a valid DuckDB database", "Tệp không do DuckDB tạo, hoặc khác phiên bản.", "Mở một tệp .duckdb thật, hoặc tạo tệp mới."],
    ["Cannot write in read_only mode", "Database được mở ở chế độ chỉ đọc.", "Mở lại với read_write để thay đổi."],
    ["File is being used by another process", "Tiến trình khác đang giữ tệp mở.", "Đóng công cụ khác đang dùng tệp và thử lại."],
  ],
};

const VI_CASSANDRA: EngineSpec = {
  slug: "cassandra",
  icon: "PlugZap",
  title: "Cassandra",
  description: "Kết nối TableR tới Apache Cassandra qua CQL với contact point, keyspace, xác thực và SSL/TLS tùy chọn, kiểm tra kết nối và khắc phục sự cố.",
  intro: "Cassandra là kho dạng wide-column truy cập qua CQL. Trỏ TableR tới một hoặc nhiều contact point và, nếu cụm yêu cầu, thêm credential.",
  overviewText: "TableR kết nối tới cụm Cassandra bằng giao thức gốc CQL (port mặc định 9042). Bạn có thể cung cấp một hoặc nhiều contact point; driver sẽ khám phá phần còn lại của cụm. Một keyspace giới hạn phạm vi các bảng bạn duyệt.",
  overviewBullets: [
    "Cụm — kết nối tới một hoặc nhiều contact point trên port 9042.",
    "Xác thực — bắt buộc username của cụm; cần password khi cụm bắt buộc.",
    "Keyspace — phạm vi tùy chọn cho các bảng bạn duyệt (ô Database).",
  ],
  beforeYouStart: [
    "Một hoặc nhiều contact point truy cập được (host và port).",
    "Một username của cụm — bắt buộc.",
    "Password của user, nếu cụm bắt buộc xác thực.",
    "Tùy chọn: một keyspace và tên datacenter local.",
    "Với cụm từ xa: cần truy cập mạng tới port và thường phải bật SSL/TLS.",
  ],
  connFieldsIntro: "Các mặc định dưới đây khớp với form kết nối Cassandra của TableR. Bí mật được ghi vào keyring của hệ điều hành, không bao giờ vào tệp cấu hình dạng văn bản.",
  fieldRows: [
    ["Host", "Có", "127.0.0.1", "Một hoặc nhiều contact point (phân tách bằng dấu phẩy)."],
    ["Port", "Có", "9042", "Port giao thức gốc CQL."],
    ["Username", "Có", "—", "User của cụm dùng để xác thực."],
    ["Password", "Không", "—", "Tùy chọn; bắt buộc khi cụm bắt buộc xác thực. Lưu trong keyring."],
    ["Keyspace", "Không", "—", "Tùy chọn (ô Database); giới hạn duyệt trong một keyspace."],
    ["Datacenter", "Không", "—", "Tên datacenter local tùy chọn để định tuyến."],
    ["SSL/TLS", "Không", "Tắt", "Bật cho cụm từ xa."],
  ],
  formSteps: [
    { title: "Chọn Cassandra", text: "Mở trình khởi chạy và chọn thẻ Cassandra." },
    { title: "Nhập contact point và port", text: "Dùng 127.0.0.1 và 9042 cho local, hoặc các host của cụm bạn." },
    { title: "Thêm credential", text: "Nhập username, và password nếu cụm yêu cầu." },
    { title: "Đặt keyspace (tùy chọn)", text: "Dùng ô Database để giới hạn duyệt trong một keyspace." },
    { title: "Đặt datacenter (tùy chọn)", text: "Cung cấp tên datacenter local để định tuyến." },
    { title: "Bật SSL/TLS cho remote", text: "Bật SSL/TLS khi kết nối tới cụm từ xa." },
    { title: "Lưu và kết nối", text: "Lưu profile để nó xuất hiện lại trong trình khởi chạy, rồi kết nối." },
  ],
  sslIntro: "Cụm local thường không cần mã hóa. Với cụm từ xa, hãy bật SSL/TLS để credential và dữ liệu được bảo vệ trên đường truyền.",
  sslBullets: [
    "Tắt — không mã hóa (chỉ dùng local hoặc mạng tin cậy).",
    "Bật — mã hóa kết nối tới cụm.",
    "Bật cho bất kỳ cụm từ xa hoặc quản lý nào.",
  ],
  verifyLead: "Sau khi kết nối, mở tab truy vấn và chạy CQL trên keyspace system:",
  verifyCode: "SELECT release_version FROM system.local;\nSELECT cluster_name FROM system.local;",
  verifyTrail: "Nếu cả hai câu lệnh trả về một dòng, kết nối và credential đang hoạt động tốt.",
  troubleshootRows: [
    ["All host(s) tried for query failed", "Không có contact point truy cập được, sai port, hoặc firewall.", "Xác nhận ít nhất một contact point đang chạy và 9042 truy cập được."],
    ["Authentication error", "Sai username hoặc password.", "Kiểm tra lại credential và cập nhật password đã lưu (nằm trong keyring)."],
    ["Keyspace does not exist", "Trường Keyspace trỏ tới keyspace không tồn tại.", "Để trống Keyspace, hoặc nhập một keyspace có thật."],
    ["No host available in datacenter", "Sai tên datacenter local.", "Kiểm tra lại giá trị Datacenter, hoặc để trống."],
  ],
};

const VI_REDIS: EngineSpec = {
  slug: "redis",
  icon: "PlugZap",
  title: "Redis",
  description: "Kết nối TableR tới Redis, một kho key-value trong bộ nhớ, với host, port, user ACL, chỉ số database, TLS tùy chọn, kiểm tra kết nối và khắc phục sự cố.",
  intro: "Redis là kho key-value trong bộ nhớ. Trỏ TableR tới host Redis của bạn và, nếu cần, thêm user ACL, password và chỉ số database.",
  overviewText: "TableR kết nối tới server Redis trên port 6379 theo mặc định. Xác thực là tùy chọn: server cũ có thể chỉ cần password, còn Redis 6+ hỗ trợ user ACL. Một chỉ số database logic chọn database được đánh số mà bạn làm việc.",
  overviewBullets: [
    "Trong bộ nhớ — kết nối tới host Redis trên port 6379.",
    "Xác thực — password tùy chọn, kèm username ACL trên Redis 6+.",
    "Chỉ số database — số database logic, thường là 0.",
  ],
  beforeYouStart: [
    "Một host Redis truy cập được (host và port).",
    "Một password, nếu server yêu cầu AUTH.",
    "Một username ACL, nếu server dùng ACL của Redis 6+.",
    "Chỉ số database bạn muốn làm việc (thường là 0).",
    "Với server từ xa: cần truy cập mạng và thường phải bật TLS.",
  ],
  connFieldsIntro: "Các mặc định dưới đây khớp với form kết nối Redis của TableR. Bí mật được ghi vào keyring của hệ điều hành, không bao giờ vào tệp cấu hình dạng văn bản.",
  fieldRows: [
    ["Host", "Có", "127.0.0.1", "Hostname hoặc IP của server Redis."],
    ["Port", "Có", "6379", "Port mặc định của Redis."],
    ["Username", "Không", "—", "Tùy chọn; một user ACL của Redis 6+."],
    ["Password", "Không", "—", "Tùy chọn; lưu trong keyring."],
    ["Chỉ số database", "Không", "0", "Số database logic để chọn."],
    ["SSL/TLS", "Không", "Tắt", "Bật cho server từ xa yêu cầu TLS."],
  ],
  formSteps: [
    { title: "Chọn Redis", text: "Mở trình khởi chạy và chọn thẻ Redis." },
    { title: "Nhập host và port", text: "Dùng 127.0.0.1 và 6379 cho local, hoặc endpoint của server bạn." },
    { title: "Thêm credential (tùy chọn)", text: "Thêm password, và username ACL trên Redis 6+." },
    { title: "Đặt chỉ số database", text: "Thường là 0; đổi nó để làm việc trong database logic khác." },
    { title: "Bật TLS cho remote", text: "Bật SSL/TLS khi server từ xa yêu cầu." },
    { title: "Lưu và kết nối", text: "Lưu profile để nó xuất hiện lại trong trình khởi chạy, rồi kết nối." },
  ],
  sslIntro: "Server local thường không cần mã hóa. Với server từ xa có hỗ trợ, hãy bật SSL/TLS để kết nối và credential được bảo vệ trên đường truyền.",
  sslBullets: [
    "Tắt — không mã hóa (chỉ dùng local hoặc mạng tin cậy).",
    "Bật — TLS tới server Redis.",
    "Bật cho bất kỳ server từ xa hoặc quản lý nào.",
  ],
  verifyLead: "Sau khi kết nối, mở tab truy vấn và chạy vài lệnh Redis:",
  verifyLang: "text",
  verifyCode: "PING\nINFO server",
  verifyTrail: "PING sẽ trả về PONG, và INFO server in ra phiên bản cùng thông tin của server.",
  troubleshootRows: [
    ["Connection refused", "Server chưa chạy, sai host/port, hoặc firewall.", "Xác nhận server đang chạy và 6379 truy cập được; kiểm tra lại host và port."],
    ["NOAUTH Authentication required", "Server yêu cầu password.", "Thêm password; nó được lưu vào keyring."],
    ["WRONGPASS invalid username-password", "Sai username hoặc password ACL.", "Kiểm tra lại credential (ACL của Redis 6+) và cập nhật password đã lưu."],
    ["Connection reset / TLS required", "Server yêu cầu kết nối TLS.", "Bật SSL/TLS cho kết nối."],
  ],
};

const VI_MONGODB: EngineSpec = {
  slug: "mongodb",
  icon: "PlugZap",
  title: "MongoDB",
  description: "Kết nối TableR tới MongoDB — SRV của Atlas hoặc host trực tiếp — với khám phá kết nối, auth source, replica set, SSL/TLS, connection string và khắc phục sự cố.",
  intro: "MongoDB là cơ sở dữ liệu document. TableR kết nối tới server standalone, replica set, hoặc Atlas; dùng các trường form hoặc dán một connection string MongoDB.",
  overviewText: "TableR nói giao thức wire của MongoDB. Khám phá kết nối có thể tự phát hiện topology, dùng bản ghi SRV (thường gặp với Atlas), hoặc kết nối trực tiếp tới một host và port. Xác thực là tùy chọn và có thể nhắm tới một database xác thực cụ thể.",
  overviewBullets: [
    "Standalone / replica set — kết nối trên port 27017, tùy chọn đặt tên replica set.",
    "Atlas — dùng kết nối SRV (mongodb+srv) hoặc dán URI của Atlas.",
    "Direct — kết nối tới một host:port; dùng cho PrivateLink (pl-*.mongodb.net) hoặc server tự cài.",
  ],
  beforeYouStart: [
    "Một host MongoDB truy cập được, hoặc hostname / URI SRV của Atlas.",
    "Một username và password, nếu triển khai yêu cầu xác thực.",
    "Database auth source, nếu không phải admin.",
    "Tên replica set, với triển khai dạng replica set.",
    "Với Atlas / từ xa: cần truy cập mạng và SSL/TLS.",
  ],
  connFieldsIntro: "Các mặc định dưới đây khớp với form kết nối MongoDB của TableR. Bí mật được ghi vào keyring của hệ điều hành, không bao giờ vào tệp cấu hình dạng văn bản.",
  fieldRows: [
    ["Host", "Có", "127.0.0.1", "Hostname, hoặc một hostname Atlas."],
    ["Port", "Có", "27017", "Port mặc định của MongoDB (bỏ qua với SRV)."],
    ["Kiểu kết nối", "Không", "Auto-detect", "Auto-detect, SRV (Atlas), hoặc Direct (host:port)."],
    ["Username", "Không", "—", "Tùy chọn; bắt buộc khi triển khai bắt buộc xác thực."],
    ["Password", "Không", "—", "Tùy chọn; lưu trong keyring."],
    ["Database", "Không", "—", "Database mặc định tùy chọn."],
    ["Auth source", "Không", "admin", "Database chứa credential của user."],
    ["Replica set", "Không", "—", "Tùy chọn; tên replica set."],
    ["SSL/TLS", "Không", "Tắt", "Hỗ trợ; Atlas và hầu hết server từ xa bắt buộc."],
  ],
  formSteps: [
    { title: "Chọn MongoDB", text: "Mở trình khởi chạy và chọn thẻ MongoDB." },
    { title: "Chọn kiểu khám phá kết nối", text: "Auto-detect, SRV (Atlas), hoặc Direct. Dùng Direct cho PrivateLink (pl-*.mongodb.net) hoặc server tự cài." },
    { title: "Nhập host và port", text: "Dùng 127.0.0.1 và 27017 cho local, hoặc hostname Atlas." },
    { title: "Thêm credential (tùy chọn)", text: "Thêm username/password và auth source khi triển khai yêu cầu xác thực." },
    { title: "Đặt database / replica set (tùy chọn)", text: "Cung cấp database mặc định và, với replica set, tên của set." },
    { title: "Bật SSL/TLS cho Atlas / remote", text: "Bật SSL/TLS cho Atlas hoặc bất kỳ triển khai từ xa nào." },
    { title: "Lưu và kết nối", text: "Lưu profile để nó xuất hiện lại trong trình khởi chạy, rồi kết nối." },
  ],
  connString: {
    intro: "Thay vì điền từng trường, bạn có thể dán một connection string MongoDB. Cả hai scheme mongodb:// và mongodb+srv:// (Atlas) đều được chấp nhận.",
    code: "mongodb+srv://username:password@cluster.mongodb.net/?retryWrites=true&w=majority",
    bullets: [
      "Dùng mongodb+srv:// cho Atlas, hoặc mongodb://host:27017 cho server trực tiếp hoặc tự cài.",
      "Bỏ password khỏi URI và để TableR lưu nó trong keyring.",
      "Thêm authSource=admin (hoặc database xác thực của bạn) khi user nằm ngoài database đích.",
      "URL-encode các ký tự đặc biệt trong password (ví dụ @ thành %40).",
    ],
  },
  sslIntro: "Server local thường không cần mã hóa. Atlas và hầu hết triển khai từ xa bắt buộc TLS — hãy bật SSL/TLS, hoặc thêm tls=true vào connection string.",
  sslBullets: [
    "Tắt — không mã hóa (chỉ dùng local hoặc mạng tin cậy).",
    "Bật — TLS tới server (Atlas bắt buộc).",
    "Kết nối SRV / Atlas dùng TLS theo mặc định.",
  ],
  verifyLead: "Sau khi kết nối, mở tab truy vấn và chạy vài lệnh MongoDB:",
  verifyLang: "javascript",
  verifyCode: "db.runCommand({ ping: 1 })\ndb.version()",
  verifyTrail: "ping sẽ trả về { ok: 1 }, và db.version() in ra phiên bản của server.",
  troubleshootRows: [
    ["Connection refused / timed out", "Server chưa chạy, sai host/port, hoặc firewall.", "Xác nhận server truy cập được; với Atlas, cho phép IP của bạn trong access list."],
    ["Xác thực thất bại", "Sai credential, hoặc sai auth source.", "Kiểm tra lại username/password và đặt đúng Auth source (thường là admin)."],
    ["DNS / SRV lookup failed", "Sai hostname SRV hoặc không có DNS.", "Kiểm tra lại hostname Atlas, hoặc chuyển khám phá sang Direct."],
    ["TLS required", "Atlas hoặc server bắt buộc TLS.", "Bật SSL/TLS, hoặc thêm tls=true vào connection string."],
  ],
};

const VI_LIBSQL: EngineSpec = {
  slug: "libsql",
  icon: "PlugZap",
  title: "LibSQL",
  description: "Kết nối TableR tới libSQL và database Turso từ xa bằng URL và auth token, các trường kết nối, kiểm tra kết nối và khắc phục sự cố.",
  intro: "libSQL tương thích SQLite và có thể chạy local hoặc như một database Turso từ xa. Trỏ TableR tới một URL libSQL và, với database từ xa, thêm auth token.",
  overviewText: "TableR kết nối tới libSQL qua URL của nó. Một database Turso từ xa truy cập tại your-db.turso.io và xác thực bằng token; server libSQL local dùng URL local. Vì libSQL tương thích SQLite, SQL bạn đã biết vẫn áp dụng.",
  overviewBullets: [
    "Turso từ xa — kết nối tới your-db.turso.io với một auth token.",
    "libSQL local — kết nối tới một URL libSQL local.",
    "Tương thích SQLite — cùng phương ngữ SQL và hàm như SQLite.",
  ],
  beforeYouStart: [
    "Một URL libSQL — your-db.turso.io cho Turso, hoặc một URL libSQL local.",
    "Một auth token, cho database từ xa / Turso.",
    "Port, nếu server local của bạn không dùng 8080.",
  ],
  connFieldsIntro: "Các mặc định dưới đây khớp với form kết nối libSQL của TableR. Auth token được lưu trong keyring của hệ điều hành, không bao giờ vào tệp cấu hình dạng văn bản.",
  fieldRows: [
    ["Host", "Có", "—", "your-db.turso.io, hoặc một URL libSQL local."],
    ["Port", "Không", "8080", "Dùng bởi các server libSQL local."],
    ["Credential", "Không", "—", "Một auth token cho database từ xa / Turso; lưu trong keyring."],
    ["Database", "Không", "—", "Tùy chọn."],
  ],
  formSteps: [
    { title: "Chọn LibSQL", text: "Mở trình khởi chạy và chọn thẻ LibSQL." },
    { title: "Nhập URL libSQL", text: "Dùng your-db.turso.io cho Turso, hoặc URL libSQL local của bạn." },
    { title: "Thêm auth token", text: "Bắt buộc với database từ xa / Turso; lưu vào keyring." },
    { title: "Đặt port (local)", text: "Server local dùng 8080 theo mặc định." },
    { title: "Lưu và kết nối", text: "Lưu profile để nó xuất hiện lại trong trình khởi chạy, rồi kết nối." },
  ],
  connString: {
    intro: "Bạn cũng có thể kết nối bằng một URL libSQL. Database Turso từ xa dùng scheme libsql:// với một auth token.",
    code: "libsql://your-db.turso.io?authToken=YOUR_TOKEN",
    bullets: [
      "Dùng libsql:// cho database Turso từ xa.",
      "Nên lưu token trong keyring hơn là nhúng vào URL.",
      "Với server local, dùng URL libSQL hoặc http(s) của nó.",
    ],
  },
  verifyCode: "SELECT sqlite_version();\nSELECT name FROM sqlite_master WHERE type = 'table';",
  verifyTrail: "Câu lệnh đầu trả về phiên bản tương thích SQLite; câu thứ hai liệt kê các bảng.",
  troubleshootRows: [
    ["Could not connect to URL", "Sai URL libSQL hoặc không có mạng.", "Kiểm tra lại URL (your-db.turso.io) và kết nối của bạn."],
    ["Unauthorized / invalid token", "Thiếu hoặc sai auth token.", "Thêm một auth token hợp lệ; nó được lưu vào keyring."],
    ["Token expired", "Token Turso không còn hợp lệ.", "Tạo token mới và cập nhật credential đã lưu."],
    ["Connection refused (local)", "Server libSQL local chưa chạy, hoặc sai port.", "Khởi động server và xác nhận port (mặc định 8080)."],
  ],
};

const VI_CLOUDFLARE_D1: EngineSpec = {
  slug: "cloudflare-d1",
  icon: "PlugZap",
  title: "Cloudflare D1",
  description: "Kết nối TableR tới Cloudflare D1, SQLite serverless, bằng account ID, database ID và API token, kiểm tra kết nối và khắc phục sự cố.",
  intro: "Cloudflare D1 là SQLite serverless truy cập qua Cloudflare API. Cung cấp account ID, database ID đích, và một API token có quyền D1.",
  overviewText: "TableR truy cập D1 qua Cloudflare API trên HTTPS — không có host hay port để chạy. Bạn xác thực bằng một API token và định danh database bằng account ID và database ID. D1 chạy trên SQLite bên dưới, nên SQL bạn đã biết vẫn áp dụng.",
  overviewBullets: [
    "Serverless — truy cập tại api.cloudflare.com qua HTTPS; không có server để chạy.",
    "Xác thực — một Cloudflare API token có quyền D1.",
    "Định danh — một account ID và một database ID chọn database D1 đích.",
  ],
  beforeYouStart: [
    "Account ID Cloudflare của bạn.",
    "Database ID của database D1 đích.",
    "Một API token có quyền đọc/ghi D1.",
  ],
  connFieldsIntro: "Các trường dưới đây khớp với form kết nối Cloudflare D1 của TableR. API token được lưu trong keyring của hệ điều hành, không bao giờ vào tệp cấu hình dạng văn bản.",
  fieldRows: [
    ["Host", "Có", "api.cloudflare.com", "Endpoint HTTPS; kết nối luôn được mã hóa."],
    ["Credential", "Có", "—", "Một Cloudflare API token có quyền D1; lưu trong keyring."],
    ["Account ID", "Có", "—", "Tài khoản Cloudflare của bạn."],
    ["Database ID", "Có", "—", "Database D1 đích."],
  ],
  formSteps: [
    { title: "Chọn Cloudflare D1", text: "Mở trình khởi chạy và chọn thẻ Cloudflare D1." },
    { title: "Thêm API token", text: "Dán một token có quyền D1; nó được lưu vào keyring." },
    { title: "Nhập account ID", text: "Dùng account ID Cloudflare của bạn." },
    { title: "Nhập database ID", text: "Định danh database D1 đích." },
    { title: "Lưu và kết nối", text: "Lưu profile để nó xuất hiện lại trong trình khởi chạy, rồi kết nối." },
  ],
  verifyCode: "SELECT sqlite_version();\nSELECT name FROM sqlite_master WHERE type = 'table';",
  verifyTrail: "Câu lệnh đầu trả về phiên bản SQLite mà D1 chạy; câu thứ hai liệt kê các bảng.",
  troubleshootRows: [
    ["Authentication error (403)", "Thiếu hoặc sai API token, hoặc không đủ scope.", "Dùng một token có quyền D1 và kiểm tra lại; nó được lưu vào keyring."],
    ["Account not found", "Sai account ID.", "Kiểm tra lại account ID trong Cloudflare dashboard."],
    ["Database not found", "Sai database ID.", "Kiểm tra lại database ID của D1."],
    ["Rate limited (429)", "Quá nhiều request API.", "Chờ và thử lại; giảm tần suất request."],
  ],
};

/* ------------------------------------------------------------------ */
/* English content                                                     */
/* ------------------------------------------------------------------ */

const en: DocsBundle = {
  label: "Documentation",
  tagline: "Everything you need to install, connect, query, and understand TableR.",
  homeLabel: "Home",
  downloadLabel: "Download",
  githubLabel: "GitHub",
  onThisSection: "In this section",
  previous: "Previous",
  next: "Next",
  menu: "Documentation menu",
  groups: [
    { label: "Getting started", slugs: ["", "getting-started"] },
    {
      label: "Guides",
      slugs: [
        "connections",
        "plugins",
        "sql-workspace",
        "exploring-data",
        "visualize",
        "ai-agent",
      ],
    },
    { label: "Reference", slugs: ["shortcuts", "architecture"] },
    { label: "Help", slugs: ["faq"] },
  ],
  pages: [
    {
      slug: "",
      icon: "BookOpen",
      title: "Introduction",
      description:
        "TableR is a fast, cross-platform desktop workspace for exploring schemas, writing SQL, visualizing results, and working with AI.",
      blocks: [
        { type: "p", text:
          "TableR brings the tools used during day-to-day database work into one native desktop application. Browse database objects, write and run SQL in Monaco, inspect or export results, build charts and ER diagrams, and keep a database-aware AI assistant beside the query instead of in another window." },
        { type: "image", src: "/screenshots/table-r-query-workspace.png", alt: "TableR query workspace with SQL editor and result table", width: 1280, height: 801 },
        { type: "callout", tone: "tip", title: "New here? Start in two minutes", text:
          "Head to Getting started to install a release and run your first query, then come back for the bigger picture. Prefer to read first? Keep scrolling." },
        { type: "h2", text: "Why TableR" },
        { type: "p", text:
          "Most database work is scattered across a query tool, a schema browser, a diagramming app, an export script, and a separate AI chat window. Every switch drops context. TableR collapses that into one local-first workspace so the schema, the query, the results, and the assistant stay in a single view — and stay on your machine." },
        { type: "ul", items: [
          "One workspace — editor, explorer, results, charts, diagrams, terminal, and AI without leaving the window.",
          "Local-first — the desktop app does the work on your machine; connection secrets live in the OS keyring and never touch this website.",
          "Safe by default — a six-level SQL Safe Mode plus a review-before-run flow keep destructive statements behind an explicit confirmation.",
          "Broad coverage — 18 relational, analytical, embedded, NoSQL, and cloud engines behind one consistent interface.",
          "Open source — GPLv3, so you can read the code, open an issue, or contribute the workflow you wish existed.",
        ] },
        { type: "h2", text: "What you get" },
        { type: "cards", items: [
          { title: "SQL workspace", text: "Monaco editor, multiple query tabs, formatting, execution timing, explain tools, history, and favorites." },
          { title: "Data exploration", text: "Searchable schema explorer, table browsing, row inspection, pagination, sorting, and filtering." },
          { title: "Results and exports", text: "Table and chart views with CSV, JSON, Excel, and SQL-oriented export workflows." },
          { title: "Visual database tools", text: "Interactive ER diagrams, minimap and layout controls, metrics boards, and query plan visualization." },
          { title: "AI assistance", text: "Prompt, Edit, and Agent modes with schema context, attachments, review-before-run SQL, and configurable providers." },
          { title: "Desktop workflow", text: "Saved connections, local database bootstrap, OS keyring credentials, command palette, terminal, and session persistence." },
        ] },
        { type: "h2", text: "Design principles" },
        { type: "p", text:
          "A few ideas shape every screen in TableR. Knowing them up front makes the rest of these docs easier to navigate." },
        { type: "cards", items: [
          { title: "Local-first", text: "Your databases, credentials, and query history stay on your machine. The desktop app connects directly; this site only documents it." },
          { title: "Safe to explore", text: "Safe Mode classifies every statement, and destructive DDL stays blocked or gated behind confirmation — so you can poke at production-like data without fear." },
          { title: "Keyboard-driven", text: "New tab, run, format, command palette, and the AI panel are each one shortcut away, and every binding is remappable in settings." },
          { title: "Consistent across engines", text: "The same connection form, workspace, and result tools work whether you point at PostgreSQL, ClickHouse, MongoDB, or Cloudflare D1." },
        ] },
        { type: "h2", text: "Who it is for" },
        { type: "p", text:
          "TableR is built for software engineers and database-focused developers who inspect production-like databases, write SQL, edit small data sets, move data in and out, and use AI to investigate — while keeping control over every database write. Analysts and data teams who want one calm workspace across relational, analytical, document, cache, and cloud engines are right at home too." },
        { type: "callout", tone: "info", title: "Open source", text:
          "TableR is distributed under the GNU General Public License v3.0. You can read the code, open an issue, or contribute the workflow you wish existed." },
        { type: "h2", text: "How these docs are organized" },
        { type: "p", text:
          "The sidebar follows the order you will likely need it: install, connect, query, explore, visualize, then automate with AI. Jump straight to a section below." },
        { type: "cards", items: [
          { title: "Getting started", text: "Install a release or build from source, then run your first query.", href: "/docs/getting-started" },
          { title: "Connections & databases", text: "The launcher, all 18 supported engines, and local bootstrap.", href: "/docs/connections" },
          { title: "SQL workspace", text: "The Monaco editor, tabs, execution model, Safe Mode, history, and export.", href: "/docs/sql-workspace" },
          { title: "Exploring data", text: "Schema explorer, table browsing, the row inspector, and structure tools.", href: "/docs/exploring-data" },
          { title: "Visualize & diagrams", text: "ER diagrams, charts, metrics boards, and query plans.", href: "/docs/visualize" },
          { title: "AI & Agent", text: "Prompt, Edit, and Agent modes, autonomy, and the safety model.", href: "/docs/ai-agent" },
          { title: "Keyboard shortcuts", text: "The full reference for working without leaving the keyboard.", href: "/docs/shortcuts" },
          { title: "Architecture & FAQ", text: "How the app is built, plus answers to common questions.", href: "/docs/architecture" },
        ] },
      ],
    },
    {
      slug: "getting-started",
      icon: "Rocket",
      title: "Getting started",
      description: "Install a prebuilt release, or build TableR from source for development.",
      blocks: [
        { type: "callout", tone: "tip", title: "Get started in 4 steps", steps: [
          "Download the installer marked Recommended for your OS.",
          "Install and launch TableR.",
          "Create a connection — or bootstrap a local database — from the launcher.",
          "Open a query tab (Ctrl + N) and run your first statement (Ctrl + Enter).",
        ] },
        { type: "p", text: "There are two ways to get TableR: install a prebuilt release (fastest, recommended for most people) or build it from source (for contributors and anyone who wants the latest development branch). Both are covered below." },
        { type: "h2", text: "Install a release" },
        { type: "p", text: "Prebuilt installers are available for Windows, macOS, and Linux. Downloads redirect straight to the official GitHub release assets." },
        { type: "steps", items: [
          { title: "Download", text: "Open the Download page and pick the option marked Recommended for your operating system." },
          { title: "Install", text: "Windows: run the setup .exe or .msi. macOS: open the .dmg and drag TableR to Applications. Linux: use the AppImage, .deb, or .rpm." },
          { title: "Launch", text: "Open TableR and create your first connection, or start a local database from the launcher." },
        ] },
        { type: "callout", tone: "warn", title: "macOS: unsigned build", text:
          "Move TableR to Applications, try to open it once, then choose Open Anyway in System Settings → Privacy & Security. If Gatekeeper still blocks it, run the command below and open it again. This does not mean the app is Apple-notarized." },
        { type: "code", lang: "bash", code: MACOS_QUARANTINE },
        { type: "h2", text: "System requirements" },
        { type: "p", text: "TableR is a native desktop app built on Tauri 2, so it reuses your operating system's web runtime and stays small and fast." },
        { type: "ul", items: [
          "Windows 10 or 11 (64-bit). The WebView2 runtime is required and is already present on Windows 11.",
          "macOS 11 Big Sur or newer, on both Apple Silicon and Intel.",
          "A modern 64-bit Linux distribution with WebKitGTK (pulled in automatically by the .deb and .rpm packages).",
          "About 200 MB of free disk space, plus extra room for any local databases you create.",
        ] },
        { type: "h2", text: "Create your first connection" },
        { type: "p", text: "The connection launcher is the first screen you see. Open a saved workspace, or start a new connection to any of the 18 supported engines." },
        { type: "steps", items: [
          { title: "Choose an engine", text: "Pick a card in the launcher. Each one shows whether it supports remote connections, file databases, or a local bootstrap." },
          { title: "Enter details", text: "Provide host, port, and credentials, paste a full connection string, or select a database file where supported." },
          { title: "Connect and save", text: "Test the connection, then save the profile so it reappears in the launcher the next time you open TableR." },
        ] },
        { type: "callout", tone: "info", title: "No server? Bootstrap one locally", text: "TableR can start a local PostgreSQL, MySQL, MariaDB, or SQLite database straight from the launcher, so you can begin querying without installing a separate server. Connection secrets are always kept in the OS keyring." },
        { type: "p", text: "See Connections & databases for the full engine list and every connection option." },
        { type: "h2", text: "Run your first query" },
        { type: "ol", items: [
          "Open a new query tab with Ctrl + N.",
          "Type SQL in the Monaco editor; autocomplete and schema hints appear as you type (Ctrl + Space forces suggestions).",
          "Press Ctrl + Enter to run the statement under the cursor.",
          "Read the results grid — sort, filter, and page through rows, or switch to the chart view.",
          "Export the result set to CSV, JSON, Excel, or SQL when you want to share it.",
        ] },
        { type: "h2", text: "Explore and visualize" },
        { type: "p", text: "Beyond running SQL, TableR ships a searchable schema explorer, interactive ER diagrams, metrics boards, and query-plan visualization, so you can understand a database rather than just query it. See Exploring data and Visualize for the details." },
        { type: "h2", text: "Ask the built-in AI assistant" },
        { type: "p", text: "A database-aware assistant sits beside the editor with Prompt, Edit, and Agent modes. It reads your schema for context, accepts file attachments, and always shows the generated SQL for review before anything runs. See AI agent for provider setup." },
        { type: "h2", text: "Troubleshooting first launch" },
        { type: "steps", items: [
          { title: "Windows SmartScreen", text: "If Defender SmartScreen warns about an unrecognized app, choose More info, then Run anyway. The installers are not code-signed yet." },
          { title: "macOS Gatekeeper", text: "Use Open Anyway in System Settings, Privacy & Security, or run the quarantine command shown above." },
          { title: "Linux AppImage", text: "Mark the download as executable before you run it:" },
        ] },
        { type: "code", lang: "bash", code: "chmod +x TableR-*.AppImage\n./TableR-*.AppImage" },
        { type: "h2", text: "Update TableR" },
        { type: "p", text: "To update, download the newest release from the Download page and install it over the current version. Saved connections live in the OS keyring and your preferences are stored locally, so they carry across updates." },
        { type: "h2", text: "Build from source" },
        { type: "p", text: "The Tauri development command starts Vite, builds the Rust backend, and opens the desktop application with hot reload." },
        { type: "code", lang: "bash", code: CODE_CLONE },
        { type: "h3", text: "Prerequisites" },
        { type: "ul", items: [
          "Node.js 18 or newer",
          "npm",
          "Rust (stable toolchain)",
          "Platform dependencies required by Tauri 2",
        ] },
        { type: "h3", text: "Useful commands" },
        { type: "table", head: ["Command", "Purpose"], rows: [
          [COMMANDS[0], "Start the frontend development server"],
          [COMMANDS[1], "Run the complete desktop application"],
          [COMMANDS[2], "Type-check TypeScript without emitting files"],
          [COMMANDS[3], "Run the Vitest suite once"],
          [COMMANDS[4], "Type-check and build the frontend"],
          [COMMANDS[5], "Create platform-specific desktop bundles"],
          [COMMANDS[6], "Start this public product website"],
        ] },
        { type: "callout", tone: "tip", title: "Before you contribute", text: "Run the quality gate before submitting a change:" },
        { type: "code", lang: "bash", code: CODE_QUALITY },
        { type: "h2", text: "Next steps" },
        { type: "cards", items: [
          { title: "Connections & databases", text: "Connect to all 18 engines, or bootstrap one locally.", href: "/docs/connections" },
          { title: "SQL workspace", text: "Tabs, formatting, the execution model, history, and favorites.", href: "/docs/sql-workspace" },
          { title: "Exploring data", text: "Schema explorer, table browsing, and row inspection.", href: "/docs/exploring-data" },
          { title: "Visualize & diagrams", text: "Charts, ER diagrams, and query-plan views.", href: "/docs/visualize" },
          { title: "AI & Agent", text: "Prompt, Edit, and Agent modes with schema context.", href: "/docs/ai-agent" },
          { title: "Keyboard shortcuts", text: "The full reference for working faster.", href: "/docs/shortcuts" },
        ] },
      ],
    },
    {
      slug: "connections",
      icon: "PlugZap",
      title: "Connections & databases",
      description: "Save workspaces, bootstrap local databases, and connect to 18 engines.",
      blocks: [
        { type: "p", text: "Reopen a saved workspace, or create a new one from 18 ready engines. The picker shows what each engine can do — remote connections, file databases, or a local bootstrap — before you fill in the form." },
        { type: "image", src: "/screenshots/table-r-connection-launcher.png", alt: "TableR connection launcher showing saved connections", width: 1280, height: 801 },
        { type: "callout", tone: "info", title: "Credentials stay local", text: "Connection secrets are stored in the operating system keyring, not in the interface or in plain configuration files." },
        { type: "h2", text: "Create a connection" },
        { type: "steps", items: [
          { title: "Choose an engine", text: "Pick from the launcher. Each card indicates remote, file-based, or local-bootstrap support." },
          { title: "Provide details", text: "Fill in host, port, and credentials, use a connection string, or select a database file where supported." },
          { title: "Save and reopen", text: "Saved profiles appear in the launcher so you can jump back into recent work instantly." },
        ] },
        { type: "h2", text: "Supported databases" },
        { type: "p", text: "TableR currently exposes connection workflows for 18 database engines." },
        { type: "table", head: ["Category", "Engines"], rows: [
          ["Relational & analytical", "PostgreSQL, MySQL, MariaDB, CockroachDB, Greenplum, Amazon Redshift, SQL Server, Vertica, ClickHouse, Snowflake, BigQuery"],
          ["Embedded & file-based", "SQLite, DuckDB"],
          ["NoSQL & cloud-native", "Cassandra, Redis, MongoDB, LibSQL, Cloudflare D1"],
        ] },
        { type: "callout", tone: "info", title: "Feature depth varies by engine", text: "Metadata, explain plans, schema editing, and export behavior depend on each database driver, so capabilities can differ between engines." },
        { type: "h2", text: "Local bootstrap" },
        { type: "p", text: "Local bootstrap lets TableR start a database for you with no external server. It is ready for PostgreSQL, MySQL, MariaDB, SQLite, and SQL Server (MongoDB is planned). Existing databases can also be opened through saved connection profiles, connection strings, or file selection where supported." },
        { type: "h2", text: "Connecting to each engine" },
        { type: "p", text: "These defaults match TableR's connection form. Network engines share the same core fields — Host, Port, optional SSL/TLS, and credentials (secrets are saved to the OS keyring); file engines just point at a database file. You can also paste a connection string where an engine supports it. Only the extra fields below change per engine." },
        { type: "cards", items: [
          { title: "PostgreSQL — in-depth guide", text: "Connection fields, connection strings, SSL/TLS, local bootstrap, verifying the connection, and troubleshooting — on its own page.", href: "/docs/postgresql" },
          { title: "MySQL — in-depth guide", text: "Connection fields, connection strings, SSL/TLS, local bootstrap, verifying the connection, and troubleshooting — on its own page.", href: "/docs/mysql" },
          { title: "MariaDB — in-depth guide", text: "MySQL-compatible connection fields, connection strings, SSL/TLS, local bootstrap, and troubleshooting — on its own page.", href: "/docs/mariadb" },
          { title: "SQL Server — in-depth guide", text: "Windows or SQL authentication, connection fields, encryption, local bootstrap, and troubleshooting — on its own page.", href: "/docs/sql-server" },
          { title: "CockroachDB — in-depth guide", text: "PostgreSQL-compatible connection fields, connection strings, SSL/TLS, and troubleshooting — on its own page.", href: "/docs/cockroachdb" },
          { title: "Greenplum — in-depth guide", text: "PostgreSQL-compatible analytics warehouse: connection fields, connection strings, SSL/TLS, and troubleshooting — on its own page.", href: "/docs/greenplum" },
          { title: "Amazon Redshift — in-depth guide", text: "PostgreSQL-compatible cloud warehouse: connection fields, connection strings, SSL/TLS, and troubleshooting — on its own page.", href: "/docs/amazon-redshift" },
          { title: "Vertica — in-depth guide", text: "Columnar analytics: connection fields, SSL/TLS, verifying the connection, and troubleshooting — on its own page.", href: "/docs/vertica" },
          { title: "ClickHouse — in-depth guide", text: "HTTP-interface connection fields, SSL/TLS, verifying the connection, and troubleshooting — on its own page.", href: "/docs/clickhouse" },
          { title: "Snowflake — in-depth guide", text: "Cloud warehouse over HTTPS: account host, warehouse, role, connection fields, verifying the connection, and troubleshooting — on its own page.", href: "/docs/snowflake" },
          { title: "BigQuery — in-depth guide", text: "Serverless Google Cloud warehouse: service-account auth, project and dataset, verifying the connection, and troubleshooting — on its own page.", href: "/docs/bigquery" },
          { title: "SQLite — in-depth guide", text: "File-based database: pick or create a file, local bootstrap, verifying the connection, and troubleshooting — on its own page.", href: "/docs/sqlite" },
          { title: "DuckDB — in-depth guide", text: "Embedded analytics in a single file: open mode, verifying the connection, and troubleshooting — on its own page.", href: "/docs/duckdb" },
          { title: "Cassandra — in-depth guide", text: "CQL contact points, keyspace, optional auth and SSL/TLS, verifying the connection, and troubleshooting — on its own page.", href: "/docs/cassandra" },
          { title: "Redis — in-depth guide", text: "In-memory key-value store: ACL user, database index, optional TLS, verifying the connection, and troubleshooting — on its own page.", href: "/docs/redis" },
          { title: "MongoDB — in-depth guide", text: "Atlas SRV or direct hosts: connection discovery, auth source, replica set, SSL/TLS, connection strings, and troubleshooting — on its own page.", href: "/docs/mongodb" },
          { title: "LibSQL — in-depth guide", text: "libSQL and remote Turso databases: URL and auth token, verifying the connection, and troubleshooting — on its own page.", href: "/docs/libsql" },
          { title: "Cloudflare D1 — in-depth guide", text: "Serverless SQLite via the Cloudflare API: account ID, database ID, API token, verifying the connection, and troubleshooting — on its own page.", href: "/docs/cloudflare-d1" },
        ] },
      ],
    },
    buildEnginePage(EN_ENGINE_LABELS, EN_POSTGRESQL),
    buildEnginePage(EN_ENGINE_LABELS, EN_MYSQL),
    buildEnginePage(EN_ENGINE_LABELS, EN_MARIADB),
    buildEnginePage(EN_ENGINE_LABELS, EN_COCKROACHDB),
    buildEnginePage(EN_ENGINE_LABELS, EN_GREENPLUM),
    buildEnginePage(EN_ENGINE_LABELS, EN_AMAZON_REDSHIFT),
    buildEnginePage(EN_ENGINE_LABELS, EN_SQL_SERVER),
    buildEnginePage(EN_ENGINE_LABELS, EN_VERTICA),
    buildEnginePage(EN_ENGINE_LABELS, EN_CLICKHOUSE),
    buildEnginePage(EN_ENGINE_LABELS, EN_SNOWFLAKE),
    buildEnginePage(EN_ENGINE_LABELS, EN_BIGQUERY),
    buildEnginePage(EN_ENGINE_LABELS, EN_SQLITE),
    buildEnginePage(EN_ENGINE_LABELS, EN_DUCKDB),
    buildEnginePage(EN_ENGINE_LABELS, EN_CASSANDRA),
    buildEnginePage(EN_ENGINE_LABELS, EN_REDIS),
    buildEnginePage(EN_ENGINE_LABELS, EN_MONGODB),
    buildEnginePage(EN_ENGINE_LABELS, EN_LIBSQL),
    buildEnginePage(EN_ENGINE_LABELS, EN_CLOUDFLARE_D1),
    {
      slug: "plugins",
      icon: "Puzzle",
      title: "Plugins & drivers",
      description:
        "TableR ships lean and adds database engines as installable driver plugins — install from the app, the plugin store, or a downloaded bundle.",
      blocks: [
        { type: "p", text:
          "TableR keeps a small, fast core and adds most database engines as plugins you install on demand. Instead of one heavy build with every driver compiled in, you install only the engines you actually use — and the app verifies each bundle before it loads." },
        { type: "callout", tone: "tip", title: "Browse the plugin store", text:
          "Every official driver is listed on the plugin store with one-click bundle downloads and per-plugin install steps. The store link is at the bottom of this page." },
        { type: "h2", text: "Why plugins" },
        { type: "ul", items: [
          "Lean core — the base app stays small; you add engines only when you need them.",
          "Independent updates — a driver can ship a fix without waiting for a full app release.",
          "Verified on install — the app recomputes each bundle's SHA-256 digest and refuses anything that does not match its manifest.",
          "Explicit permissions — every plugin declares exactly which capabilities it uses (metadata, read, execute, network), shown before you install.",
        ] },
        { type: "h2", text: "Two kinds of driver" },
        { type: "p", text:
          "Driver plugins come in two runtimes. The difference decides how a plugin connects and whether it needs a compiled binary." },
        { type: "table",
          head: ["Type", "Runtime", "How it connects", "Install"],
          rows: [
            ["Cloud / HTTP", "declarative-http-v1", "Talks to the database over HTTPS", "Installs instantly from the registry — manifest-only, no binary"],
            ["Native", "driver-sidecar-v1", "Out-of-process driver over a native protocol", "Also needs a per-OS binary from a full release build"],
          ] },
        { type: "p", text:
          "Cloud / HTTP drivers today: Google BigQuery, ClickHouse, Cloudflare D1, OpenSearch, and Snowflake. Native drivers: DuckDB, Cassandra, Redis, and LibSQL — these connect once the matching binary is present." },
        { type: "h2", text: "Install a plugin" },
        { type: "steps", items: [
          { title: "From the Official registry", text: "In the app, open App menu → Plugin Manager → Official registry, then click Install next to the engine. Cloud / HTTP drivers are ready to use immediately." },
          { title: "From a downloaded bundle", text: "Download a bundle from the plugin store, unzip it, then choose Install plugin and pick the unzipped folder — the one that directly contains plugin.json." },
          { title: "Native drivers", text: "Install as above, then make sure the matching per-OS binary from a full release build is present. Without it the driver imports but cannot connect yet." },
        ] },
        { type: "callout", tone: "info", title: "Manifest-only bundles", text:
          "A cloud / HTTP driver bundle is just its signed manifest — there is no compiled code to download, so it installs and connects the moment the registry entry is verified." },
        { type: "h2", text: "How install stays safe" },
        { type: "p", text:
          "On import the host recomputes the bundle's SHA-256 digest byte-for-byte and rejects the bundle unless it equals the digest recorded in the manifest. Downloaded assets are additionally checked by size and hash before they are written. Credentials stay on your machine and never touch the website that hosts the plugins." },
        { type: "h2", text: "Browse & download" },
        { type: "cards", items: [
          { title: "Open the plugin store", text: "Browse every official driver, review permissions, and download bundles.", href: "/plugins" },
          { title: "Connections & databases", text: "See all supported engines and how to connect once a driver is installed.", href: "/docs/connections" },
        ] },
      ],
    },
    {
      slug: "sql-workspace",
      icon: "Code2",
      title: "SQL workspace",
      description: "Write SQL in Monaco with tabs, a predictable execution model, Safe Mode, history, favorites, and a terminal.",
      blocks: [
        { type: "p", text: "The query workspace keeps the editor, data, and tools in one view. Explore objects from the sidebar, write SQL with Monaco, run it with a predictable timeout-and-cancel model, inspect results as a table or chart, and drop into the terminal without breaking context." },
        { type: "image", src: "/screenshots/table-r-query-workspace.png", alt: "TableR query workspace with SQL editor and result table", width: 1280, height: 801 },
        { type: "h2", text: "The workspace at a glance" },
        { type: "ul", items: [
          "Database explorer on the left (toggle with Ctrl + B) for schemas, tables, and columns.",
          "A Monaco editor in the center with SQL awareness, autocomplete, and formatting.",
          "Multiple query tabs so related statements stay side by side.",
          "A results panel below the editor (toggle with Ctrl + Shift + `) with table and chart views.",
          "An integrated terminal dock (toggle with Ctrl + `) and the AI panel (toggle with Ctrl + Space).",
        ] },
        { type: "h2", text: "Write SQL in Monaco" },
        { type: "p", text: "The editor is the same engine that powers VS Code, tuned for SQL. Autocomplete and schema hints appear as you type; press Ctrl + Space to force suggestions, and Ctrl + Shift + F to format the current statement." },
        { type: "ul", items: [
          "Schema-aware completion for databases, tables, and columns on the active connection.",
          "One-key formatting to normalize spacing, casing, and indentation.",
          "Multiple tabs (Ctrl + N) to keep exploratory queries, edits, and reports separate.",
          "The quick switcher (Ctrl + P) and command palette (Ctrl + Shift + P) jump between tabs, objects, and actions.",
        ] },
        { type: "h2", text: "Run a query" },
        { type: "steps", items: [
          { title: "Open a query tab", text: "Press Ctrl + N to create a new tab bound to the active connection." },
          { title: "Write SQL", text: "Type your statement in Monaco. Format it with Ctrl + Shift + F if you like." },
          { title: "Execute", text: "Press Ctrl + Enter to run the statement under the cursor. Results appear below with the execution time." },
          { title: "Reuse it", text: "Save it to favorites (Ctrl + Shift + S) or find it later in history (Ctrl + H)." },
        ] },
        { type: "callout", tone: "tip", title: "Run exactly what you mean", text: "Ctrl + Enter runs the statement under the cursor, not the whole tab — so a scratch tab full of queries only executes the one you are on." },
        { type: "h2", text: "Timeouts and cancellation" },
        { type: "p", text: "TableR classifies each run before it executes and applies a timeout based on how risky the batch is. Read-only work gets a generous window; anything that mutates data or schema gets a tighter one." },
        { type: "table", head: ["Statement kind", "Timeout", "Notes"], rows: [
          ["Read-only (SELECT / SHOW / EXPLAIN / WITH)", "180 seconds", "The long window for exploration and reporting."],
          ["Mutating or schema (INSERT / UPDATE / DELETE / DDL, including mutating CTEs)", "60 seconds", "Applied to writes and structure changes."],
          ["Mixed batch", "60 seconds", "If a batch contains any write, the whole batch uses the shorter window."],
        ] },
        { type: "p", text: "Cancel a running query at any time. Cancellation unblocks the UI immediately; on PostgreSQL and MySQL/MariaDB, TableR also stops the statement on the server by issuing the cancel over a second connection, so it does not queue behind the query it is cancelling." },
        { type: "callout", tone: "info", title: "SQLite cancellation is best-effort", text: "The embedded SQLite driver has no public interrupt API, so cancelling stops TableR from waiting, but the engine may finish the statement in the background." },
        { type: "h2", text: "Stay safe with Safe Mode" },
        { type: "p", text: "Safe Mode is a six-level gradient over statement kind. It decides — before a statement runs — whether it executes freely, needs a confirmation, or is blocked outright. Raise the level when you are working against important data." },
        { type: "table", head: ["Level", "Label", "Effect"], rows: [
          ["0", "Disabled", "Statement-kind guard off (the capability guard still runs)."],
          ["1", "Read Only", "Only SELECT / SHOW / EXPLAIN / WITH; all writes blocked."],
          ["2", "Low Risk", "SELECT and INSERT only; UPDATE / DELETE blocked."],
          ["3", "Standard", "INSERT / UPDATE / DELETE need confirmation; DROP / TRUNCATE / most ALTER / CREATE TABLE blocked."],
          ["4", "Strict", "Confirmation for all writes; DROP / TRUNCATE / CREATE TABLE hard-blocked."],
          ["5", "Paranoid", "Confirmation for SELECT and every write, with a preview and estimated affected rows."],
        ] },
        { type: "callout", tone: "warn", title: "A floor you cannot turn off", text: "Regardless of level, a capability guard blocks SQL that touches the filesystem, network, or OS (for example pg_read_file, LOAD_FILE, COPY … TO PROGRAM, xp_cmdshell). It runs even at level 0 and has no bypass." },
        { type: "h2", text: "History and favorites" },
        { type: "ul", items: [
          "Query history (Ctrl + H) records what you ran so you can re-open or re-run it.",
          "SQL favorites (Ctrl + Shift + S) save statements you reach for often.",
          "Tabs and session state persist, so reopening TableR brings your work back.",
        ] },
        { type: "h2", text: "Results, charts, and export" },
        { type: "p", text: "Every result set opens in a fast, virtualized grid you can sort, filter, and page through — even on large tables. Switch the same result between a table and a chart, then export it when you need to share." },
        { type: "ul", items: [
          "Table view with sorting, filtering, and pagination for big result sets.",
          "Chart view to visualize the same rows without a round trip.",
          "Export to CSV, JSON, Excel, or SQL-oriented formats.",
        ] },
        { type: "h2", text: "Integrated terminal" },
        { type: "p", text: "Toggle a terminal dock with Ctrl + ` to run shell commands next to your queries — handy for migrations, scripts, or a quick psql/mysql session — without leaving the workspace." },
        { type: "callout", tone: "tip", title: "Stay on the keyboard", text: "Ctrl + Enter runs, Ctrl + Space toggles the AI panel, Ctrl + B the explorer, and Ctrl + ` the terminal — most of a session never needs the mouse." },
        { type: "h2", text: "Next steps" },
        { type: "cards", items: [
          { title: "Exploring data", text: "Browse schemas, inspect rows, and compare structures.", href: "/docs/exploring-data" },
          { title: "Visualize & diagrams", text: "Turn results into charts, ER diagrams, and query plans.", href: "/docs/visualize" },
          { title: "AI & Agent", text: "Generate and review SQL with schema context and the safety model.", href: "/docs/ai-agent" },
        ] },
      ],
    },
    {
      slug: "exploring-data",
      icon: "Table",
      title: "Exploring data",
      description: "Browse schemas, page through large tables, inspect rows, compare structures, and edit data safely.",
      blocks: [
        { type: "p", text: "TableR gives you a searchable schema explorer plus focused tools for reading, understanding, and editing table data without writing boilerplate queries. It is designed to stay smooth on real-world databases — hundreds of tables and tables with millions of rows." },
        { type: "h2", text: "Schema explorer" },
        { type: "p", text: "The explorer on the left is the map of your connection. Search narrows it instantly, and toggling it with Ctrl + B reclaims the whole width for the editor and results." },
        { type: "ul", items: [
          "Search across databases, schemas, tables, and columns at once.",
          "Expand an object to see its columns, keys, and indexes inline.",
          "Open a table straight into the data browser, or jump to its structure view.",
          "Toggle the explorer with Ctrl + B; use the quick switcher (Ctrl + P) to jump to an object by name.",
        ] },
        { type: "h2", text: "Browse table data" },
        { type: "p", text: "Opening a table loads its rows into a virtualized grid built for scale. Only the visible rows render, so scrolling stays responsive whether the table has a hundred rows or a million." },
        { type: "ul", items: [
          "Pagination, sorting, and filtering to find the rows you care about.",
          "Column resizing, reordering, visibility, and pinning to shape the view.",
          "Per-table layout that is remembered, so a table reopens the way you left it.",
        ] },
        { type: "callout", tone: "info", title: "Built for large tables", text: "The data grid is virtualized and pages results, so browsing a million-row table stays smooth and stays within bounded memory." },
        { type: "h2", text: "Inspect a single row" },
        { type: "p", text: "Wide tables are hard to read across. The row inspector opens one record in a tall, readable panel — long text, JSON, and binary-ish columns included — so you can study or copy a value without horizontal scrolling." },
        { type: "h2", text: "Understand structure" },
        { type: "ul", items: [
          "Structure view for a table's columns, data types, keys, and indexes.",
          "Schema diff to compare two structures and spot drift between environments.",
          "Create-schema-object helpers that draft the DDL for common tasks so you can review it before running.",
        ] },
        { type: "callout", tone: "info", title: "Depth varies by engine", text: "Metadata richness, explain plans, and schema editing depend on each database driver, so some engines expose more structure detail than others." },
        { type: "h2", text: "Edit data safely" },
        { type: "p", text: "TableR supports inline edits directly in the grid, with change tracking so you can see exactly what will be written. Edits, pastes, fills, and deletes target the rows you selected, and are staged for review before they commit — the same review-before-run principle used everywhere in the app." },
        { type: "callout", tone: "warn", title: "You are always in control of writes", text: "Data edits are previewed and applied by you. Nothing is written silently, and Safe Mode still governs the underlying statements." },
        { type: "h2", text: "Move data in and out" },
        { type: "p", text: "Preview and import CSV files, and export any result set or table to CSV, JSON, Excel, or SQL-oriented formats. Large transfers stream with progress and can be cancelled, so a big export does not lock up the app." },
        { type: "callout", tone: "tip", title: "Results your way", text: "Switch any result set between a table and a chart, then export it — the view you are looking at is the shape you can share." },
        { type: "h2", text: "Next steps" },
        { type: "cards", items: [
          { title: "SQL workspace", text: "Write and run SQL against what you just explored.", href: "/docs/sql-workspace" },
          { title: "Visualize & diagrams", text: "Turn tables and relationships into ER diagrams and charts.", href: "/docs/visualize" },
          { title: "Connections & databases", text: "Add another engine or bootstrap a local database.", href: "/docs/connections" },
        ] },
      ],
    },
    {
      slug: "visualize",
      icon: "Network",
      title: "Visualize & diagrams",
      description: "Build ER diagrams, chart results, track metrics, and read query plans visually.",
      blocks: [
        { type: "p", text: "Sometimes the fastest way to understand a database is to see it. TableR turns tables into ER diagrams, result sets into charts, and query plans into a readable graph — so you can explain a schema, spot a slow step, or hand a picture to the next person in the conversation." },
        { type: "image", src: "/screenshots/table-r-er-diagram.png", alt: "TableR ER diagram workspace displaying tables and relationships", width: 1280, height: 801 },
        { type: "h2", text: "ER diagrams" },
        { type: "p", text: "Build an entity-relationship diagram from the tables you select. TableR reads foreign keys to draw the relationships, then lays the graph out for you." },
        { type: "steps", items: [
          { title: "Select tables", text: "Choose the tables that matter to the model you are describing — a feature area, not the whole database." },
          { title: "Auto-layout", text: "Let TableR arrange the graph, then fit the canvas to frame it." },
          { title: "Inspect", text: "Follow the lines between tables to trace foreign keys and cardinality." },
          { title: "Export", text: "Save the diagram as PNG to share, or export SQL for the modeled tables." },
        ] },
        { type: "h3", text: "Navigate large schemas" },
        { type: "ul", items: [
          "A minimap keeps you oriented when the graph is bigger than the screen.",
          "Zoom, pan, and fit-to-canvas controls move you around quickly.",
          "Drag tables to refine the auto-layout when you want a specific arrangement.",
        ] },
        { type: "h2", text: "Charts" },
        { type: "p", text: "Any result set can become a chart without a round trip to the database. Run a query, switch the result to the chart view, and pick how to plot it — useful for a quick trend or a figure to drop into a report." },
        { type: "ul", items: [
          "Chart any result set with the built-in chart view (powered by Recharts).",
          "Choose the columns that map to the axes and series.",
          "Flip between table and chart on the same result at any time.",
        ] },
        { type: "h2", text: "Metrics boards" },
        { type: "p", text: "Pin the numbers you check often — row counts, totals, health figures — to a metrics board so they stay visible while you work, instead of re-running the same query by hand." },
        { type: "h2", text: "Query plan visualization" },
        { type: "p", text: "Explain a statement to see how the engine intends to run it, rendered as a graph rather than raw text. Follow the steps to find the expensive scan or join, then adjust the query or add an index." },
        { type: "callout", tone: "info", title: "Explain depth varies by engine", text: "Plan detail depends on the database driver, so the richness of the visualization differs between engines." },
        { type: "h2", text: "Next steps" },
        { type: "cards", items: [
          { title: "Exploring data", text: "Find the tables and relationships worth diagramming.", href: "/docs/exploring-data" },
          { title: "SQL workspace", text: "Write the queries behind your charts and plans.", href: "/docs/sql-workspace" },
          { title: "AI & Agent", text: "Ask the assistant to draft the query or explain the plan.", href: "/docs/ai-agent" },
        ] },
      ],
    },
    {
      slug: "ai-agent",
      icon: "Bot",
      title: "AI & Agent",
      description: "Prompt, Edit, and Agent modes with schema context, an autonomy dial, Safe Mode, and review-before-run safety.",
      blocks: [
        { type: "p", text: "TableR keeps schema context, generated SQL, query execution, and the assistant in the same view. Ask a question, generate or rewrite a statement, or hand the agent a multi-step task — and stay in control of every database write through an autonomy dial and Safe Mode." },
        { type: "image", src: "/screenshots/table-r-ai-workspace.png", alt: "TableR AI workspace beside the SQL editor", width: 1280, height: 801 },
        { type: "h2", text: "Three modes" },
        { type: "cards", items: [
          { title: "Prompt", text: "Ask questions with schema context, generate SQL from plain language, and explain existing queries." },
          { title: "Edit", text: "Refine and rewrite SQL with the assistant working directly on the statement in your editor." },
          { title: "Agent", text: "Hand off a goal: the agent inspects the schema, reads data safely, and drafts an answer or report across multiple steps." },
        ] },
        { type: "callout", tone: "tip", title: "It lives beside your query", text: "Toggle the AI panel with Ctrl + Space. It reads the active connection's schema for context, and you can attach images or text files to a message." },
        { type: "h2", text: "Autonomy: when the agent runs SQL" },
        { type: "p", text: "Autonomy controls whether the agent pauses for a per-statement dialog before it executes. It is separate from Safe Mode: autonomy decides when to ask, Safe Mode decides what is even allowed." },
        { type: "table", head: ["Autonomy", "Behavior"], rows: [
          ["Review", "Always shows the review dialog. Nothing runs until you approve it — the most cautious setting."],
          ["Smart", "Auto-runs safe reads and pauses to confirm every write or high-risk statement."],
          ["Full", "Standing approval: reads and writes run without a per-statement dialog — but only while Safe Mode is at levels 1–3."],
        ] },
        { type: "callout", tone: "info", title: "Full autonomy is still bounded", text: "The standing grant of Full only applies at Safe Mode levels 1–3. At Strict or Paranoid (4–5), the agent still stops for confirmation, and blocked statements stay blocked." },
        { type: "h2", text: "Safe Mode governs every statement" },
        { type: "p", text: "Whether SQL comes from you or the agent, it passes through the same six-level Safe Mode. Human approval can relax the write/DDL block at levels 1–3, but the destructive family — DROP, TRUNCATE, CREATE TABLE — stays hard-blocked at levels 4–5 with no override." },
        { type: "table", head: ["Level", "Label", "Effect"], rows: [
          ["0", "Disabled", "Statement-kind guard off (the capability guard still runs)."],
          ["1", "Read Only", "Only SELECT / SHOW / EXPLAIN / WITH; all writes blocked."],
          ["2", "Low Risk", "SELECT and INSERT only; UPDATE / DELETE blocked."],
          ["3", "Standard", "INSERT / UPDATE / DELETE need confirmation; DROP / TRUNCATE / most ALTER / CREATE TABLE blocked."],
          ["4", "Strict", "Confirmation for all writes; DROP / TRUNCATE / CREATE TABLE hard-blocked."],
          ["5", "Paranoid", "Confirmation for SELECT and every write, with a preview and estimated affected rows."],
        ] },
        { type: "h2", text: "The always-on capability guard" },
        { type: "p", text: "Before Safe Mode even classifies a statement, a fail-closed capability guard runs first and cannot be bypassed — not even at level 0. It blocks SQL that reaches outside the database into the filesystem, network, or OS." },
        { type: "ul", items: [
          "Filesystem and program access such as pg_read_file, pg_ls_dir, lo_import/lo_export, MySQL LOAD_FILE / INTO OUTFILE / LOAD DATA INFILE, DuckDB read_csv/read_parquet/glob, Postgres COPY … TO/FROM PROGRAM, and MSSQL xp_cmdshell/openrowset.",
          "Session and access control such as USE, ATTACH, SET search_path, transactions, and GRANT/REVOKE.",
          "One statement per item, so a benign query cannot smuggle a second one.",
        ] },
        { type: "callout", tone: "info", title: "The backend has the final say", text: "A fast frontend check is advisory only; the authoritative guard is a SQL parser in the Rust backend, which also catches mutating CTEs a simple pattern match would miss." },
        { type: "h2", text: "Review before run" },
        { type: "p", text: "For writes, TableR previews the effect before you commit. Write previews execute inside a transaction and always roll back, so you can read the affected rows first and then apply the final SQL yourself." },
        { type: "callout", tone: "warn", title: "Proposes, never surprises", text: "The assistant drafts SQL and shows a preview; you decide what actually runs against your data." },
        { type: "h2", text: "Grounded and observable" },
        { type: "ul", items: [
          "Shows its work: every step lands in a live trace you can expand, and runs are recorded so you can replay them.",
          "Uses your schema: answers are built from verified schema rather than guessed column names.",
          "Learns your business: verified metric definitions and aliases are remembered per database.",
          "Cites its sources: answers link back to the rows they came from so you can navigate to the evidence.",
        ] },
        { type: "h2", text: "Providers and failover" },
        { type: "p", text: "Configure your own AI providers in settings. If a provider rate-limits or drops mid-task, the agent fails over to the next provider you configured, so a long-running job does not die on a single hiccup." },
        { type: "callout", tone: "info", title: "AI is the one online feature", text: "The rest of TableR runs locally. AI features need a configured provider and network access; your credentials and data still stay on your machine." },
        { type: "h2", text: "Next steps" },
        { type: "cards", items: [
          { title: "SQL workspace", text: "Where generated SQL runs, with timeouts and Safe Mode.", href: "/docs/sql-workspace" },
          { title: "Exploring data", text: "Give the agent context by exploring the schema yourself.", href: "/docs/exploring-data" },
          { title: "Architecture", text: "How execution, cancellation, and pooling work under the hood.", href: "/docs/architecture" },
        ] },
      ],
    },
    {
      slug: "shortcuts",
      icon: "Keyboard",
      title: "Keyboard shortcuts",
      description: "Move through the workspace without leaving the keyboard.",
      blocks: [
        { type: "p", text: "TableR is built for repeated, everyday work, so the core actions are one shortcut away. Shortcuts can be customized from the application settings." },
        { type: "table", head: ["Shortcut", "Action"], rows: shortcutRows([
          "Create a query tab",
          "Run the active query",
          "Toggle the AI workspace",
          "Open the quick switcher",
          "Open the command palette",
          "Toggle the database explorer",
          "Toggle the terminal",
          "Toggle query results",
          "Open query history",
          "Open SQL favorites",
          "Format SQL",
        ]) },
        { type: "h2", text: "Command palette & quick switcher" },
        { type: "ul", items: [
          "Command palette (Ctrl + Shift + P) runs any action by name.",
          "Quick switcher (Ctrl + P) jumps between tabs, objects, and views.",
        ] },
        { type: "callout", tone: "tip", title: "Make them yours", text: "Every shortcut can be reassigned in the application settings to match your muscle memory." },
      ],
    },
    {
      slug: "architecture",
      icon: "Layers3",
      title: "Architecture",
      description: "How the Tauri shell, React interface, and Rust backend fit together.",
      blocks: [
        { type: "p", text: "TableR combines a Tauri desktop shell, a React interface, and a Rust backend. The frontend talks to native services through Tauri commands and events; the backend manages connection pools and engine adapters." },
        { type: "code", lang: "text", code: ARCH_DIAGRAM },
        { type: "h2", text: "Technology" },
        { type: "table", head: ["Layer", "Stack"], rows: [
          ["Desktop runtime", TECH_STACK[0]],
          ["Frontend", TECH_STACK[1]],
          ["Styling", TECH_STACK[2]],
          ["Native backend", TECH_STACK[3]],
          ["Database access", TECH_STACK[4]],
          ["Editor & terminal", TECH_STACK[5]],
          ["Data & diagrams", TECH_STACK[6]],
          ["State management", TECH_STACK[7]],
        ] },
        { type: "h2", text: "How a query flows" },
        { type: "p", text: "When you run a statement, the frontend query store issues a request with a unique id and the active connection. The Rust backend registers a cancellation token for that request, then executes the SQL on a driver for the target engine." },
        { type: "steps", items: [
          { title: "Request", text: "The frontend creates a request id, stores the active connection, and calls the matching Tauri command." },
          { title: "Register", text: "The backend registers a cancellation token for the request so it can be stopped later." },
          { title: "Execute", text: "On PostgreSQL and MySQL, the driver takes a dedicated pool connection and records its backend/connection id, then runs your SQL on that connection." },
          { title: "Finish or cancel", text: "Results return with timing, or a cancel request stops the wait — and, where supported, the statement on the server." },
        ] },
        { type: "h3", text: "Cancellation" },
        { type: "p", text: "Cancelling unblocks the waiting request immediately. On PostgreSQL, TableR issues pg_cancel_backend over a second pool connection; on MySQL/MariaDB it issues KILL QUERY the same way, so the cancel does not queue behind the running statement. A drop guard always cleans up the registry entry, even on timeout or panic." },
        { type: "h3", text: "Connection pooling" },
        { type: "p", text: "PostgreSQL and MySQL pools are capped at eight connections. Cancellation deliberately uses a separate connection so it never waits behind the in-flight query. Desktop usage is single-user, so a dedicated connection during a cancellable query is an acceptable trade-off." },
        { type: "h2", text: "Project layout" },
        { type: "code", lang: "text", code: PROJECT_LAYOUT },
        { type: "callout", tone: "info", title: "Local-first by design", text: "TableR runs on your machine. Credentials live in the OS keyring, and your data does not pass through this website." },
      ],
    },
    {
      slug: "faq",
      icon: "HelpCircle",
      title: "FAQ & support",
      description: "Common questions about licensing, data, and where to get help.",
      blocks: [
        { type: "h3", text: "Is TableR free and open source?" },
        { type: "p", text: "Yes. TableR is distributed under the GNU General Public License v3.0. You can read, modify, and contribute to the source on GitHub." },
        { type: "h3", text: "Which databases are supported?" },
        { type: "p", text: "18 engines across relational, analytical, embedded, NoSQL, and cloud-native categories — from PostgreSQL and MySQL to Snowflake, MongoDB, and Cloudflare D1. See Connections & databases for the full list." },
        { type: "h3", text: "Where are my credentials stored?" },
        { type: "p", text: "In the operating system keyring. Secrets are not shown in the interface, and they never touch this website." },
        { type: "h3", text: "Does it work offline?" },
        { type: "p", text: "The desktop app runs locally. AI features require a configured provider and network access, but everything else works on your machine." },
        { type: "h3", text: "Is my data sent anywhere?" },
        { type: "p", text: "No. TableR connects directly from your machine to your databases. This website does not receive your queries, results, or credentials. Only AI features contact an external provider — and only with the context you send in a message." },
        { type: "h3", text: "What is Safe Mode?" },
        { type: "p", text: "A six-level guard (0–5) over what SQL is allowed to run. Higher levels block or require confirmation for writes and destructive DDL. A separate, always-on capability guard blocks filesystem, network, and OS access at every level, with no bypass. See SQL workspace and AI & Agent for the full model." },
        { type: "h3", text: "Can the AI run destructive SQL on its own?" },
        { type: "p", text: "Only within limits you set. The autonomy dial decides when the agent pauses for approval, and Safe Mode decides what is allowed at all. Even at Full autonomy, that standing approval only applies at Safe Mode levels 1–3; DROP, TRUNCATE, and CREATE TABLE stay hard-blocked at the strict tiers." },
        { type: "h3", text: "How do query timeouts and cancellation work?" },
        { type: "p", text: "Read-only statements time out after 180 seconds and mutating or schema statements after 60 seconds; a mixed batch uses the shorter window. You can cancel anytime — on PostgreSQL and MySQL/MariaDB the statement is stopped on the server too. See Architecture for the details." },
        { type: "h3", text: "Which engines can I bootstrap locally?" },
        { type: "p", text: "Local bootstrap is available for PostgreSQL, MySQL, MariaDB, and SQLite (MongoDB is planned). Any supported engine can also be opened through a saved profile, a connection string, or file selection where applicable." },
        { type: "h3", text: "How do I update TableR?" },
        { type: "p", text: "Download the newest release and install it over the current version. Saved connections live in the OS keyring and preferences are stored locally, so they carry across updates." },
        { type: "h3", text: "How do I report a bug or request a feature?" },
        { type: "p", text: "Use GitHub Issues for reproducible bugs and GitHub Discussions for ideas or general questions." },
        { type: "callout", tone: "tip", title: "Support development", text: "You can support continued work through Buy Me a Coffee. Contributions and focused feature proposals are always welcome." },
      ],
    },
  ],
};

/* ------------------------------------------------------------------ */
/* Vietnamese content                                                  */
/* ------------------------------------------------------------------ */

const vi: DocsBundle = {
  label: "Tài liệu",
  tagline: "Tất cả những gì bạn cần để cài đặt, kết nối, truy vấn và hiểu TableR.",
  homeLabel: "Trang chủ",
  downloadLabel: "Tải xuống",
  githubLabel: "GitHub",
  onThisSection: "Trong mục này",
  previous: "Trước",
  next: "Tiếp",
  menu: "Mục lục tài liệu",
  groups: [
    { label: "Bắt đầu", slugs: ["", "getting-started"] },
    {
      label: "Hướng dẫn",
      slugs: [
        "connections",
        "plugins",
        "sql-workspace",
        "exploring-data",
        "visualize",
        "ai-agent",
      ],
    },
    { label: "Tham khảo", slugs: ["shortcuts", "architecture"] },
    { label: "Trợ giúp", slugs: ["faq"] },
  ],
  pages: [
    {
      slug: "",
      icon: "BookOpen",
      title: "Giới thiệu",
      description:
        "TableR là workspace desktop nhanh, đa nền tảng để khám phá schema, viết SQL, trực quan hóa kết quả và làm việc cùng AI.",
      blocks: [
        { type: "p", text:
          "TableR gom các công cụ cho công việc CSDL hằng ngày vào một ứng dụng desktop native. Duyệt object, viết và chạy SQL trong Monaco, xem hoặc xuất kết quả, dựng biểu đồ và sơ đồ ER, và giữ một trợ lý AI hiểu database ngay cạnh câu truy vấn thay vì ở cửa sổ khác." },
        { type: "image", src: "/screenshots/table-r-query-workspace.png", alt: "Workspace truy vấn TableR với trình soạn SQL và bảng kết quả", width: 1280, height: 801 },
        { type: "callout", tone: "tip", title: "Mới dùng? Bắt đầu trong hai phút", text:
          "Mở mục Bắt đầu để cài một bản phát hành và chạy truy vấn đầu tiên, rồi quay lại đây để nắm bức tranh tổng thể. Thích đọc trước? Cứ kéo xuống." },
        { type: "h2", text: "Vì sao chọn TableR" },
        { type: "p", text:
          "Phần lớn công việc database bị chia nhỏ ra nhiều công cụ: một trình truy vấn, một trình duyệt schema, một app vẽ sơ đồ, một script xuất dữ liệu và một cửa sổ chat AI riêng. Mỗi lần chuyển qua lại là mất ngữ cảnh. TableR gộp tất cả vào một workspace local-first, để schema, câu truy vấn, kết quả và trợ lý luôn ở cùng một khung nhìn — và ở ngay trên máy bạn." },
        { type: "ul", items: [
          "Một workspace duy nhất — trình soạn, trình duyệt, kết quả, biểu đồ, sơ đồ, terminal và AI mà không rời cửa sổ.",
          "Local-first — ứng dụng desktop chạy trên máy bạn; bí mật kết nối nằm trong keyring của hệ điều hành và không đi qua website này.",
          "An toàn mặc định — Safe Mode SQL sáu cấp cùng luồng duyệt-trước-khi-chạy giữ các câu lệnh nguy hiểm sau một bước xác nhận rõ ràng.",
          "Bao phủ rộng — 18 engine quan hệ, phân tích, nhúng, NoSQL và đám mây sau cùng một giao diện.",
          "Mã nguồn mở — GPLv3, nên bạn có thể đọc mã, mở issue, hoặc đóng góp quy trình bạn mong muốn.",
        ] },
        { type: "h2", text: "Bạn nhận được gì" },
        { type: "cards", items: [
          { title: "SQL workspace", text: "Trình soạn Monaco, nhiều tab truy vấn, format, đo thời gian chạy, công cụ explain, lịch sử và mục ưa thích." },
          { title: "Khám phá dữ liệu", text: "Trình duyệt schema có tìm kiếm, duyệt dữ liệu bảng, xem chi tiết dòng, phân trang, sắp xếp và lọc." },
          { title: "Kết quả & xuất dữ liệu", text: "Chế độ bảng và biểu đồ với các luồng xuất CSV, JSON, Excel và SQL." },
          { title: "Công cụ trực quan", text: "Sơ đồ ER tương tác, minimap và điều khiển bố cục, bảng chỉ số, và trực quan hóa query plan." },
          { title: "Trợ lý AI", text: "Chế độ Prompt, Edit và Agent với ngữ cảnh schema, đính kèm tệp, duyệt SQL trước khi chạy và provider cấu hình được." },
          { title: "Quy trình desktop", text: "Kết nối đã lưu, bootstrap CSDL local, lưu credential trong keyring hệ điều hành, command palette, terminal và lưu phiên." },
        ] },
        { type: "h2", text: "Nguyên tắc thiết kế" },
        { type: "p", text:
          "Một vài ý tưởng định hình mọi màn hình trong TableR. Nắm được chúng từ đầu sẽ giúp bạn đọc phần còn lại của tài liệu dễ hơn." },
        { type: "cards", items: [
          { title: "Local-first", text: "Database, credential và lịch sử truy vấn của bạn nằm trên máy bạn. Ứng dụng desktop kết nối trực tiếp; website này chỉ để tra cứu tài liệu." },
          { title: "An toàn để khám phá", text: "Safe Mode phân loại mọi câu lệnh, và DDL phá hủy bị chặn hoặc buộc xác nhận — nên bạn có thể mày mò dữ liệu giống production mà không lo." },
          { title: "Ưu tiên bàn phím", text: "Tab mới, chạy, format, command palette và panel AI — mỗi thứ chỉ cách một phím tắt, và mọi phím tắt đều gán lại được trong cài đặt." },
          { title: "Nhất quán giữa các engine", text: "Cùng một form kết nối, workspace và công cụ kết quả dù bạn trỏ tới PostgreSQL, ClickHouse, MongoDB hay Cloudflare D1." },
        ] },
        { type: "h2", text: "Dành cho ai" },
        { type: "p", text:
          "TableR được xây cho kỹ sư phần mềm và lập trình viên thiên về database — những người thường xuyên soi database giống production, viết SQL, sửa các tập dữ liệu nhỏ, đưa dữ liệu ra vào, và dùng AI để điều tra, đồng thời vẫn kiểm soát mọi lần ghi vào database. Nhà phân tích và các nhóm dữ liệu muốn một workspace gọn gàng cho các engine quan hệ, phân tích, tài liệu, cache và đám mây cũng rất hợp." },
        { type: "callout", tone: "info", title: "Mã nguồn mở", text:
          "TableR phát hành theo giấy phép GNU GPL v3.0. Bạn có thể đọc mã nguồn, mở issue, hoặc đóng góp quy trình bạn mong muốn." },
        { type: "h2", text: "Tài liệu được sắp xếp thế nào" },
        { type: "p", text:
          "Sidebar đi theo đúng thứ tự bạn thường cần: cài đặt, kết nối, truy vấn, khám phá, trực quan hóa, rồi tự động hóa bằng AI. Nhảy thẳng tới một mục bên dưới." },
        { type: "cards", items: [
          { title: "Bắt đầu", text: "Cài một bản phát hành hoặc build từ mã nguồn, rồi chạy truy vấn đầu tiên.", href: "/docs/getting-started" },
          { title: "Kết nối & CSDL", text: "Trình khởi chạy, cả 18 engine được hỗ trợ và bootstrap local.", href: "/docs/connections" },
          { title: "SQL workspace", text: "Trình soạn Monaco, tab, mô hình thực thi, Safe Mode, lịch sử và xuất dữ liệu.", href: "/docs/sql-workspace" },
          { title: "Khám phá dữ liệu", text: "Trình duyệt schema, duyệt bảng, trình xem dòng và công cụ cấu trúc.", href: "/docs/exploring-data" },
          { title: "Trực quan & sơ đồ", text: "Sơ đồ ER, biểu đồ, bảng chỉ số và query plan.", href: "/docs/visualize" },
          { title: "AI & Agent", text: "Chế độ Prompt, Edit, Agent, mức tự chủ và mô hình an toàn.", href: "/docs/ai-agent" },
          { title: "Phím tắt", text: "Tài liệu tham chiếu đầy đủ để làm việc không rời bàn phím.", href: "/docs/shortcuts" },
          { title: "Kiến trúc & FAQ", text: "Cách ứng dụng được xây dựng, cùng lời giải cho các câu hỏi thường gặp.", href: "/docs/architecture" },
        ] },
      ],
    },
    {
      slug: "getting-started",
      icon: "Rocket",
      title: "Bắt đầu",
      description: "Cài bản dựng sẵn, hoặc build TableR từ mã nguồn để phát triển.",
      blocks: [
        { type: "callout", tone: "tip", title: "Bắt đầu trong 4 bước", steps: [
          "Tải trình cài đặt có nhãn Đề xuất cho hệ điều hành của bạn.",
          "Cài và khởi chạy TableR.",
          "Tạo một kết nối — hoặc bootstrap một database local — từ trình khởi chạy.",
          "Mở tab truy vấn (Ctrl + N) và chạy câu lệnh đầu tiên (Ctrl + Enter).",
        ] },
        { type: "p", text: "Có hai cách để có TableR: cài một bản phát hành dựng sẵn (nhanh nhất, hợp với hầu hết mọi người) hoặc build từ mã nguồn (dành cho người đóng góp và ai muốn nhánh phát triển mới nhất). Cả hai đều được hướng dẫn bên dưới." },
        { type: "h2", text: "Cài một bản phát hành" },
        { type: "p", text: "Có sẵn trình cài đặt dựng sẵn cho Windows, macOS và Linux. Link tải trỏ thẳng tới asset chính thức trên GitHub." },
        { type: "steps", items: [
          { title: "Tải xuống", text: "Mở trang Tải xuống và chọn tùy chọn có nhãn Đề xuất cho hệ điều hành của bạn." },
          { title: "Cài đặt", text: "Windows: chạy .exe hoặc .msi. macOS: mở .dmg và kéo TableR vào Applications. Linux: dùng AppImage, .deb hoặc .rpm." },
          { title: "Khởi chạy", text: "Mở TableR và tạo kết nối đầu tiên, hoặc khởi tạo một database local từ trình khởi chạy." },
        ] },
        { type: "callout", tone: "warn", title: "macOS: bản chưa ký", text:
          "Chuyển TableR vào Applications, thử mở một lần, rồi chọn Open Anyway trong System Settings → Privacy & Security. Nếu Gatekeeper vẫn chặn, chạy lệnh dưới đây rồi mở lại. Việc này không đồng nghĩa app đã được Apple notarize." },
        { type: "code", lang: "bash", code: MACOS_QUARANTINE },
        { type: "h2", text: "Yêu cầu hệ thống" },
        { type: "p", text: "TableR là ứng dụng desktop gốc dựng trên Tauri 2, nên nó tận dụng web runtime sẵn có của hệ điều hành và giữ cho ứng dụng nhẹ, nhanh." },
        { type: "ul", items: [
          "Windows 10 hoặc 11 (64-bit). Cần WebView2 runtime — Windows 11 đã có sẵn.",
          "macOS 11 Big Sur trở lên, cả Apple Silicon lẫn Intel.",
          "Bản Linux 64-bit hiện đại có WebKitGTK (gói .deb và .rpm sẽ tự cài kèm).",
          "Khoảng 200 MB dung lượng trống, cộng thêm chỗ cho các database local bạn tạo.",
        ] },
        { type: "h2", text: "Tạo kết nối đầu tiên" },
        { type: "p", text: "Trình khởi chạy kết nối là màn hình đầu tiên bạn thấy. Mở một workspace đã lưu, hoặc tạo kết nối mới tới bất kỳ engine nào trong 18 engine được hỗ trợ." },
        { type: "steps", items: [
          { title: "Chọn engine", text: "Chọn một thẻ trong trình khởi chạy. Mỗi thẻ cho biết engine hỗ trợ kết nối từ xa, database dạng tệp, hay bootstrap local." },
          { title: "Nhập thông tin", text: "Điền host, port và thông tin đăng nhập, dán chuỗi kết nối đầy đủ, hoặc chọn tệp database nếu engine hỗ trợ." },
          { title: "Kết nối và lưu", text: "Kiểm tra kết nối, rồi lưu hồ sơ để lần sau mở TableR nó xuất hiện lại trong trình khởi chạy." },
        ] },
        { type: "callout", tone: "info", title: "Chưa có server? Bootstrap ngay tại máy", text: "TableR có thể khởi tạo một database PostgreSQL, MySQL, MariaDB hoặc SQLite local ngay từ trình khởi chạy, nên bạn có thể bắt đầu truy vấn mà không cần cài server riêng. Thông tin bí mật luôn được giữ trong keyring của hệ điều hành." },
        { type: "p", text: "Xem Kết nối & cơ sở dữ liệu để biết danh sách engine đầy đủ và mọi tùy chọn kết nối." },
        { type: "h2", text: "Chạy truy vấn đầu tiên" },
        { type: "ol", items: [
          "Mở một tab truy vấn mới bằng Ctrl + N.",
          "Gõ SQL trong trình soạn thảo Monaco; gợi ý tự động và thông tin schema hiện ra khi bạn gõ (Ctrl + Space để bật gợi ý).",
          "Nhấn Ctrl + Enter để chạy câu lệnh tại vị trí con trỏ.",
          "Xem bảng kết quả — sắp xếp, lọc, phân trang, hoặc chuyển sang chế độ biểu đồ.",
          "Xuất kết quả ra CSV, JSON, Excel hoặc SQL khi cần chia sẻ.",
        ] },
        { type: "h2", text: "Khám phá và trực quan hóa" },
        { type: "p", text: "Ngoài chạy SQL, TableR còn có trình khám phá schema tìm kiếm được, sơ đồ ER tương tác, bảng số liệu và trực quan hóa query plan, giúp bạn hiểu database chứ không chỉ truy vấn. Xem Khám phá dữ liệu và Trực quan hóa để biết chi tiết." },
        { type: "h2", text: "Hỏi trợ lý AI tích hợp" },
        { type: "p", text: "Một trợ lý hiểu database nằm ngay cạnh trình soạn thảo với ba chế độ Prompt, Edit và Agent. Nó đọc schema để lấy ngữ cảnh, cho phép đính kèm tệp, và luôn hiển thị SQL sinh ra để bạn duyệt trước khi chạy. Xem Trợ lý AI để cấu hình nhà cung cấp." },
        { type: "h2", text: "Xử lý sự cố khi mở lần đầu" },
        { type: "steps", items: [
          { title: "Windows SmartScreen", text: "Nếu Defender SmartScreen cảnh báo ứng dụng lạ, chọn More info rồi Run anyway. Trình cài đặt hiện chưa được ký số." },
          { title: "macOS Gatekeeper", text: "Dùng Open Anyway trong System Settings, Privacy & Security, hoặc chạy lệnh gỡ quarantine ở trên." },
          { title: "Linux AppImage", text: "Cấp quyền thực thi cho tệp tải về trước khi chạy:" },
        ] },
        { type: "code", lang: "bash", code: "chmod +x TableR-*.AppImage\n./TableR-*.AppImage" },
        { type: "h2", text: "Cập nhật TableR" },
        { type: "p", text: "Để cập nhật, tải bản mới nhất từ trang Tải xuống và cài đè lên bản hiện tại. Kết nối đã lưu nằm trong keyring của hệ điều hành và tùy chọn được lưu cục bộ, nên chúng được giữ nguyên qua các lần cập nhật." },
        { type: "h2", text: "Build từ mã nguồn" },
        { type: "p", text: "Lệnh phát triển của Tauri sẽ khởi động Vite, build backend Rust và mở ứng dụng desktop với hot reload." },
        { type: "code", lang: "bash", code: CODE_CLONE },
        { type: "h3", text: "Yêu cầu môi trường" },
        { type: "ul", items: [
          "Node.js 18 trở lên",
          "npm",
          "Rust (toolchain stable)",
          "Các phụ thuộc nền tảng mà Tauri 2 yêu cầu",
        ] },
        { type: "h3", text: "Các lệnh hữu ích" },
        { type: "table", head: ["Lệnh", "Mục đích"], rows: [
          [COMMANDS[0], "Khởi động server phát triển frontend"],
          [COMMANDS[1], "Chạy toàn bộ ứng dụng desktop"],
          [COMMANDS[2], "Kiểm tra TypeScript mà không xuất tệp"],
          [COMMANDS[3], "Chạy bộ test Vitest một lần"],
          [COMMANDS[4], "Type-check và build frontend"],
          [COMMANDS[5], "Tạo gói cài đặt desktop theo nền tảng"],
          [COMMANDS[6], "Khởi động chính website sản phẩm này"],
        ] },
        { type: "callout", tone: "tip", title: "Trước khi đóng góp", text: "Chạy bộ kiểm tra chất lượng trước khi gửi thay đổi:" },
        { type: "code", lang: "bash", code: CODE_QUALITY },
        { type: "h2", text: "Bước tiếp theo" },
        { type: "cards", items: [
          { title: "Kết nối & CSDL", text: "Kết nối tới cả 18 engine, hoặc bootstrap một cái ngay tại máy.", href: "/docs/connections" },
          { title: "SQL workspace", text: "Tab, định dạng, mô hình thực thi, lịch sử và mục yêu thích.", href: "/docs/sql-workspace" },
          { title: "Khám phá dữ liệu", text: "Trình khám phá schema, duyệt bảng và xem chi tiết dòng.", href: "/docs/exploring-data" },
          { title: "Trực quan & sơ đồ", text: "Biểu đồ, sơ đồ ER và xem query plan.", href: "/docs/visualize" },
          { title: "AI & Agent", text: "Ba chế độ Prompt, Edit và Agent với ngữ cảnh schema.", href: "/docs/ai-agent" },
          { title: "Phím tắt", text: "Tài liệu tham chiếu đầy đủ để làm việc nhanh hơn.", href: "/docs/shortcuts" },
        ] },
      ],
    },
    {
      slug: "connections",
      icon: "PlugZap",
      title: "Kết nối & CSDL",
      description: "Lưu workspace, khởi tạo database local và kết nối 18 engine.",
      blocks: [
        { type: "p", text: "Mở lại workspace đã lưu, hoặc tạo mới từ 18 engine sẵn sàng. Trình chọn cho biết mỗi engine làm được gì — kết nối remote, database dạng tệp, hay bootstrap local — trước khi bạn điền form." },
        { type: "image", src: "/screenshots/table-r-connection-launcher.png", alt: "Trình khởi chạy kết nối TableR hiển thị các kết nối đã lưu", width: 1280, height: 801 },
        { type: "callout", tone: "info", title: "Credential nằm ở máy bạn", text: "Bí mật kết nối được lưu trong keyring của hệ điều hành, không nằm trên giao diện hay trong tệp cấu hình dạng văn bản." },
        { type: "h2", text: "Tạo một kết nối" },
        { type: "steps", items: [
          { title: "Chọn engine", text: "Chọn từ trình khởi chạy. Mỗi thẻ cho biết hỗ trợ remote, dạng tệp hay bootstrap local." },
          { title: "Nhập thông tin", text: "Điền host, port và credential, dùng connection string, hoặc chọn tệp database nếu được hỗ trợ." },
          { title: "Lưu & mở lại", text: "Profile đã lưu xuất hiện trong trình khởi chạy để bạn quay lại công việc tức thì." },
        ] },
        { type: "h2", text: "Các CSDL được hỗ trợ" },
        { type: "p", text: "TableR hiện cung cấp luồng kết nối cho 18 engine database." },
        { type: "table", head: ["Nhóm", "Engine"], rows: [
          ["Quan hệ & phân tích", "PostgreSQL, MySQL, MariaDB, CockroachDB, Greenplum, Amazon Redshift, SQL Server, Vertica, ClickHouse, Snowflake, BigQuery"],
          ["Nhúng & dạng tệp", "SQLite, DuckDB"],
          ["NoSQL & cloud-native", "Cassandra, Redis, MongoDB, LibSQL, Cloudflare D1"],
        ] },
        { type: "callout", tone: "info", title: "Độ sâu tính năng khác nhau theo engine", text: "Metadata, explain plan, chỉnh sửa schema và hành vi xuất dữ liệu phụ thuộc từng driver, nên khả năng có thể khác nhau giữa các engine." },
        { type: "h2", text: "Bootstrap local" },
        { type: "p", text: "Bootstrap local giúp TableR tự khởi tạo database mà không cần server ngoài. Đã sẵn sàng cho PostgreSQL, MySQL, MariaDB, SQLite và SQL Server (MongoDB đang lên kế hoạch). Database sẵn có cũng mở được qua profile đã lưu, connection string hoặc chọn tệp nếu được hỗ trợ." },
        { type: "h2", text: "Kết nối từng engine" },
        { type: "p", text: "Các mặc định dưới đây khớp với form kết nối của TableR. Engine mạng dùng chung các trường cốt lõi — Host, Port, tùy chọn SSL/TLS, và thông tin đăng nhập (bí mật lưu trong keyring của hệ điều hành); engine dạng tệp chỉ cần chọn tệp database. Bạn cũng có thể dán connection string ở engine có hỗ trợ. Chỉ các trường riêng bên dưới là khác nhau theo engine." },
        { type: "cards", items: [
          { title: "PostgreSQL — hướng dẫn chuyên sâu", text: "Các trường kết nối, connection string, SSL/TLS, bootstrap local, kiểm tra kết nối và khắc phục sự cố — trên một trang riêng.", href: "/docs/postgresql" },
          { title: "MySQL — hướng dẫn chuyên sâu", text: "Các trường kết nối, connection string, SSL/TLS, bootstrap local, kiểm tra kết nối và khắc phục sự cố — trên một trang riêng.", href: "/docs/mysql" },
          { title: "MariaDB — hướng dẫn chuyên sâu", text: "Các trường kết nối tương thích MySQL, connection string, SSL/TLS, bootstrap local và khắc phục sự cố — trên một trang riêng.", href: "/docs/mariadb" },
          { title: "SQL Server — hướng dẫn chuyên sâu", text: "Xác thực Windows hoặc SQL, các trường kết nối, mã hóa, bootstrap local và khắc phục sự cố — trên một trang riêng.", href: "/docs/sql-server" },
          { title: "CockroachDB — hướng dẫn chuyên sâu", text: "Các trường kết nối tương thích PostgreSQL, connection string, SSL/TLS và khắc phục sự cố — trên một trang riêng.", href: "/docs/cockroachdb" },
          { title: "Greenplum — hướng dẫn chuyên sâu", text: "Kho phân tích tương thích PostgreSQL: các trường kết nối, connection string, SSL/TLS và khắc phục sự cố — trên một trang riêng.", href: "/docs/greenplum" },
          { title: "Amazon Redshift — hướng dẫn chuyên sâu", text: "Kho dữ liệu đám mây tương thích PostgreSQL: các trường kết nối, connection string, SSL/TLS và khắc phục sự cố — trên một trang riêng.", href: "/docs/amazon-redshift" },
          { title: "Vertica — hướng dẫn chuyên sâu", text: "Phân tích dạng cột: các trường kết nối, SSL/TLS, kiểm tra kết nối và khắc phục sự cố — trên một trang riêng.", href: "/docs/vertica" },
          { title: "ClickHouse — hướng dẫn chuyên sâu", text: "Các trường kết nối qua giao diện HTTP, SSL/TLS, kiểm tra kết nối và khắc phục sự cố — trên một trang riêng.", href: "/docs/clickhouse" },
          { title: "Snowflake — hướng dẫn chuyên sâu", text: "Kho đám mây qua HTTPS: host tài khoản, warehouse, role, các trường kết nối, kiểm tra kết nối và khắc phục sự cố — trên một trang riêng.", href: "/docs/snowflake" },
          { title: "BigQuery — hướng dẫn chuyên sâu", text: "Kho serverless của Google Cloud: xác thực service account, project và dataset, kiểm tra kết nối và khắc phục sự cố — trên một trang riêng.", href: "/docs/bigquery" },
          { title: "SQLite — hướng dẫn chuyên sâu", text: "Cơ sở dữ liệu dạng tệp: chọn hoặc tạo tệp, bootstrap local, kiểm tra kết nối và khắc phục sự cố — trên một trang riêng.", href: "/docs/sqlite" },
          { title: "DuckDB — hướng dẫn chuyên sâu", text: "Phân tích nhúng trong một tệp: chế độ mở, kiểm tra kết nối và khắc phục sự cố — trên một trang riêng.", href: "/docs/duckdb" },
          { title: "Cassandra — hướng dẫn chuyên sâu", text: "Contact point CQL, keyspace, xác thực và SSL/TLS tùy chọn, kiểm tra kết nối và khắc phục sự cố — trên một trang riêng.", href: "/docs/cassandra" },
          { title: "Redis — hướng dẫn chuyên sâu", text: "Kho key-value trong bộ nhớ: user ACL, chỉ số database, TLS tùy chọn, kiểm tra kết nối và khắc phục sự cố — trên một trang riêng.", href: "/docs/redis" },
          { title: "MongoDB — hướng dẫn chuyên sâu", text: "SRV của Atlas hoặc host trực tiếp: khám phá kết nối, auth source, replica set, SSL/TLS, connection string và khắc phục sự cố — trên một trang riêng.", href: "/docs/mongodb" },
          { title: "LibSQL — hướng dẫn chuyên sâu", text: "libSQL và database Turso từ xa: URL và auth token, kiểm tra kết nối và khắc phục sự cố — trên một trang riêng.", href: "/docs/libsql" },
          { title: "Cloudflare D1 — hướng dẫn chuyên sâu", text: "SQLite serverless qua Cloudflare API: account ID, database ID, API token, kiểm tra kết nối và khắc phục sự cố — trên một trang riêng.", href: "/docs/cloudflare-d1" },
        ] },
      ],
    },
    buildEnginePage(VI_ENGINE_LABELS, VI_POSTGRESQL),
    buildEnginePage(VI_ENGINE_LABELS, VI_MYSQL),
    buildEnginePage(VI_ENGINE_LABELS, VI_MARIADB),
    buildEnginePage(VI_ENGINE_LABELS, VI_COCKROACHDB),
    buildEnginePage(VI_ENGINE_LABELS, VI_GREENPLUM),
    buildEnginePage(VI_ENGINE_LABELS, VI_AMAZON_REDSHIFT),
    buildEnginePage(VI_ENGINE_LABELS, VI_SQL_SERVER),
    buildEnginePage(VI_ENGINE_LABELS, VI_VERTICA),
    buildEnginePage(VI_ENGINE_LABELS, VI_CLICKHOUSE),
    buildEnginePage(VI_ENGINE_LABELS, VI_SNOWFLAKE),
    buildEnginePage(VI_ENGINE_LABELS, VI_BIGQUERY),
    buildEnginePage(VI_ENGINE_LABELS, VI_SQLITE),
    buildEnginePage(VI_ENGINE_LABELS, VI_DUCKDB),
    buildEnginePage(VI_ENGINE_LABELS, VI_CASSANDRA),
    buildEnginePage(VI_ENGINE_LABELS, VI_REDIS),
    buildEnginePage(VI_ENGINE_LABELS, VI_MONGODB),
    buildEnginePage(VI_ENGINE_LABELS, VI_LIBSQL),
    buildEnginePage(VI_ENGINE_LABELS, VI_CLOUDFLARE_D1),
    {
      slug: "plugins",
      icon: "Puzzle",
      title: "Plugin & driver",
      description:
        "TableR chạy gọn nhẹ và bổ sung hệ CSDL dưới dạng plugin driver cài được — cài từ trong app, từ plugin store, hoặc từ bundle tải về.",
      blocks: [
        { type: "p", text:
          "TableR giữ phần lõi nhỏ gọn, nhanh và bổ sung phần lớn hệ CSDL dưới dạng plugin cài theo nhu cầu. Thay vì một bản build nặng nề gói sẵn mọi driver, bạn chỉ cài những engine thực sự dùng — và app xác minh từng bundle trước khi nạp." },
        { type: "callout", tone: "tip", title: "Duyệt plugin store", text:
          "Mọi driver chính thức đều được liệt kê trên plugin store, có nút tải bundle một chạm và hướng dẫn cài cho từng plugin. Link store nằm ở cuối trang này." },
        { type: "h2", text: "Vì sao dùng plugin" },
        { type: "ul", items: [
          "Lõi gọn nhẹ — app nền tảng giữ nhỏ; bạn chỉ thêm engine khi cần.",
          "Cập nhật độc lập — một driver có thể vá lỗi mà không chờ bản phát hành app đầy đủ.",
          "Xác minh khi cài — app tính lại SHA-256 của từng bundle và từ chối mọi thứ không khớp manifest.",
          "Quyền rõ ràng — mỗi plugin khai báo đúng những khả năng nó dùng (metadata, đọc, thực thi, mạng), hiển thị trước khi cài.",
        ] },
        { type: "h2", text: "Hai loại driver" },
        { type: "p", text:
          "Plugin driver có hai runtime. Khác biệt này quyết định cách plugin kết nối và có cần binary biên dịch hay không." },
        { type: "table",
          head: ["Loại", "Runtime", "Cách kết nối", "Cài đặt"],
          rows: [
            ["Đám mây / HTTP", "declarative-http-v1", "Giao tiếp với CSDL qua HTTPS", "Cài tức thì từ registry — chỉ manifest, không cần binary"],
            ["Native", "driver-sidecar-v1", "Driver chạy ngoài tiến trình qua giao thức native", "Cần thêm binary theo từng HĐH từ bản build phát hành đầy đủ"],
          ] },
        { type: "p", text:
          "Driver đám mây / HTTP hiện có: Google BigQuery, ClickHouse, Cloudflare D1, OpenSearch và Snowflake. Driver native: DuckDB, Cassandra, Redis và LibSQL — kết nối được khi có binary tương ứng." },
        { type: "h2", text: "Cài một plugin" },
        { type: "steps", items: [
          { title: "Từ Registry chính thức", text: "Trong app, mở Menu ứng dụng → Plugin Manager → Registry chính thức, rồi bấm Cài cạnh engine. Driver đám mây / HTTP dùng được ngay lập tức." },
          { title: "Từ bundle tải về", text: "Tải bundle từ plugin store, giải nén, rồi chọn Cài plugin và chỉ tới thư mục vừa giải nén — thư mục chứa trực tiếp plugin.json." },
          { title: "Driver native", text: "Cài như trên, rồi bảo đảm có binary đúng HĐH từ bản build phát hành đầy đủ. Thiếu binary thì driver vẫn nhập được nhưng chưa kết nối được." },
        ] },
        { type: "callout", tone: "info", title: "Bundle chỉ gồm manifest", text:
          "Bundle của driver đám mây / HTTP chỉ là manifest đã ký — không có mã biên dịch để tải, nên cài và kết nối được ngay khi entry registry được xác minh." },
        { type: "h2", text: "Vì sao cài đặt luôn an toàn" },
        { type: "p", text:
          "Khi nhập, host tính lại SHA-256 của bundle theo từng byte và từ chối bundle nếu không bằng digest ghi trong manifest. Asset tải về còn được kiểm tra kích thước và hash trước khi ghi. Thông tin đăng nhập ở lại trên máy bạn và không bao giờ đi qua website chứa plugin." },
        { type: "h2", text: "Duyệt & tải" },
        { type: "cards", items: [
          { title: "Mở plugin store", text: "Duyệt mọi driver chính thức, xem quyền và tải bundle.", href: "/plugins" },
          { title: "Kết nối & CSDL", text: "Xem mọi engine được hỗ trợ và cách kết nối sau khi cài driver.", href: "/docs/connections" },
        ] },
      ],
    },
    {
      slug: "sql-workspace",
      icon: "Code2",
      title: "SQL workspace",
      description: "Viết SQL trong Monaco với tab, mô hình thực thi rõ ràng, Safe Mode, lịch sử, mục ưa thích và terminal.",
      blocks: [
        { type: "p", text: "Workspace truy vấn giữ trình soạn, dữ liệu và công cụ trong cùng một khung nhìn. Khám phá object từ sidebar, viết SQL bằng Monaco, chạy nó với mô hình timeout-và-hủy có thể đoán trước, xem kết quả ở dạng bảng hoặc biểu đồ, và mở terminal mà không mất ngữ cảnh." },
        { type: "image", src: "/screenshots/table-r-query-workspace.png", alt: "Workspace truy vấn TableR với trình soạn SQL và bảng kết quả", width: 1280, height: 801 },
        { type: "h2", text: "Tổng quan workspace" },
        { type: "ul", items: [
          "Trình duyệt database bên trái (bật/tắt bằng Ctrl + B) cho schema, bảng và cột.",
          "Trình soạn Monaco ở giữa, hiểu SQL, có autocomplete và format.",
          "Nhiều tab truy vấn để các câu lệnh liên quan nằm cạnh nhau.",
          "Panel kết quả bên dưới trình soạn (bật/tắt bằng Ctrl + Shift + `) với chế độ bảng và biểu đồ.",
          "Terminal dock tích hợp (bật/tắt bằng Ctrl + `) và panel AI (bật/tắt bằng Ctrl + Space).",
        ] },
        { type: "h2", text: "Viết SQL trong Monaco" },
        { type: "p", text: "Trình soạn dùng chính engine chạy VS Code, được tinh chỉnh cho SQL. Autocomplete và gợi ý schema hiện ra khi bạn gõ; nhấn Ctrl + Space để buộc gợi ý, và Ctrl + Shift + F để format câu lệnh hiện tại." },
        { type: "ul", items: [
          "Gợi ý theo schema cho database, bảng và cột trên kết nối đang mở.",
          "Format một phím để chuẩn hóa khoảng trắng, kiểu chữ và thụt lề.",
          "Nhiều tab (Ctrl + N) để tách riêng truy vấn thử nghiệm, chỉnh sửa và báo cáo.",
          "Quick switcher (Ctrl + P) và command palette (Ctrl + Shift + P) nhảy giữa tab, object và hành động.",
        ] },
        { type: "h2", text: "Chạy một truy vấn" },
        { type: "steps", items: [
          { title: "Mở tab truy vấn", text: "Nhấn Ctrl + N để tạo tab mới gắn với kết nối đang hoạt động." },
          { title: "Viết SQL", text: "Gõ câu lệnh trong Monaco. Format bằng Ctrl + Shift + F nếu muốn." },
          { title: "Thực thi", text: "Nhấn Ctrl + Enter để chạy câu lệnh tại vị trí con trỏ. Kết quả hiện bên dưới kèm thời gian chạy." },
          { title: "Dùng lại", text: "Lưu vào mục ưa thích (Ctrl + Shift + S) hoặc tìm lại trong lịch sử (Ctrl + H)." },
        ] },
        { type: "callout", tone: "tip", title: "Chạy đúng thứ bạn muốn", text: "Ctrl + Enter chạy câu lệnh tại con trỏ, không phải cả tab — nên một tab nháp đầy truy vấn chỉ thực thi đúng câu bạn đang đứng." },
        { type: "h2", text: "Timeout và hủy truy vấn" },
        { type: "p", text: "TableR phân loại mỗi lần chạy trước khi thực thi và áp timeout dựa trên mức độ rủi ro của lô lệnh. Việc chỉ đọc được cửa sổ thời gian rộng rãi; bất cứ thứ gì thay đổi dữ liệu hay cấu trúc sẽ nhận cửa sổ ngắn hơn." },
        { type: "table", head: ["Loại câu lệnh", "Timeout", "Ghi chú"], rows: [
          ["Chỉ đọc (SELECT / SHOW / EXPLAIN / WITH)", "180 giây", "Cửa sổ dài cho việc khám phá và báo cáo."],
          ["Ghi hoặc cấu trúc (INSERT / UPDATE / DELETE / DDL, kể cả CTE có ghi)", "60 giây", "Áp cho các câu ghi và thay đổi cấu trúc."],
          ["Lô hỗn hợp", "60 giây", "Nếu lô có bất kỳ câu ghi nào, cả lô dùng cửa sổ ngắn hơn."],
        ] },
        { type: "p", text: "Hủy một truy vấn đang chạy bất cứ lúc nào. Việc hủy gỡ chặn giao diện ngay lập tức; trên PostgreSQL và MySQL/MariaDB, TableR còn dừng câu lệnh trên server bằng cách gửi lệnh hủy qua một kết nối thứ hai, nên nó không phải xếp hàng sau chính truy vấn đang bị hủy." },
        { type: "callout", tone: "info", title: "Hủy trên SQLite là nỗ-lực-tốt-nhất", text: "Driver SQLite nhúng không có API ngắt công khai, nên việc hủy sẽ dừng TableR chờ, nhưng engine có thể vẫn chạy nốt câu lệnh ở nền." },
        { type: "h2", text: "An toàn với Safe Mode" },
        { type: "p", text: "Safe Mode là một thang sáu cấp theo loại câu lệnh. Nó quyết định — trước khi câu lệnh chạy — rằng câu đó được chạy tự do, cần xác nhận, hay bị chặn hẳn. Nâng cấp lên khi bạn làm việc với dữ liệu quan trọng." },
        { type: "table", head: ["Cấp", "Nhãn", "Hiệu lực"], rows: [
          ["0", "Tắt", "Tắt bộ chặn theo loại câu lệnh (bộ chặn capability vẫn chạy)."],
          ["1", "Chỉ đọc", "Chỉ SELECT / SHOW / EXPLAIN / WITH; chặn mọi câu ghi."],
          ["2", "Rủi ro thấp", "Chỉ SELECT và INSERT; chặn UPDATE / DELETE."],
          ["3", "Tiêu chuẩn", "INSERT / UPDATE / DELETE cần xác nhận; chặn DROP / TRUNCATE / phần lớn ALTER / CREATE TABLE."],
          ["4", "Nghiêm ngặt", "Xác nhận cho mọi câu ghi; chặn cứng DROP / TRUNCATE / CREATE TABLE."],
          ["5", "Cực kỳ thận trọng", "Xác nhận cho cả SELECT lẫn mọi câu ghi, kèm bản xem trước và ước lượng số dòng bị ảnh hưởng."],
        ] },
        { type: "callout", tone: "warn", title: "Một mức sàn không thể tắt", text: "Bất kể ở cấp nào, một bộ chặn capability luôn chặn SQL đụng tới filesystem, mạng hoặc hệ điều hành (ví dụ pg_read_file, LOAD_FILE, COPY … TO PROGRAM, xp_cmdshell). Nó chạy ngay cả ở cấp 0 và không có đường vòng." },
        { type: "h2", text: "Lịch sử và mục ưa thích" },
        { type: "ul", items: [
          "Lịch sử truy vấn (Ctrl + H) ghi lại những gì bạn đã chạy để mở lại hoặc chạy lại.",
          "SQL ưa thích (Ctrl + Shift + S) lưu các câu lệnh bạn hay dùng.",
          "Tab và trạng thái phiên được giữ, nên mở lại TableR là công việc quay lại.",
        ] },
        { type: "h2", text: "Kết quả, biểu đồ và xuất dữ liệu" },
        { type: "p", text: "Mọi tập kết quả mở trong một lưới ảo hóa, nhanh, cho phép sắp xếp, lọc và phân trang — kể cả trên bảng lớn. Chuyển cùng một kết quả giữa bảng và biểu đồ, rồi xuất khi cần chia sẻ." },
        { type: "ul", items: [
          "Chế độ bảng với sắp xếp, lọc và phân trang cho tập kết quả lớn.",
          "Chế độ biểu đồ để trực quan hóa chính các dòng đó mà không phải truy vấn lại.",
          "Xuất ra CSV, JSON, Excel hoặc các định dạng thiên về SQL.",
        ] },
        { type: "h2", text: "Terminal tích hợp" },
        { type: "p", text: "Bật/tắt terminal dock bằng Ctrl + ` để chạy lệnh shell ngay cạnh truy vấn — tiện cho migration, script, hay một phiên psql/mysql nhanh — mà không rời workspace." },
        { type: "callout", tone: "tip", title: "Giữ tay trên bàn phím", text: "Ctrl + Enter chạy, Ctrl + Space bật/tắt panel AI, Ctrl + B trình duyệt, và Ctrl + ` terminal — gần như cả phiên làm việc không cần đến chuột." },
        { type: "h2", text: "Bước tiếp theo" },
        { type: "cards", items: [
          { title: "Khám phá dữ liệu", text: "Duyệt schema, xem chi tiết dòng và so sánh cấu trúc.", href: "/docs/exploring-data" },
          { title: "Trực quan & sơ đồ", text: "Biến kết quả thành biểu đồ, sơ đồ ER và query plan.", href: "/docs/visualize" },
          { title: "AI & Agent", text: "Sinh và duyệt SQL với ngữ cảnh schema và mô hình an toàn.", href: "/docs/ai-agent" },
        ] },
      ],
    },
    {
      slug: "exploring-data",
      icon: "Table",
      title: "Khám phá dữ liệu",
      description: "Duyệt schema, phân trang bảng lớn, xem chi tiết dòng, so sánh cấu trúc và sửa dữ liệu an toàn.",
      blocks: [
        { type: "p", text: "TableR cho bạn trình duyệt schema có tìm kiếm cùng các công cụ tập trung để đọc, hiểu và sửa dữ liệu bảng mà không phải viết truy vấn rườm rà. Nó được thiết kế để mượt trên database thực tế — hàng trăm bảng và bảng có hàng triệu dòng." },
        { type: "h2", text: "Trình duyệt schema" },
        { type: "p", text: "Trình duyệt bên trái là bản đồ của kết nối. Ô tìm kiếm thu hẹp nó tức thì, và bật/tắt bằng Ctrl + B để trả lại toàn bộ chiều rộng cho trình soạn và kết quả." },
        { type: "ul", items: [
          "Tìm kiếm cùng lúc xuyên database, schema, bảng và cột.",
          "Mở rộng một object để xem cột, khóa và index ngay tại chỗ.",
          "Mở một bảng thẳng vào trình duyệt dữ liệu, hoặc nhảy sang khung cấu trúc của nó.",
          "Bật/tắt trình duyệt bằng Ctrl + B; dùng quick switcher (Ctrl + P) để nhảy tới object theo tên.",
        ] },
        { type: "h2", text: "Duyệt dữ liệu bảng" },
        { type: "p", text: "Mở một bảng sẽ tải các dòng vào một lưới ảo hóa được xây cho quy mô lớn. Chỉ các dòng đang hiển thị được render, nên cuộn vẫn mượt dù bảng có trăm dòng hay một triệu dòng." },
        { type: "ul", items: [
          "Phân trang, sắp xếp và lọc để tìm đúng dòng bạn quan tâm.",
          "Đổi kích thước, sắp xếp lại, ẩn/hiện và ghim cột để định hình khung nhìn.",
          "Bố cục theo từng bảng được ghi nhớ, nên mở lại bảng đúng như lúc bạn rời đi.",
        ] },
        { type: "callout", tone: "info", title: "Xây cho bảng lớn", text: "Lưới dữ liệu được ảo hóa và phân trang kết quả, nên duyệt bảng một triệu dòng vẫn mượt và giữ trong giới hạn bộ nhớ." },
        { type: "h2", text: "Xem chi tiết một dòng" },
        { type: "p", text: "Bảng rộng khó đọc theo chiều ngang. Trình xem dòng mở một bản ghi trong một panel cao, dễ đọc — kể cả văn bản dài, JSON và cột dạng nhị phân — để bạn nghiên cứu hoặc sao chép một giá trị mà không phải cuộn ngang." },
        { type: "h2", text: "Hiểu cấu trúc" },
        { type: "ul", items: [
          "Khung cấu trúc cho cột, kiểu dữ liệu, khóa và index của một bảng.",
          "Schema diff để so sánh hai cấu trúc và phát hiện lệch giữa các môi trường.",
          "Trợ giúp tạo schema object soạn sẵn DDL cho các tác vụ phổ biến để bạn duyệt trước khi chạy.",
        ] },
        { type: "callout", tone: "info", title: "Độ sâu khác nhau theo engine", text: "Mức độ chi tiết metadata, explain plan và chỉnh sửa schema phụ thuộc từng driver, nên một số engine hiển thị nhiều thông tin cấu trúc hơn engine khác." },
        { type: "h2", text: "Sửa dữ liệu an toàn" },
        { type: "p", text: "TableR hỗ trợ sửa trực tiếp trong lưới, kèm theo dõi thay đổi để bạn thấy chính xác điều gì sẽ được ghi. Sửa, dán, điền và xóa nhắm đúng các dòng bạn chọn, và được xếp để duyệt trước khi commit — đúng nguyên tắc duyệt-trước-khi-chạy dùng ở khắp ứng dụng." },
        { type: "callout", tone: "warn", title: "Bạn luôn kiểm soát việc ghi", text: "Việc sửa dữ liệu được xem trước và do bạn áp dụng. Không có gì bị ghi âm thầm, và Safe Mode vẫn chi phối các câu lệnh bên dưới." },
        { type: "h2", text: "Đưa dữ liệu ra vào" },
        { type: "p", text: "Xem trước và import tệp CSV, và xuất bất kỳ tập kết quả hay bảng nào ra CSV, JSON, Excel hoặc các định dạng thiên về SQL. Các lần truyền lớn chạy dạng luồng có tiến độ và hủy được, nên một lần xuất lớn không làm treo ứng dụng." },
        { type: "callout", tone: "tip", title: "Kết quả theo ý bạn", text: "Chuyển bất kỳ tập kết quả nào giữa bảng và biểu đồ, rồi xuất nó — khung nhìn bạn đang xem chính là hình dạng bạn có thể chia sẻ." },
        { type: "h2", text: "Bước tiếp theo" },
        { type: "cards", items: [
          { title: "SQL workspace", text: "Viết và chạy SQL với những gì bạn vừa khám phá.", href: "/docs/sql-workspace" },
          { title: "Trực quan & sơ đồ", text: "Biến bảng và quan hệ thành sơ đồ ER và biểu đồ.", href: "/docs/visualize" },
          { title: "Kết nối & CSDL", text: "Thêm một engine khác hoặc bootstrap một database local.", href: "/docs/connections" },
        ] },
      ],
    },
    {
      slug: "visualize",
      icon: "Network",
      title: "Trực quan & sơ đồ",
      description: "Dựng sơ đồ ER, vẽ biểu đồ kết quả, theo dõi chỉ số và đọc query plan bằng hình ảnh.",
      blocks: [
        { type: "p", text: "Đôi khi cách nhanh nhất để hiểu một database là nhìn thấy nó. TableR biến bảng thành sơ đồ ER, tập kết quả thành biểu đồ, và query plan thành một đồ thị dễ đọc — để bạn giải thích một schema, phát hiện bước chậm, hoặc trao một bức hình cho người tiếp theo trong cuộc trao đổi." },
        { type: "image", src: "/screenshots/table-r-er-diagram.png", alt: "Workspace sơ đồ ER của TableR hiển thị các bảng và quan hệ", width: 1280, height: 801 },
        { type: "h2", text: "Sơ đồ ER" },
        { type: "p", text: "Dựng sơ đồ quan hệ thực thể từ các bảng bạn chọn. TableR đọc khóa ngoại để vẽ quan hệ, rồi tự bố cục đồ thị cho bạn." },
        { type: "steps", items: [
          { title: "Chọn bảng", text: "Chọn những bảng quan trọng với mô hình bạn đang mô tả — một mảng tính năng, không phải cả database." },
          { title: "Tự bố cục", text: "Để TableR sắp xếp đồ thị, rồi fit canvas để đóng khung." },
          { title: "Xem xét", text: "Lần theo các đường nối giữa các bảng để truy vết khóa ngoại và lực lượng quan hệ." },
          { title: "Xuất", text: "Lưu sơ đồ ra PNG để chia sẻ, hoặc xuất SQL cho các bảng đã mô hình hóa." },
        ] },
        { type: "h3", text: "Điều hướng schema lớn" },
        { type: "ul", items: [
          "Minimap giúp bạn định vị khi đồ thị lớn hơn màn hình.",
          "Điều khiển zoom, pan và fit-to-canvas giúp di chuyển nhanh.",
          "Kéo các bảng để tinh chỉnh bố cục tự động khi bạn muốn một cách sắp xếp cụ thể.",
        ] },
        { type: "h2", text: "Biểu đồ" },
        { type: "p", text: "Bất kỳ tập kết quả nào cũng có thể thành biểu đồ mà không phải truy vấn lại database. Chạy một truy vấn, chuyển kết quả sang chế độ biểu đồ, và chọn cách vẽ — hữu ích cho một xu hướng nhanh hoặc một hình để đưa vào báo cáo." },
        { type: "ul", items: [
          "Vẽ biểu đồ cho bất kỳ tập kết quả nào bằng chế độ biểu đồ tích hợp (dùng Recharts).",
          "Chọn các cột ánh xạ vào trục và chuỗi dữ liệu.",
          "Chuyển qua lại giữa bảng và biểu đồ trên cùng một kết quả bất cứ lúc nào.",
        ] },
        { type: "h2", text: "Bảng chỉ số" },
        { type: "p", text: "Ghim những con số bạn hay kiểm tra — số dòng, tổng, chỉ số sức khỏe — lên một bảng chỉ số để chúng luôn hiển thị khi làm việc, thay vì chạy lại cùng một truy vấn bằng tay." },
        { type: "h2", text: "Trực quan hóa query plan" },
        { type: "p", text: "Explain một câu lệnh để thấy engine định chạy nó thế nào, hiển thị dạng đồ thị thay vì văn bản thô. Lần theo các bước để tìm scan hoặc join tốn kém, rồi chỉnh truy vấn hoặc thêm index." },
        { type: "callout", tone: "info", title: "Độ sâu explain khác nhau theo engine", text: "Mức chi tiết của plan phụ thuộc từng driver, nên độ phong phú của phần trực quan hóa khác nhau giữa các engine." },
        { type: "h2", text: "Bước tiếp theo" },
        { type: "cards", items: [
          { title: "Khám phá dữ liệu", text: "Tìm các bảng và quan hệ đáng để vẽ sơ đồ.", href: "/docs/exploring-data" },
          { title: "SQL workspace", text: "Viết các truy vấn đứng sau biểu đồ và plan của bạn.", href: "/docs/sql-workspace" },
          { title: "AI & Agent", text: "Nhờ trợ lý soạn truy vấn hoặc giải thích plan.", href: "/docs/ai-agent" },
        ] },
      ],
    },
    {
      slug: "ai-agent",
      icon: "Bot",
      title: "AI & Agent",
      description: "Chế độ Prompt, Edit và Agent với ngữ cảnh schema, một núm tự chủ, Safe Mode và an toàn duyệt-trước-khi-chạy.",
      blocks: [
        { type: "p", text: "TableR giữ ngữ cảnh schema, SQL sinh ra, việc thực thi truy vấn và trợ lý trong cùng một khung nhìn. Hỏi một câu, sinh hoặc viết lại một câu lệnh, hoặc giao cho agent một tác vụ nhiều bước — và luôn kiểm soát mọi lần ghi vào database qua núm tự chủ và Safe Mode." },
        { type: "image", src: "/screenshots/table-r-ai-workspace.png", alt: "Workspace AI của TableR bên cạnh trình soạn SQL", width: 1280, height: 801 },
        { type: "h2", text: "Ba chế độ" },
        { type: "cards", items: [
          { title: "Prompt", text: "Hỏi đáp kèm ngữ cảnh schema, sinh SQL từ ngôn ngữ tự nhiên và giải thích truy vấn sẵn có." },
          { title: "Edit", text: "Tinh chỉnh và viết lại SQL với trợ lý làm việc trực tiếp trên câu lệnh trong trình soạn của bạn." },
          { title: "Agent", text: "Giao một mục tiêu: agent soi schema, đọc dữ liệu an toàn và soạn câu trả lời hay báo cáo qua nhiều bước." },
        ] },
        { type: "callout", tone: "tip", title: "Nó nằm ngay cạnh truy vấn", text: "Bật/tắt panel AI bằng Ctrl + Space. Nó đọc schema của kết nối đang mở để lấy ngữ cảnh, và bạn có thể đính kèm ảnh hoặc tệp văn bản vào một tin nhắn." },
        { type: "h2", text: "Tự chủ: khi nào agent chạy SQL" },
        { type: "p", text: "Mức tự chủ quyết định agent có dừng lại để hỏi từng câu lệnh trước khi chạy hay không. Nó tách biệt với Safe Mode: tự chủ quyết định khi nào hỏi, Safe Mode quyết định điều gì được phép." },
        { type: "table", head: ["Mức tự chủ", "Hành vi"], rows: [
          ["Review", "Luôn hiện hộp thoại duyệt. Không gì chạy cho tới khi bạn đồng ý — mức thận trọng nhất."],
          ["Smart", "Tự chạy các câu đọc an toàn và dừng lại xác nhận mọi câu ghi hay rủi ro cao."],
          ["Full", "Chấp thuận thường trực: đọc và ghi đều chạy không cần hộp thoại từng câu — nhưng chỉ khi Safe Mode ở cấp 1–3."],
        ] },
        { type: "callout", tone: "info", title: "Full vẫn có giới hạn", text: "Chấp thuận thường trực của Full chỉ áp dụng ở Safe Mode cấp 1–3. Ở Nghiêm ngặt hay Cực kỳ thận trọng (4–5), agent vẫn dừng lại xác nhận, và các câu lệnh bị chặn vẫn bị chặn." },
        { type: "h2", text: "Safe Mode chi phối mọi câu lệnh" },
        { type: "p", text: "Dù SQL đến từ bạn hay từ agent, nó đều đi qua cùng một Safe Mode sáu cấp. Chấp thuận của con người có thể nới lỏng chặn ghi/DDL ở cấp 1–3, nhưng nhóm phá hủy — DROP, TRUNCATE, CREATE TABLE — bị chặn cứng ở cấp 4–5 và không có đường vòng." },
        { type: "table", head: ["Cấp", "Nhãn", "Hiệu lực"], rows: [
          ["0", "Tắt", "Tắt bộ chặn theo loại câu lệnh (bộ chặn capability vẫn chạy)."],
          ["1", "Chỉ đọc", "Chỉ SELECT / SHOW / EXPLAIN / WITH; chặn mọi câu ghi."],
          ["2", "Rủi ro thấp", "Chỉ SELECT và INSERT; chặn UPDATE / DELETE."],
          ["3", "Tiêu chuẩn", "INSERT / UPDATE / DELETE cần xác nhận; chặn DROP / TRUNCATE / phần lớn ALTER / CREATE TABLE."],
          ["4", "Nghiêm ngặt", "Xác nhận cho mọi câu ghi; chặn cứng DROP / TRUNCATE / CREATE TABLE."],
          ["5", "Cực kỳ thận trọng", "Xác nhận cho cả SELECT lẫn mọi câu ghi, kèm bản xem trước và ước lượng số dòng bị ảnh hưởng."],
        ] },
        { type: "h2", text: "Bộ chặn capability luôn bật" },
        { type: "p", text: "Trước cả khi Safe Mode phân loại một câu lệnh, một bộ chặn capability fail-closed chạy trước và không thể vượt qua — kể cả ở cấp 0. Nó chặn SQL vươn ra ngoài database để đụng vào filesystem, mạng hoặc hệ điều hành." },
        { type: "ul", items: [
          "Truy cập filesystem và chương trình như pg_read_file, pg_ls_dir, lo_import/lo_export, MySQL LOAD_FILE / INTO OUTFILE / LOAD DATA INFILE, DuckDB read_csv/read_parquet/glob, Postgres COPY … TO/FROM PROGRAM, và MSSQL xp_cmdshell/openrowset.",
          "Kiểm soát phiên và truy cập như USE, ATTACH, SET search_path, transaction, và GRANT/REVOKE.",
          "Mỗi mục chỉ một câu lệnh, nên một truy vấn vô hại không thể lén kèm câu thứ hai.",
        ] },
        { type: "callout", tone: "info", title: "Backend là nơi quyết định cuối cùng", text: "Kiểm tra nhanh ở frontend chỉ mang tính tư vấn; bộ chặn có thẩm quyền là một trình phân tích SQL trong backend Rust, nó còn bắt được các CTE có ghi mà so khớp mẫu đơn giản sẽ bỏ sót." },
        { type: "h2", text: "Duyệt trước khi chạy" },
        { type: "p", text: "Với các câu ghi, TableR xem trước hiệu ứng trước khi bạn commit. Write preview chạy trong một transaction và luôn rollback, nên bạn đọc số dòng bị ảnh hưởng trước, rồi tự áp dụng câu SQL cuối cùng." },
        { type: "callout", tone: "warn", title: "Đề xuất, không bất ngờ", text: "Trợ lý soạn SQL và hiện bản xem trước; bạn quyết định điều gì thực sự chạy trên dữ liệu của mình." },
        { type: "h2", text: "Có căn cứ và quan sát được" },
        { type: "ul", items: [
          "Phơi bày cách làm: mỗi bước nằm trong một trace trực tiếp có thể mở ra, và mỗi lần chạy được ghi lại để xem lại.",
          "Dùng schema của bạn: câu trả lời được dựng từ schema đã xác minh thay vì đoán tên cột.",
          "Học nghiệp vụ: định nghĩa chỉ số và alias đã xác minh được ghi nhớ theo từng database.",
          "Dẫn nguồn: câu trả lời liên kết ngược về các dòng làm căn cứ để bạn điều hướng tới bằng chứng.",
        ] },
        { type: "h2", text: "Provider và dự phòng" },
        { type: "p", text: "Cấu hình provider AI của riêng bạn trong cài đặt. Nếu một provider bị rate limit hoặc ngắt giữa chừng, agent tự chuyển sang provider kế tiếp bạn đã cấu hình, nên một tác vụ dài không chết vì một trục trặc." },
        { type: "callout", tone: "info", title: "AI là tính năng trực tuyến duy nhất", text: "Phần còn lại của TableR chạy cục bộ. Tính năng AI cần một provider đã cấu hình và mạng; credential và dữ liệu của bạn vẫn ở trên máy bạn." },
        { type: "h2", text: "Bước tiếp theo" },
        { type: "cards", items: [
          { title: "SQL workspace", text: "Nơi SQL sinh ra được chạy, với timeout và Safe Mode.", href: "/docs/sql-workspace" },
          { title: "Khám phá dữ liệu", text: "Cấp ngữ cảnh cho agent bằng cách tự khám phá schema.", href: "/docs/exploring-data" },
          { title: "Kiến trúc", text: "Cách thực thi, hủy và pooling hoạt động bên dưới.", href: "/docs/architecture" },
        ] },
      ],
    },
    {
      slug: "shortcuts",
      icon: "Keyboard",
      title: "Phím tắt",
      description: "Di chuyển trong workspace mà không rời bàn phím.",
      blocks: [
        { type: "p", text: "TableR được xây cho công việc lặp lại hằng ngày, nên các thao tác cốt lõi chỉ cách một phím tắt. Phím tắt có thể tùy chỉnh trong phần cài đặt của ứng dụng." },
        { type: "table", head: ["Phím tắt", "Hành động"], rows: shortcutRows([
          "Tạo tab truy vấn",
          "Chạy truy vấn hiện tại",
          "Bật/tắt workspace AI",
          "Mở quick switcher",
          "Mở command palette",
          "Bật/tắt trình duyệt database",
          "Bật/tắt terminal",
          "Bật/tắt kết quả truy vấn",
          "Mở lịch sử truy vấn",
          "Mở SQL ưa thích",
          "Format SQL",
        ]) },
        { type: "h2", text: "Command palette & quick switcher" },
        { type: "ul", items: [
          "Command palette (Ctrl + Shift + P) chạy bất kỳ hành động nào theo tên.",
          "Quick switcher (Ctrl + P) nhảy giữa các tab, object và khung nhìn.",
        ] },
        { type: "callout", tone: "tip", title: "Tùy biến theo bạn", text: "Mọi phím tắt đều gán lại được trong cài đặt ứng dụng để hợp với thói quen của bạn." },
      ],
    },
    {
      slug: "architecture",
      icon: "Layers3",
      title: "Kiến trúc",
      description: "Cách vỏ Tauri, giao diện React và backend Rust kết hợp với nhau.",
      blocks: [
        { type: "p", text: "TableR kết hợp vỏ desktop Tauri, giao diện React và backend Rust. Frontend giao tiếp với dịch vụ native qua Tauri command và event; backend quản lý connection pool và các engine adapter." },
        { type: "code", lang: "text", code: ARCH_DIAGRAM },
        { type: "h2", text: "Công nghệ" },
        { type: "table", head: ["Tầng", "Stack"], rows: [
          ["Runtime desktop", TECH_STACK[0]],
          ["Frontend", TECH_STACK[1]],
          ["Giao diện", TECH_STACK[2]],
          ["Backend native", TECH_STACK[3]],
          ["Truy cập CSDL", TECH_STACK[4]],
          ["Trình soạn & terminal", TECH_STACK[5]],
          ["Dữ liệu & sơ đồ", TECH_STACK[6]],
          ["Quản lý state", TECH_STACK[7]],
        ] },
        { type: "h2", text: "Một truy vấn chạy thế nào" },
        { type: "p", text: "Khi bạn chạy một câu lệnh, query store ở frontend phát một yêu cầu kèm id duy nhất và kết nối đang hoạt động. Backend Rust đăng ký một cancellation token cho yêu cầu đó, rồi thực thi SQL trên driver của engine đích." },
        { type: "steps", items: [
          { title: "Yêu cầu", text: "Frontend tạo request id, lưu kết nối đang hoạt động và gọi Tauri command tương ứng." },
          { title: "Đăng ký", text: "Backend đăng ký một cancellation token cho yêu cầu để có thể dừng về sau." },
          { title: "Thực thi", text: "Trên PostgreSQL và MySQL, driver lấy một kết nối pool riêng và ghi lại backend/connection id của nó, rồi chạy SQL của bạn trên kết nối đó." },
          { title: "Kết thúc hoặc hủy", text: "Kết quả trả về kèm thời gian, hoặc một yêu cầu hủy dừng việc chờ — và, nơi được hỗ trợ, dừng câu lệnh trên server." },
        ] },
        { type: "h3", text: "Hủy truy vấn" },
        { type: "p", text: "Việc hủy gỡ chặn yêu cầu đang chờ ngay lập tức. Trên PostgreSQL, TableR phát pg_cancel_backend qua một kết nối pool thứ hai; trên MySQL/MariaDB nó phát KILL QUERY theo cùng cách, nên lệnh hủy không xếp hàng sau câu lệnh đang chạy. Một drop guard luôn dọn dẹp mục trong registry, kể cả khi timeout hay panic." },
        { type: "h3", text: "Connection pooling" },
        { type: "p", text: "Pool của PostgreSQL và MySQL giới hạn ở tám kết nối. Việc hủy cố ý dùng một kết nối riêng để không bao giờ phải chờ sau truy vấn đang chạy. Sử dụng desktop là đơn người dùng, nên một kết nối riêng trong lúc truy vấn có thể hủy là đánh đổi chấp nhận được." },
        { type: "h2", text: "Bố cục dự án" },
        { type: "code", lang: "text", code: PROJECT_LAYOUT },
        { type: "callout", tone: "info", title: "Local-first theo thiết kế", text: "TableR chạy trên máy bạn. Credential nằm trong keyring hệ điều hành, và dữ liệu của bạn không đi qua website này." },
      ],
    },
    {
      slug: "faq",
      icon: "HelpCircle",
      title: "FAQ & hỗ trợ",
      description: "Câu hỏi thường gặp về giấy phép, dữ liệu và nơi nhận trợ giúp.",
      blocks: [
        { type: "h3", text: "TableR có miễn phí và mã nguồn mở không?" },
        { type: "p", text: "Có. TableR phát hành theo giấy phép GNU GPL v3.0. Bạn có thể đọc, chỉnh sửa và đóng góp mã nguồn trên GitHub." },
        { type: "h3", text: "Hỗ trợ những database nào?" },
        { type: "p", text: "18 engine thuộc các nhóm quan hệ, phân tích, nhúng, NoSQL và cloud-native — từ PostgreSQL và MySQL tới Snowflake, MongoDB và Cloudflare D1. Xem mục Kết nối & CSDL để có danh sách đầy đủ." },
        { type: "h3", text: "Credential của tôi lưu ở đâu?" },
        { type: "p", text: "Trong keyring của hệ điều hành. Bí mật không hiển thị trên giao diện, và không bao giờ đi qua website này." },
        { type: "h3", text: "Có hoạt động offline không?" },
        { type: "p", text: "Ứng dụng desktop chạy cục bộ. Tính năng AI cần một provider đã cấu hình và mạng, nhưng phần còn lại chạy trên máy bạn." },
        { type: "h3", text: "Dữ liệu của tôi có bị gửi đi đâu không?" },
        { type: "p", text: "Không. TableR kết nối trực tiếp từ máy bạn tới database của bạn. Website này không nhận truy vấn, kết quả hay credential của bạn. Chỉ tính năng AI mới liên hệ một provider bên ngoài — và chỉ với ngữ cảnh bạn gửi trong một tin nhắn." },
        { type: "h3", text: "Safe Mode là gì?" },
        { type: "p", text: "Một bộ chặn sáu cấp (0–5) đối với SQL được phép chạy. Cấp cao hơn chặn hoặc buộc xác nhận với câu ghi và DDL phá hủy. Một bộ chặn capability luôn bật, tách biệt, chặn truy cập filesystem, mạng và hệ điều hành ở mọi cấp, không có đường vòng. Xem SQL workspace và AI & Agent để biết mô hình đầy đủ." },
        { type: "h3", text: "AI có thể tự chạy SQL phá hủy không?" },
        { type: "p", text: "Chỉ trong giới hạn bạn đặt. Núm tự chủ quyết định khi nào agent dừng lại xin phép, còn Safe Mode quyết định điều gì được phép. Kể cả ở mức Full, chấp thuận thường trực đó chỉ áp dụng ở Safe Mode cấp 1–3; DROP, TRUNCATE và CREATE TABLE vẫn bị chặn cứng ở các cấp nghiêm ngặt." },
        { type: "h3", text: "Timeout và hủy truy vấn hoạt động ra sao?" },
        { type: "p", text: "Câu chỉ đọc timeout sau 180 giây, còn câu ghi hoặc cấu trúc sau 60 giây; lô hỗn hợp dùng cửa sổ ngắn hơn. Bạn có thể hủy bất cứ lúc nào — trên PostgreSQL và MySQL/MariaDB câu lệnh còn bị dừng trên server. Xem Kiến trúc để biết chi tiết." },
        { type: "h3", text: "Engine nào bootstrap local được?" },
        { type: "p", text: "Bootstrap local có cho PostgreSQL, MySQL, MariaDB và SQLite (MongoDB đang lên kế hoạch). Mọi engine được hỗ trợ cũng mở được qua profile đã lưu, connection string, hoặc chọn tệp nếu phù hợp." },
        { type: "h3", text: "Cập nhật TableR thế nào?" },
        { type: "p", text: "Tải bản mới nhất và cài đè lên bản hiện tại. Kết nối đã lưu nằm trong keyring hệ điều hành và tùy chọn lưu cục bộ, nên chúng được giữ qua các lần cập nhật." },
        { type: "h3", text: "Báo lỗi hoặc đề xuất tính năng thế nào?" },
        { type: "p", text: "Dùng GitHub Issues cho lỗi tái hiện được và GitHub Discussions cho ý tưởng hoặc câu hỏi chung." },
        { type: "callout", tone: "tip", title: "Ủng hộ phát triển", text: "Bạn có thể ủng hộ qua Buy Me a Coffee. Mọi đóng góp và đề xuất tính năng tập trung đều được hoan nghênh." },
      ],
    },
  ],
};

const bundles: Record<SiteLanguage, DocsBundle> = { en, vi };

export function getDocs(language: SiteLanguage): DocsBundle {
  return bundles[language];
}

export function getDocPage(language: SiteLanguage, slug: string): DocPage | undefined {
  return bundles[language].pages.find((page) => page.slug === slug);
}
