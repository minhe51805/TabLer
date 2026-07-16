import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeMutation = vi.fn();
const invokeWithTimeout = vi.fn();

vi.mock("../../src/utils/tauri-utils", () => ({
  invokeMutation: (...args: unknown[]) => invokeMutation(...args),
  invokeWithTimeout: (...args: unknown[]) => invokeWithTimeout(...args),
}));

import {
  buildPersistableTabs,
  saveTabState,
  MAX_PERSISTABLE_CONTENT_LENGTH,
  restoreTabSnapshot,
} from "../../src/utils/tab-persistence";
import type { Tab } from "../../src/types";

function makeTab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: "tab-1",
    type: "query",
    title: "Query 1",
    connectionId: "conn-1",
    content: "SELECT 1",
    ...overrides,
  };
}

describe("buildPersistableTabs", () => {
  it("keeps content under the cap intact", () => {
    const tab = makeTab({ content: "SELECT * FROM users" });
    const [persisted] = buildPersistableTabs([tab], "tab-1");
    expect(persisted.content).toBe("SELECT * FROM users");
    expect(persisted.isActive).toBe(true);
  });

  it("drops content that exceeds the persistence cap", () => {
    const huge = "x".repeat(MAX_PERSISTABLE_CONTENT_LENGTH + 1);
    const [persisted] = buildPersistableTabs(
      [makeTab({ content: huge })],
      "tab-1",
    );
    expect(persisted.content).toBe("");
  });

  it("keeps content exactly at the cap", () => {
    const atCap = "y".repeat(MAX_PERSISTABLE_CONTENT_LENGTH);
    const [persisted] = buildPersistableTabs(
      [makeTab({ content: atCap })],
      "tab-1",
    );
    expect(persisted.content).toBe(atCap);
  });

  it("preserves undefined content", () => {
    const [persisted] = buildPersistableTabs(
      [makeTab({ content: undefined })],
      "tab-1",
    );
    expect(persisted.content).toBeUndefined();
  });

  it("excludes metrics tabs", () => {
    const tabs: Tab[] = [
      makeTab({ id: "q", type: "query" }),
      makeTab({ id: "m", type: "metrics" }),
    ];
    const result = buildPersistableTabs(tabs, "q");
    expect(result.map((t) => t.tabId)).toEqual(["q"]);
  });

  it("does not persist ephemeral metric result rows", () => {
    const [persisted] = buildPersistableTabs(
      [
        makeTab({
          type: "table",
          title: "Orders result",
          queryResult: {
            columns: [
              {
                name: "total",
                data_type: "integer",
                is_nullable: false,
                is_primary_key: false,
              },
            ],
            rows: [[42]],
            affected_rows: 0,
            execution_time_ms: 2,
            query: "SELECT count(*) AS total FROM orders",
            sandboxed: true,
            truncated: false,
          },
        }),
      ],
      "tab-1",
    );

    expect(persisted).not.toHaveProperty("queryResult");
    expect(JSON.stringify(persisted)).not.toContain(
      "SELECT count(*) AS total FROM orders",
    );
  });
});

describe("restoreTabSnapshot", () => {
  it("restores query content and ER diagram tabs", () => {
    const createdAtMs = Date.now();
    expect(
      restoreTabSnapshot(
        {
          tabId: "query-1",
          tabType: "query",
          title: "Query 1",
          content: "select 1",
          isActive: true,
          createdAtMs,
        },
        "connection-1",
      ),
    ).toMatchObject({
      id: "query-1",
      type: "query",
      connectionId: "connection-1",
      content: "select 1",
    });
    expect(
      restoreTabSnapshot(
        {
          tabId: "er-1",
          tabType: "er-diagram",
          title: "ER Diagram",
          isActive: false,
          createdAtMs,
        },
        "connection-1",
      ),
    ).toMatchObject({ id: "er-1", type: "er-diagram" });
  });

  it("rejects incomplete table snapshots and transient metrics tabs", () => {
    const createdAtMs = Date.now();
    expect(
      restoreTabSnapshot(
        {
          tabId: "table-1",
          tabType: "table",
          title: "users",
          isActive: false,
          createdAtMs,
        },
        "connection-1",
      ),
    ).toBeNull();
    expect(
      restoreTabSnapshot(
        {
          tabId: "metrics-1",
          tabType: "metrics",
          title: "Metrics",
          isActive: false,
          createdAtMs,
        },
        "connection-1",
      ),
    ).toBeNull();
  });
});

describe("saveTabState", () => {
  beforeEach(() => {
    invokeMutation.mockReset();
  });

  it("serializes capped content before persisting", async () => {
    invokeMutation.mockResolvedValue(undefined);
    const huge = "z".repeat(MAX_PERSISTABLE_CONTENT_LENGTH + 100);
    await saveTabState("conn-1", [makeTab({ content: huge })], "tab-1");

    expect(invokeMutation).toHaveBeenCalledTimes(1);
    const [command, args] = invokeMutation.mock.calls[0] as [
      string,
      { tabsJson: string },
    ];
    expect(command).toBe("save_tabs");
    const parsed = JSON.parse(args.tabsJson) as Array<{ content?: string }>;
    expect(parsed[0].content).toBe("");
  });

  it("never throws when the backend rejects", async () => {
    invokeMutation.mockRejectedValue(new Error("backend down"));
    await expect(
      saveTabState("conn-1", [makeTab()], "tab-1"),
    ).resolves.toBeUndefined();
  });
});
