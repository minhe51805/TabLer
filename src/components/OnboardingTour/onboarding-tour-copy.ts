/**
 * Copy for the onboarding tour — the task-funnel walkthrough (sample DB →
 * open a table → edit → SQL → ask the agent). Per-feature copy module; see
 * AGENTS.md §6 for the convention (en/vi/ko/tr/zh + English fallback).
 */

import type { AppLanguage } from "../../i18n";

export interface OnboardingStepCopy {
  title: string;
  body: string;
}

export interface OnboardingCopy {
  /** Launcher phase — points at the bundled sample DB card. */
  stepLauncherSample: OnboardingStepCopy;
  /** Launcher phase — shown while the sample DB is being created. */
  stepLauncherCreating: OnboardingStepCopy;
  /** Launcher phase — user picks an existing connection (no sample CTA). */
  stepLauncherPick: OnboardingStepCopy;
  stepWorkspaceSidebar: OnboardingStepCopy;
  /** Workspace — expand the "Tables" folder first. */
  stepWorkspaceExpandTables: OnboardingStepCopy;
  /** Workspace — click the `customers` table to open it. */
  stepWorkspaceOpenTable: OnboardingStepCopy;
  /** Workspace — the data grid surface. */
  stepWorkspaceGrid: OnboardingStepCopy;
  /** Workspace — clicking a cell stages an edit in the Review modal. */
  stepWorkspaceEdit: OnboardingStepCopy;
  /** Workspace — the grid toolbar (Rows / Tools menus). */
  stepWorkspaceToolbar: OnboardingStepCopy;
  /** Workspace — the "+" tab button opens a SQL editor. */
  stepWorkspaceSqlTab: OnboardingStepCopy;
  /** Workspace — the AI assistant trigger. */
  stepWorkspaceAi: OnboardingStepCopy;
  /** Buttons */
  back: string;
  next: string;
  done: string;
  skip: string;
  /** Step counter, e.g. "3 / 8". */
  stepOf(current: number, total: number): string;
}

const EN: OnboardingCopy = {
  stepLauncherSample: {
    title: "Start with the sample data",
    body: "Click the card below — it loads a demo SQLite database (customers, orders, products) with zero setup. Your own connection comes later from the same screen.",
  },
  stepLauncherCreating: {
    title: "Setting up…",
    body: "Seeding the sample database and connecting — this takes a second.",
  },
  stepLauncherPick: {
    title: "Or pick a connection",
    body: "Any saved connection works too — click one to open the workspace. The tour continues there.",
  },
  stepWorkspaceSidebar: {
    title: "Your tables live here",
    body: "The sidebar lists every table and view in the active connection. Expand the database to see them.",
  },
  stepWorkspaceExpandTables: {
    title: "Expand Tables",
    body: "Click the Tables folder to list the sample tables inside.",
  },
  stepWorkspaceOpenTable: {
    title: "Open a table",
    body: "Click `customers` to open it in the data grid.",
  },
  stepWorkspaceGrid: {
    title: "This is your data",
    body: "Rows, headers and selection live here. Sort, filter and copy are all built in.",
  },
  stepWorkspaceEdit: {
    title: "Edit a cell",
    body: "Click any cell to edit it — changes stage in the Review modal, and nothing commits until you approve.",
  },
  stepWorkspaceToolbar: {
    title: "Rows and Tools",
    body: "Insert, paste, import CSV and Rewind (undo a committed write) live in these menus.",
  },
  stepWorkspaceSqlTab: {
    title: "Or write SQL",
    body: "Open a new tab for the SQL editor — Run, or Ctrl/Cmd+Enter to execute.",
  },
  stepWorkspaceAi: {
    title: "Ask the agent",
    body: "The AI panel writes, explains and reviews SQL — try a question on this data.",
  },
  back: "Back",
  next: "Next",
  done: "Done",
  skip: "Skip tour",
  stepOf: (current, total) => `${current} / ${total}`,
};

const VI: OnboardingCopy = {
  ...EN,
  stepLauncherSample: {
    title: "Bắt đầu với dữ liệu mẫu",
    body: "Bấm vào thẻ bên dưới — nó sẽ tải một database SQLite mẫu (customers, orders, products) mà không cần cài đặt gì. Kết nối database của bạn làm sau ở cùng màn hình này.",
  },
  stepLauncherCreating: {
    title: "Đang thiết lập…",
    body: "Đang nạp database mẫu và kết nối — chỉ mất một giây.",
  },
  stepLauncherPick: {
    title: "Hoặc chọn một kết nối",
    body: "Kết nối đã lưu cũng được — bấm vào để mở workspace. Tour tiếp tục ở đó.",
  },
  stepWorkspaceSidebar: {
    title: "Bảng của bạn ở đây",
    body: "Sidebar liệt kê mọi bảng và view trong kết nối đang hoạt động. Mở database để xem.",
  },
  stepWorkspaceExpandTables: {
    title: "Mở mục Bảng",
    body: "Bấm vào thư mục Bảng (Tables) để xem các bảng mẫu bên trong.",
  },
  stepWorkspaceOpenTable: {
    title: "Mở một bảng",
    body: "Bấm `customers` để mở nó trong lưới dữ liệu.",
  },
  stepWorkspaceGrid: {
    title: "Đây là dữ liệu của bạn",
    body: "Hàng, cột và chọn ô ở đây. Sắp xếp, lọc và copy đều có sẵn.",
  },
  stepWorkspaceEdit: {
    title: "Sửa một ô",
    body: "Bấm vào ô để sửa — thay đổi vào Review modal trước, chưa ghi vào DB cho tới khi bạn duyệt.",
  },
  stepWorkspaceToolbar: {
    title: "Menu Rows và Tools",
    body: "Insert, paste, import CSV và Rewind (hoàn tác một write đã commit) nằm trong hai menu này.",
  },
  stepWorkspaceSqlTab: {
    title: "Hoặc viết SQL",
    body: "Mở tab mới cho SQL editor — Run, hoặc Ctrl/Cmd+Enter để chạy.",
  },
  stepWorkspaceAi: {
    title: "Hỏi agent",
    body: "Panel AI viết, giải thích và review SQL — thử hỏi một câu trên dữ liệu này.",
  },
  back: "Quay lại",
  next: "Tiếp",
  done: "Xong",
  skip: "Bỏ qua",
};

const KO: OnboardingCopy = {
  ...EN,
  stepLauncherSample: {
    title: "샘플 데이터로 시작하기",
    body: "아래 카드를 클릭하세요 — 별도 설정 없이 데모 SQLite 데이터베이스(customers, orders, products)가 로드됩니다. 실제 연결은 같은 화면에서 나중에 추가합니다.",
  },
  stepLauncherCreating: {
    title: "설정 중…",
    body: "샘플 데이터베이스를 채우고 연결하는 중입니다 — 잠시만 기다려 주세요.",
  },
  stepLauncherPick: {
    title: "또는 연결 선택",
    body: "저장된 연결도 괜찮습니다 — 하나를 클릭해 워크스페이스를 엽니다. 투어는 거기서 이어집니다.",
  },
  stepWorkspaceSidebar: {
    title: "테이블은 여기 있습니다",
    body: "사이드바에 활성 연결의 모든 테이블과 뷰가 나열됩니다. 데이터베이스를 펼쳐 보세요.",
  },
  stepWorkspaceExpandTables: {
    title: "Tables 펼치기",
    body: "Tables 폴더를 클릭해 안에 있는 샘플 테이블을 확인합니다.",
  },
  stepWorkspaceOpenTable: {
    title: "테이블 열기",
    body: "`customers`를 클릭해 데이터 그리드에서 엽니다.",
  },
  stepWorkspaceGrid: {
    title: "여기가 데이터입니다",
    body: "행, 헤더, 선택 영역이 여기에 있습니다. 정렬, 필터, 복사가 기본 제공됩니다.",
  },
  stepWorkspaceEdit: {
    title: "셀 편집",
    body: "셀을 클릭해 편집하세요 — 변경 사항은 Review 모달에 올라가고, 승인 전까지는 커밋되지 않습니다.",
  },
  stepWorkspaceToolbar: {
    title: "Rows / Tools 메뉴",
    body: "Insert, paste, CSV import, Rewind(커밋된 쓰기 되돌리기)가 이 메뉴에 있습니다.",
  },
  stepWorkspaceSqlTab: {
    title: "또는 SQL 작성",
    body: "새 탭에서 SQL 편집기를 엽니다 — Run 또는 Ctrl/Cmd+Enter로 실행.",
  },
  stepWorkspaceAi: {
    title: "에이전트에게 물어보기",
    body: "AI 패널이 SQL을 작성하고 설명하고 검토합니다 — 이 데이터로 한 번 물어보세요.",
  },
  back: "이전",
  next: "다음",
  done: "완료",
  skip: "건너뛰기",
};

const TR: OnboardingCopy = {
  ...EN,
  stepLauncherSample: {
    title: "Örnek veriyle başla",
    body: "Aşağıdaki karta tıklayın — hiçbir kurulum olmadan demo SQLite veritabanı (customers, orders, products) yüklenir. Kendi bağlantınızı daha sonra aynı ekrandan eklersiniz.",
  },
  stepLauncherCreating: {
    title: "Kuruluyor…",
    body: "Örnek veritabanı oluşturulup bağlanıyor — bir saniye sürer.",
  },
  stepLauncherPick: {
    title: "Ya da bir bağlantı seçin",
    body: "Kayıtlı bir bağlantı da olur — birine tıklayıp çalışma alanını açın. Tur orada devam eder.",
  },
  stepWorkspaceSidebar: {
    title: "Tablolarınız burada",
    body: "Kenar çubuğu etkin bağlantıdaki tüm tablo ve view'ları listeler. Veritabanını açarak görün.",
  },
  stepWorkspaceExpandTables: {
    title: "Tables klasörünü aç",
    body: "İçindeki örnek tabloları görmek için Tables klasörüne tıklayın.",
  },
  stepWorkspaceOpenTable: {
    title: "Bir tablo aç",
    body: "`customers`'a tıklayarak veri ızgarasında açın.",
  },
  stepWorkspaceGrid: {
    title: "Veriniz burada",
    body: "Satırlar, başlıklar ve seçim burada. Sıralama, filtreleme ve kopyalama hazır.",
  },
  stepWorkspaceEdit: {
    title: "Hücre düzenle",
    body: "Düzenlemek için bir hücreye tıklayın — değişiklikler önce Review modalına gider, siz onaylamadan commit edilmez.",
  },
  stepWorkspaceToolbar: {
    title: "Rows ve Tools menüleri",
    body: "Insert, paste, CSV import ve Rewind (commit edilmiş yazmayı geri al) bu menülerde.",
  },
  stepWorkspaceSqlTab: {
    title: "Ya da SQL yazın",
    body: "Yeni sekmede SQL düzenleyici açılır — Run veya Ctrl/Cmd+Enter ile çalıştırın.",
  },
  stepWorkspaceAi: {
    title: "Ajan'a sorun",
    body: "AI paneli SQL yazar, açıklar ve gözden geçirir — bu veride bir soru deneyin.",
  },
  back: "Geri",
  next: "İleri",
  done: "Bitti",
  skip: "Turu atla",
};

const ZH: OnboardingCopy = {
  ...EN,
  stepLauncherSample: {
    title: "先用示例数据",
    body: "点击下方卡片 — 无需配置即可加载示例 SQLite 数据库(customers、orders、products)。之后可在同一页面连接你自己的数据库。",
  },
  stepLauncherCreating: {
    title: "正在设置…",
    body: "正在写入示例数据并连接 — 稍等片刻。",
  },
  stepLauncherPick: {
    title: "或选择一个连接",
    body: "已保存的连接也可以 — 点击打开工作区,导览在那里继续。",
  },
  stepWorkspaceSidebar: {
    title: "表都在侧边栏",
    body: "侧边栏列出当前连接下的所有表和视图。展开数据库查看。",
  },
  stepWorkspaceExpandTables: {
    title: "展开 Tables",
    body: "点击 Tables 文件夹查看里面的示例表。",
  },
  stepWorkspaceOpenTable: {
    title: "打开一个表",
    body: "点击 `customers` 在数据网格中打开。",
  },
  stepWorkspaceGrid: {
    title: "这里是你的数据",
    body: "行、表头与选中都在这里。排序、筛选、复制一应俱全。",
  },
  stepWorkspaceEdit: {
    title: "编辑单元格",
    body: "点击任意单元格开始编辑 — 修改会先进入 Review 模态,确认前不会写入数据库。",
  },
  stepWorkspaceToolbar: {
    title: "Rows / Tools 菜单",
    body: "Insert、paste、CSV 导入和 Rewind(撤销已提交的写入)都在这两个菜单里。",
  },
  stepWorkspaceSqlTab: {
    title: "或者写 SQL",
    body: "新建标签页打开 SQL 编辑器 — 点 Run 或按 Ctrl/Cmd+Enter 执行。",
  },
  stepWorkspaceAi: {
    title: "问问 AI 助手",
    body: "AI 面板可以编写、解释并评审 SQL — 不妨就这份数据问一句。",
  },
  back: "上一步",
  next: "下一步",
  done: "完成",
  skip: "跳过导览",
};

const COPY: Record<AppLanguage, OnboardingCopy> = {
  en: EN,
  vi: VI,
  ko: KO,
  tr: TR,
  zh: ZH,
};

export function getOnboardingCopy(language: AppLanguage): OnboardingCopy {
  return COPY[language] ?? EN;
}
