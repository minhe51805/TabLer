import type {
  InstalledPluginRecord,
  PluginFormatContribution,
} from "../types/plugin";
import { saveExportFile } from "./tauri-utils";

export interface RuntimePluginFormat extends PluginFormatContribution {
  pluginId: string;
  pluginName: string;
}

function stringifyValue(value: string | number | boolean | null): string {
  if (value === null) return "";
  return String(value);
}

function escapeDelimited(value: string, delimiter: string): string {
  if (
    value.includes(delimiter) ||
    value.includes('"') ||
    value.includes("\r") ||
    value.includes("\n")
  ) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function getEnabledPluginFormats(
  plugins: InstalledPluginRecord[],
): RuntimePluginFormat[] {
  return plugins.flatMap((plugin) => {
    if (
      !plugin.enabled ||
      !plugin.verified ||
      !plugin.manifest.capabilities.includes("export")
    ) {
      return [];
    }
    return plugin.manifest.contributes.formats.map((format) => ({
      ...format,
      pluginId: plugin.manifest.id,
      pluginName: plugin.manifest.name,
    }));
  });
}

export function serializePluginFormat(
  format: PluginFormatContribution,
  columns: string[],
  rows: (string | number | boolean | null)[][],
): string {
  if (format.mode === "json-lines") {
    return rows
      .map((row) =>
        JSON.stringify(
          Object.fromEntries(columns.map((column, index) => [column, row[index] ?? null])),
        ),
      )
      .join("\n");
  }

  const delimiter = format.delimiter;
  if (!delimiter || [...delimiter].length !== 1 || delimiter === "\r" || delimiter === "\n") {
    throw new Error(`Plugin format "${format.id}" has an invalid delimiter.`);
  }
  const lines: string[] = [];
  if (format.includeHeader) {
    lines.push(columns.map((column) => escapeDelimited(column, delimiter)).join(delimiter));
  }
  for (const row of rows) {
    lines.push(
      columns
        .map((_, index) => escapeDelimited(stringifyValue(row[index] ?? null), delimiter))
        .join(delimiter),
    );
  }
  return lines.join("\r\n");
}

export async function downloadPluginFormat(
  format: RuntimePluginFormat,
  columns: string[],
  rows: (string | number | boolean | null)[][],
  filename: string,
): Promise<void> {
  const content = serializePluginFormat(format, columns, rows);
  await saveExportFile({
    fileName: filename,
    content,
    filters: [{ name: format.label, extensions: [format.extension] }],
  });
}
