import { browser } from "@wdio/globals";
import {
  connectionConfig,
  connectionId,
  engine,
  expectRejected,
  fixtureDatabase,
  flattenResultText,
  invoke,
  setSafeMode,
  waitForApp,
} from "../helpers.mjs";

describe("TableR reliability contract", () => {
  before(async () => {
    await waitForApp();
    await invoke("connect_database", { config: connectionConfig() });
    await setSafeMode(1);
  });

  after(async () => {
    try {
      await setSafeMode(0);
      await invoke("execute_query", {
        connectionId,
        sql: "DELETE FROM smoke_items WHERE id > 2;",
      });
    } catch {
      // Fixture cleanup is best-effort if the session already dropped.
    }
    try {
      await invoke("disconnect_database", { connectionId });
    } catch {
      // Ignore a session that is already gone.
    }
  });

  describe("backend Safe Mode", () => {
    it("blocks writes at level 1 through execute_query, sandbox, and parameterized paths", async () => {
      await setSafeMode(1);

      await expectRejected(
        invoke("execute_query", {
          connectionId,
          sql: "DELETE FROM smoke_items WHERE id = 1;",
        }),
        "Safe Mode level 1",
      );

      await expectRejected(
        invoke("execute_sandboxed_query", {
          connectionId,
          statements: ["INSERT INTO smoke_items (id, label) VALUES (99, 'blocked')"],
        }),
        "Safe Mode level 1",
      );

      await expectRejected(
        invoke("execute_parameterized_query", {
          connectionId,
          sql: "UPDATE smoke_items SET label = :label WHERE id = :id",
          parameters: [
            { name: "label", value: "nope", dataType: "text" },
            { name: "id", value: 1, dataType: "integer" },
          ],
        }),
        "Safe Mode level 1",
      );

      const stillThere = await invoke("execute_query", {
        connectionId,
        sql: "SELECT COUNT(*) AS smoke_count FROM smoke_items;",
      });
      if (!flattenResultText(stillThere).includes("2")) {
        throw new Error(`Safe Mode 1 must not mutate fixture rows: ${flattenResultText(stillThere)}`);
      }
    });

    it("blocks mutating CTEs that prefix-based frontend regex used to allow", async () => {
      await setSafeMode(1);
      const sql = engine === "postgresql"
        ? "WITH changed AS (DELETE FROM smoke_items RETURNING id) SELECT * FROM changed;"
        : "WITH changed AS (SELECT id FROM smoke_items) DELETE FROM smoke_items WHERE id IN (SELECT id FROM changed);";

      await expectRejected(
        invoke("execute_query", { connectionId, sql }),
        "Safe Mode",
      );
    });

    it("allows SELECT at level 1 and writes only after policy is lowered", async () => {
      await setSafeMode(1);
      const allowed = await invoke("execute_query", {
        connectionId,
        sql: "SELECT label FROM smoke_items WHERE id = 1;",
      });
      if (!flattenResultText(allowed).includes("ready")) {
        throw new Error(`Expected a fixture label, got ${flattenResultText(allowed)}`);
      }

      await setSafeMode(0);
      await invoke("execute_query", {
        connectionId,
        sql: "INSERT INTO smoke_items (id, label) VALUES (3, 'temp-write');",
      });
      await invoke("execute_query", {
        connectionId,
        sql: "DELETE FROM smoke_items WHERE id = 3;",
      });
      await setSafeMode(1);
    });
  });

  describe("parameterized queries", () => {
    it("binds :name parameters using the engine DatabaseType, not the driver display name", async () => {
      await setSafeMode(1);
      const result = await invoke("execute_parameterized_query", {
        connectionId,
        sql: "SELECT label FROM smoke_items WHERE id = :id",
        parameters: [{ name: "id", value: 2, dataType: "integer" }],
      });
      const text = flattenResultText(result);
      if (!text.includes("desktop smoke")) {
        throw new Error(`Parameterized :id lookup failed (${engine}): ${text}`);
      }
      if (text.includes("SQLite ready") && engine === "postgresql") {
        throw new Error(`PostgreSQL parameterized query returned the SQLite fixture: ${text}`);
      }
    });
  });

  describe("sandbox request id and cancel", () => {
    it("runs sandboxed SELECT with a request id and marks the result sandboxed", async () => {
      await setSafeMode(1);
      const result = await invoke("execute_sandboxed_query", {
        connectionId,
        statements: ["SELECT COUNT(*) AS smoke_count FROM smoke_items"],
        requestId: "e2e-sandbox-ok",
        requireReadOnly: true,
      });
      if (result?.sandboxed !== true) {
        throw new Error(`Expected sandboxed=true, got ${JSON.stringify(result)}`);
      }
      if (!flattenResultText(result).includes("2")) {
        throw new Error(`Unexpected sandbox count: ${flattenResultText(result)}`);
      }
    });

    it("cancels an in-flight sandbox query via requestId", async () => {
      await setSafeMode(1);
      const requestId = `e2e-cancel-${Date.now()}`;
      const slowSql = engine === "postgresql"
        ? "SELECT pg_sleep(20);"
        : "WITH RECURSIVE t(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM t WHERE x < 50000000) SELECT COUNT(*) FROM t;";

      // WDIO IPC is serialized; cancel must run inside the webview alongside the query.
      const outcome = await browser.execute(async (invokeConnectionId, invokeRequestId, sql) => {
        const tauri = window.__TAURI__;
        if (!tauri?.core?.invoke) {
          return { error: "window.__TAURI__.core.invoke is unavailable" };
        }
        const pending = tauri.core.invoke("execute_sandboxed_query", {
          connectionId: invokeConnectionId,
          statements: [sql],
          requestId: invokeRequestId,
        });
        await new Promise((resolve) => setTimeout(resolve, 250));
        let cancelled = false;
        for (let attempt = 0; attempt < 40; attempt += 1) {
          cancelled = Boolean(await tauri.core.invoke("cancel_query", { requestId: invokeRequestId }));
          if (cancelled) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        let queryError = null;
        try {
          await pending;
        } catch (error) {
          queryError = String(error?.message ?? error);
        }
        return { cancelled, queryError };
      }, connectionId, requestId, slowSql);

      if (outcome?.error) {
        throw new Error(outcome.error);
      }
      if (!outcome?.cancelled) {
        throw new Error(`cancel_query never reported an active sandbox request: ${JSON.stringify(outcome)}`);
      }
      if (!String(outcome.queryError ?? "").toLowerCase().includes("cancel")) {
        throw new Error(`Expected cancelled query error, got: ${JSON.stringify(outcome)}`);
      }
    });
  });

  describe("get_table_data paging", () => {
    it("returns more than 500 rows when the caller asks for a larger page", async () => {
      await setSafeMode(0);
      const padSql = engine === "postgresql"
        ? "INSERT INTO smoke_items (id, label) SELECT gs, 'pad-' || gs FROM generate_series(3, 620) AS gs;"
        : "WITH RECURSIVE seq(x) AS (SELECT 3 UNION ALL SELECT x + 1 FROM seq WHERE x < 620) INSERT INTO smoke_items (id, label) SELECT x, 'pad-' || x FROM seq;";
      await invoke("execute_query", { connectionId, sql: padSql });

      const page = await invoke("get_table_data", {
        connectionId,
        table: "smoke_items",
        database: fixtureDatabase,
        offset: 0,
        limit: 600,
        orderBy: "id",
        orderDir: "ASC",
        filter: null,
      });
      const rowCount = Array.isArray(page?.rows) ? page.rows.length : 0;
      if (rowCount < 600) {
        throw new Error(
          `get_table_data still appears capped (got ${rowCount} rows, truncated=${page?.truncated}).`,
        );
      }

      await invoke("execute_query", {
        connectionId,
        sql: "DELETE FROM smoke_items WHERE id > 2;",
      });
      await setSafeMode(1);
    });
  });

  describe("saved connection serde", () => {
    it("accepts camelCase startupCommands and verify_ca ssl_mode on connect", async () => {
      await setSafeMode(1);
      const config = connectionConfig({
        ssl_mode: engine === "sqlite" ? "verify_ca" : "disable",
      });
      delete config.startup_commands;
      config.startupCommands = "SELECT 1;";
      await invoke("connect_database", { config, requestId: `e2e-serde-${Date.now()}` });

      const saved = await invoke("get_saved_connections");
      const profile = Array.isArray(saved)
        ? saved.find((item) => item.id === connectionId)
        : null;
      if (!profile) {
        throw new Error(`Saved profile ${connectionId} was missing: ${JSON.stringify(saved)}`);
      }
      const startup = profile.startup_commands ?? profile.startupCommands;
      if (startup !== "SELECT 1;") {
        throw new Error(`startupCommands did not persist: ${JSON.stringify(profile)}`);
      }
      if (engine === "sqlite") {
        const sslMode = profile.ssl_mode ?? profile.sslMode;
        if (sslMode !== "verify_ca") {
          throw new Error(`ssl_mode verify_ca did not persist: ${JSON.stringify(profile)}`);
        }
      }
    });
  });

  describe("disconnect", () => {
    it("drops the live session so later queries require reconnect", async () => {
      await invoke("disconnect_database", { connectionId });
      await expectRejected(
        invoke("execute_query", {
          connectionId,
          sql: "SELECT 1;",
        }),
        "connect",
      );
      await invoke("connect_saved_connection", {
        connectionId,
        requestId: `e2e-reconnect-${Date.now()}`,
      });
      await setSafeMode(1);
    });
  });

  describe("PostgreSQL catalog switch", () => {
    const pgOnly = engine === "postgresql" ? it : it.skip;

    pgOnly("reconnects the pool so queries hit the newly selected database", async () => {
      await setSafeMode(1);
      const otherDatabase = fixtureDatabase === "postgres" ? "template1" : "postgres";

      await invoke("use_database", { connectionId, database: otherDatabase });
      const foreignTables = await invoke("list_tables", {
        connectionId,
        database: otherDatabase,
      });
      if (Array.isArray(foreignTables) && foreignTables.some((table) => table.name === "smoke_items")) {
        throw new Error(`smoke_items leaked into ${otherDatabase}: ${JSON.stringify(foreignTables)}`);
      }

      await expectRejected(
        invoke("execute_query", {
          connectionId,
          sql: "SELECT COUNT(*) FROM smoke_items;",
        }),
        "smoke_items",
      );

      await invoke("use_database", { connectionId, database: fixtureDatabase });
      const restored = await invoke("execute_query", {
        connectionId,
        sql: "SELECT COUNT(*) AS smoke_count FROM smoke_items;",
      });
      if (!flattenResultText(restored).includes("2")) {
        throw new Error(`Catalog switch did not restore ${fixtureDatabase}: ${flattenResultText(restored)}`);
      }
    });
  });

  describe("out of fixture scope", () => {
    it.skip("MSSQL inline edits bind @P1 instead of interpolating N'…' (no SQL Server E2E fixture)", () => {
      // Covered by the MssqlDriver execute_bound path; requires a live TDS server.
    });
  });
});
