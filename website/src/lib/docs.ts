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
  | { type: "callout"; tone: "info" | "tip" | "warn"; title?: string; text: string }
  | { type: "steps"; items: { title: string; text: string }[] }
  | { type: "cards"; items: { title: string; text: string }[] }
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
        { type: "h2", text: "What you get" },
        { type: "cards", items: [
          { title: "SQL workspace", text: "Monaco editor, multiple query tabs, formatting, execution timing, explain tools, history, and favorites." },
          { title: "Data exploration", text: "Searchable schema explorer, table browsing, row inspection, pagination, sorting, and filtering." },
          { title: "Results and exports", text: "Table and chart views with CSV, JSON, Excel, and SQL-oriented export workflows." },
          { title: "Visual database tools", text: "Interactive ER diagrams, minimap and layout controls, metrics boards, and query plan visualization." },
          { title: "AI assistance", text: "Prompt, Edit, and Agent modes with schema context, attachments, review-before-run SQL, and configurable providers." },
          { title: "Desktop workflow", text: "Saved connections, local database bootstrap, OS keyring credentials, command palette, terminal, and session persistence." },
        ] },
        { type: "h2", text: "Who it is for" },
        { type: "p", text:
          "Anyone who works with databases day to day: engineers, analysts, and data teams who want one calm workspace across relational, analytical, document, cache, and cloud engines." },
        { type: "callout", tone: "info", title: "Open source", text:
          "TableR is distributed under the GNU General Public License v3.0. You can read the code, open an issue, or contribute the workflow you wish existed." },
        { type: "h2", text: "How these docs are organized" },
        { type: "ul", items: [
          "Getting started — install the app or build it from source.",
          "Connections — the launcher, supported engines, and local bootstrap.",
          "SQL workspace — the editor, tabs, execution, and history.",
          "Exploring data — schema explorer, row inspector, and structure tools.",
          "Visualize — charts, ER diagrams, and query plans.",
          "AI & Agent — Prompt/Edit/Agent modes and safety.",
          "Keyboard shortcuts, architecture, and FAQ round out the reference.",
        ] },
      ],
    },
    {
      slug: "getting-started",
      icon: "Rocket",
      title: "Getting started",
      description: "Install a prebuilt release, or build TableR from source for development.",
      blocks: [
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
        { type: "ul", items: [
          "Connections & databases — connect to all 18 engines, or bootstrap one locally.",
          "SQL workspace — tabs, formatting, execution timing, history, and favorites.",
          "Exploring data — schema explorer, table browsing, and row inspection.",
          "Visualize — charts, ER diagrams, and query-plan views.",
          "AI agent — Prompt, Edit, and Agent modes with schema context.",
          "Keyboard shortcuts — the full reference for working faster.",
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
        { type: "h3", text: "PostgreSQL" },
        { type: "p", text: "A network SQL engine. Fill the form, or use the local bootstrap if you do not have a server." },
        { type: "ul", items: [
          "Host — your server (default 127.0.0.1).",
          "Port — 5432.",
          "Username — required.",
          "Password — optional, stored in the OS keyring.",
          "Database — optional.",
          "SSL/TLS — supported; enable it for remote servers.",
          "Local bootstrap — ready.",
        ] },
        { type: "h3", text: "MySQL" },
        { type: "p", text: "The engine selected by default when you create a new connection." },
        { type: "ul", items: [
          "Host — default 127.0.0.1.",
          "Port — 3306.",
          "Username — required.",
          "Password — optional.",
          "Database — optional.",
          "SSL/TLS — supported.",
          "Local bootstrap — ready.",
        ] },
        { type: "h3", text: "MariaDB" },
        { type: "p", text: "Uses the MySQL wire protocol, so the fields match MySQL." },
        { type: "ul", items: [
          "Host — default 127.0.0.1.",
          "Port — 3306.",
          "Username — required.",
          "Password — optional.",
          "Database — optional.",
          "SSL/TLS — supported.",
          "Local bootstrap — ready.",
        ] },
        { type: "h3", text: "CockroachDB" },
        { type: "p", text: "Speaks the PostgreSQL wire protocol." },
        { type: "ul", items: [
          "Host — your node or CockroachDB Cloud host.",
          "Port — 26257.",
          "Username — required.",
          "Password — optional.",
          "Database — optional.",
          "SSL/TLS — supported (often required by CockroachDB Cloud).",
        ] },
        { type: "h3", text: "Greenplum" },
        { type: "p", text: "A PostgreSQL-compatible analytics warehouse." },
        { type: "ul", items: [
          "Host — your coordinator host.",
          "Port — 5432.",
          "Username — required.",
          "Password — optional.",
          "Database — optional.",
          "SSL/TLS — supported.",
        ] },
        { type: "h3", text: "Amazon Redshift" },
        { type: "p", text: "A PostgreSQL-compatible cloud warehouse." },
        { type: "ul", items: [
          "Host — your cluster endpoint (cluster.region.redshift.amazonaws.com).",
          "Port — 5439.",
          "Username — required.",
          "Password — optional.",
          "Database — optional.",
          "SSL/TLS — supported.",
        ] },
        { type: "h3", text: "SQL Server" },
        { type: "p", text: "Microsoft SQL Server, with Windows or SQL authentication." },
        { type: "ul", items: [
          "Host — localhost,1433 or SERVER\\INSTANCE.",
          "Port — 1433.",
          "Authentication — Windows or SQL Server, auto-detected from the host (Microsoft Entra not supported yet).",
          "Username / Password — optional, used for SQL authentication.",
          "Database — optional.",
          "Instance name — optional, or embed SERVER\\INSTANCE in the host.",
          "Encrypt — Optional or Mandatory; Trust server certificate is on by default for local self-signed certs.",
          "Local bootstrap — ready.",
        ] },
        { type: "h3", text: "Vertica" },
        { type: "p", text: "A columnar analytics database." },
        { type: "ul", items: [
          "Host — your Vertica host.",
          "Port — 5433.",
          "Username — required.",
          "Password — optional.",
          "Database — optional.",
          "SSL/TLS — supported.",
        ] },
        { type: "h3", text: "ClickHouse" },
        { type: "p", text: "Connects over the ClickHouse HTTP interface." },
        { type: "ul", items: [
          "Host — your ClickHouse host.",
          "Port — 8123 (HTTP interface).",
          "Username — required.",
          "Password — optional.",
          "Database — optional.",
          "SSL/TLS — supported.",
        ] },
        { type: "h3", text: "Snowflake" },
        { type: "p", text: "A cloud data warehouse reached over HTTPS at your account host." },
        { type: "ul", items: [
          "Host — account.region.snowflakecomputing.com.",
          "Port — 443 (HTTPS).",
          "Credential — your Snowflake password or token.",
          "Warehouse — needed when the session has no default warehouse.",
          "Schema — optional default schema.",
          "Role — optional; uses the default role when empty.",
          "Database — optional.",
        ] },
        { type: "h3", text: "BigQuery" },
        { type: "p", text: "Google Cloud's serverless warehouse, authenticated with a service account." },
        { type: "ul", items: [
          "Host — bigquery.googleapis.com (HTTPS).",
          "Credential — a service-account key / token.",
          "Project ID — your Google Cloud project.",
          "Dataset — the dataset to browse.",
          "Location — the dataset region.",
        ] },
        { type: "h3", text: "SQLite" },
        { type: "p", text: "Embedded and file-based — there is no server." },
        { type: "ul", items: [
          "Database file — pick an existing .sqlite or .db file.",
          "No host, port, or credentials.",
          "Local bootstrap — ready; TableR can create a new local database file.",
        ] },
        { type: "h3", text: "DuckDB" },
        { type: "p", text: "An embedded analytical database in a single file." },
        { type: "ul", items: [
          "Database file — select or create a .duckdb file.",
          "Open mode — read_write, or read_only to inspect a file safely.",
          "No host, port, or credentials.",
        ] },
        { type: "h3", text: "Cassandra" },
        { type: "p", text: "A wide-column store reached over CQL." },
        { type: "ul", items: [
          "Host — one or more contact points (default 127.0.0.1).",
          "Port — 9042.",
          "Username — required (cluster user).",
          "Password — optional.",
          "Keyspace — optional (the Database field).",
          "Datacenter — optional local datacenter name.",
        ] },
        { type: "h3", text: "Redis" },
        { type: "p", text: "An in-memory key-value store." },
        { type: "ul", items: [
          "Host — default 127.0.0.1.",
          "Port — 6379.",
          "Username — optional (Redis 6+ ACL user).",
          "Password — optional.",
          "Database index — logical database number, usually 0.",
        ] },
        { type: "h3", text: "MongoDB" },
        { type: "p", text: "A document database; supports Atlas SRV and direct hosts." },
        { type: "ul", items: [
          "Host — default 127.0.0.1, or an Atlas hostname.",
          "Port — 27017.",
          "Connection discovery — Auto-detect, SRV (Atlas), or Direct (host:port); use Direct for PrivateLink (pl-*.mongodb.net) or self-hosted servers.",
          "Username / Password — optional.",
          "Database — optional; Auth source — the authentication database; Replica set — optional.",
          "SSL/TLS — supported. Local bootstrap — planned.",
        ] },
        { type: "h3", text: "LibSQL" },
        { type: "p", text: "SQLite-compatible, including remote Turso databases." },
        { type: "ul", items: [
          "Host — your-db.turso.io, or a local libSQL URL.",
          "Port — 8080.",
          "Credential — an auth token for remote/Turso databases.",
          "Database — optional.",
        ] },
        { type: "h3", text: "Cloudflare D1" },
        { type: "p", text: "Cloudflare's serverless SQLite, reached through the Cloudflare API." },
        { type: "ul", items: [
          "Host — api.cloudflare.com (HTTPS).",
          "Credential — a Cloudflare API token with D1 access.",
          "Account ID — your Cloudflare account.",
          "Database ID — the target D1 database.",
        ] },
      ],
    },
    {
      slug: "sql-workspace",
      icon: "Code2",
      title: "SQL workspace",
      description: "Write SQL in Monaco with tabs, execution timing, history, favorites, and a terminal.",
      blocks: [
        { type: "p", text: "The query workspace keeps the editor, data, and tools in one view. Explore objects from the sidebar, write SQL with Monaco, inspect results, switch to charts, and use the terminal without breaking context." },
        { type: "h2", text: "Highlights" },
        { type: "ul", items: [
          "Monaco editor with SQL awareness and formatting.",
          "Multiple query tabs to keep related work side by side.",
          "Execution timing and explain tools for each run.",
          "Query history and SQL favorites for reusable statements.",
          "An integrated terminal dock and results panel you can toggle.",
        ] },
        { type: "h2", text: "Run your first query" },
        { type: "steps", items: [
          { title: "Open a query tab", text: "Press Ctrl + N to create a new query tab." },
          { title: "Write SQL", text: "Type your statement in Monaco. Use Ctrl + Shift + F to format it." },
          { title: "Execute", text: "Press Ctrl + Enter to run the active query and see results with timing." },
          { title: "Reuse it", text: "Save it to favorites (Ctrl + Shift + S) or find it later in history (Ctrl + H)." },
        ] },
        { type: "callout", tone: "tip", title: "Stay on the keyboard", text: "Ctrl + Enter runs the active query, and Ctrl + Space toggles the AI workspace beside it — no mouse required." },
      ],
    },
    {
      slug: "exploring-data",
      icon: "Table",
      title: "Exploring data",
      description: "Browse schemas, inspect rows, compare structures, and page through results.",
      blocks: [
        { type: "p", text: "TableR gives you a searchable schema explorer plus focused tools for reading and understanding table data without writing boilerplate queries." },
        { type: "h2", text: "Schema explorer" },
        { type: "ul", items: [
          "Search across databases, schemas, tables, and columns.",
          "Toggle the explorer with Ctrl + B to reclaim screen space.",
          "Open table data browsing with pagination, sorting, and filtering.",
        ] },
        { type: "h2", text: "Inspect and understand" },
        { type: "ul", items: [
          "Row inspector for a full, readable view of a single record.",
          "Table structure view for columns, keys, and indexes.",
          "Schema diff to compare structures and spot drift.",
          "Create-schema-object helpers for common DDL tasks.",
        ] },
        { type: "callout", tone: "info", title: "Results your way", text: "Switch any result set between a table and a chart, then export to CSV, JSON, Excel, or SQL-oriented formats." },
      ],
    },
    {
      slug: "visualize",
      icon: "Network",
      title: "Visualize & diagrams",
      description: "Build ER diagrams, chart results, and read query plans visually.",
      blocks: [
        { type: "p", text: "See the shape of a database. Build an ER diagram from selected tables, navigate large schemas with a minimap, and export the result for the next conversation." },
        { type: "image", src: "/screenshots/table-r-er-diagram.png", alt: "TableR ER diagram workspace displaying tables and relationships", width: 1280, height: 801 },
        { type: "h2", text: "ER diagrams" },
        { type: "steps", items: [
          { title: "Select tables", text: "Choose the tables that matter to the model you are describing." },
          { title: "Auto-layout", text: "Let TableR arrange the graph, then fit the canvas and use the minimap for large schemas." },
          { title: "Inspect & export", text: "Trace relationships, then export the diagram as PNG or SQL." },
        ] },
        { type: "h2", text: "Charts & metrics" },
        { type: "ul", items: [
          "Chart any result set with the built-in chart view (Recharts).",
          "Metrics boards to keep key figures visible.",
          "Query plan visualization to understand how a statement executes.",
        ] },
      ],
    },
    {
      slug: "ai-agent",
      icon: "Bot",
      title: "AI & Agent",
      description: "Prompt, Edit, and Agent modes with schema context and review-before-run safety.",
      blocks: [
        { type: "p", text: "Keep schema context, generated SQL, query execution, and the assistant in the same view. Attach images or text files, switch between Prompt / Edit / Agent, and review SQL before anything writes to the database." },
        { type: "image", src: "/screenshots/table-r-ai-workspace.png", alt: "TableR AI workspace beside the SQL editor", width: 1280, height: 801 },
        { type: "h2", text: "Modes" },
        { type: "cards", items: [
          { title: "Prompt", text: "Ask questions with schema context, generate SQL, and explain existing queries." },
          { title: "Edit", text: "Refine and rewrite SQL with the assistant working directly on your statement." },
          { title: "Agent", text: "Let the agent inspect the schema, read data safely, and draft reports across multiple steps." },
        ] },
        { type: "h2", text: "Built to be trusted" },
        { type: "ul", items: [
          "Shows its work: every step lands in a live trace you can expand, and runs are recorded for replay.",
          "Learns your business: verified metric definitions and aliases are remembered per database.",
          "Proposes, never surprises: write previews run inside a transaction and always roll back.",
          "Stays online: if a provider rate-limits or drops, the agent fails over to your next configured provider.",
        ] },
        { type: "callout", tone: "warn", title: "Review before run", text: "Write previews execute inside a transaction and always roll back. You review the affected rows, then apply the final SQL yourself." },
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
        { type: "h2", text: "Bạn nhận được gì" },
        { type: "cards", items: [
          { title: "SQL workspace", text: "Trình soạn Monaco, nhiều tab truy vấn, format, đo thời gian chạy, công cụ explain, lịch sử và mục ưa thích." },
          { title: "Khám phá dữ liệu", text: "Trình duyệt schema có tìm kiếm, duyệt dữ liệu bảng, xem chi tiết dòng, phân trang, sắp xếp và lọc." },
          { title: "Kết quả & xuất dữ liệu", text: "Chế độ bảng và biểu đồ với các luồng xuất CSV, JSON, Excel và SQL." },
          { title: "Công cụ trực quan", text: "Sơ đồ ER tương tác, minimap và điều khiển bố cục, bảng chỉ số, và trực quan hóa query plan." },
          { title: "Trợ lý AI", text: "Chế độ Prompt, Edit và Agent với ngữ cảnh schema, đính kèm tệp, duyệt SQL trước khi chạy và provider cấu hình được." },
          { title: "Quy trình desktop", text: "Kết nối đã lưu, bootstrap CSDL local, lưu credential trong keyring hệ điều hành, command palette, terminal và lưu phiên." },
        ] },
        { type: "h2", text: "Dành cho ai" },
        { type: "p", text:
          "Bất kỳ ai làm việc với database hằng ngày: kỹ sư, nhà phân tích và các nhóm dữ liệu muốn một workspace gọn gàng cho các engine quan hệ, phân tích, tài liệu, cache và đám mây." },
        { type: "callout", tone: "info", title: "Mã nguồn mở", text:
          "TableR phát hành theo giấy phép GNU GPL v3.0. Bạn có thể đọc mã nguồn, mở issue, hoặc đóng góp quy trình bạn mong muốn." },
        { type: "h2", text: "Tài liệu được sắp xếp thế nào" },
        { type: "ul", items: [
          "Bắt đầu — cài đặt app hoặc build từ mã nguồn.",
          "Kết nối — trình khởi chạy, các engine hỗ trợ và bootstrap local.",
          "SQL workspace — trình soạn, tab, chạy truy vấn và lịch sử.",
          "Khám phá dữ liệu — trình duyệt schema, xem dòng và công cụ cấu trúc.",
          "Trực quan hóa — biểu đồ, sơ đồ ER và query plan.",
          "AI & Agent — chế độ Prompt/Edit/Agent và tính an toàn.",
          "Phím tắt, kiến trúc và FAQ bổ sung cho phần tham khảo.",
        ] },
      ],
    },
    {
      slug: "getting-started",
      icon: "Rocket",
      title: "Bắt đầu",
      description: "Cài bản dựng sẵn, hoặc build TableR từ mã nguồn để phát triển.",
      blocks: [
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
        { type: "ul", items: [
          "Kết nối & cơ sở dữ liệu — kết nối tới cả 18 engine, hoặc bootstrap một cái ngay tại máy.",
          "SQL workspace — tab, định dạng, đo thời gian chạy, lịch sử và mục yêu thích.",
          "Khám phá dữ liệu — trình khám phá schema, duyệt bảng và xem chi tiết dòng.",
          "Trực quan hóa — biểu đồ, sơ đồ ER và xem query plan.",
          "Trợ lý AI — ba chế độ Prompt, Edit và Agent với ngữ cảnh schema.",
          "Phím tắt — tài liệu tham chiếu đầy đủ để làm việc nhanh hơn.",
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
        { type: "h3", text: "PostgreSQL" },
        { type: "p", text: "Engine SQL qua mạng. Điền form, hoặc dùng bootstrap local nếu bạn chưa có server." },
        { type: "ul", items: [
          "Host — server của bạn (mặc định 127.0.0.1).",
          "Port — 5432.",
          "Username — bắt buộc.",
          "Password — tùy chọn, lưu trong keyring.",
          "Database — tùy chọn.",
          "SSL/TLS — hỗ trợ; bật khi kết nối server từ xa.",
          "Bootstrap local — sẵn sàng.",
        ] },
        { type: "h3", text: "MySQL" },
        { type: "p", text: "Engine được chọn mặc định khi tạo kết nối mới." },
        { type: "ul", items: [
          "Host — mặc định 127.0.0.1.",
          "Port — 3306.",
          "Username — bắt buộc.",
          "Password — tùy chọn.",
          "Database — tùy chọn.",
          "SSL/TLS — hỗ trợ.",
          "Bootstrap local — sẵn sàng.",
        ] },
        { type: "h3", text: "MariaDB" },
        { type: "p", text: "Dùng giao thức wire của MySQL nên các trường giống MySQL." },
        { type: "ul", items: [
          "Host — mặc định 127.0.0.1.",
          "Port — 3306.",
          "Username — bắt buộc.",
          "Password — tùy chọn.",
          "Database — tùy chọn.",
          "SSL/TLS — hỗ trợ.",
          "Bootstrap local — sẵn sàng.",
        ] },
        { type: "h3", text: "CockroachDB" },
        { type: "p", text: "Dùng giao thức wire của PostgreSQL." },
        { type: "ul", items: [
          "Host — node của bạn hoặc host CockroachDB Cloud.",
          "Port — 26257.",
          "Username — bắt buộc.",
          "Password — tùy chọn.",
          "Database — tùy chọn.",
          "SSL/TLS — hỗ trợ (CockroachDB Cloud thường bắt buộc).",
        ] },
        { type: "h3", text: "Greenplum" },
        { type: "p", text: "Kho phân tích tương thích PostgreSQL." },
        { type: "ul", items: [
          "Host — host coordinator của bạn.",
          "Port — 5432.",
          "Username — bắt buộc.",
          "Password — tùy chọn.",
          "Database — tùy chọn.",
          "SSL/TLS — hỗ trợ.",
        ] },
        { type: "h3", text: "Amazon Redshift" },
        { type: "p", text: "Kho dữ liệu đám mây tương thích PostgreSQL." },
        { type: "ul", items: [
          "Host — endpoint cụm (cluster.region.redshift.amazonaws.com).",
          "Port — 5439.",
          "Username — bắt buộc.",
          "Password — tùy chọn.",
          "Database — tùy chọn.",
          "SSL/TLS — hỗ trợ.",
        ] },
        { type: "h3", text: "SQL Server" },
        { type: "p", text: "Microsoft SQL Server, với xác thực Windows hoặc SQL." },
        { type: "ul", items: [
          "Host — localhost,1433 hoặc SERVER\\INSTANCE.",
          "Port — 1433.",
          "Xác thực — Windows hoặc SQL Server, tự nhận theo host (Microsoft Entra chưa hỗ trợ).",
          "Username / Password — tùy chọn, dùng cho xác thực SQL.",
          "Database — tùy chọn.",
          "Instance name — tùy chọn, hoặc điền SERVER\\INSTANCE vào Host.",
          "Encrypt — Optional hoặc Mandatory; Trust server certificate bật sẵn cho cert tự ký ở local.",
          "Bootstrap local — sẵn sàng.",
        ] },
        { type: "h3", text: "Vertica" },
        { type: "p", text: "Cơ sở dữ liệu phân tích dạng cột." },
        { type: "ul", items: [
          "Host — host Vertica của bạn.",
          "Port — 5433.",
          "Username — bắt buộc.",
          "Password — tùy chọn.",
          "Database — tùy chọn.",
          "SSL/TLS — hỗ trợ.",
        ] },
        { type: "h3", text: "ClickHouse" },
        { type: "p", text: "Kết nối qua giao diện HTTP của ClickHouse." },
        { type: "ul", items: [
          "Host — host ClickHouse của bạn.",
          "Port — 8123 (giao diện HTTP).",
          "Username — bắt buộc.",
          "Password — tùy chọn.",
          "Database — tùy chọn.",
          "SSL/TLS — hỗ trợ.",
        ] },
        { type: "h3", text: "Snowflake" },
        { type: "p", text: "Kho dữ liệu đám mây, kết nối qua HTTPS tới host tài khoản." },
        { type: "ul", items: [
          "Host — account.region.snowflakecomputing.com.",
          "Port — 443 (HTTPS).",
          "Credential — password hoặc token Snowflake.",
          "Warehouse — cần khi session chưa có warehouse mặc định.",
          "Schema — tùy chọn, schema mặc định.",
          "Role — tùy chọn; để trống dùng role mặc định.",
          "Database — tùy chọn.",
        ] },
        { type: "h3", text: "BigQuery" },
        { type: "p", text: "Kho serverless của Google Cloud, xác thực bằng service account." },
        { type: "ul", items: [
          "Host — bigquery.googleapis.com (HTTPS).",
          "Credential — service-account key / token.",
          "Project ID — project Google Cloud của bạn.",
          "Dataset — dataset cần duyệt.",
          "Location — vùng của dataset.",
        ] },
        { type: "h3", text: "SQLite" },
        { type: "p", text: "Nhúng và dạng tệp — không có server." },
        { type: "ul", items: [
          "Tệp database — chọn tệp .sqlite hoặc .db sẵn có.",
          "Không cần host, port hay credential.",
          "Bootstrap local — sẵn sàng; TableR tạo được tệp database local mới.",
        ] },
        { type: "h3", text: "DuckDB" },
        { type: "p", text: "Cơ sở dữ liệu phân tích nhúng trong một tệp." },
        { type: "ul", items: [
          "Tệp database — chọn hoặc tạo tệp .duckdb.",
          "Open mode — read_write, hoặc read_only để xem tệp an toàn.",
          "Không cần host, port hay credential.",
        ] },
        { type: "h3", text: "Cassandra" },
        { type: "p", text: "Kho dạng wide-column, kết nối qua CQL." },
        { type: "ul", items: [
          "Host — một hoặc nhiều contact point (mặc định 127.0.0.1).",
          "Port — 9042.",
          "Username — bắt buộc (user của cụm).",
          "Password — tùy chọn.",
          "Keyspace — tùy chọn (ô Database).",
          "Datacenter — tùy chọn, tên datacenter local.",
        ] },
        { type: "h3", text: "Redis" },
        { type: "p", text: "Kho key-value trong bộ nhớ." },
        { type: "ul", items: [
          "Host — mặc định 127.0.0.1.",
          "Port — 6379.",
          "Username — tùy chọn (user ACL của Redis 6+).",
          "Password — tùy chọn.",
          "Chỉ số database — số database logic, thường là 0.",
        ] },
        { type: "h3", text: "MongoDB" },
        { type: "p", text: "Cơ sở dữ liệu document; hỗ trợ SRV của Atlas và host trực tiếp." },
        { type: "ul", items: [
          "Host — mặc định 127.0.0.1, hoặc hostname Atlas.",
          "Port — 27017.",
          "Kiểu kết nối — Auto-detect, SRV (Atlas), hoặc Direct (host:port); dùng Direct cho PrivateLink (pl-*.mongodb.net) hoặc server tự cài.",
          "Username / Password — tùy chọn.",
          "Database — tùy chọn; Auth source — database xác thực; Replica set — tùy chọn.",
          "SSL/TLS — hỗ trợ. Bootstrap local — đang lên kế hoạch.",
        ] },
        { type: "h3", text: "LibSQL" },
        { type: "p", text: "Tương thích SQLite, kể cả database Turso từ xa." },
        { type: "ul", items: [
          "Host — your-db.turso.io, hoặc URL libSQL local.",
          "Port — 8080.",
          "Credential — auth token cho database từ xa/Turso.",
          "Database — tùy chọn.",
        ] },
        { type: "h3", text: "Cloudflare D1" },
        { type: "p", text: "SQLite serverless của Cloudflare, truy cập qua Cloudflare API." },
        { type: "ul", items: [
          "Host — api.cloudflare.com (HTTPS).",
          "Credential — Cloudflare API token có quyền D1.",
          "Account ID — tài khoản Cloudflare của bạn.",
          "Database ID — database D1 đích.",
        ] },
      ],
    },
    {
      slug: "sql-workspace",
      icon: "Code2",
      title: "SQL workspace",
      description: "Viết SQL trong Monaco với tab, đo thời gian chạy, lịch sử, mục ưa thích và terminal.",
      blocks: [
        { type: "p", text: "Workspace truy vấn giữ trình soạn, dữ liệu và công cụ trong cùng một khung nhìn. Khám phá object từ sidebar, viết SQL bằng Monaco, xem kết quả, chuyển sang biểu đồ và dùng terminal mà không mất ngữ cảnh." },
        { type: "h2", text: "Điểm nổi bật" },
        { type: "ul", items: [
          "Trình soạn Monaco hiểu SQL và có format.",
          "Nhiều tab truy vấn để đặt các phần việc liên quan cạnh nhau.",
          "Đo thời gian chạy và công cụ explain cho mỗi lần chạy.",
          "Lịch sử truy vấn và SQL ưa thích cho các câu lệnh dùng lại.",
          "Terminal dock tích hợp và panel kết quả có thể bật/tắt.",
        ] },
        { type: "h2", text: "Chạy truy vấn đầu tiên" },
        { type: "steps", items: [
          { title: "Mở tab truy vấn", text: "Nhấn Ctrl + N để tạo tab truy vấn mới." },
          { title: "Viết SQL", text: "Gõ câu lệnh trong Monaco. Dùng Ctrl + Shift + F để format." },
          { title: "Thực thi", text: "Nhấn Ctrl + Enter để chạy truy vấn hiện tại và xem kết quả kèm thời gian." },
          { title: "Dùng lại", text: "Lưu vào mục ưa thích (Ctrl + Shift + S) hoặc tìm lại trong lịch sử (Ctrl + H)." },
        ] },
        { type: "callout", tone: "tip", title: "Giữ tay trên bàn phím", text: "Ctrl + Enter chạy truy vấn hiện tại, Ctrl + Space bật/tắt workspace AI ngay bên cạnh — không cần chuột." },
      ],
    },
    {
      slug: "exploring-data",
      icon: "Table",
      title: "Khám phá dữ liệu",
      description: "Duyệt schema, xem chi tiết dòng, so sánh cấu trúc và phân trang kết quả.",
      blocks: [
        { type: "p", text: "TableR cho bạn trình duyệt schema có tìm kiếm cùng các công cụ tập trung để đọc và hiểu dữ liệu bảng mà không phải viết truy vấn rườm rà." },
        { type: "h2", text: "Trình duyệt schema" },
        { type: "ul", items: [
          "Tìm kiếm xuyên database, schema, bảng và cột.",
          "Bật/tắt trình duyệt bằng Ctrl + B để lấy lại không gian màn hình.",
          "Mở duyệt dữ liệu bảng với phân trang, sắp xếp và lọc.",
        ] },
        { type: "h2", text: "Xem xét và thấu hiểu" },
        { type: "ul", items: [
          "Trình xem dòng để đọc trọn vẹn một bản ghi.",
          "Khung cấu trúc bảng cho cột, khóa và index.",
          "Schema diff để so sánh cấu trúc và phát hiện lệch.",
          "Trợ giúp tạo schema object cho các tác vụ DDL phổ biến.",
        ] },
        { type: "callout", tone: "info", title: "Kết quả theo ý bạn", text: "Chuyển bất kỳ tập kết quả nào giữa bảng và biểu đồ, rồi xuất ra CSV, JSON, Excel hoặc định dạng thiên về SQL." },
      ],
    },
    {
      slug: "visualize",
      icon: "Network",
      title: "Trực quan & sơ đồ",
      description: "Dựng sơ đồ ER, vẽ biểu đồ kết quả và đọc query plan bằng hình ảnh.",
      blocks: [
        { type: "p", text: "Nhìn thấy hình dạng của database. Dựng sơ đồ ER từ các bảng đã chọn, điều hướng schema lớn bằng minimap và xuất kết quả cho buổi làm việc tiếp theo." },
        { type: "image", src: "/screenshots/table-r-er-diagram.png", alt: "Workspace sơ đồ ER của TableR hiển thị các bảng và quan hệ", width: 1280, height: 801 },
        { type: "h2", text: "Sơ đồ ER" },
        { type: "steps", items: [
          { title: "Chọn bảng", text: "Chọn những bảng quan trọng với mô hình bạn đang mô tả." },
          { title: "Tự bố cục", text: "Để TableR sắp xếp đồ thị, rồi fit canvas và dùng minimap cho schema lớn." },
          { title: "Xem & xuất", text: "Lần theo quan hệ, rồi xuất sơ đồ ra PNG hoặc SQL." },
        ] },
        { type: "h2", text: "Biểu đồ & chỉ số" },
        { type: "ul", items: [
          "Vẽ biểu đồ cho bất kỳ tập kết quả nào bằng chế độ biểu đồ tích hợp (Recharts).",
          "Bảng chỉ số để giữ các con số quan trọng luôn hiển thị.",
          "Trực quan hóa query plan để hiểu cách một câu lệnh thực thi.",
        ] },
      ],
    },
    {
      slug: "ai-agent",
      icon: "Bot",
      title: "AI & Agent",
      description: "Chế độ Prompt, Edit và Agent với ngữ cảnh schema và an toàn duyệt-trước-khi-chạy.",
      blocks: [
        { type: "p", text: "Giữ ngữ cảnh schema, SQL sinh ra, việc thực thi truy vấn và trợ lý trong cùng một khung nhìn. Đính kèm ảnh hoặc tệp văn bản, chuyển giữa Prompt / Edit / Agent, và duyệt SQL trước khi có bất kỳ thay đổi nào ghi vào database." },
        { type: "image", src: "/screenshots/table-r-ai-workspace.png", alt: "Workspace AI của TableR bên cạnh trình soạn SQL", width: 1280, height: 801 },
        { type: "h2", text: "Các chế độ" },
        { type: "cards", items: [
          { title: "Prompt", text: "Hỏi đáp kèm ngữ cảnh schema, sinh SQL và giải thích truy vấn sẵn có." },
          { title: "Edit", text: "Tinh chỉnh và viết lại SQL với trợ lý làm việc trực tiếp trên câu lệnh của bạn." },
          { title: "Agent", text: "Để agent khám phá schema, đọc dữ liệu an toàn và soạn báo cáo qua nhiều bước." },
        ] },
        { type: "h2", text: "Được thiết kế để tin cậy" },
        { type: "ul", items: [
          "Phơi bày cách làm: mỗi bước nằm trong trace trực tiếp có thể mở ra, và mỗi lần chạy được ghi lại để xem lại.",
          "Học nghiệp vụ: định nghĩa chỉ số và alias đã xác minh được ghi nhớ theo từng database.",
          "Đề xuất, không bất ngờ: write preview chạy trong một transaction và luôn rollback.",
          "Luôn trực tuyến: nếu một provider bị rate limit hoặc ngắt, agent tự chuyển sang provider kế tiếp bạn đã cấu hình.",
        ] },
        { type: "callout", tone: "warn", title: "Duyệt trước khi chạy", text: "Write preview chạy trong một transaction và luôn rollback. Bạn xem số dòng bị ảnh hưởng, rồi tự áp dụng câu SQL cuối cùng." },
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
