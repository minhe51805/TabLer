import { browser, $ } from "@wdio/globals";
import path from "node:path";

export const engine = process.env.TABLER_E2E_ENGINE === "postgresql" ? "postgresql" : "sqlite";
export const connectionId = `e2e-${engine}`;
export const fixtureDatabase = engine === "postgresql"
  ? (process.env.TABLER_E2E_POSTGRES_DATABASE ?? "tabler_test")
  : null;

export function connectionConfig(overrides = {}) {
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
    ...overrides,
  };
  if (engine === "postgresql") {
    return {
      ...common,
      host: process.env.TABLER_E2E_POSTGRES_HOST ?? "127.0.0.1",
      port: Number(process.env.TABLER_E2E_POSTGRES_PORT ?? "5432"),
      username: process.env.TABLER_E2E_POSTGRES_USER ?? "tabler",
      password: process.env.TABLER_E2E_POSTGRES_PASSWORD ?? "",
      database: fixtureDatabase,
      ssl_mode: overrides.ssl_mode ?? "disable",
    };
  }
  const dataDir = process.env.TABLER_E2E_DATA_DIR;
  if (!dataDir) throw new Error("TABLER_E2E_DATA_DIR is required for SQLite smoke tests.");
  return {
    ...common,
    file_path: path.join(dataDir, "smoke.sqlite"),
  };
}

export async function invoke(command, args = {}) {
  return browser.tauri.execute(
    (tauri, invokeCommand, invokeArgs) => tauri.core.invoke(invokeCommand, invokeArgs),
    command,
    args,
  );
}

export async function waitForApp() {
  const body = await $("body");
  await body.waitForDisplayed({ timeout: 30_000 });
}

export async function setSafeMode(globalLevel, extras = {}) {
  await invoke("set_safe_mode_policy", {
    globalLevel,
    connectionOverrides: extras.connectionOverrides ?? [],
    productionConnectionIds: extras.productionConnectionIds ?? [],
  });
}

export async function expectRejected(promise, substring) {
  try {
    const result = await promise;
    throw new Error(`Expected a rejection, got ${JSON.stringify(result)}`);
  } catch (error) {
    const message = String(error?.message ?? error);
    if (message.startsWith("Expected a rejection")) throw error;
    if (substring && !message.toLowerCase().includes(String(substring).toLowerCase())) {
      throw new Error(`Expected error containing "${substring}", got: ${message}`);
    }
    return message;
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function flattenResultText(result) {
  return JSON.stringify(result);
}
