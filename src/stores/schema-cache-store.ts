/**
 * Schema Cache Store — persists schema metadata per connection to avoid repeated queries.
 * Used by SQL autocomplete and other schema-dependent features.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface SchemaTable {
  name: string;
  schema?: string;
  type: "table" | "view" | "materialized_view";
}

export interface SchemaColumn {
  name: string;
  data_type: string;
  is_nullable: boolean;
  is_primary_key: boolean;
  default_value?: string;
}

export interface SchemaEntry {
  tables: SchemaTable[];
  columns: Record<string, SchemaColumn[]>; // keyed by "schema.table" or just "table"
  functions: string[]; // function names for this database type
  timestamp: number;
}

interface SchemaCacheState {
  /** Schema data keyed by `${connectionId}:${database}` */
  schemas: Record<string, SchemaEntry>;
  /** Loading state per schema key */
  loading: Record<string, boolean>;
}

interface SchemaCacheActions {
  /** Get cached schema entry */
  getSchema: (connectionId: string, database: string) => SchemaEntry | undefined;
  /** Set schema entry after fetch */
  setSchema: (connectionId: string, database: string, entry: SchemaEntry) => void;
  /** Check if schema is cached and fresh (within TTL) */
  isSchemaCached: (connectionId: string, database: string, ttlMs?: number) => boolean;
  /** Mark schema as loading */
  setLoading: (connectionId: string, database: string, loading: boolean) => void;
  /** Clear schema cache for a connection */
  clearConnection: (connectionId: string) => void;
  /** Get all table names for a schema */
  getTableNames: (connectionId: string, database: string) => string[];
  /** Get columns for a specific table */
  getTableColumns: (connectionId: string, database: string, tableName: string) => SchemaColumn[];
  /** Get functions for a database type */
  getFunctions: (connectionId: string, database: string) => string[];
}

const DEFAULT_TTL_MS = 300_000; // 5 minutes

export const useSchemaCacheStore = create<SchemaCacheState & SchemaCacheActions>()(
  persist(
    (set, get) => ({
      schemas: {},
      loading: {},

      getSchema: (connectionId, database) => {
        const key = `${connectionId}:${database}`;
        return get().schemas[key];
      },

      setSchema: (connectionId, database, entry) => {
        const key = `${connectionId}:${database}`;
        set((s) => ({
          schemas: { ...s.schemas, [key]: entry },
        }));
      },

      isSchemaCached: (connectionId, database, ttlMs = DEFAULT_TTL_MS) => {
        const entry = get().schemas[`${connectionId}:${database}`];
        if (!entry) return false;
        return Date.now() - entry.timestamp < ttlMs;
      },

      setLoading: (connectionId, database, loading) => {
        const key = `${connectionId}:${database}`;
        set((s) => ({
          loading: { ...s.loading, [key]: loading },
        }));
      },

      clearConnection: (connectionId) => {
        const state = get();
        const newSchemas = { ...state.schemas };
        const newLoading = { ...state.loading };
        for (const key of Object.keys(newSchemas)) {
          if (key.startsWith(`${connectionId}:`)) {
            delete newSchemas[key];
            delete newLoading[key];
          }
        }
        set({ schemas: newSchemas, loading: newLoading });
      },

      getTableNames: (connectionId, database) => {
        const entry = get().schemas[`${connectionId}:${database}`];
        if (!entry) return [];
        return entry.tables.map((t) => (t.schema ? `${t.schema}.${t.name}` : t.name));
      },

      getTableColumns: (connectionId, database, tableName) => {
        const entry = get().schemas[`${connectionId}:${database}`];
        if (!entry) return [];
        // Try full key first, then just table name
        return entry.columns[tableName] ?? entry.columns[tableName.split(".").pop() ?? ""] ?? [];
      },

      getFunctions: (connectionId, database) => {
        const entry = get().schemas[`${connectionId}:${database}`];
        return entry?.functions ?? [];
      },
    }),
    {
      name: "tabler.schema-cache",
      partialize: (state) => ({ schemas: state.schemas }),
    },
  ),
);