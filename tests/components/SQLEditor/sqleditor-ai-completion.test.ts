import { beforeEach, describe, expect, it, vi } from "vitest";

const { connectionState, aiState } = vi.hoisted(() => ({
  connectionState: {
    connections: [] as Array<{
      id: string;
      name: string;
      db_type: string;
      host?: string;
      use_ssl: boolean;
    }>,
    currentDatabase: "appdb" as string | null,
    tables: [] as Array<{ name: string }>,
  },
  aiState: {
    aiConfigs: [] as Array<Record<string, unknown>>,
    askAI: vi.fn<(prompt: string, context: string, mode?: string) => Promise<string>>(),
  },
}));

// The stores are mocked (not seeded) so this test never loads the real
// zustand/tauri wiring — only the gate ORDER under test matters here.
vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: Object.assign(
    (selector: (state: typeof connectionState) => unknown) => selector(connectionState),
    { getState: () => connectionState },
  ),
}));
vi.mock("@/stores/aiStore", () => ({
  useAIStore: Object.assign((selector: (state: typeof aiState) => unknown) => selector(aiState), {
    getState: () => aiState,
  }),
}));

import { registerInlineAICompletionProvider } from "@/components/SQLEditor/SQLEditorAICompletion";

type Provider = {
  provideInlineCompletions: (
    model: unknown,
    position: unknown,
    context: unknown,
    token: unknown,
  ) => Promise<{ items: Array<{ insertText: string }> }>;
};

function createMonaco() {
  let provider: Provider | null = null;
  const monaco = {
    Range: class {
      constructor(
        public startLineNumber: number,
        public startColumn: number,
        public endLineNumber: number,
        public endColumn: number,
      ) {}
    },
    languages: {
      registerInlineCompletionsProvider: vi.fn((_lang: string, next: Provider) => {
        provider = next;
        return { dispose: vi.fn() };
      }),
    },
  };
  return { monaco, getProvider: () => provider! };
}

function createModel(text: string) {
  return {
    getValueInRange: () => text,
  };
}

const position = { lineNumber: 1, column: 8 };

function createRefs() {
  return {
    cacheRef: { current: null as { key: string; value: string; timestamp: number } | null },
    inFlightRef: { current: null as { key: string; promise: Promise<string> } | null },
    lastAtRef: { current: 0 },
    dailyRef: { current: { count: 0, date: new Date().toDateString() } },
  };
}

function register(refs: ReturnType<typeof createRefs>, connectionId = "conn-1") {
  const { monaco, getProvider } = createMonaco();
  registerInlineAICompletionProvider(
    monaco,
    connectionId,
    refs.cacheRef,
    refs.inFlightRef,
    refs.lastAtRef,
    refs.dailyRef,
  );
  return getProvider();
}

const enabledProvider = (overrides: Record<string, unknown> = {}) => ({
  id: "p1",
  provider_type: "openai",
  endpoint: "https://api.example.com",
  is_enabled: true,
  is_primary: true,
  allow_inline_completion: true,
  allow_schema_context: false,
  ...overrides,
});

const trustedConnection = {
  id: "conn-1",
  name: "local",
  db_type: "postgresql",
  host: "127.0.0.1",
  use_ssl: false,
};

const TYPED = "SELECT * F";

beforeEach(() => {
  aiState.askAI.mockReset().mockResolvedValue("ROM users");
  aiState.aiConfigs = [enabledProvider()];
  connectionState.connections = [trustedConnection];
  connectionState.currentDatabase = "appdb";
  connectionState.tables = [];
});

describe("inline AI completion provider — gate order", () => {
  it("never calls askAI when the text before the cursor is too short", async () => {
    const provider = register(createRefs());
    const result = await provider.provideInlineCompletions(createModel("SEL"), position, {}, {});
    expect(result.items).toEqual([]);
    expect(aiState.askAI).not.toHaveBeenCalled();
  });

  it("never calls askAI without an enabled provider allowing inline completion", async () => {
    aiState.aiConfigs = [enabledProvider({ allow_inline_completion: false })];
    const provider = register(createRefs());
    const result = await provider.provideInlineCompletions(createModel(TYPED), position, {}, {});
    expect(result.items).toEqual([]);
    expect(aiState.askAI).not.toHaveBeenCalled();
  });

  it("privacy: a non-local connection gets no completion even with a warm cache", async () => {
    connectionState.connections = [{ ...trustedConnection, host: "db.example.com" }];
    const refs = createRefs();
    // Poison the cache: a hit here would still leak schema context timing —
    // the trusted-host gate must run BEFORE the cache lookup.
    refs.cacheRef.current = {
      key: "appdb:SELECT * F",
      value: "ROM users",
      timestamp: Date.now(),
    };
    const provider = register(refs);
    const result = await provider.provideInlineCompletions(createModel(TYPED), position, {}, {});
    expect(result.items).toEqual([]);
    expect(aiState.askAI).not.toHaveBeenCalled();
  });

  it("cache hit serves the suggestion without calling askAI again", async () => {
    const refs = createRefs();
    const provider = register(refs);

    const first = await provider.provideInlineCompletions(createModel(TYPED), position, {}, {});
    expect(first.items[0]?.insertText).toBe("ROM users");
    expect(aiState.askAI).toHaveBeenCalledTimes(1);

    // Reset the rate limit so the ONLY thing that can serve this call is the
    // cache — a second backend call proves the cache gate is dead.
    refs.lastAtRef.current = 0;
    const second = await provider.provideInlineCompletions(createModel(TYPED), position, {}, {});
    expect(second.items[0]?.insertText).toBe("ROM users");
    expect(aiState.askAI).toHaveBeenCalledTimes(1);
  });

  it("in-flight dedup: two calls for the same key share one askAI request", async () => {
    let release!: (value: string) => void;
    aiState.askAI.mockImplementation(() => new Promise<string>((resolve) => (release = resolve)));
    const refs = createRefs();
    const provider = register(refs);

    const first = provider.provideInlineCompletions(createModel(TYPED), position, {}, {});
    await vi.waitFor(() => {
      expect(refs.inFlightRef.current).not.toBeNull();
    });
    const second = provider.provideInlineCompletions(createModel(TYPED), position, {}, {});

    release("ROM users");
    const [r1, r2] = await Promise.all([first, second]);
    expect(r1.items[0]?.insertText).toBe("ROM users");
    expect(r2.items[0]?.insertText).toBe("ROM users");
    expect(aiState.askAI).toHaveBeenCalledTimes(1);
  });

  it("rate limit suppresses a second request inside the min interval", async () => {
    const refs = createRefs();
    const provider = register(refs);

    await provider.provideInlineCompletions(createModel(TYPED), position, {}, {});
    // A different key bypasses the cache but must hit the 2s rate limit.
    const second = await provider.provideInlineCompletions(
      createModel("SELECT * G"),
      position,
      {},
      {},
    );
    expect(second.items).toEqual([]);
    expect(aiState.askAI).toHaveBeenCalledTimes(1);
  });

  it("daily cap: the 101st request of the day never reaches askAI", async () => {
    const refs = createRefs();
    refs.dailyRef.current = { count: 100, date: new Date().toDateString() };
    const provider = register(refs);

    const result = await provider.provideInlineCompletions(createModel(TYPED), position, {}, {});
    expect(result.items).toEqual([]);
    expect(aiState.askAI).not.toHaveBeenCalled();
  });

  it("schema context only leaves for providers that opted in", async () => {
    connectionState.tables = [{ name: "users" }, { name: "orders" }];
    const refs = createRefs();
    const provider = register(refs);

    await provider.provideInlineCompletions(createModel(TYPED), position, {}, {});
    expect(aiState.askAI).toHaveBeenCalledWith(expect.stringContaining(TYPED), "", "inline");
    aiState.askAI.mockClear();
    aiState.aiConfigs = [enabledProvider({ allow_schema_context: true })];
    refs.lastAtRef.current = 0;
    refs.cacheRef.current = null;
    const provider2 = register(refs);
    await provider2.provideInlineCompletions(createModel(TYPED), position, {}, {});
    expect(aiState.askAI).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("users, orders"),
      "inline",
    );
  });
});
