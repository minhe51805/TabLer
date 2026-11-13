import { browser, $ } from "@wdio/globals";
import {
  connectionConfig,
  connectionId,
  engine,
  expectRejected,
  flattenResultText,
  invoke,
  setSafeMode,
  waitForApp,
} from "../helpers.mjs";

describe("AI agent SQL boundary", () => {
  before(async () => {
    await waitForApp();
    await invoke("connect_database", { config: connectionConfig() });
    await setSafeMode(1);
  });

  after(async () => {
    try {
      await setSafeMode(0);
    } catch {
      // Policy reset is best-effort.
    }
    try {
      await invoke("disconnect_database", { connectionId });
    } catch {
      // Ignore a session that is already gone.
    }
  });

  it("reports a SQL queryModel for the connected engine", async () => {
    const profile = await invoke("get_connection_capabilities", { connectionId });
    if (profile?.queryModel !== "sql") {
      throw new Error(`Expected queryModel=sql on ${engine}, got ${JSON.stringify(profile)}`);
    }
    if (profile?.key !== engine) {
      throw new Error(`Expected capability key ${engine}, got ${profile?.key}`);
    }
  });

  it("execute_agent_readonly_query runs SELECT and marks the result sandboxed", async () => {
    const result = await invoke("execute_agent_readonly_query", {
      connectionId,
      statements: ["SELECT COUNT(*) AS smoke_count FROM smoke_items"],
      requestId: "e2e-agent-readonly-ok",
    });
    if (result?.sandboxed !== true) {
      throw new Error(`Expected sandboxed=true, got ${JSON.stringify(result)}`);
    }
    if (
      !flattenResultText(result).includes("2") &&
      !flattenResultText(result).includes("smoke_count")
    ) {
      throw new Error(`Expected a SELECT result, got ${flattenResultText(result)}`);
    }
  });

  it("rejects UPDATE even if the caller also sends requireReadOnly=false", async () => {
    await expectRejected(
      invoke("execute_agent_readonly_query", {
        connectionId,
        statements: ["UPDATE smoke_items SET label = 'hacked' WHERE id = 1"],
        requireReadOnly: false,
      }),
      "read-only",
    );

    const stillThere = await invoke("execute_query", {
      connectionId,
      sql: "SELECT label FROM smoke_items WHERE id = 1;",
    });
    if (flattenResultText(stillThere).includes("hacked")) {
      throw new Error("Agent readonly command must not persist an UPDATE");
    }
  });

  it("rejects DELETE and DDL", async () => {
    await expectRejected(
      invoke("execute_agent_readonly_query", {
        connectionId,
        statements: ["DELETE FROM smoke_items WHERE id = 1"],
      }),
      "read-only",
    );
    await expectRejected(
      invoke("execute_agent_readonly_query", {
        connectionId,
        statements: ["DROP TABLE smoke_items"],
      }),
      "read-only",
    );
  });

  it("rejects mutating SQL that is shaped like a SELECT", async () => {
    const sql =
      engine === "postgresql"
        ? "WITH changed AS (DELETE FROM smoke_items RETURNING id) SELECT * FROM changed"
        : "WITH changed AS (SELECT id FROM smoke_items) DELETE FROM smoke_items WHERE id IN (SELECT id FROM changed)";
    await expectRejected(
      invoke("execute_agent_readonly_query", {
        connectionId,
        statements: [sql],
      }),
      "read-only",
    );
  });

  it("returns structured AppError JSON over raw window.__TAURI__.core.invoke", async () => {
    const rawError = await browser.execute(async (invokeConnectionId) => {
      const tauri = window.__TAURI__;
      if (!tauri?.core?.invoke) {
        return { missingTauri: true };
      }
      try {
        await tauri.core.invoke("execute_agent_readonly_query", {
          connectionId: invokeConnectionId,
          statements: ["DROP TABLE smoke_items"],
        });
        return { unexpectedlySucceeded: true };
      } catch (error) {
        return {
          typeOf: typeof error,
          code: error?.code ?? null,
          message: error?.message ?? null,
          retryable: error?.retryable ?? null,
        };
      }
    }, connectionId);

    if (rawError?.missingTauri) {
      throw new Error("window.__TAURI__.core.invoke is unavailable");
    }
    if (rawError?.unexpectedlySucceeded) {
      throw new Error("Expected execute_agent_readonly_query to reject DDL");
    }
    if (rawError?.typeOf !== "object") {
      throw new Error(`Expected structured AppError object, got ${JSON.stringify(rawError)}`);
    }
    if (typeof rawError.code !== "string" || rawError.code.length === 0) {
      throw new Error(`Expected non-empty AppError.code, got ${JSON.stringify(rawError)}`);
    }
    if (
      typeof rawError.message !== "string" ||
      !rawError.message.toLowerCase().includes("read-only")
    ) {
      throw new Error(`Expected read-only AppError.message, got ${JSON.stringify(rawError)}`);
    }
    if (typeof rawError.retryable !== "boolean") {
      throw new Error(`Expected boolean AppError.retryable, got ${JSON.stringify(rawError)}`);
    }
  });

  it("caps execute_sandboxed_query rows when maxRows is set while leaving workspace queries uncapped", async () => {
    const tenRowSql =
      engine === "postgresql"
        ? "SELECT gs AS x FROM generate_series(1, 10) AS gs"
        : engine === "mssql"
          ? "WITH seq(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM seq WHERE x < 10) SELECT x FROM seq"
          : "WITH RECURSIVE seq(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM seq WHERE x < 10) SELECT x FROM seq";

    const capped = await invoke("execute_sandboxed_query", {
      connectionId,
      statements: [tenRowSql],
      requireReadOnly: true,
      maxRows: 3,
      requestId: `e2e-sandbox-capped-${Date.now()}`,
    });
    const uncapped = await invoke("execute_sandboxed_query", {
      connectionId,
      statements: [tenRowSql],
      requireReadOnly: true,
      requestId: `e2e-sandbox-uncapped-${Date.now()}`,
    });

    if (!Array.isArray(capped?.rows) || capped.rows.length > 3 || capped.rows.length === 0) {
      throw new Error(`Expected 1..3 rows with maxRows=3, got ${JSON.stringify(capped)}`);
    }
    if (!Array.isArray(uncapped?.rows) || uncapped.rows.length !== 10) {
      throw new Error(`Expected 10 rows when maxRows is omitted, got ${JSON.stringify(uncapped)}`);
    }
  });

  it("opens real AISlidePanel in WebView2, filters slash commands with /backup, and closes cleanly on Escape", async function () {
    this.timeout(120_000);
    await invoke("disconnect_database", { connectionId });
    await invoke("connect_saved_connection", { connectionId });
    await browser.execute(() => window.location.reload());
    await waitForApp();
    await browser.setWindowSize(1280, 900);

    const skip = await $("button.onboarding-skip");
    if (await skip.isDisplayed()) {
      await skip.click();
      await $(".onboarding-tour").waitForDisplayed({ timeout: 5_000, reverse: true });
    }

    const openConnection = await $(
      `[data-testid="connection-${connectionId}"] .startup-connection-open`,
    );
    await browser.waitUntil(
      async () =>
        (await $('[data-testid="database-current"]').isDisplayed()) ||
        (await openConnection.isDisplayed()),
      { timeout: 30_000, interval: 200 },
    );
    if (!(await $('[data-testid="database-current"]').isDisplayed())) {
      await openConnection.click();
    }
    await $('[data-testid="database-current"]').waitForDisplayed({ timeout: 30_000 });

    const trigger = await $('[data-tour="ai-trigger"]');
    await trigger.waitForDisplayed({ timeout: 10_000 });
    await trigger.click();

    const composer = await $(".ai-workspace-composer-textarea");
    await composer.waitForDisplayed({ timeout: 10_000 });
    await composer.click();
    await composer.setValue("/backup");

    const slashMenu = await $('[role="listbox"]');
    await slashMenu.waitForDisplayed({ timeout: 10_000 });
    const slashText = await slashMenu.getText();
    if (!slashText.toLowerCase().includes("backup")) {
      throw new Error(`Expected /backup option in slash listbox, got: ${slashText}`);
    }

    await browser.keys("Escape");
    await slashMenu.waitForDisplayed({ timeout: 5_000, reverse: true });
    if (await composer.isDisplayed()) {
      await browser.keys("Escape");
    }
    await composer.waitForDisplayed({ timeout: 5_000, reverse: true });
  });
});
