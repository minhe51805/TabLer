import { useCallback, useRef, useState } from "react";
import {
  Palette,
  Type,
  LayoutGrid,
  Download,
  Upload,
  RotateCcw,
  Sun,
  Moon,
  Eye,
  X,
} from "lucide-react";
import { useThemeStore, PRESET_THEMES, type TablerTheme } from "../../stores/themeStore";

interface ThemeCustomizerProps {
  onClose: () => void;
}

type TabId = "colors" | "font" | "layout";

export function ThemeCustomizer({ onClose }: ThemeCustomizerProps) {
  const {
    activeThemeId,
    customTheme,
    setActiveTheme,
    updateCustomEditor,
    updateCustomFont,
    updateCustomLayout,
    exportCustomTheme,
    importCustomTheme,
    resetCustomTheme,
  } = useThemeStore();

  const [activeTab, setActiveTab] = useState<TabId>("colors");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleExport = useCallback(() => {
    const json = exportCustomTheme();
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${customTheme.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [customTheme.id, exportCustomTheme]);

  const handleImportClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleImportFile = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const text = ev.target?.result as string;
        const ok = importCustomTheme(text);
        if (!ok) {
          alert("Invalid theme JSON file.");
        }
      };
      reader.readAsText(file);
      // Reset input so same file can be re-imported
      e.target.value = "";
    },
    [importCustomTheme],
  );

  const allThemes: TablerTheme[] = [
    ...PRESET_THEMES,
    { id: "tabler-custom", name: "Custom", type: customTheme.type, editor: customTheme.editor, font: customTheme.font, layout: customTheme.layout },
  ];

  return (
    <div className="app-help-modal-backdrop" onClick={onClose}>
      <div className="app-help-modal theme-customizer-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="app-help-modal-header">
          <div className="app-help-modal-copy">
            <span className="app-help-modal-kicker">Settings</span>
            <h3 className="app-help-modal-title">Theme Customizer</h3>
            <p className="app-help-modal-description">
              Customize editor colors, fonts, and layout. Switch to Custom theme to edit.
            </p>
          </div>
          <button type="button" className="app-help-modal-close" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        {/* Preset quick-select */}
        <div className="theme-customizer-presets">
          <span className="theme-customizer-presets-label">Theme:</span>
          <div className="theme-customizer-preset-list">
            {allThemes.map((theme) => (
              <button
                key={theme.id}
                type="button"
                className={`theme-customizer-preset-btn ${activeThemeId === theme.id ? "active" : ""}`}
                onClick={() => setActiveTheme(theme.id)}
                title={theme.name}
              >
                <span
                  className="theme-customizer-preset-swatch"
                  style={{ background: theme.editor.background }}
                >
                  <span
                    className="theme-customizer-preset-accent"
                    style={{ background: theme.editor.keyword }}
                  />
                </span>
                <span className="theme-customizer-preset-name">
                  {theme.name}
                  {theme.type === "light" ? (
                    <Sun size={10} className="theme-customizer-preset-type-icon" />
                  ) : (
                    <Moon size={10} className="theme-customizer-preset-type-icon" />
                  )}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* Tab navigation */}
        <div className="theme-customizer-tabs">
          <button
            type="button"
            className={`theme-customizer-tab ${activeTab === "colors" ? "active" : ""}`}
            onClick={() => setActiveTab("colors")}
          >
            <Palette size={14} />
            <span>Colors</span>
          </button>
          <button
            type="button"
            className={`theme-customizer-tab ${activeTab === "font" ? "active" : ""}`}
            onClick={() => setActiveTab("font")}
          >
            <Type size={14} />
            <span>Font</span>
          </button>
          <button
            type="button"
            className={`theme-customizer-tab ${activeTab === "layout" ? "active" : ""}`}
            onClick={() => setActiveTab("layout")}
          >
            <LayoutGrid size={14} />
            <span>Layout</span>
          </button>
        </div>

        {/* Tab content */}
        <div className="theme-customizer-content">
          {activeTab === "colors" && (
            <ColorEditor
              editor={customTheme.editor}
              onChange={updateCustomEditor}
              disabled={activeThemeId !== "tabler-custom"}
            />
          )}
          {activeTab === "font" && (
            <FontEditor
              font={customTheme.font}
              onChange={updateCustomFont}
              disabled={activeThemeId !== "tabler-custom"}
            />
          )}
          {activeTab === "layout" && (
            <LayoutEditor
              layout={customTheme.layout}
              onChange={updateCustomLayout}
              disabled={activeThemeId !== "tabler-custom"}
            />
          )}
        </div>

        {/* Preview */}
        <div className="theme-customizer-preview">
          <div className="theme-customizer-preview-label">
            <Eye size={12} />
            Preview
          </div>
          <ThemePreview theme={customTheme} />
        </div>

        {/* Import/Export */}
        <div className="theme-customizer-actions-row">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={handleImportClick}
            disabled={activeThemeId !== "tabler-custom"}
          >
            <Upload size={14} />
            Import JSON
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            style={{ display: "none" }}
            onChange={handleImportFile}
          />

          <button
            type="button"
            className="btn btn-secondary"
            onClick={handleExport}
            disabled={activeThemeId !== "tabler-custom"}
          >
            <Download size={14} />
            Export JSON
          </button>

          <button
            type="button"
            className="btn btn-secondary"
            onClick={resetCustomTheme}
            disabled={activeThemeId !== "tabler-custom"}
          >
            <RotateCcw size={14} />
            Reset
          </button>
        </div>

        {/* Apply note */}
        {activeThemeId !== "tabler-custom" && (
          <div className="theme-customizer-note">
            Select &quot;Custom&quot; theme to edit. Current: {allThemes.find((t) => t.id === activeThemeId)?.name}
          </div>
        )}

        <div className="app-help-modal-actions">
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Color Editor ──────────────────────────────────────────────────────────────

interface ColorEditorProps {
  editor: TablerTheme["editor"];
  onChange: (partial: Partial<TablerTheme["editor"]>) => void;
  disabled: boolean;
}

function ColorEditor({ editor, onChange, disabled }: ColorEditorProps) {
  const colors: Array<{ key: keyof TablerTheme["editor"]; label: string }> = [
    { key: "background", label: "Background" },
    { key: "foreground", label: "Foreground" },
    { key: "selection", label: "Selection" },
    { key: "cursor", label: "Cursor" },
    { key: "lineHighlight", label: "Line Highlight" },
    { key: "lineNumber", label: "Line Number" },
    { key: "lineNumberActive", label: "Line Number (Active)" },
    { key: "keyword", label: "Keyword" },
    { key: "string", label: "String" },
    { key: "number", label: "Number" },
    { key: "comment", label: "Comment" },
    { key: "operator", label: "Operator" },
  ];

  return (
    <div className="theme-color-grid">
      {colors.map(({ key, label }) => (
        <div key={key} className="theme-color-row">
          <label className="theme-color-label">{label}</label>
          <div className="theme-color-input-group">
            <input
              type="color"
              className="theme-color-picker"
              value={editor[key]}
              onChange={(e) => onChange({ [key]: e.target.value })}
              disabled={disabled}
            />
            <input
              type="text"
              className="theme-color-text"
              value={editor[key]}
              onChange={(e) => onChange({ [key]: e.target.value })}
              disabled={disabled}
              maxLength={9}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Font Editor ───────────────────────────────────────────────────────────────

interface FontEditorProps {
  font: TablerTheme["font"];
  onChange: (partial: Partial<TablerTheme["font"]>) => void;
  disabled: boolean;
}

function FontEditor({ font, onChange, disabled }: FontEditorProps) {
  return (
    <div className="theme-font-editor">
      <div className="theme-font-row">
        <label className="theme-color-label">Font Family</label>
        <input
          type="text"
          className="input theme-font-input"
          value={font.family}
          onChange={(e) => onChange({ family: e.target.value })}
          disabled={disabled}
          placeholder="JetBrains Mono, Fira Code, monospace"
        />
      </div>

      <div className="theme-font-row">
        <label className="theme-color-label">Size: {font.size}px</label>
        <input
          type="range"
          className="theme-range"
          min={8}
          max={32}
          value={font.size}
          onChange={(e) => onChange({ size: Number(e.target.value) })}
          disabled={disabled}
        />
      </div>

      <div className="theme-font-row">
        <label className="theme-color-label">Line Height: {font.lineHeight.toFixed(1)}</label>
        <input
          type="range"
          className="theme-range"
          min={1.0}
          max={3.0}
          step={0.1}
          value={font.lineHeight}
          onChange={(e) => onChange({ lineHeight: Number(e.target.value) })}
          disabled={disabled}
        />
      </div>

      <div className="theme-font-row">
        <label className="theme-font-toggle-label">
          <input
            type="checkbox"
            checked={font.ligatures}
            onChange={(e) => onChange({ ligatures: e.target.checked })}
            disabled={disabled}
          />
          Font Ligatures
        </label>
      </div>

      {/* Font preview */}
      <div
        className="theme-font-preview"
        style={{
          fontFamily: font.family,
          fontSize: `${font.size}px`,
          lineHeight: font.lineHeight,
          fontVariantLigatures: font.ligatures ? "normal" : "none",
        }}
      >
        <div className="theme-font-preview-title">SELECT * FROM users WHERE id = 42 -- get user</div>
        <div className="theme-font-preview-title" style={{ color: "#22D3EE" }}>
          SELECT * FROM users WHERE id = 42 -- get user
        </div>
        <div className="theme-font-preview-title" style={{ color: "#7FE0C2" }}>
          SELECT * FROM users WHERE id = 42 -- get user
        </div>
      </div>
    </div>
  );
}

// ── Layout Editor ─────────────────────────────────────────────────────────────

interface LayoutEditorProps {
  layout: TablerTheme["layout"];
  onChange: (partial: Partial<TablerTheme["layout"]>) => void;
  disabled: boolean;
}

function LayoutEditor({ layout, onChange, disabled }: LayoutEditorProps) {
  return (
    <div className="theme-font-editor">
      <div className="theme-font-row">
        <label className="theme-color-label">Tab Height: {layout.tabHeight}px</label>
        <input
          type="range"
          className="theme-range"
          min={28}
          max={60}
          value={layout.tabHeight}
          onChange={(e) => onChange({ tabHeight: Number(e.target.value) })}
          disabled={disabled}
        />
      </div>

      <div className="theme-font-row">
        <label className="theme-color-label">Sidebar Width: {layout.sidebarWidth}px</label>
        <input
          type="range"
          className="theme-range"
          min={200}
          max={500}
          value={layout.sidebarWidth}
          onChange={(e) => onChange({ sidebarWidth: Number(e.target.value) })}
          disabled={disabled}
        />
      </div>

      <div className="theme-font-row">
        <label className="theme-color-label">Panel Spacing: {layout.panelSpacing}px</label>
        <input
          type="range"
          className="theme-range"
          min={0}
          max={24}
          value={layout.panelSpacing}
          onChange={(e) => onChange({ panelSpacing: Number(e.target.value) })}
          disabled={disabled}
        />
      </div>

      <div className="theme-font-row">
        <label className="theme-color-label">Border Radius: {layout.borderRadius}px</label>
        <input
          type="range"
          className="theme-range"
          min={0}
          max={24}
          value={layout.borderRadius}
          onChange={(e) => onChange({ borderRadius: Number(e.target.value) })}
          disabled={disabled}
        />
      </div>
    </div>
  );
}

// ── Theme Preview ──────────────────────────────────────────────────────────────

function ThemePreview({ theme }: { theme: TablerTheme }) {
  return (
    <div
      className="theme-preview-editor"
      style={{
        background: theme.editor.background,
        color: theme.editor.foreground,
        fontFamily: theme.font.family,
        fontSize: `${Math.min(theme.font.size, 14)}px`,
        lineHeight: theme.font.lineHeight,
        borderRadius: `${theme.layout.borderRadius}px`,
      }}
    >
      <div className="theme-preview-line">
        <span className="theme-preview-line-number">1</span>
        <span className="theme-preview-code" style={{ color: theme.editor.keyword }}>
          SELECT
        </span>
        <span> </span>
        <span className="theme-preview-code" style={{ color: theme.editor.operator }}>
          *
        </span>
        <span> </span>
        <span className="theme-preview-code" style={{ color: theme.editor.keyword }}>
          FROM
        </span>
        <span> </span>
        <span className="theme-preview-code" style={{ color: theme.editor.foreground }}>
          users
        </span>
        <span> </span>
        <span className="theme-preview-code" style={{ color: theme.editor.keyword }}>
          WHERE
        </span>
        <span> </span>
        <span>active</span>
        <span> </span>
        <span className="theme-preview-code" style={{ color: theme.editor.operator }}>
          =
        </span>
        <span> </span>
        <span className="theme-preview-code" style={{ color: theme.editor.number }}>
          1
        </span>
        <span> </span>
        <span className="theme-preview-code" style={{ color: theme.editor.comment }}>
          -- active users
        </span>
      </div>
      <div
        className="theme-preview-line theme-preview-line-active"
        style={{ background: theme.editor.lineHighlight }}
      >
        <span className="theme-preview-line-number" style={{ color: theme.editor.lineNumberActive }}>
          2
        </span>
        <span className="theme-preview-code" style={{ color: theme.editor.keyword }}>
          ORDER BY
        </span>
        <span> </span>
        <span>created_at</span>
        <span> </span>
        <span className="theme-preview-code" style={{ color: theme.editor.keyword }}>
          DESC
        </span>
        <span className="theme-preview-cursor" style={{ background: theme.editor.cursor }} />
      </div>
      <div className="theme-preview-line">
        <span className="theme-preview-line-number" style={{ color: theme.editor.lineNumber }}>
          3
        </span>
        <span className="theme-preview-code" style={{ color: theme.editor.string }}>
          &quot;Hello, World!&quot;
        </span>
      </div>
    </div>
  );
}
