/**
 * Path utility helpers for working with file/table paths.
 */

export function getLastPathSegment(value?: string | null): string {
  if (!value) return "";
  const normalized = value.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] || value;
}
