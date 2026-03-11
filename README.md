# TableR

A fast, cross-platform database client built with Tauri + React + Rust.

Works on **Windows**, **macOS**, and **Linux**.

## Features (Core)

- **Multi-database support**: MySQL, PostgreSQL, SQLite
- **Data grid**: Sortable, paginated table viewer with cell selection
- **SQL editor**: Monaco-based editor with syntax highlighting, Ctrl+Enter to execute
- **Connection manager**: Save, test, and organize database connections
- **Table structure viewer**: Columns, indexes, foreign keys
- **Cross-platform secure storage**: Passwords stored via OS keyring

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Runtime** | Tauri 2 |
| **Backend** | Rust + SQLx |
| **Frontend** | React 19 + TypeScript |
| **UI** | Tailwind CSS 4 |
| **SQL Editor** | Monaco Editor |
| **Data Grid** | TanStack Table |
| **State** | Zustand |
| **Icons** | Lucide React |

## Architecture

```
TableR/
├── src/                    # React frontend
│   ├── components/
│   │   ├── ConnectionForm/ # New connection dialog
│   │   ├── ConnectionList/ # Saved connections sidebar
│   │   ├── DataGrid/       # Table data viewer with pagination
│   │   ├── Sidebar/        # Database/table tree browser
│   │   ├── SQLEditor/      # Monaco SQL editor + results
│   │   ├── TabBar/         # Editor tabs
│   │   └── TableStructure/ # Column/index/FK viewer
│   ├── stores/             # Zustand state management
│   ├── types/              # TypeScript interfaces
│   └── App.tsx             # Main layout
├── src-tauri/              # Rust backend
│   └── src/
│       ├── database/
│       │   ├── driver.rs   # DatabaseDriver trait
│       │   ├── mysql.rs    # MySQL via SQLx
│       │   ├── postgres.rs # PostgreSQL via SQLx
│       │   ├── sqlite.rs   # SQLite via SQLx
│       │   ├── manager.rs  # Connection pool manager
│       │   └── models.rs   # Shared data models
│       ├── commands/       # Tauri IPC commands
│       └── storage/        # Connection persistence
```

## Development

### Prerequisites

- Node.js 18+
- Rust 1.70+
- Platform build tools (VS Build Tools on Windows, Xcode CLI on macOS, build-essential + libwebkit2gtk on Linux)

### Run

```bash
npm install
npm run tauri dev
```

### Build

```bash
npm run tauri build
```

## License

GPL-3.0

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
