export interface IdentityColumn {
  name: string;
  is_primary_key?: boolean;
}

function encodeIdentityValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return `date:${value.toISOString()}`;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return `number:${value}`;
  }
  if (typeof value === "bigint") return `bigint:${value.toString()}`;
  if (typeof value === "boolean") return `boolean:${value ? "1" : "0"}`;
  if (typeof value === "string") return `string:${value}`;
  return `json:${JSON.stringify(value)}`;
}

/**
 * Returns an unambiguous identity only when every primary-key component exists.
 * Row indices are deliberately excluded because sorting and virtualization change them.
 */
export function buildStableRowIdentity(
  row: readonly unknown[],
  columns: readonly IdentityColumn[],
): string | null {
  const primaryKeys = columns
    .map((column, index) => ({ column, index }))
    .filter(({ column }) => column.is_primary_key);
  if (primaryKeys.length === 0) return null;

  const parts: string[] = [];
  for (const { column, index } of primaryKeys) {
    if (index >= row.length) return null;
    const encoded = encodeIdentityValue(row[index]);
    if (encoded === null) return null;
    parts.push(`${JSON.stringify(column.name)}=${JSON.stringify(encoded)}`);
  }
  return parts.join("|");
}

