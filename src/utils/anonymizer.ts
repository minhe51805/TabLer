/**
 * Data anonymizer for exports and clipboard copies (Group-2 Feature 8).
 *
 * Deterministic, dependency-free PII masking: the same value with the same
 * salt always produces the same output, so masked exports still support
 * joins and diffing, while never leaking the original value of a masked
 * column. Hashing prefers Web Crypto SHA-256 and falls back to a
 * synchronous FNV-1a where subtle crypto is unavailable (old WebViews,
 * some test environments).
 */

export type AnonymizerStrategy =
  | "hash"
  | "redact"
  | "null"
  | "fake-email"
  | "fake-name"
  | "fake-phone"
  | "noise";

export type AnonymizerValue = string | number | boolean | null;

const REDACTED = "***";

/** FNV-1a 64-bit as hex — deterministic fallback when SHA-256 is unavailable. */
function fnv1a64Hex(text: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

async function sha256Hex(text: string): Promise<string> {
  const globalCrypto = typeof globalThis !== "undefined"
    ? (globalThis as { crypto?: Crypto }).crypto
    : undefined;
  if (globalCrypto?.subtle) {
    const bytes = new TextEncoder().encode(text);
    const digest = await globalCrypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }
  return fnv1a64Hex(text);
}

/** First 8 hex chars — enough entropy for masking, short enough to read. */
async function stableToken(value: string, salt: string): Promise<string> {
  return (await sha256Hex(`${salt}:${value}`)).slice(0, 8);
}

const FAKE_FIRST_NAMES = [
  "Alex", "Blake", "Casey", "Dana", "Elliott", "Frankie", "Gale", "Harper",
  "Indigo", "Jamie", "Kelly", "Logan", "Morgan", "Noel", "Oakley", "Peyton",
];
const FAKE_LAST_NAMES = [
  "Adler", "Bennett", "Carter", "Delgado", "Ellison", "Fischer", "Grant", "Hayes",
  "Iverson", "Jensen", "Keller", "Lambert", "Mercer", "Novak", "Ortega", "Preston",
];

async function fakeEmail(value: string, salt: string): Promise<string> {
  // .invalid is reserved by RFC 2606 — masked addresses can never receive mail.
  return `user${await stableToken(value, salt)}@example.invalid`;
}

async function fakeName(value: string, salt: string): Promise<string> {
  const token = parseInt(await stableToken(value, salt), 16);
  const first = FAKE_FIRST_NAMES[token % FAKE_FIRST_NAMES.length];
  const last = FAKE_LAST_NAMES[Math.floor(token / FAKE_FIRST_NAMES.length) % FAKE_LAST_NAMES.length];
  return `${first} ${last}`;
}

async function fakePhone(value: string, salt: string): Promise<string> {
  // 555-01xx is the fictional number block, so no real subscriber is hit.
  const token = parseInt(await stableToken(value, salt), 16);
  const line = 100 + (token % 900);
  return `555-01${String(line).slice(0, 2)}`;
}

async function noisyNumber(value: number, salt: string): Promise<number> {
  const token = parseInt(await stableToken(String(value), salt), 16);
  // Deterministic jitter within ±15%.
  const factor = 0.85 + ((token % 1000) / 1000) * 0.3;
  return Math.round(value * factor * 1_000_000) / 1_000_000;
}

async function anonymizeValue(
  value: AnonymizerValue,
  strategy: AnonymizerStrategy,
  salt: string,
): Promise<AnonymizerValue> {
  if (value === null || value === undefined || value === "") {
    return strategy === "null" ? null : value;
  }
  switch (strategy) {
    case "hash":
      return `hashed_${await stableToken(String(value), salt)}`;
    case "redact":
      return REDACTED;
    case "null":
      return null;
    case "fake-email":
      return fakeEmail(String(value), salt);
    case "fake-name":
      return fakeName(String(value), salt);
    case "fake-phone":
      return fakePhone(String(value), salt);
    case "noise": {
      const numeric = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(numeric)) return REDACTED;
      return noisyNumber(numeric, salt);
    }
    default:
      return REDACTED;
  }
}

/**
 * Apply per-column strategies to a row matrix. `strategies` maps column
 * index → strategy; untouched columns keep their original values. Returns a
 * new matrix — the input is never mutated.
 */
export async function anonymizeRows(
  rows: readonly (readonly AnonymizerValue[])[],
  strategies: ReadonlyMap<number, AnonymizerStrategy>,
  salt: string,
): Promise<AnonymizerValue[][]> {
  if (strategies.size === 0) return rows.map((row) => [...row]);
  const masked = await Promise.all(
    rows.map(async (row) => {
      const next: AnonymizerValue[] = [...row];
      for (const [columnIndex, strategy] of strategies) {
        next[columnIndex] = await anonymizeValue(
          next[columnIndex] ?? null,
          strategy,
          salt,
        );
      }
      return next;
    }),
  );
  return masked;
}

/**
 * Guard for the WF-safety gate: primary-key columns must never be masked,
 * because masked keys break joins and can violate uniqueness downstream.
 * Throws when a strategy targets a primary-key column.
 */
export function assertNoPrimaryKeyStrategies(
  primaryKeyIndices: readonly number[],
  strategies: ReadonlyMap<number, AnonymizerStrategy>,
): void {
  for (const index of primaryKeyIndices) {
    if (strategies.has(index)) {
      throw new Error(
        `Refusing to anonymize a primary-key column (index ${index}); masked keys would break row identity.`,
      );
    }
  }
}
