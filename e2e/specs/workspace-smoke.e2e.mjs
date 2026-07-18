import { browser, $ } from "@wdio/globals";
import path from "node:path";

describe("TableR desktop workspace smoke", () => {
  const engine = process.env.TABLER_E2E_ENGINE === "postgresql" ? "postgresql" : "sqlite";
  const connectionId = `e2e-${engine}`;
  const readyText = engine === "postgresql" ? "PostgreSQL ready" : "SQLite ready";

  function connectionConfig() {
    const common = {
      id: connectionId,
      name: `E2E ${engine}`,
      db_type: engine,
      host: null,
      port: null,
      username: null,
      password: null,
      database: null,
      file_path: null,
      use_ssl: false,
      ssl_mode: null,
      ssl_ca_cert_path: null,
      ssl_client_cert_path: null,
      ssl_client_key_path: null,
      ssl_skip_host_verification: null,
      color: engine === "postgresql" ? "#336791" : "#3498db",
      additional_fields: {},
      pre_connect_script: null,
      startup_commands: null,
      ssh_config: null,
    };
    if (engine === "postgresql") {
      return {
        ...common,
        host: process.env.TABLER_E2E_POSTGRES_HOST ?? "127.0.0.1",
        port: Number(process.env.TABLER_E2E_POSTGRES_PORT ?? "5432"),
        username: process.env.TABLER_E2E_POSTGRES_USER ?? "tabler",
        password: process.env.TABLER_E2E_POSTGRES_PASSWORD ?? "",
        database: process.env.TABLER_E2E_POSTGRES_DATABASE ?? "tabler_test",
        ssl_mode: "disable",
      };
    }
    const dataDir = process.env.TABLER_E2E_DATA_DIR;
    if (!dataDir) throw new Error("TABLER_E2E_DATA_DIR is required for SQLite smoke tests.");
    return {
      ...common,
      file_path: path.join(dataDir, "smoke.sqlite"),
    };
  }

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

    await invoke("connect_database", { config: connectionConfig() });
    await invoke("disconnect_database", { connectionId });
    await invoke("connect_saved_connection", { connectionId });

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
