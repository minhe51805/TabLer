import { describe, expect, it } from "vitest";
import {
  createWorkspaceBundle,
  isSafeWorkspaceQuery,
  parseWorkspaceBundle,
} from "../../src/utils/workspace-bundle";
import type { MetricsBoardDefinition, Tab } from "../../src/types";

const queryTab: Tab = {
  id: "query-1",
  type: "query",
  title: "Orders",
  connectionId: "connection-1",
  database: "workspace",
  content: "SELECT * FROM orders",
};

const dashboard: MetricsBoardDefinition = {
  id: "board-1",
  name: "Orders overview",
  connection_id: "connection-1",
  database: "workspace",
  created_at: 1,
  updated_at: 1,
  widgets: [
    {
      id: "widget-safe",
      type: "scoreboard",
      title: "Total orders",
      query: "SELECT count(*) AS total FROM orders",
      refresh_seconds: 15,
      col_span: 3,
      row_span: 3,
      grid_x: 0,
      grid_y: 0,
    },
    {
      id: "widget-unsafe",
      type: "scoreboard",
      title: "Never export",
      query: "DELETE FROM orders",
      refresh_seconds: 15,
      col_span: 3,
      row_span: 3,
      grid_x: 3,
      grid_y: 0,
    },
  ],
};

describe("workspace bundles", () => {
  it("keeps layouts and only includes safe read-only SQL", () => {
    const bundle = createWorkspaceBundle({
      databaseType: "postgresql",
      database: "workspace",
      tabs: [
        queryTab,
        { ...queryTab, id: "unsafe", content: "DROP TABLE orders" },
      ],
      dashboards: [dashboard],
      erRelationships: [
        {
          id: "relationship",
          fromTable: "orders",
          fromColumn: "customer_id",
          toTable: "customers",
          toColumn: "id",
          isCustom: true,
        },
      ],
      layout: {
        sidebarCollapsed: false,
        sidebarWidth: 348,
        leftPanel: "metrics",
      },
    });

    expect(bundle.version).toBe(2);
    expect(bundle.queries).toMatchObject([
      { id: "query-1", title: "Orders", database: "workspace", sql: "SELECT * FROM orders" },
    ]);
    expect(bundle.dashboards[0].widgets.map((widget) => widget.id)).toEqual([
      "widget-safe",
    ]);
    expect(bundle.layout).toEqual({
      sidebarCollapsed: false,
      sidebarWidth: 348,
      leftPanel: "metrics",
    });
    expect(bundle.erViews[0].relationships).toHaveLength(1);
    expect(JSON.stringify(bundle)).not.toContain("connection-1");
  });

  it("includes shareable connection metadata but never credentials", () => {
    const bundle = createWorkspaceBundle({
      connection: {
        id: "connection-1",
        name: "Production read replica",
        db_type: "postgresql",
        host: "db.example.test",
        port: 5432,
        username: "admin",
        password: "never-sync-this",
        database: "app",
        use_ssl: true,
      },
      databaseType: "postgresql",
      database: "app",
      tabs: [],
      dashboards: [],
      erRelationships: [],
      layout: { sidebarCollapsed: false, sidebarWidth: 320, leftPanel: "database" },
    });
    expect(bundle.connections[0]).toMatchObject({
      id: "connection-1",
      name: "Production read replica",
      host: "db.example.test",
    });
    expect(JSON.stringify(bundle)).not.toContain("admin");
    expect(JSON.stringify(bundle)).not.toContain("never-sync-this");
  });

  it("rejects unsupported files and strips unsafe imported entries", () => {
    expect(() =>
      parseWorkspaceBundle('{"format":"other","version":1}'),
    ).toThrow("not a supported");

    const imported = parseWorkspaceBundle(
      JSON.stringify({
        format: "tabler-workspace",
        version: 1,
        target: { databaseType: "sqlite" },
        layout: {
          sidebarCollapsed: false,
          sidebarWidth: 1000,
          leftPanel: "unknown",
        },
        queries: [
          { title: "safe", sql: "SHOW TABLES" },
          { title: "unsafe", sql: "UPDATE users SET admin = true" },
        ],
        dashboards: [dashboard],
        erViews: [],
      }),
    );

    expect(imported.queries.map((query) => query.title)).toEqual(["safe"]);
    expect(imported.dashboards[0].widgets.map((widget) => widget.id)).toEqual([
      "widget-safe",
    ]);
    expect(imported.layout).toEqual({
      sidebarCollapsed: false,
      sidebarWidth: 560,
      leftPanel: "database",
    });
  });

  it("recognizes read-only statements without accepting write CTEs", () => {
    expect(
      isSafeWorkspaceQuery("/* review */ EXPLAIN SELECT * FROM orders"),
    ).toBe(true);
    expect(
      isSafeWorkspaceQuery(
        "WITH changed AS (DELETE FROM orders RETURNING id) SELECT * FROM changed",
      ),
    ).toBe(false);
    expect(isSafeWorkspaceQuery("SELECT 1; SELECT 2")).toBe(false);
  });
});
