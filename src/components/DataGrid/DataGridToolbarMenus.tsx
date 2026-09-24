import { createPortal } from "react-dom";
import type { RefObject } from "react";
import {
  ArrowUpDown,
  Braces,
  Copy,
  FileCode,
  FileJson,
  FilePen,
  FileSpreadsheet,
  ShieldCheck,
  Table2,
  Timer,
  X,
} from "lucide-react";
import type { useI18n } from "../../i18n";
import type { RuntimePluginFormat } from "../../utils/plugin-format-runtime";
import type { getDataGridChartCopy } from "./datagrid-chart-copy";
import type { getDataGridPowerCopy } from "./datagrid-power-copy";
import type { ResolvedColumn } from "./hooks/useDataGrid";
import type { useDataGridSettings } from "../../stores/datagrid-settings-store";

type TFunction = ReturnType<typeof useI18n>["t"];
type ChartCopy = ReturnType<typeof getDataGridChartCopy>;
type PowerCopy = ReturnType<typeof getDataGridPowerCopy>;
type GridSettings = ReturnType<typeof useDataGridSettings>["settings"];
type UpdateSettings = ReturnType<typeof useDataGridSettings>["updateSettings"];

interface MenuOption {
  label: string;
  hint: string;
  icon: typeof FileSpreadsheet;
  run: () => void;
}

/** Fixed-position dropdown anchored under a toolbar button, portaled to
 *  document.body so transformed ancestors can't trap it. */
function ToolbarMenu({
  anchorRef,
  className,
  children,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  className?: string;
  children: React.ReactNode;
}) {
  const rect = anchorRef.current?.getBoundingClientRect();
  if (!rect) return null;
  const top = rect.bottom + 6;
  const right = window.innerWidth - rect.right;
  return createPortal(
    <div
      className={className ?? "datagrid-export-menu"}
      style={{ position: "fixed", top, right, zIndex: 9999 }}
    >
      {children}
    </div>,
    document.body,
  );
}

function MenuOptionButton({ opt, onDone }: { opt: MenuOption; onDone: () => void }) {
  const OptIcon = opt.icon;
  return (
    <button
      type="button"
      className="datagrid-export-menu-item"
      onClick={() => {
        opt.run();
        onDone();
      }}
    >
      <OptIcon className="!w-4 !h-4" />
      <span className="datagrid-export-menu-copy">
        <strong>{opt.label}</strong>
        <span>{opt.hint}</span>
      </span>
    </button>
  );
}

/** "Copy selected rows as SQL" dropdown: INSERT/UPDATE statements plus the
 *  parameterized variants; DELETE only when a primary key exists. */
export function DataGridSqlMenu({
  open,
  anchorRef,
  hasPk,
  t,
  onCopyAsInsert,
  onCopyAsUpdate,
  onCopyAsInsertParam,
  onCopyAsUpdateParam,
  onCopyAsDeleteParam,
  onClose,
}: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  hasPk: boolean;
  t: TFunction;
  onCopyAsInsert: () => void;
  onCopyAsUpdate: () => void;
  onCopyAsInsertParam: () => void;
  onCopyAsUpdateParam: () => void;
  onCopyAsDeleteParam: () => void;
  onClose: () => void;
}) {
  if (!open) return null;
  const sqlOptions: MenuOption[] = [
    {
      label: "INSERT",
      hint: t("datagrid.sqlInsertHint"),
      icon: Copy,
      run: () => void onCopyAsInsert(),
    },
    {
      label: "UPDATE",
      hint: t("datagrid.sqlInsertHint"),
      icon: FilePen,
      run: () => void onCopyAsUpdate(),
    },
    {
      label: "INSERT $.",
      hint: t("datagrid.sqlParamHint"),
      icon: Braces,
      run: () => void onCopyAsInsertParam(),
    },
    {
      label: "UPDATE $.",
      hint: t("datagrid.sqlParamHint"),
      icon: Braces,
      run: () => void onCopyAsUpdateParam(),
    },
    ...(hasPk
      ? [
          {
            label: "DELETE $.",
            hint: t("datagrid.sqlDeleteHint"),
            icon: Braces,
            run: () => void onCopyAsDeleteParam(),
          },
        ]
      : []),
  ];
  return (
    <ToolbarMenu anchorRef={anchorRef}>
      {sqlOptions.map((opt) => (
        <MenuOptionButton key={opt.label} opt={opt} onDone={onClose} />
      ))}
    </ToolbarMenu>
  );
}

/** Auto-refresh interval picker: off / 5s / 15s / 30s / 60s. */
export function DataGridRefreshMenu({
  open,
  anchorRef,
  autoRefreshMs,
  chartCopy,
  onAutoRefreshMsChange,
  onClose,
}: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  autoRefreshMs: number;
  chartCopy: ChartCopy;
  onAutoRefreshMsChange?: (ms: number) => void;
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <ToolbarMenu anchorRef={anchorRef} className="datagrid-export-menu datagrid-sort-menu">
      {[0, 5000, 15000, 30000, 60000].map((ms) => (
        <button
          key={ms}
          type="button"
          className={`datagrid-sort-menu-item${autoRefreshMs === ms ? " active" : ""}`}
          onClick={() => {
            onAutoRefreshMsChange?.(ms);
            onClose();
          }}
        >
          <Timer className="!w-3.5 !h-3.5" />
          <span>
            {ms === 0 ? chartCopy.autoRefresh.off : chartCopy.autoRefresh.everySeconds(ms / 1000)}
          </span>
        </button>
      ))}
    </ToolbarMenu>
  );
}

/** Export dropdown: CSV/JSON/XLSX/Markdown/MQL plus plugin-registered formats. */
export function DataGridExportMenu({
  open,
  anchorRef,
  tableName,
  onExportFull,
  pluginFormats,
  powerCopy,
  t,
  onExportCSV,
  onExportJSON,
  onExportXLSX,
  onExportMarkdown,
  onExportMQL,
  onPluginExport,
  onClose,
}: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  tableName?: string;
  onExportFull?: (format: "csv" | "jsonl") => void;
  pluginFormats: RuntimePluginFormat[];
  powerCopy: PowerCopy;
  t: TFunction;
  onExportCSV: () => void;
  onExportJSON: () => void;
  onExportXLSX: () => void;
  onExportMarkdown: () => void;
  onExportMQL: () => void;
  onPluginExport: (format: RuntimePluginFormat) => void;
  onClose: () => void;
}) {
  if (!open) return null;
  const exportOptions: MenuOption[] = [
    {
      label: tableName && onExportFull ? t("datagrid.exportFullCsv") : "CSV",
      hint: t("datagrid.exportHintCsv"),
      icon: FileSpreadsheet,
      run: onExportCSV,
    },
    {
      label: tableName && onExportFull ? t("datagrid.exportFullJsonl") : "JSON",
      hint: t("datagrid.exportHintJson"),
      icon: FileJson,
      run: onExportJSON,
    },
    {
      label: "XLSX",
      hint: t("datagrid.exportHintXlsx"),
      icon: FileSpreadsheet,
      run: onExportXLSX,
    },
    {
      label: powerCopy.copyAs.markdown,
      hint: powerCopy.copyAs.markdownHint,
      icon: Table2,
      run: onExportMarkdown,
    },
    {
      label: "MQL",
      hint: t("datagrid.exportHintMql"),
      icon: FileCode,
      run: () => void onExportMQL(),
    },
    ...pluginFormats.map((format) => ({
      label: format.label,
      hint: format.description || t("datagrid.exportHintPlugin", { plugin: format.pluginName }),
      icon: FileCode,
      run: () => onPluginExport(format),
    })),
  ];
  return (
    <ToolbarMenu anchorRef={anchorRef}>
      {exportOptions.map((opt) => (
        <MenuOptionButton key={opt.label} opt={opt} onDone={onClose} />
      ))}
    </ToolbarMenu>
  );
}

/** Copy-as dropdown: clipboard formats, INSERT script, anonymizer, plugins. */
export function DataGridCopyMenu({
  open,
  anchorRef,
  tableName,
  pluginFormats,
  powerCopy,
  t,
  onCopyCSV,
  onCopyTSV,
  onCopyJSON,
  onCopyMarkdown,
  onCopyInsert,
  onCopyMQL,
  onOpenAnonymizer,
  onCopyPlugin,
  onClose,
}: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  tableName?: string;
  pluginFormats: RuntimePluginFormat[];
  powerCopy: PowerCopy;
  t: TFunction;
  onCopyCSV: () => void;
  onCopyTSV: () => void;
  onCopyJSON: () => void;
  onCopyMarkdown: () => void;
  onCopyInsert: () => void;
  onCopyMQL: () => void;
  onOpenAnonymizer: () => void;
  onCopyPlugin: (format: RuntimePluginFormat) => void;
  onClose: () => void;
}) {
  if (!open) return null;
  const copyOptions: MenuOption[] = [
    { label: "CSV", hint: t("datagrid.copyHintCsv"), icon: FileSpreadsheet, run: onCopyCSV },
    { label: "TSV", hint: t("datagrid.copyHintTsv"), icon: FileSpreadsheet, run: onCopyTSV },
    { label: "JSON", hint: t("datagrid.copyHintJson"), icon: FileJson, run: onCopyJSON },
    {
      label: powerCopy.copyAs.markdown,
      hint: powerCopy.copyAs.markdownHint,
      icon: Table2,
      run: onCopyMarkdown,
    },
    ...(tableName
      ? [
          {
            label: powerCopy.copyAs.insert,
            hint: powerCopy.copyAs.insertHint,
            icon: FileCode,
            run: onCopyInsert,
          },
        ]
      : []),
    { label: "MQL", hint: t("datagrid.copyHintMql"), icon: FileCode, run: onCopyMQL },
    {
      label: t("datagrid.anonymizer.title"),
      hint: t("datagrid.anonymizer.saltHint"),
      icon: ShieldCheck,
      run: onOpenAnonymizer,
    },
    ...pluginFormats.map((format) => ({
      label: format.label,
      hint: format.description || t("datagrid.exportHintPlugin", { plugin: format.pluginName }),
      icon: FileCode,
      run: () => onCopyPlugin(format),
    })),
  ];
  return (
    <ToolbarMenu anchorRef={anchorRef}>
      {copyOptions.map((opt) => (
        <MenuOptionButton key={opt.label} opt={opt} onDone={onClose} />
      ))}
    </ToolbarMenu>
  );
}

/** Column sort picker: one row per column with the active sort marked. */
export function DataGridSortMenu({
  open,
  anchorRef,
  resolvedColumns,
  sortColumn,
  sortDir,
  multiSort,
  t,
  onSortColumn,
  onClearMultiSort,
  onClose,
}: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  resolvedColumns: ResolvedColumn[];
  sortColumn: string | null;
  sortDir: "ASC" | "DESC";
  multiSort: { priority: number; column: string; direction: string }[];
  t: TFunction;
  onSortColumn?: (colName: string) => void;
  onClearMultiSort?: () => void;
  onClose: () => void;
}) {
  if (!open || resolvedColumns.length === 0) return null;
  return (
    <ToolbarMenu anchorRef={anchorRef} className="datagrid-export-menu datagrid-sort-menu">
      {resolvedColumns.map((col) => {
        const entry = multiSort.find((item) => item.column === col.name);
        const isSingle = sortColumn === col.name;
        const label = entry
          ? `${col.name} ${entry.direction === "ASC" ? "↑" : "↓"}${entry.priority}`
          : isSingle
            ? `${col.name} ${sortDir === "ASC" ? "↑" : "↓"}`
            : col.name;
        return (
          <button
            key={col.name}
            type="button"
            className={`datagrid-sort-menu-item${entry || isSingle ? " active" : ""}`}
            onClick={() => {
              onSortColumn?.(col.name);
              onClose();
            }}
          >
            <ArrowUpDown className="!w-3.5 !h-3.5" />
            <span>{label}</span>
          </button>
        );
      })}
      {(sortColumn || multiSort.length > 0) && (
        <button
          type="button"
          className="datagrid-sort-menu-item danger"
          onClick={() => {
            onClearMultiSort?.();
            onSortColumn?.("");
            onClose();
          }}
        >
          <X className="!w-3.5 !h-3.5" />
          <span>{t("datagrid.clearSort")}</span>
        </button>
      )}
    </ToolbarMenu>
  );
}

/** Grid settings popover: NULL placeholder, row height, alternating rows. */
export function DataGridSettingsMenu({
  open,
  anchorRef,
  settings,
  updateSettings,
  t,
  onClose,
}: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  settings: GridSettings;
  updateSettings: UpdateSettings;
  t: TFunction;
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <ToolbarMenu anchorRef={anchorRef} className="datagrid-settings-popover">
      <div className="datagrid-settings-popover-header">
        <span className="datagrid-settings-popover-title">{t("datagrid.gridSettings")}</span>
        <button type="button" className="datagrid-settings-popover-close" onClick={onClose}>
          <X className="h-3 w-3" />
        </button>
      </div>
      <div className="datagrid-settings-section">
        <label className="datagrid-settings-label">{t("datagrid.nullDisplay")}</label>
        <input
          type="text"
          className="datagrid-settings-input"
          value={settings.nullPlaceholder}
          maxLength={20}
          onChange={(e) => updateSettings({ nullPlaceholder: e.target.value })}
          placeholder="NULL"
        />
      </div>
      <div className="datagrid-settings-section">
        <label className="datagrid-settings-label">{t("datagrid.rowHeight")}</label>
        <div className="datagrid-settings-row">
          {(["small", "medium", "large"] as const).map((size) => (
            <button
              key={size}
              type="button"
              className={`datagrid-settings-toggle ${settings.rowHeight === size ? "active" : ""}`}
              onClick={() => updateSettings({ rowHeight: size })}
            >
              {t(
                size === "small"
                  ? "datagrid.sizeSmall"
                  : size === "medium"
                    ? "datagrid.sizeMedium"
                    : "datagrid.sizeLarge",
              )}
            </button>
          ))}
        </div>
      </div>
      <div className="datagrid-settings-section">
        <label className="datagrid-settings-label">{t("datagrid.alternatingRows")}</label>
        <button
          type="button"
          className={`datagrid-settings-toggle ${settings.alternatingRows ? "active" : ""}`}
          onClick={() => updateSettings({ alternatingRows: !settings.alternatingRows })}
        >
          {t(settings.alternatingRows ? "datagrid.on" : "datagrid.off")}
        </button>
      </div>
    </ToolbarMenu>
  );
}
