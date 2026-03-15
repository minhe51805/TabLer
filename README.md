# TableR

A fast, modern database client for developers. Built with Tauri + React + Rust.

Works on **Windows**, **macOS**, and **Linux**.

## Supported Databases

- **PostgreSQL** - Full support including schemas, indexes, foreign keys
- **MySQL** - Full support with InnoDB engine
- **SQLite** - Local file databases

## Features

### Connection Management
- Save and organize multiple database connections
- Secure password storage via OS keyring
- Test connection before saving
- Support for connection string (URI)

### Data Browser
- Tree view of databases and tables
- Sort and filter tables by name
- Quick search across all tables

### Data Viewer
- Paginated table data with configurable page size
- Sort by any column
- Copy cell values
- View row count

### SQL Editor
- Monaco-based editor with syntax highlighting
- Execute with Ctrl+Enter
- Auto-completion for tables and SQL keywords
- AI-powered SQL completion (Ctrl+K)
- Query results with execution time
- Error highlighting

### Table Structure Editor
- View columns, data types, nullable, default values
- View indexes with column details
- View foreign key relationships
- Edit column properties (add NOT NULL, change type, rename)
- Stage multiple changes and review SQL before applying
- Discard or apply all changes

### Multi-tab Interface
- Multiple query tabs
- Structure tabs per table
- Drag to reorder tabs
- Close individual tabs

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Tauri 2 |
| Backend | Rust + SQLx |
| Frontend | React 19 + TypeScript |
| UI | Tailwind CSS 4 |
| SQL Editor | Monaco Editor |
| Data Grid | TanStack Table |
| State | Zustand |
| Icons | Lucide React |

## Architecture

`
TableR/
├── src/                    # React frontend
│   ├── components/
│   │   ├── ConnectionForm/ # New connection dialog
│   │   ├── ConnectionList/ # Saved connections sidebar
│   │   ├── DataGrid/      # Table data viewer with pagination
│   │   ├── Sidebar/       # Database/table tree browser
│   │   ├── SQLEditor/     # Monaco SQL editor + results
│   │   ├── TabBar/        # Editor tabs
│   │   └── TableStructure/# Column/index/FK viewer & editor
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
`

## Development

### Prerequisites

- Node.js 18+
- Rust 1.70+
- Platform build tools:
  - **Windows**: VS Build Tools
  - **macOS**: Xcode CLI
  - **Linux**: build-essential + libwebkit2gtk

### Run Development Server

`ash
npm install
npm run tauri dev
`

### Build for Production

`ash
npm run tauri build
`

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Ctrl+Enter | Execute SQL query |
| Ctrl+K | AI SQL assistant |
| Ctrl+J | Toggle terminal |
| Ctrl+ | Toggle terminal |

## License

GPL-3.0
