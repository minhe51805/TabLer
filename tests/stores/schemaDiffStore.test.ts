import { describe, expect, it } from "vitest";
import { useSchemaDiffStore } from "../../src/stores/schemaDiffStore";

describe("schemaDiffStore", () => {
  it("opens and closes the Schema Diff modal", () => {
    const initial = useSchemaDiffStore.getState().isOpen;
    useSchemaDiffStore.getState().open();
    expect(useSchemaDiffStore.getState().isOpen).toBe(true);
    useSchemaDiffStore.getState().close();
    expect(useSchemaDiffStore.getState().isOpen).toBe(false);
    expect(initial).toBe(false);
  });
});
