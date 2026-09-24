import { beforeEach, describe, expect, it } from "vitest";
import { columnMaskScopeKey, useColumnMaskStore } from "@/stores/columnMaskStore";
import { defaultMaskStrategy } from "@/components/DataGrid/hooks/useDataGridColumnMasks";
import type { ResolvedColumn } from "@/components/DataGrid/hooks/useDataGrid";

const STORAGE_KEY = "tabler.column-masks";
const SCOPE = columnMaskScopeKey("conn-1", "app", "users");
interface PersistedMasks {
  masks?: Record<string, Record<string, string>>;
  salts?: Record<string, string>;
  revealed?: Record<string, string[]>;
}

function persisted(): PersistedMasks {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  if (parsed && typeof parsed === "object" && "state" in parsed) {
    const state = parsed.state;
    if (state && typeof state === "object") return state as PersistedMasks;
  }
  return {};
}

describe("column mask store", () => {
  beforeEach(() => {
    localStorage.clear();
    useColumnMaskStore.setState({ masks: {}, salts: {}, revealed: {} });
  });

  it("persists mask rules and the scope salt, but never the reveal state", () => {
    const store = useColumnMaskStore.getState();
    store.setColumnMask(SCOPE, "email", "fake-email");
    store.setRevealed(SCOPE, "email", true);

    const saved = persisted();
    expect(saved.masks).toEqual({ [SCOPE]: { email: "fake-email" } });
    expect(saved.salts).toEqual({ [SCOPE]: expect.any(String) });
    // Reveal is session-only: it must never reach storage.
    expect(saved.revealed).toBeUndefined();
  });

  it("reuses one salt per scope so masked output stays deterministic", () => {
    const store = useColumnMaskStore.getState();
    store.setColumnMask(SCOPE, "email", "hash");
    const first = useColumnMaskStore.getState().salts[SCOPE];
    store.setColumnMask(SCOPE, "phone", "redact");
    expect(useColumnMaskStore.getState().salts[SCOPE]).toBe(first);
  });

  it("clearScopeMasks drops rules and reveal flags for the scope only", () => {
    const other = columnMaskScopeKey("conn-1", "app", "teams");
    const store = useColumnMaskStore.getState();
    store.setColumnMask(SCOPE, "email", "hash");
    store.setColumnMask(other, "name", "redact");
    store.setRevealed(SCOPE, "email", true);

    store.clearScopeMasks(SCOPE);
    const state = useColumnMaskStore.getState();
    expect(state.masks[SCOPE]).toBeUndefined();
    expect(state.revealed[SCOPE]).toBeUndefined();
    expect(state.masks[other]).toEqual({ name: "redact" });
  });
});

describe("defaultMaskStrategy", () => {
  const col = (name: string, data_type = ""): ResolvedColumn => ({
    name,
    data_type,
    is_nullable: true,
    is_primary_key: false,
  });

  it("prefers fake-* generators for PII-shaped column names", () => {
    expect(defaultMaskStrategy(col("email", "varchar(255)"))).toBe("fake-email");
    expect(defaultMaskStrategy(col("phone_number", "varchar(20)"))).toBe("fake-phone");
    expect(defaultMaskStrategy(col("first_name", "varchar(50)"))).toBe("fake-name");
  });

  it("uses noise for numeric types and hash for text", () => {
    expect(defaultMaskStrategy(col("balance", "decimal(10,2)"))).toBe("noise");
    expect(defaultMaskStrategy(col("notes", "text"))).toBe("hash");
  });

  it("falls back to redact for other types", () => {
    expect(defaultMaskStrategy(col("payload", "jsonb"))).toBe("redact");
  });
});
