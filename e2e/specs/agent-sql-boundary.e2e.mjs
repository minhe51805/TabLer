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
    if (!flattenResultText(result).includes("2") && !flattenResultText(result).includes("smoke_count")) {
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
    const sql = engine === "postgresql"
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
});
