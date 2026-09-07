/**
 * TTL cache for fetched ER-diagram schemas, shared across component instances.
 */

import type { ERDiagramSchema } from "../../types/database";
import { getERDRelationshipScopeKey } from "../../utils/erd-custom-relationships";

export const ER_DIAGRAM_CACHE_TTL_MS = 30 * 60 * 1000;
export const ER_DIAGRAM_STRUCTURE_BATCH_SIZE = 10;

export interface ERDiagramCacheEntry {
  schema: ERDiagramSchema;
  cachedAt: number;
  lastUsedAt: number;
}

export const erDiagramSchemaCache = new Map<string, ERDiagramCacheEntry>();
export const erDiagramSchemaRequests = new Map<string, Promise<ERDiagramSchema>>();

export function getERDiagramScopeKey(connectionId: string, database?: string) {
  return getERDRelationshipScopeKey(connectionId, database);
}

export function getCachedERDiagramSchema(connectionId: string, database?: string) {
  const scopeKey = getERDiagramScopeKey(connectionId, database);
  const cached = erDiagramSchemaCache.get(scopeKey);
  if (!cached) return null;

  if (Date.now() - cached.lastUsedAt > ER_DIAGRAM_CACHE_TTL_MS) {
    erDiagramSchemaCache.delete(scopeKey);
    return null;
  }

  cached.lastUsedAt = Date.now();
  erDiagramSchemaCache.set(scopeKey, cached);
  return cached.schema;
}

export function setCachedERDiagramSchema(
  connectionId: string,
  database: string | undefined,
  schema: ERDiagramSchema,
) {
  const scopeKey = getERDiagramScopeKey(connectionId, database);
  erDiagramSchemaCache.set(scopeKey, {
    schema,
    cachedAt: Date.now(),
    lastUsedAt: Date.now(),
  });
}

export function invalidateCachedERDiagramSchema(
  connectionId: string,
  database?: string,
) {
  const scopeKey = getERDiagramScopeKey(connectionId, database);
  erDiagramSchemaCache.delete(scopeKey);
}
