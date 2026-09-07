import type { ERRelationship } from "../types";

export const ERD_CUSTOM_RELATIONSHIPS_STORAGE_KEY =
  "tabler.erd.customRelationships.v1";

export function getERDRelationshipScopeKey(
  connectionId: string,
  database?: string,
) {
  return `${connectionId}|${database || ""}`;
}

export function readCustomERDRelationships(
  connectionId: string,
  database?: string,
): ERRelationship[] {
  if (typeof window === "undefined") return [];

  try {
    const raw = window.localStorage.getItem(
      ERD_CUSTOM_RELATIONSHIPS_STORAGE_KEY,
    );
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Record<string, ERRelationship[]>;
    const relationships =
      parsed?.[getERDRelationshipScopeKey(connectionId, database)];
    return Array.isArray(relationships) ? relationships : [];
  } catch {
    return [];
  }
}

export function writeCustomERDRelationships(
  connectionId: string,
  database: string | undefined,
  relationships: ERRelationship[],
) {
  if (typeof window === "undefined") return;

  try {
    const raw = window.localStorage.getItem(
      ERD_CUSTOM_RELATIONSHIPS_STORAGE_KEY,
    );
    const parsed = raw
      ? (JSON.parse(raw) as Record<string, ERRelationship[]>)
      : {};
    parsed[getERDRelationshipScopeKey(connectionId, database)] = relationships;
    window.localStorage.setItem(
      ERD_CUSTOM_RELATIONSHIPS_STORAGE_KEY,
      JSON.stringify(parsed),
    );
  } catch {
    // The active ER diagram remains usable when local persistence is unavailable.
  }
}
