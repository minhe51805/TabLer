import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentToolExecutor } from "@/components/AISlidePanel/ai-agent-tool-executor";
import type { AIAgentToolAction } from "@/components/AISlidePanel/ai-agent-tools";
import { useConnectionStore } from "@/stores/connectionStore";
import type { DatabaseInfo } from "@/types";
import { mkDeps, runTool, tbl } from "./ai-agent-test-harness";

vi.mock("@/utils/semantic-glossary", () => ({
  saveSemanticGlossaryEntry: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/utils/tauri-utils", () => ({
  invokeMutation: vi.fn(),
}));
vi.mock("@/components/AISlidePanel/hooks/use-agent-memory", () => ({
  invalidateAgentMemoryIndex: vi.fn(),
  getAgentMemoryIndex: vi.fn(),
}));

const db = (name: string) => ({ name }) as DatabaseInfo;

const ORIGINAL_CONNECTION_STATE = useConnectionStore.getState();

function seedConnectionStore(options: {
  activeConnectionId?: string | null;
  databases?: DatabaseInfo[];
  currentDatabase?: string | null;
  switchImpl?: (connectionId: string, database: string) => Promise<void>;
}) {
  const switchDatabase = vi.fn().mockImplementation(
    options.switchImpl ??
      (async (_connectionId: string, database: string) => {
        useConnectionStore.setState({
          currentDatabase: database,
          tables: [tbl("audit_log", 3)],
        });
      }),
  );
  useConnectionStore.setState(ORIGINAL_CONNECTION_STATE, true);
  useConnectionStore.setState({
    activeConnectionId:
      options.activeConnectionId === undefined ? "conn-1" : options.activeConnectionId,
    connectedIds: new Set(["conn-1"]),
    databases: options.databases ?? [db("appdb"), db("analytics")],
    currentDatabase: options.currentDatabase === undefined ? "appdb" : options.currentDatabase,
    tables: [tbl("users")],
    switchDatabase,
  });
  return { switchDatabase };
}

beforeEach(() => {
  vi.clearAllMocks();
  seedConnectionStore({});
});

const switchTo = (database?: string) =>
  ({
    action: "switch_database",
    args: database === undefined ? {} : { database },
  }) as AIAgentToolAction;

describe("switch_database", () => {
  it("requires a database name", async () => {
    const obs = await runTool(mkDeps(), switchTo());
    expect(obs).toContain("Tool error");
    expect(obs).toContain("requires args.database");
  });

  it("requires an active connection", async () => {
    const obs = await runTool(mkDeps({ connectionId: null }), switchTo("analytics"));
    expect(obs).toContain("Tool error");
    expect(obs).toContain("requires an active connection");
  });

  it("refuses when the run's connection is no longer active", async () => {
    const { switchDatabase } = seedConnectionStore({ activeConnectionId: "conn-2" });
    const obs = await runTool(mkDeps(), switchTo("analytics"));
    expect(obs).toContain("Tool error");
    expect(obs).toContain("no longer the active one");
    expect(switchDatabase).not.toHaveBeenCalled();
  });

  it("rejects an unknown database and lists what exists", async () => {
    const obs = await runTool(mkDeps(), switchTo("missing-db"));
    expect(obs).toContain('database "missing-db" does not exist');
    expect(obs).toContain("appdb");
    expect(obs).toContain("analytics");
    expect(useConnectionStore.getState().switchDatabase).not.toHaveBeenCalled();
  });

  it("skips the existence check when the database list is not loaded", async () => {
    const { switchDatabase } = seedConnectionStore({ databases: [] });
    const obs = await runTool(mkDeps(), switchTo("anything-goes"));
    // Empty list = "not loaded yet" (per the handler contract), so the switch
    // is attempted instead of refused.
    expect(switchDatabase).toHaveBeenCalledTimes(1);
    expect(obs).toContain('Switched to database "anything-goes"');
  });

  it("no-ops politely when already on the target database", async () => {
    const { switchDatabase } = seedConnectionStore({});
    const obs = await runTool(mkDeps(), switchTo("appdb"));
    expect(obs).toContain('Already on database "appdb"');
    expect(switchDatabase).not.toHaveBeenCalled();
  });

  it("switches and clears the per-run read cache so stale catalog data cannot leak", async () => {
    const deps = mkDeps();
    const executor = createAgentToolExecutor(deps);
    const action = {
      action: "run_readonly_sql",
      args: { sql: "SELECT 1" },
    } as AIAgentToolAction;
    // Unbounded SELECT also fires an EXPLAIN preflight; count only the real
    // statement calls.
    const selectCalls = () =>
      vi.mocked(deps.executeReadonlyQuery).mock.calls.filter((call) => call[1]?.[0] === "SELECT 1")
        .length;

    await executor.runAgentTool(action);
    const cached = await executor.runAgentTool(action);
    expect(cached).toContain("[cached");
    expect(selectCalls()).toBe(1);

    const obs = await executor.runAgentTool(switchTo("analytics"));
    expect(obs).toContain('Switched to database "analytics"');

    const after = await executor.runAgentTool(action);
    expect(after).not.toContain("[cached");
    expect(selectCalls()).toBe(2);
  });
});
