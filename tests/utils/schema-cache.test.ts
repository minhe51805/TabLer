import { afterEach, describe, expect, it } from "vitest";
import {
  containsSchemaMutation,
  getOrLoadSchemaTables,
  getSchemaCacheVersion,
  invalidateSchemaCache,
  resetSchemaCacheForTests,
} from "@/utils/schema-cache";

const scope = { connectionId: "connection-1", database: "app" };

afterEach(() => resetSchemaCacheForTests());

describe("schema cache", () => {
  it("deduplicates metadata reads within the current schema version", async () => {
    let calls = 0;
    const load = async () => {
      calls += 1;
      return [{ name: "orders", table_type: "TABLE" }];
    };

    await Promise.all([getOrLoadSchemaTables(scope, load), getOrLoadSchemaTables(scope, load)]);
    expect(calls).toBe(1);
    expect(await getOrLoadSchemaTables(scope, load)).toHaveLength(1);
    expect(calls).toBe(1);
  });

  it("bumps a schema version and forces a fresh metadata read after invalidation", async () => {
    let calls = 0;
    const load = async () => [{ name: `orders_${++calls}`, table_type: "TABLE" }];

    await getOrLoadSchemaTables(scope, load);
    invalidateSchemaCache(scope.connectionId, scope.database);

    expect(getSchemaCacheVersion(scope)).toBe(1);
    await expect(getOrLoadSchemaTables(scope, load)).resolves.toEqual([{ name: "orders_2", table_type: "TABLE" }]);
  });
});

describe("containsSchemaMutation", () => {
  it("detects DDL and skips read/write data statements", () => {
    expect(containsSchemaMutation("SELECT * FROM orders; ALTER TABLE orders ADD COLUMN note text")).toBe(true);
    expect(containsSchemaMutation("-- maintenance\nDROP INDEX order_created_idx")).toBe(true);
    expect(containsSchemaMutation("UPDATE orders SET status = 'paid'")).toBe(false);
    expect(containsSchemaMutation("SELECT 'CREATE TABLE example' AS text")).toBe(false);
  });
});
