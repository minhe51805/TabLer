import type { ColumnDetail, SchemaObjectInfo, TableInfo, TableStructure } from "../types";
import { splitSqlStatements } from "./sqlStatements";

export interface SchemaCacheScope {
  connectionId: string;
  database?: string | null;
}

interface VersionedEntry<T> {
  version: number;
  cachedAt: number;
  value: T;
}

const SCHEMA_CACHE_TTL_MS = 5 * 60 * 1000;
const versions = new Map<string, number>();
const tableEntries = new Map<string, VersionedEntry<TableInfo[]>>();
const objectEntries = new Map<string, VersionedEntry<SchemaObjectInfo[]>>();
const structureEntries = new Map<string, VersionedEntry<TableStructure>>();
const columnsEntries = new Map<string, VersionedEntry<ColumnDetail[]>>();
const inFlightLoads = new Map<string, Promise<unknown>>();

function scopeKey({ connectionId, database }: SchemaCacheScope) {
  return `${connectionId}|${database || ""}`;
}

function structureKey(scope: SchemaCacheScope, table: string) {
  return `${scopeKey(scope)}|${table}`;
}

function versionFor(scope: SchemaCacheScope) {
  return versions.get(scopeKey(scope)) ?? 0;
}

function isFresh<T>(entry: VersionedEntry<T> | undefined, scope: SchemaCacheScope) {
  return Boolean(
    entry
      && entry.version === versionFor(scope)
      && Date.now() - entry.cachedAt < SCHEMA_CACHE_TTL_MS,
  );
}

async function getOrLoad<T>(
  cache: Map<string, VersionedEntry<T>>,
  key: string,
  scope: SchemaCacheScope,
  loader: () => Promise<T>,
): Promise<T> {
  const cached = cache.get(key);
  if (isFresh(cached, scope)) return cached!.value;

  const loadKey = `${key}|v${versionFor(scope)}`;
  const pending = inFlightLoads.get(loadKey) as Promise<T> | undefined;
  if (pending) return pending;

  const requestedVersion = versionFor(scope);
  const request = loader()
    .then((value) => {
      // Do not let a slow request resurrect metadata invalidated while it was loading.
      if (versionFor(scope) === requestedVersion) {
        cache.set(key, { value, version: requestedVersion, cachedAt: Date.now() });
      }
      return value;
    })
    .finally(() => inFlightLoads.delete(loadKey));

  inFlightLoads.set(loadKey, request);
  return request;
}

export function getSchemaCacheVersion(scope: SchemaCacheScope) {
  return versionFor(scope);
}

export function getOrLoadSchemaTables(scope: SchemaCacheScope, loader: () => Promise<TableInfo[]>) {
  return getOrLoad(tableEntries, scopeKey(scope), scope, loader);
}

export function getOrLoadSchemaObjects(scope: SchemaCacheScope, loader: () => Promise<SchemaObjectInfo[]>) {
  return getOrLoad(objectEntries, scopeKey(scope), scope, loader);
}

export function getOrLoadTableStructure(
  scope: SchemaCacheScope,
  table: string,
  loader: () => Promise<TableStructure>,
) {
  return getOrLoad(structureEntries, structureKey(scope, table), scope, loader);
}

export function getOrLoadTableColumns(
  scope: SchemaCacheScope,
  table: string,
  loader: () => Promise<ColumnDetail[]>,
) {
  return getOrLoad(columnsEntries, structureKey(scope, table), scope, loader);
}

/**
 * Bumps every matching cache scope, so queued requests cannot restore stale
 * tables, objects, or structures after a schema mutation completes.
 */
export function invalidateSchemaCache(connectionId: string, database?: string | null) {
  const knownScopes = [
    ...versions.keys(),
    ...tableEntries.keys(),
    ...objectEntries.keys(),
    ...[...structureEntries.keys(), ...columnsEntries.keys()].map((key) => key.split("|").slice(0, 2).join("|")),
  ];
  const matchingScopes = knownScopes
    .filter((key, index, all) => all.indexOf(key) === index)
    .filter((key) => {
      const [cachedConnectionId, cachedDatabase] = key.split("|");
      return cachedConnectionId === connectionId && (database === undefined || cachedDatabase === (database || ""));
    });

  const scopes = matchingScopes.length > 0
    ? matchingScopes
    : [scopeKey({ connectionId, database })];

  for (const key of scopes) {
    versions.set(key, (versions.get(key) ?? 0) + 1);
    tableEntries.delete(key);
    objectEntries.delete(key);
    for (const structureCacheKey of structureEntries.keys()) {
      if (structureCacheKey.startsWith(`${key}|`)) structureEntries.delete(structureCacheKey);
    }
    for (const columnsCacheKey of columnsEntries.keys()) {
      if (columnsCacheKey.startsWith(`${key}|`)) columnsEntries.delete(columnsCacheKey);
    }
  }
}

/** Returns true only for statements that can change the schema metadata. */
export function containsSchemaMutation(sql: string) {
  return splitSqlStatements(sql).some((statement) => {
    const normalized = statement
      .replace(/^\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/\s*)+/g, "")
      .trim()
      .toUpperCase();
    return /^(CREATE|ALTER|DROP|TRUNCATE|RENAME|COMMENT\s+ON|GRANT|REVOKE)\b/.test(normalized);
  });
}

/** Test-only reset for deterministic cache fixtures. */
export function resetSchemaCacheForTests() {
  versions.clear();
  tableEntries.clear();
  objectEntries.clear();
  structureEntries.clear();
  columnsEntries.clear();
  inFlightLoads.clear();
}
