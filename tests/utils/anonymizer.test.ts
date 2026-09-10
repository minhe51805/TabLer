import { describe, expect, it } from "vitest";
import {
  anonymizeRows,
  assertNoPrimaryKeyStrategies,
  type AnonymizerStrategy,
  type AnonymizerValue,
} from "@/utils/anonymizer";

async function maskOne(
  value: AnonymizerValue,
  strategy: AnonymizerStrategy,
  salt = "s1",
): Promise<AnonymizerValue> {
  const strategies = new Map([[0, strategy]]);
  const [row] = await anonymizeRows([[value]], strategies, salt);
  return row[0];
}

describe("anonymizer strategies", () => {
  it("hashes deterministically and never leaks the original value", async () => {
    const masked = await maskOne("alice@example.com", "hash");
    expect(masked).toMatch(/^hashed_[0-9a-f]{8}$/);
    expect(String(masked)).not.toContain("alice");

    const again = await maskOne("alice@example.com", "hash");
    expect(again).toBe(masked);

    const otherSalt = await maskOne("alice@example.com", "hash", "s2");
    expect(otherSalt).not.toBe(masked);
  });

  it("redacts to a fixed marker and nulls stay null", async () => {
    expect(await maskOne("secret", "redact")).toBe("***");
    expect(await maskOne(null, "redact")).toBeNull();
    expect(await maskOne("", "redact")).toBe("");
    expect(await maskOne(null, "null")).toBeNull();
  });

  it("produces deterministic fake emails on the reserved domain", async () => {
    const email = await maskOne("alice@example.com", "fake-email");
    expect(email).toMatch(/^user[0-9a-f]{8}@example\.invalid$/);
    expect(email).toBe(await maskOne("alice@example.com", "fake-email"));
    // A different original never collides onto the same fake at the same salt.
    expect(email).not.toBe(await maskOne("bob@example.com", "fake-email"));
  });

  it("draws fake names from the built-in pool", async () => {
    const name = await maskOne("Alice Smith", "fake-name");
    expect(name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
    expect(name).toBe(await maskOne("Alice Smith", "fake-name"));
  });

  it("produces fictional 555-01xx phone numbers", async () => {
    const phone = await maskOne("+84 912 345 678", "fake-phone");
    expect(phone).toMatch(/^555-01\d\d$/);
    expect(phone).toBe(await maskOne("+84 912 345 678", "fake-phone"));
  });

  it("jitters numeric values within ±15% deterministically", async () => {
    const noisy = await maskOne(1000, "noise");
    expect(typeof noisy).toBe("number");
    expect(noisy as number).toBeGreaterThanOrEqual(850);
    expect(noisy as number).toBeLessThanOrEqual(1150);
    expect(noisy).toBe(await maskOne(1000, "noise"));
    // Non-numeric input under noise redacts instead of guessing.
    expect(await maskOne("not-a-number", "noise")).toBe("***");
  });
});

describe("anonymizeRows", () => {
  const rows: AnonymizerValue[][] = [
    [1, "alice@example.com", "Alice", "public-a"],
    [2, "bob@example.com", "Bob", "public-b"],
  ];

  it("masks only the targeted columns and never mutates the input", async () => {
    const strategies = new Map([
      [1, "fake-email" as AnonymizerStrategy],
      [2, "fake-name" as AnonymizerStrategy],
    ]);
    const masked = await anonymizeRows(rows, strategies, "salt");
    expect(masked[0][0]).toBe(1);
    expect(masked[0][3]).toBe("public-a");
    expect(masked[1][1]).toMatch(/^user[0-9a-f]{8}@example\.invalid$/);
    expect(masked[1][2]).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
    // Originals intact.
    expect(rows[0][1]).toBe("alice@example.com");
    expect(rows[0]).not.toBe(masked[0]);
  });

  it("keeps the row shape when no strategies are configured", async () => {
    const masked = await anonymizeRows(rows, new Map(), "salt");
    expect(masked).toEqual(rows);
  });
});

describe("assertNoPrimaryKeyStrategies", () => {
  it("allows strategies on non-key columns", () => {
    expect(() =>
      assertNoPrimaryKeyStrategies([0], new Map([[1, "redact" as AnonymizerStrategy]])),
    ).not.toThrow();
  });

  it("refuses strategies on primary-key columns", () => {
    expect(() =>
      assertNoPrimaryKeyStrategies([0], new Map([[0, "redact" as AnonymizerStrategy]])),
    ).toThrow(/primary-key/);
  });
});
