export type SiteLanguage = "en" | "vi";

export const LANGUAGE_COOKIE = "tabler-lang";
export const SITE_LANGUAGES: SiteLanguage[] = ["en", "vi"];

export function resolveSiteLanguage(value: string | undefined): SiteLanguage {
  return value === "vi" ? "vi" : "en";
}

const en = {
  nav: {
    features: "Features",
    workflow: "Workflow",
    agent: "Agent",
    engines: "Engines",
    openSource: "Open source",
    changelog: "Changelog",
    docs: "Docs",
    plugins: "Plugins",
    download: "Download",
  },
  hero: {
    kicker: "Open-source database workspace",
    lede: "Query, explore, visualize, and understand your databases from one focused desktop workspace.",
    download: "Download",
    viewOnGitHub: "View on GitHub",
    note: "Windows, macOS, and Linux",
  },
  signal: {
    items: [
      { strong: "18", span: "database engines" },
      { strong: "One", span: "unified workspace" },
      { strong: "Local", span: "desktop experience" },
      { strong: "GPLv3", span: "open-source license" },
    ],
  },
  arch: [
    "Tauri 2 desktop shell",
    "React 19 interface",
    "Rust backend",
    "Monaco editor",
    "GPL-3.0 licensed",
    "Local-first workflow",
  ],
  features: {
    eyebrow: "THE WORKSPACE",
    heading: "Less switching. More understanding.",
    intro:
      "TableR keeps the tools around your data close enough to be useful and quiet enough to stay out of the way.",
    cards: [
      {
        title: "One place for every database",
        copy: "Save connections, browse schemas, inspect objects, and move between engines without rebuilding your workspace.",
      },
      {
        title: "A query editor built for flow",
        copy: "Write SQL in Monaco, keep multiple tabs open, review results, chart data, and export without leaving the query.",
      },
      {
        title: "AI that knows the workspace",
        copy: "Ask questions with schema context, generate SQL, explain queries, and keep the conversation beside the work.",
      },
      {
        title: "ER diagrams on demand",
        copy: "Select the tables that matter, trace relationships, use the minimap, and export a diagram when the model is clear.",
      },
    ],
  },
  workflow: {
    eyebrow: "A COMPLETE LOOP",
    heading: "From connection to answer, without losing the thread.",
    check: "Designed for repeated, everyday database work",
    steps: [
      {
        eyebrow: "CONNECT",
        title: "Start with a calmer connection launcher.",
        copy: "Search saved profiles, create a connection, and jump back into recent work. Credentials stay in the operating system keyring instead of the interface.",
      },
      {
        eyebrow: "QUERY",
        title: "Keep the editor, data, and tools in one workspace.",
        copy: "Explore objects from the sidebar, write SQL with Monaco, inspect results, switch to charts, and use the terminal without breaking context.",
      },
      {
        eyebrow: "UNDERSTAND",
        title: "Bring AI close to the query, not over it.",
        copy: "Use the assistant when it helps and collapse it when it does not. The workspace remains readable, with actions grouped around the conversation instead of scattered through it.",
      },
    ],
  },
  agent: {
    eyebrow: "THE AGENT",
    heading: "An assistant that shows its work.",
    intro:
      "The built-in agent can inspect your schema, read data safely, and draft reports on its own — with every step visible, verified figures, and nothing persisted without your approval.",
    cards: [
      {
        title: "Shows its work",
        copy: "Every step the agent takes lands in a live trace you can expand, and each run is recorded for replay. No silent decisions.",
      },
      {
        title: "Learns your business",
        copy: "Verified metric definitions and aliases are remembered per database, so next week's analysis uses what you taught it this week.",
      },
      {
        title: "Proposes, never surprises",
        copy: "Write previews execute inside a transaction and always roll back. You review the affected rows, then apply the final SQL yourself.",
      },
      {
        title: "Stays online",
        copy: "If an AI endpoint rate-limits or drops, the agent fails over to your next configured provider and keeps the run alive.",
      },
    ],
  },
  erd: {
    eyebrow: "ENTITY RELATIONSHIPS",
    heading: "See the shape of a database.",
    intro:
      "Build an ER diagram from selected tables, navigate large schemas with a minimap, and export the result for the next conversation.",
  },
  engines: {
    eyebrow: "ENGINE COVERAGE",
    heading: "Your database is probably already invited.",
    intro:
      "Use the same familiar workflow across relational, analytical, document, cache, and cloud data platforms.",
    details: "Explore support details",
  },
  openSource: {
    eyebrow: "BUILT IN THE OPEN",
    heading: "A desktop tool you can inspect, shape, and trust.",
    intro:
      "TableR combines a Tauri shell, a React interface, and a Rust backend. Read the code, open an issue, or contribute the database workflow you wish existed.",
    browse: "Browse source",
    issue: "Open an issue",
  },
  cta: {
    eyebrow: "READY TO EXPLORE?",
    heading: "Give your databases a better workspace.",
    download: "Download TableR",
  },
  footer: {
    built: "Built by the TableR Team. Licensed under GPL-3.0.",
    github: "GitHub",
    download: "Download",
    support: "Support",
    changelog: "Changelog",
    docs: "Docs",
  },
  download: {
    back: "Back to home",
    latestPrefix: "LATEST RELEASE",
    fallbackPrefix: "TABLER RELEASES",
    heading: "Download TableR",
    intro:
      "Current and previous builds for Windows, macOS, and Linux. Downloads redirect straight to the official GitHub release assets.",
    chooseIntro:
      "Choose a current or previous release. Each option starts the installer download directly.",
    trustTitle: "Official release files",
    versionsAvailable: (count: number) => `${count} versions available`,
    versionsFallback: "GitHub Releases",
    syncNote: "Synced automatically from GitHub Releases every 5 minutes.",
    helpChooseTitle: "Not sure which file to choose?",
    helpChooseCopy:
      "Open the latest release and use the option marked Recommended for your operating system.",
    helpMacosTitle: "Installing the unsigned macOS build",
    helpMacosCopyBefore:
      "Move TableR to Applications, try to open it once, then choose Open Anyway in System Settings > Privacy & Security. If Gatekeeper still blocks it, run",
    helpMacosCopyAfter:
      "and open it again. This override does not mean the app is Apple-notarized.",
    footerLicense: "TableR is open source and licensed under GPL-3.0.",
    allReleases: "All releases on GitHub",
    securityTitle: "Safe by default",
    securityCopy:
      "Assets are served from the official GitHub releases of the repository. Credentials never touch the website.",
    refresh: "Refresh releases",
    empty:
      "Release information is temporarily unavailable. Please try again in a few minutes.",
    yourDevice: "Your device",
    recommended: "Recommended",
    files: "files",
    latest: "Latest",
    preRelease: "Pre-release",
    viewNotes: "View release notes for",
  },
  plugins: {
    back: "Back to home",
    eyebrow: "PLUGIN REPOSITORY",
    heading: "Database driver plugins",
    intro:
      "TableR ships lean and adds database engines as plugins. Browse every official driver here, download a bundle, or install it straight from the app's Plugin Manager.",
    trustTitle: "Verified bundles",
    trustCopy: (count: number) =>
      `${count} official plugins, each SHA-256 verified on install`,
    counts: {
      installable: "Install from the app now",
      pending: "Awaiting release binaries",
    },
    registryTitle: "Registry endpoint",
    registryCopy:
      "The desktop app's Plugin Manager reads this registry to list and install plugins. Point a custom registry URL here in Settings.",
    groups: {
      http: {
        title: "Cloud & HTTP drivers",
        copy: "Manifest-only drivers that talk to a database over HTTPS. They install instantly from the Official registry tab — no binary or extra download.",
      },
      native: {
        title: "Native drivers",
        copy: "Out-of-process drivers that connect over native protocols. They need a per-OS binary shipped with a release build before they can connect.",
      },
      format: {
        title: "Export formats & tools",
        copy: "Non-driver plugins that add capabilities such as extra export formats to the data grid.",
      },
    },
    card: {
      version: "Version",
      size: "Bundle",
      permissions: "Permissions",
      protocol: "Protocol",
      download: "Download bundle",
      docs: "Open docs",
      installNow: "Installs from registry",
      binaryPending: "Needs release binary",
      formatsLabel: "Adds formats",
    },
    install: {
      title: "How to install a plugin",
      steps: [
        "In the app, open App menu → Plugin Manager → Official registry, then click Install next to the engine. Cloud/HTTP drivers install instantly.",
        "Or download a bundle below, unzip it, then choose Install plugin → pick the unzipped folder (the one containing plugin.json).",
        "Native drivers additionally require the matching per-OS binary from a full release build before they can connect.",
      ],
    },
    security: {
      title: "Safe by default",
      copy: "On install the app recomputes each bundle's SHA-256 digest and refuses to import it unless the digest matches the manifest. Credentials never touch this website.",
    },
    empty:
      "The plugin catalog is not available yet. Run the repository generator to publish it.",
  },
  changelog: {
    back: "Back to home",
    eyebrow: "RELEASE HISTORY",
    heading: "Changelog",
    intro:
      "Every shipped TableR release, newest first. Notes come straight from the GitHub release of each version.",
    empty:
      "No published releases yet. Notes will appear here as soon as a version ships.",
    viewOnGitHub: "View on GitHub",
  },
};

const vi: typeof en = {
  nav: {
    features: "Tính năng",
    workflow: "Quy trình",
    agent: "Agent",
    engines: "Hệ CSDL",
    openSource: "Mã nguồn mở",
    changelog: "Lịch sử bản phát hành",
    docs: "Tài liệu",
    plugins: "Plugin",
    download: "Tải xuống",
  },
  hero: {
    kicker: "Không gian làm việc CSDL mã nguồn mở",
    lede: "Truy vấn, khám phá, trực quan hóa và thấu hiểu cơ sở dữ liệu của bạn trong một workspace desktop tập trung.",
    download: "Tải xuống",
    viewOnGitHub: "Xem trên GitHub",
    note: "Windows, macOS và Linux",
  },
  signal: {
    items: [
      { strong: "18", span: "hệ CSDL" },
      { strong: "Một", span: "workspace thống nhất" },
      { strong: "Local", span: "trải nghiệm desktop" },
      { strong: "GPLv3", span: "giấy phép mã nguồn mở" },
    ],
  },
  arch: [
    "Vỏ desktop Tauri 2",
    "Giao diện React 19",
    "Backend Rust",
    "Trình soạn Monaco",
    "Giấy phép GPL-3.0",
    "Trải nghiệm local-first",
  ],
  features: {
    eyebrow: "THE WORKSPACE",
    heading: "Ít chuyển qua lại. Nhiều thấu hiểu hơn.",
    intro:
      "TableR giữ các công cụ quanh dữ liệu của bạn đủ gần để hữu ích và đủ yên tĩnh để không làm phiền.",
    cards: [
      {
        title: "Một nơi cho mọi database",
        copy: "Lưu kết nối, duyệt schema, inspect object, và di chuyển giữa các engine mà không phải dựng lại workspace.",
      },
      {
        title: "Trình soạn SQL mượt như ý tưởng",
        copy: "Viết SQL trong Monaco, mở nhiều tab, xem kết quả, vẽ biểu đồ và xuất dữ liệu mà không rời khỏi câu truy vấn.",
      },
      {
        title: "AI thấu hiểu workspace",
        copy: "Hỏi đáp kèm ngữ cảnh schema, sinh SQL, giải thích truy vấn, và giữ hội thoại ngay cạnh công việc.",
      },
      {
        title: "Sơ đồ ER khi cần",
        copy: "Chọn bảng cần thiết, lần theo quan hệ, dùng minimap và xuất sơ đồ khi mô hình đã rõ.",
      },
    ],
  },
  workflow: {
    eyebrow: "MỘT VÒNG ĐỦ MẠCH",
    heading: "Từ kết nối đến câu trả lời, không mất mạch.",
    check: "Thiết kế cho công việc CSDL lặp lại hằng ngày",
    steps: [
      {
        eyebrow: "KẾT NỐI",
        title: "Bắt đầu với trình kết nối nhẹ nhàng hơn.",
        copy: "Tìm profile đã lưu, tạo kết nối, quay lại công việc dở. Thông tin đăng nhập nằm trong keyring của hệ điều hành, không nằm trên giao diện.",
      },
      {
        eyebrow: "TRUY VẤN",
        title: "Giữ editor, dữ liệu và công cụ trong cùng một workspace.",
        copy: "Khám phá object từ sidebar, viết SQL với Monaco, xem kết quả, chuyển sang biểu đồ, mở terminal mà không mất ngữ cảnh.",
      },
      {
        eyebrow: "THẤU HIỂU",
        title: "Đặt AI cạnh câu truy vấn, không đè lên nó.",
        copy: "Dùng trợ lý khi hữu ích và thu gọn khi không. Workspace vẫn dễ đọc, các thao tác nhóm quanh hội thoại thay vì rải khắp nơi.",
      },
    ],
  },
  agent: {
    eyebrow: "AGENT",
    heading: "Trợ lý biết phơi bày cách nó làm việc.",
    intro:
      "Agent tích hợp sẵn có thể tự khám phá schema, đọc dữ liệu an toàn và soạn báo cáo — mọi bước hiển thị rõ, số liệu được xác minh, và không gì được lưu nếu bạn chưa duyệt.",
    cards: [
      {
        title: "Phơi bày cách làm việc",
        copy: "Mỗi bước của agent xuất hiện trong trace trực tiếp có thể mở ra, và mỗi lần chạy được ghi lại để xem lại. Không quyết định âm thầm.",
      },
      {
        title: "Học nghiệp vụ của bạn",
        copy: "Định nghĩa chỉ số và alias đã xác minh được ghi nhớ theo từng database, để lần phân tích sau dùng đúng điều bạn dạy hôm nay.",
      },
      {
        title: "Đề xuất, không bất ngờ",
        copy: "Write preview chạy trong một transaction và luôn rollback. Bạn xem số dòng bị ảnh hưởng, rồi tự áp dụng câu SQL cuối.",
      },
      {
        title: "Luôn trực tuyến",
        copy: "Nếu một AI endpoint bị rate limit hoặc ngắt, agent tự chuyển sang provider kế tiếp bạn đã cấu hình và giữ phiên chạy tiếp.",
      },
    ],
  },
  erd: {
    eyebrow: "QUAN HỆ THỰC THỂ",
    heading: "Nhìn thấy hình dạng của database.",
    intro:
      "Dựng sơ đồ ER từ các bảng đã chọn, điều hướng schema lớn bằng minimap và xuất kết quả cho buổi làm việc tiếp theo.",
  },
  engines: {
    eyebrow: "ĐỘ PHỦ ENGINE",
    heading: "Database của bạn chắc chắn đã được mời.",
    intro:
      "Dùng cùng một quy trình quen thuộc trên các nền tảng dữ liệu quan hệ, phân tích, tài liệu, cache và đám mây.",
    details: "Xem chi tiết hỗ trợ",
  },
  openSource: {
    eyebrow: "XÂY DỰNG CÔNG KHAI",
    heading: "Công cụ desktop bạn có thể xem, chỉnh và tin tưởng.",
    intro:
      "TableR kết hợp vỏ Tauri, giao diện React và backend Rust. Đọc mã nguồn, mở issue, hoặc đóng góp quy trình CSDL bạn mong muốn.",
    browse: "Xem mã nguồn",
    issue: "Mở issue",
  },
  cta: {
    eyebrow: "SẴN SÀNG KHÁM PHÁ?",
    heading: "Trao cho database của bạn một workspace tốt hơn.",
    download: "Tải TableR",
  },
  footer: {
    built: "Xây dựng bởi TableR Team. Giấy phép GPL-3.0.",
    github: "GitHub",
    download: "Tải xuống",
    support: "Ủng hộ",
    changelog: "Lịch sử bản phát hành",
    docs: "Tài liệu",
  },
  download: {
    back: "Về trang chủ",
    latestPrefix: "BẢN MỚI NHẤT",
    fallbackPrefix: "CÁC PHIÊN BẢN TABLE R",
    heading: "Tải TableR",
    intro:
      "Bản dựng hiện tại và các bản cũ cho Windows, macOS, Linux. Link tải trỏ thẳng tới asset chính thức trên GitHub.",
    chooseIntro:
      "Chọn bản hiện tại hoặc bản cũ. Mỗi tùy chọn bắt đầu tải trình cài đặt trực tiếp.",
    trustTitle: "Tệp phát hành chính thức",
    versionsAvailable: (count: number) => `${count} phiên bản khả dụng`,
    versionsFallback: "GitHub Releases",
    syncNote: "Tự động đồng bộ từ GitHub Releases mỗi 5 phút.",
    helpChooseTitle: "Chưa chắc chọn tệp nào?",
    helpChooseCopy:
      "Mở bản mới nhất và chọn tùy chọn có nhãn Đề xuất cho hệ điều hành của bạn.",
    helpMacosTitle: "Cài bản macOS chưa ký",
    helpMacosCopyBefore:
      "Chuyển TableR vào Applications, thử mở một lần, rồi chọn Open Anyway trong System Settings > Privacy & Security. Nếu Gatekeeper vẫn chặn, chạy",
    helpMacosCopyAfter:
      "và mở lại. Việc này không đồng nghĩa ứng dụng đã được Apple notarize.",
    footerLicense: "TableR là phần mềm mã nguồn mở theo giấy phép GPL-3.0.",
    allReleases: "Tất cả bản phát hành trên GitHub",
    securityTitle: "An toàn mặc định",
    securityCopy:
      "Asset được phục vụ từ GitHub release chính thức của repository. Thông tin đăng nhập không bao giờ đi qua website.",
    refresh: "Làm mới danh sách",
    empty:
      "Thông tin bản phát hành tạm thời không khả dụng. Vui lòng thử lại sau vài phút.",
    yourDevice: "Thiết bị của bạn",
    recommended: "Đề xuất",
    files: "tệp",
    latest: "Mới nhất",
    preRelease: "Bản thử nghiệm",
    viewNotes: "Xem ghi chú phát hành cho",
  },
  plugins: {
    back: "Về trang chủ",
    eyebrow: "KHO PLUGIN",
    heading: "Plugin driver cơ sở dữ liệu",
    intro:
      "TableR chạy gọn nhẹ và bổ sung từng hệ CSDL dưới dạng plugin. Duyệt mọi driver chính thức tại đây, tải bundle về, hoặc cài trực tiếp từ Plugin Manager trong ứng dụng.",
    trustTitle: "Bundle đã xác minh",
    trustCopy: (count: number) =>
      `${count} plugin chính thức, mỗi bundle được xác minh SHA-256 khi cài`,
    counts: {
      installable: "Cài ngay từ ứng dụng",
      pending: "Chờ binary bản phát hành",
    },
    registryTitle: "Địa chỉ registry",
    registryCopy:
      "Plugin Manager trong app đọc registry này để liệt kê và cài plugin. Trỏ registry URL tùy chỉnh về đây trong phần Cài đặt.",
    groups: {
      http: {
        title: "Driver đám mây & HTTP",
        copy: "Driver chỉ gồm manifest, giao tiếp với CSDL qua HTTPS. Cài tức thì từ tab Registry chính thức — không cần binary hay tải thêm.",
      },
      native: {
        title: "Driver native",
        copy: "Driver chạy ngoài tiến trình, kết nối qua giao thức native. Cần binary theo từng HĐH đi kèm bản build phát hành thì mới kết nối được.",
      },
      format: {
        title: "Định dạng xuất & công cụ",
        copy: "Plugin không phải driver, bổ sung khả năng như định dạng xuất dữ liệu cho bảng kết quả.",
      },
    },
    card: {
      version: "Phiên bản",
      size: "Bundle",
      permissions: "Quyền",
      protocol: "Giao thức",
      download: "Tải bundle",
      docs: "Mở tài liệu",
      installNow: "Cài từ registry",
      binaryPending: "Cần binary phát hành",
      formatsLabel: "Thêm định dạng",
    },
    install: {
      title: "Cách cài một plugin",
      steps: [
        "Trong app, mở Menu ứng dụng → Plugin Manager → Registry chính thức, rồi bấm Cài cạnh engine. Driver đám mây/HTTP cài tức thì.",
        "Hoặc tải bundle bên dưới, giải nén, rồi chọn Cài plugin → chọn thư mục vừa giải nén (thư mục chứa plugin.json).",
        "Driver native cần thêm binary đúng HĐH từ bản build phát hành đầy đủ thì mới kết nối được.",
      ],
    },
    security: {
      title: "An toàn mặc định",
      copy: "Khi cài, app tính lại SHA-256 của từng bundle và từ chối nhập nếu digest không khớp manifest. Thông tin đăng nhập không bao giờ đi qua website.",
    },
    empty:
      "Danh mục plugin chưa sẵn sàng. Hãy chạy trình sinh repository để xuất bản.",
  },
  changelog: {
    back: "Về trang chủ",
    eyebrow: "LỊCH SỬ PHÁT HÀNH",
    heading: "Lịch sử bản phát hành",
    intro:
      "Mọi bản TableR đã phát hành, mới nhất đứng trước. Ghi chú lấy trực tiếp từ GitHub release của từng phiên bản.",
    empty:
      "Chưa có bản phát hành nào. Ghi chú sẽ xuất hiện ngay khi có phiên bản mới.",
    viewOnGitHub: "Xem trên GitHub",
  },
};

export const dictionaries: Record<SiteLanguage, typeof en> = { en, vi };

export function getDictionary(language: SiteLanguage) {
  return dictionaries[language];
}
