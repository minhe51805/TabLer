import { describe, expect, it } from "vitest";

import { mapWithConcurrency, setBoundedCacheEntry, yieldToBrowserFrame } from "@/components/AISlidePanel/ai-async-utils";

describe("AI async utilities", () => {
  it("evicts the oldest cache entry and refreshes insertion order", () => {
    const cache = new Map<string, string>();
    setBoundedCacheEntry(cache, "a", "one", 2);
    setBoundedCacheEntry(cache, "b", "two", 2);
    setBoundedCacheEntry(cache, "a", "updated", 2);
    setBoundedCacheEntry(cache, "c", "three", 2);

    expect([...cache.entries()]).toEqual([
      ["a", "updated"],
      ["c", "three"],
    ]);
  });

  it("keeps results ordered while respecting the concurrency limit", async () => {
    let active = 0;
    let peak = 0;
    const results = await mapWithConcurrency([1, 2, 3, 4], 2, async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, value === 1 ? 10 : 1));
      active -= 1;
      return value * 2;
    });

    expect(peak).toBe(2);
    expect(results).toEqual([2, 4, 6, 8]);
  });

  it("yields back to the browser event loop", async () => {
    let didYield = false;
    const work = yieldToBrowserFrame().then(() => { didYield = true; });
    expect(didYield).toBe(false);
    await work;
    expect(didYield).toBe(true);
  });
});
