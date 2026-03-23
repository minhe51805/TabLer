<p align="center">
  <h1 align="center">TableR</h1>
  <p align="center">
    A fast, modern, cross-platform database client for developers
    <br />
    <br />
    <a href="https://github.com/minhe51805/TabLer"><strong>Explore the docs »</strong></a>
    <br />
    <br />
    <a href="https://github.com/minhe51805/TabLer/issues">Report Bug</a>
    ·
    <a href="https://github.com/minhe51805/TabLer/issues">Request Feature</a>
    ·
    <a href="https://github.com/minhe51805/TabLer/discussions">Discussions</a>
  </p>
</p>

<p align="center">
  <a href="https://github.com/minhe51805/TabLer/blob/main/LICENSE">
    <img src="https://img.shields.io/badge/License-GPLv3-blue.svg" alt="License: GPL v3" />
  </a>
  <a href="https://tauri.app">
    <img src="https://img.shields.io/badge/Tauri-2.0-24C8CD?logo=tauri" alt="Tauri" />
  </a>
  <a href="https://react.dev">
    <img src="https://img.shields.io/badge/React-19-61DAFB?logo=react" alt="React" />
  </a>
  <a href="https://www.rust-lang.org">
    <img src="https://img.shields.io/badge/Rust-latest-DEA584?logo=rust" alt="Rust" />
  </a>
  <a href="https://www.typescriptlang.org">
    <img src="https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript" alt="TypeScript" />
  </a>
</p>

<p align="center">
  <strong>Works on Windows · macOS · Linux</strong>
</p>

---

## 📖 Table of Contents

- [About](#about)
- [Features](#features)
- [Supported Databases](#supported-databases)
- [Screenshots](#screenshots)
- [Tech Stack](#tech-stack)
- [Architecture](#architecture)
- [Getting Started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Installation](#installation)
  - [Development](#development)
  - [Building](#building)
- [Usage](#usage)
  - [Keyboard Shortcuts](#keyboard-shortcuts)
- [Project Structure](#project-structure)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)
- [Acknowledgments](#acknowledgments)

---

## 📋 About

**TableR** is a lightweight, high-performance database client built with Tauri, React, and Rust. It provides a unified interface for managing multiple database systems while maintaining native performance and a modern user experience.

Designed for developers who need a reliable, fast, and feature-rich database tool without the bloat of traditional clients.

---

## ✨ Features

### 🔌 Connection Management
- **Multi-database support** - Connect to 7+ database types
- **Secure credential storage** - Passwords encrypted via OS keyring
- **Connection testing** - Validate connections before saving
- **URI support** - Import connection strings directly

### 📊 Data Browser
- **Hierarchical tree view** - Navigate databases, schemas, and tables
- **Smart filtering** - Search and filter tables by name
- **Quick actions** - Right-click context menus for common operations

### 📋 Data Viewer
- **Pagination** - Configurable page sizes for large datasets
- **Column sorting** - Sort by any column ascending/descending
- **Cell operations** - Copy, edit, and nullify cell values
- **Row statistics** - View total row count and filtered results

### 📝 SQL Editor
- **Monaco Editor** - Same engine as VS Code
- **Syntax highlighting** - SQL dialect-aware highlighting
- **IntelliSense** - Auto-completion for tables, columns, keywords
- **AI Assistant** - AI-powered SQL generation (Ctrl+K)
- **Query results** - Tabular output with execution time
- **Error detection** - Inline error highlighting

### 🛠️ Schema Editor
- **Column management** - View and edit columns, types, constraints
- **Index viewer** - Explore indexes with column details
- **Foreign keys** - Visualize table relationships
- **Change staging** - Batch multiple changes before applying
- **SQL preview** - Review generated SQL before execution

### 🗂️ Multi-tab Interface
- **Unlimited tabs** - Open multiple queries simultaneously
- **Tab organization** - Drag to reorder, close individually
- **Session persistence** - Restore tabs on restart

---

## 🗄️ Supported Databases

| Database | Version | Driver | Status |
|----------|---------|--------|--------|
| **PostgreSQL** | 9.6+ | SQLx | ✅ Full |
| **MySQL** | 5.7+ | SQLx | ✅ Full |
| **SQLite** | 3.x | SQLx | ✅ Full |
| **MSSQL** | 2017+ | SQLx | ✅ Full |
| **ClickHouse** | 21.8+ | SQLx | ✅ Full |
| **LibSQL** | Latest | SQLx | ✅ Full |
| **MariaDB** | 10.2+ | SQLx | ✅ Full |

---

## 📸 Screenshots

> *Add your screenshots here*

| Connection Manager | SQL Editor | Data Viewer |
|-------------------|------------|-------------|
| ![Connections](./docs/screenshots/connections.png) | ![Editor](./docs/screenshots/editor.png) | ![Data](./docs/screenshots/data.png) |

---

## 🏗️ Tech Stack

| Category | Technology | Purpose |
|----------|------------|---------|
| **Runtime** | [Tauri 2](https://tauri.app) | Desktop application framework |
| **Backend** | [Rust](https://www.rust-lang.org) + [SQLx](https://github.com/launchbadge/sqlx) | Database drivers & connection pooling |
| **Frontend** | [React 19](https://react.dev) + [TypeScript 5](https://www.typescriptlang.org) | UI components |
| **Styling** | [Tailwind CSS 4](https://tailwindcss.com) | Utility-first CSS |
| **Editor** | [Monaco Editor](https://microsoft.github.io/monaco-editor) | Code editing |
| **Data Grid** | [TanStack Table](https://tanstack.com/table) | Table state management |
| **State** | [Zustand](https://zustand-demo.pmnd.rs) | Global state management |
| **Icons** | [Lucide React](https://lucide.dev) | Icon library |

---

## 🏛️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      TableR Application                      │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────┐    │
│  │              React Frontend (TypeScript)            │    │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────┐ │    │
│  │  │Connection│ │  SQL     │ │   Data   │ │Schema  │ │    │
│  │  │ Manager  │ │ Editor   │ │  Viewer  │ │Editor  │ │    │
│  │  └──────────┘ └──────────┘ └──────────┘ └────────┘ │    │
│  └─────────────────────────────────────────────────────┘    │
│                            │                                 │
│                    Tauri IPC Commands                        │
│                            │                                 │
│  ┌─────────────────────────────────────────────────────┐    │
│  │                Rust Backend (SQLx)                  │    │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────┐ │    │
│  │  │PostgreSQL│ │  MySQL   │ │  SQLite  │ │ MSSQL  │ │    │
│  │  │  Driver  │ │  Driver  │ │  Driver  │ │ Driver │ │    │
│  │  └──────────┘ └──────────┘ └──────────┘ └────────┘ │    │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐            │    │
│  │  │ClickHouse│ │  LibSQL  │ │ MariaDB  │            │    │
│  │  │  Driver  │ │  Driver  │ │  Driver  │            │    │
│  │  └──────────┘ └──────────┘ └──────────┘            │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

---

## 🚀 Getting Started

### Prerequisites

Ensure you have the following installed:

- **[Node.js](https://nodejs.org/)** 18+ (LTS recommended)
- **[Rust](https://www.rust-lang.org/tools/install)** 1.70+
- **Platform-specific tools:**

| Platform | Requirements |
|----------|--------------|
| **Windows** | [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) |
| **macOS** | [Xcode Command Line Tools](https://developer.apple.com/xcode/) |
| **Linux** | `build-essential`, `libwebkit2gtk-4.1-dev`, `libssl-dev`, `libgtk-3-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev` |

**Ubuntu/Debian:**
```bash
sudo apt update
sudo apt install -y build-essential libwebkit2gtk-4.1-dev libssl-dev \
  libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev
```

**Fedora:**
```bash
sudo dnf install -y webkit2gtk4.1-devel openssl-devel gtk3-devel \
  libappindicator-gtk3-devel librsvg2-devel
```

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/minhe51805/TabLer.git
   cd TabLer
   ```

2. **Install Node.js dependencies**
   ```bash
   npm install
   ```

3. **Verify Rust installation**
   ```bash
   rustc --version
   cargo --version
   ```

### Development

Start the development server with hot reload:

```bash
npm run tauri dev
```

This will:
- Build the Rust backend in debug mode
- Start the React frontend with Vite
- Launch the desktop application

### Building

Create a production build:

```bash
npm run tauri build
```

Output artifacts will be in:
- `src-tauri/target/release/bundle/`

---

## 💻 Usage

### Keyboard Shortcuts

| Category | Shortcut | Action |
|----------|----------|--------|
| **Editor** | `Ctrl+Enter` | Execute SQL query |
| | `Ctrl+K` | AI SQL assistant |
| | `Ctrl+N` | New query tab |
| **Navigation** | `Ctrl+B` | Toggle sidebar |
| | `Ctrl+Space` | Toggle AI panel |
| | `Ctrl+Shift+P` | Open command palette |
| **View** | `Ctrl+\`` | Toggle results pane |
| | `Ctrl+0` | Reset sidebar width |
| | `Ctrl+=` | Increase font size |
| | `Ctrl+-` | Decrease font size |
| **Tabs** | `Ctrl+W` | Close current tab |
| | `Ctrl+Tab` | Switch to next tab |
| | `Ctrl+Shift+Tab` | Switch to previous tab |

---

## 📁 Project Structure

```
TableR/
├── .github/                    # GitHub workflows & templates
├── docs/                       # Documentation
├── fixtures/                   # Test fixtures
├── src/                        # React frontend
│   ├── components/             # UI components
│   │   ├── AI/                 # AI integration
│   │   ├── ConnectionForm/     # Connection dialog
│   │   ├── DataGrid/           # Data table component
│   │   ├── Sidebar/            # Database navigator
│   │   ├── SQLEditor/          # Monaco editor wrapper
│   │   └── TableStructure/     # Schema editor
│   ├── hooks/                  # Custom React hooks
│   ├── stores/                 # Zustand stores
│   ├── types/                  # TypeScript definitions
│   ├── utils/                  # Helper functions
│   ├── i18n.ts                 # Internationalization
│   └── App.tsx                 # Root component
├── src-tauri/                  # Rust backend
│   ├── icons/                  # App icons
│   ├── src/
│   │   ├── commands/           # Tauri IPC handlers
│   │   ├── database/           # Database drivers
│   │   └── storage/            # Connection persistence
│   ├── Cargo.toml              # Rust dependencies
│   └── tauri.conf.json         # Tauri configuration
├── index.html                  # HTML entry point
├── package.json                # Node.js dependencies
├── tsconfig.json               # TypeScript config
├── vite.config.ts              # Vite bundler config
└── README.md                   # This file
```

---

## 🛣️ Roadmap

### v0.1 (Current)
- [x] Multi-database support
- [x] SQL editor with AI assistance
- [x] Data viewer with pagination
- [x] Schema editor

### v0.2 (Planned)
- [ ] Query history & bookmarks
- [ ] Export to CSV/JSON/SQL
- [ ] Database backup/restore
- [ ] Theme customization

### v0.3 (Future)
- [ ] Visual query builder
- [ ] Real-time collaboration
- [ ] Plugin system
- [ ] Mobile companion app

See the [open issues](https://github.com/minhe51805/TabLer/issues) for a full list of proposed features and known issues.

---

## 🤝 Contributing

Contributions are what make the open source community such an amazing place to learn, inspire, and create. Any contributions you make are **greatly appreciated**.

### Getting Started

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'feat: add AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

### Guidelines

- Follow [Conventional Commits](https://www.conventionalcommits.org/)
- Write tests for new features
- Update documentation as needed
- Ensure CI passes before requesting review

Please read our [Contributing Guide](CONTRIBUTING.md) and [Code of Conduct](CODE_OF_CONDUCT.md) for details.

---

## 📄 License

Distributed under the **GNU General Public License v3.0**. See [LICENSE](LICENSE) for more information.

---

## ☕ Support

If you find TableR helpful, consider buying me a coffee! Your support helps keep this project alive and growing.

<a href="https://buymeacoffee.com/minjev" target="_blank">
  <img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" width="217" height="60" />
</a>

---

## 🙏 Acknowledgments

- [Tauri Team](https://tauri.app) - For the amazing desktop framework
- [SQLx Contributors](https://github.com/launchbadge/sqlx) - For async Rust database drivers
- [Monaco Editor](https://microsoft.github.io/monaco-editor) - For the code editor component
- [TanStack](https://tanstack.com) - For headless UI utilities
- [Lucide](https://lucide.dev) - For beautiful icons

---

## 📬 Connect

<p align="center">
  <a href="https://github.com/minhe51805/TabLer">
    <img src="https://img.shields.io/badge/GitHub-181717?style=for-the-badge&logo=github&logoColor=white" alt="GitHub" />
  </a>
  <a href="https://github.com/minhe51805/TabLer/issues">
    <img src="https://img.shields.io/badge/Issues-24292e?style=for-the-badge&logo=github&logoColor=white" alt="Issues" />
  </a>
  <a href="https://github.com/minhe51805/TabLer/discussions">
    <img src="https://img.shields.io/badge/Discussions-24292e?style=for-the-badge&logo=github&logoColor=white" alt="Discussions" />
  </a>
</p>

<p align="center">
  <strong>Built with ❤️ by minjev</strong>
</p>
