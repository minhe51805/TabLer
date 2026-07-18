import { browser, $ } from "@wdio/globals";

describe("TableR desktop workspace smoke", () => {
  const engine = process.env.TABLER_E2E_ENGINE === "postgresql" ? "postgresql" : "sqlite";
  const connectionId = `e2e-${engine}`;
  const readyText = engine === "postgresql" ? "PostgreSQL ready" : "SQLite ready";

  async function invoke(command, args = {}) {
    return browser.tauri.execute(
      (tauri, invokeCommand, invokeArgs) => tauri.core.invoke(invokeCommand, invokeArgs),
      command,
      args,
    );
  }

  it(`launches, connects, queries, and browses ${engine}`, async () => {
    const body = await $("body");
    await body.waitForDisplayed({ timeout: 30_000 });

    const status = await invoke("check_connection_status", { connectionId });
    if (!status) {
      await invoke("connect_saved_connection", { connectionId });
    }

    const tables = await invoke("list_tables", {
      connectionId,
      database: engine === "postgresql" ? "tabler_test" : null,
    });
    if (!Array.isArray(tables) || !tables.some((table) => table.name === "smoke_items")) {
      throw new Error(`smoke_items was not discovered: ${JSON.stringify(tables)}`);
    }

    const browsed = await invoke("get_table_data", {
      connectionId,
      table: "smoke_items",
      database: engine === "postgresql" ? "tabler_test" : null,
      offset: 0,
      limit: 10,
      orderBy: "id",
      orderDir: "ASC",
      filter: null,
    });
    const browsedText = JSON.stringify(browsed);
    if (!browsedText.includes(readyText) || !browsedText.includes("desktop smoke")) {
      throw new Error(`Unexpected browse result: ${browsedText}`);
    }

    const query = await invoke("execute_query", {
      connectionId,
      sql: "SELECT COUNT(*) AS smoke_count FROM smoke_items;",
    });
    const queryText = JSON.stringify(query);
    if (!queryText.includes("smoke_count") || !queryText.includes("2")) {
      throw new Error(`Unexpected count query result: ${queryText}`);
    }
  });
});
