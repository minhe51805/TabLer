import { useCallback, useEffect, useMemo, useState } from "react";
import type { useI18n } from "../../../i18n";
import { usePluginStore } from "../../../stores/pluginStore";
import type { DatabaseType } from "../../../types/database";
import { emitAppToast } from "../../../utils/app-toast";
import {
  DEFAULT_EXPORT_FORMATS,
  getCompiledExportFormats,
  type ExportFormatInfo,
  type TableExportFormat,
} from "../../../utils/export-formats";
import { buildMqlContent, exportToMQL } from "../../../utils/export-mql";
import {
  buildCsvContent,
  buildJsonContent,
  buildMarkdownTableContent,
  buildTsvContent,
  exportToCSV,
  exportToHtml,
  exportToJSON,
  exportToMarkdown,
  exportToNDJSON,
  exportToTSV,
} from "../../../utils/export-utils";
import { exportToXML } from "../../../utils/export-xml";
import { exportXLSX } from "../../../utils/export-xlsx";
import {
  downloadPluginFormat,
  getEnabledPluginFormats,
  serializePluginFormat,
  type RuntimePluginFormat,
} from "../../../utils/plugin-format-runtime";
import { generateInsertSql } from "../../../utils/sql-generator";
import { saveExportFile } from "../../../utils/tauri-utils";
import type { ResolvedColumn } from "./useDataGrid";

export function buildExportFilename(tableName: string | undefined, extension: string): string {
  const base = tableName
    ? tableName
        .replace(/[^a-zA-Z0-9_.-]/g, "_")
        .split(".")
        .pop() || tableName
    : "table_export";
  const date = new Date().toISOString().slice(0, 10);
  return `${base}_${date}.${extension}`;
}

export interface UseDataGridToolbarExportActionsParams {
  tableName?: string;
  database?: string;
  dbType?: DatabaseType;
  resolvedColumns: ResolvedColumn[];
  dataRows: (string | number | boolean | null)[][];
  canExportData: boolean;
  onExportFull?: (format: TableExportFormat) => void;
  t: ReturnType<typeof useI18n>["t"];
}

/**
 * File-export and clipboard-copy handlers for `DataGridToolbar`.
 */
export function useDataGridToolbarExportActions({
  tableName,
  database,
  dbType,
  resolvedColumns,
  dataRows,
  canExportData,
  onExportFull,
  t,
}: UseDataGridToolbarExportActionsParams) {
  // Formats compiled into the backend; parquet is absent when `parquet-export` is off.
  const [fullFormats, setFullFormats] = useState<ExportFormatInfo[]>(DEFAULT_EXPORT_FORMATS);
  useEffect(() => {
    let cancelled = false;
    void getCompiledExportFormats().then((formats) => {
      if (!cancelled) setFullFormats(formats);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const installedPlugins = usePluginStore((state) => state.plugins);
  const pluginsHaveLoaded = usePluginStore((state) => state.hasLoaded);
  const loadPlugins = usePluginStore((state) => state.loadPlugins);
  const pluginFormats = useMemo(
    () => getEnabledPluginFormats(installedPlugins),
    [installedPlugins],
  );

  useEffect(() => {
    if (!pluginsHaveLoaded) void loadPlugins();
  }, [loadPlugins, pluginsHaveLoaded]);

  const canExport =
    canExportData &&
    resolvedColumns.length > 0 &&
    (dataRows.length > 0 || Boolean(tableName && onExportFull));
  const exportFilenameBase = tableName
    ? tableName
        .replace(/[^a-zA-Z0-9_.-]/g, "_")
        .split(".")
        .pop() || tableName
    : "table_export";

  const notifyExportError = useCallback(
    (error: unknown) => {
      emitAppToast({
        title: t("datagrid.exportFailed"),
        description: String(error),
        tone: "error",
      });
    },
    [t],
  );

  const handleExportCSV = useCallback(() => {
    if (!canExport) return;
    const cols = resolvedColumns.map((c) => c.name);
    exportToCSV(cols, dataRows, buildExportFilename(exportFilenameBase, "csv")).catch(
      notifyExportError,
    );
  }, [canExport, dataRows, exportFilenameBase, notifyExportError, resolvedColumns]);

  const handleExportTSV = useCallback(() => {
    if (!canExport) return;
    const cols = resolvedColumns.map((c) => c.name);
    exportToTSV(cols, dataRows, buildExportFilename(exportFilenameBase, "tsv")).catch(
      notifyExportError,
    );
  }, [canExport, dataRows, exportFilenameBase, notifyExportError, resolvedColumns]);

  const handleExportJSON = useCallback(() => {
    if (!canExport) return;
    const cols = resolvedColumns.map((c) => c.name);
    exportToJSON(cols, dataRows, buildExportFilename(exportFilenameBase, "json")).catch(
      notifyExportError,
    );
  }, [canExport, dataRows, exportFilenameBase, notifyExportError, resolvedColumns]);

  const handleExportXLSX = useCallback(async () => {
    if (!canExport) return;
    const cols = resolvedColumns.map((c) => ({ name: c.name, data_type: c.data_type || "" }));
    try {
      await exportXLSX(
        [{ name: tableName || "Result", columns: cols, rows: dataRows }],
        buildExportFilename(exportFilenameBase, "xlsx"),
      );
    } catch (error) {
      notifyExportError(error);
    }
  }, [canExport, dataRows, exportFilenameBase, notifyExportError, resolvedColumns, tableName]);

  const handleExportMarkdown = useCallback(() => {
    if (!canExport) return;
    const cols = resolvedColumns.map((c) => c.name);
    exportToMarkdown(cols, dataRows, buildExportFilename(exportFilenameBase, "md")).catch(
      notifyExportError,
    );
  }, [canExport, dataRows, exportFilenameBase, notifyExportError, resolvedColumns]);

  const handleExportXML = useCallback(() => {
    if (!canExport) return;
    const cols = resolvedColumns.map((c) => c.name);
    exportToXML(cols, dataRows, buildExportFilename(exportFilenameBase, "xml")).catch(
      notifyExportError,
    );
  }, [canExport, dataRows, exportFilenameBase, notifyExportError, resolvedColumns]);

  const handleExportNDJSON = useCallback(() => {
    if (!canExport) return;
    const cols = resolvedColumns.map((c) => c.name);
    exportToNDJSON(cols, dataRows, buildExportFilename(exportFilenameBase, "ndjson")).catch(
      notifyExportError,
    );
  }, [canExport, dataRows, exportFilenameBase, notifyExportError, resolvedColumns]);

  const handleExportHtml = useCallback(() => {
    if (!canExport) return;
    const cols = resolvedColumns.map((c) => c.name);
    exportToHtml(cols, dataRows, buildExportFilename(exportFilenameBase, "html")).catch(
      notifyExportError,
    );
  }, [canExport, dataRows, exportFilenameBase, notifyExportError, resolvedColumns]);

  const handleExportSQL = useCallback(() => {
    if (!canExport || !tableName) return;
    const cols = resolvedColumns.map((c) => c.name);
    saveExportFile({
      fileName: buildExportFilename(exportFilenameBase, "sql"),
      content: generateInsertSql(tableName, cols, dataRows, dbType),
      filters: [{ name: "SQL", extensions: ["sql"] }],
    }).catch(notifyExportError);
  }, [
    canExport,
    dataRows,
    dbType,
    exportFilenameBase,
    notifyExportError,
    resolvedColumns,
    tableName,
  ]);

  const handleExportMQL = useCallback(async () => {
    if (!canExport) return;
    const cols = resolvedColumns.map((c) => c.name);
    try {
      await exportToMQL({
        collectionName: tableName,
        databaseName: database,
        columns: cols,
        rows: dataRows,
      });
    } catch (error) {
      notifyExportError(error);
    }
  }, [canExport, dataRows, database, notifyExportError, resolvedColumns, tableName]);

  const handlePluginExport = useCallback(
    (format: RuntimePluginFormat) => {
      if (!canExport) return;
      downloadPluginFormat(
        format,
        resolvedColumns.map((column) => column.name),
        dataRows,
        buildExportFilename(exportFilenameBase, format.extension),
      ).catch(notifyExportError);
    },
    [canExport, dataRows, exportFilenameBase, notifyExportError, resolvedColumns],
  );

  // Copy actions place the same bytes the export path would write onto the
  // clipboard (TSV stands in for XLSX, which is a binary format).
  const copyText = useCallback(
    async (content: string, label: string) => {
      try {
        await navigator.clipboard.writeText(content);
        emitAppToast({
          title: t("datagrid.copiedTitle", { format: label }),
          description: t("datagrid.copiedDescription", { count: dataRows.length }),
          tone: "success",
        });
      } catch (error) {
        emitAppToast({
          title: t("datagrid.copyFailed"),
          description: String(error),
          tone: "error",
        });
      }
    },
    [dataRows.length, t],
  );

  const handleCopyCSV = useCallback(() => {
    const cols = resolvedColumns.map((c) => c.name);
    void copyText(buildCsvContent(cols, dataRows), "CSV");
  }, [copyText, dataRows, resolvedColumns]);

  const handleCopyTSV = useCallback(() => {
    const cols = resolvedColumns.map((c) => c.name);
    void copyText(buildTsvContent(cols, dataRows), "TSV");
  }, [copyText, dataRows, resolvedColumns]);

  const handleCopyMarkdown = useCallback(() => {
    const cols = resolvedColumns.map((c) => c.name);
    void copyText(buildMarkdownTableContent(cols, dataRows), "Markdown");
  }, [copyText, dataRows, resolvedColumns]);

  const handleCopyInsert = useCallback(() => {
    if (!tableName) return;
    const cols = resolvedColumns.map((c) => c.name);
    void copyText(generateInsertSql(tableName, cols, dataRows, dbType), "INSERT");
  }, [copyText, dataRows, dbType, resolvedColumns, tableName]);

  const handleCopyJSON = useCallback(() => {
    const cols = resolvedColumns.map((c) => c.name);
    void copyText(buildJsonContent(cols, dataRows), "JSON");
  }, [copyText, dataRows, resolvedColumns]);

  const handleCopyMQL = useCallback(() => {
    void copyText(
      buildMqlContent({
        collectionName: tableName,
        databaseName: database,
        columns: resolvedColumns.map((c) => c.name),
        rows: dataRows,
      }),
      "MQL",
    );
  }, [copyText, dataRows, database, resolvedColumns, tableName]);

  const handleCopyPlugin = useCallback(
    (format: RuntimePluginFormat) => {
      void copyText(
        serializePluginFormat(
          format,
          resolvedColumns.map((column) => column.name),
          dataRows,
        ),
        format.label,
      );
    },
    [copyText, dataRows, resolvedColumns],
  );

  return {
    fullFormats,
    pluginFormats,
    canExport,
    handleExportCSV,
    handleExportTSV,
    handleExportJSON,
    handleExportXLSX,
    handleExportMarkdown,
    handleExportXML,
    handleExportNDJSON,
    handleExportHtml,
    handleExportSQL,
    handleExportMQL,
    handlePluginExport,
    handleCopyCSV,
    handleCopyTSV,
    handleCopyMarkdown,
    handleCopyInsert,
    handleCopyJSON,
    handleCopyMQL,
    handleCopyPlugin,
  };
}
