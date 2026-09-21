/**
 * Test-row generator (Round-5 "Generate test rows" feature).
 *
 * Pure client-side faker: given a table's column metadata it produces N rows
 * of plausible values, which the caller stages through the change-tracking
 * review modal. No AI, no backend — the user approves the staged INSERTs
 * before anything reaches the database.
 *
 * Name/email pools are shared with the anonymizer so masked exports and
 * generated seeds come from the same fictional universe.
 */

import type { ColumnDetail } from "../types";
import { FAKE_FIRST_NAMES, FAKE_LAST_NAMES, FAKE_EMAIL_DOMAINS } from "./anonymizer";

export type SeedValue = string | number | boolean | null;

/** One generated row: column name → value. Skipped columns are absent. */
export type GeneratedRow = Record<string, SeedValue>;

export const SEED_ROW_MIN = 1;
export const SEED_ROW_MAX = 1000;
export const SEED_ROW_DEFAULT = 50;

// ─── Small local pools ───────────────────────────────────────────────────────

const WORDS = [
  "amber",
  "anchor",
  "basket",
  "beacon",
  "breeze",
  "canyon",
  "cedar",
  "comet",
  "copper",
  "coral",
  "cricket",
  "delta",
  "drift",
  "ember",
  "falcon",
  "fjord",
  "glacier",
  "harbor",
  "island",
  "juniper",
  "kelp",
  "lagoon",
  "lantern",
  "maple",
  "meadow",
  "meridian",
  "mesa",
  "monarch",
  "nebula",
  "oasis",
  "onyx",
  "orchid",
  "pebble",
  "pioneer",
  "quartz",
  "raven",
  "ridge",
  "sable",
  "summit",
  "tide",
  "timber",
  "topaz",
  "trail",
  "tundra",
  "violet",
  "willow",
  "zephyr",
];

const CITIES = [
  "Springfield",
  "Riverton",
  "Lakewood",
  "Fairview",
  "Greenville",
  "Bristol",
  "Clinton",
  "Georgetown",
  "Madison",
  "Salem",
  "Auburn",
  "Dayton",
];

const STREETS = [
  "Main St",
  "Oak Ave",
  "Maple Dr",
  "Cedar Ln",
  "Park Blvd",
  "Lake Rd",
  "Hill St",
  "Elm St",
  "Pine Ave",
  "River Rd",
];

const COMPANIES = [
  "Acme Corp",
  "Globex",
  "Initech",
  "Umbrella Labs",
  "Stark Industries",
  "Wayne Enterprises",
  "Hooli",
  "Massive Dynamic",
  "Soylent Co",
  "Tyrell Group",
];

const STATUSES = ["active", "pending", "inactive", "archived"];
const CATEGORIES = ["general", "featured", "standard", "premium", "legacy"];
const CURRENCIES = ["USD", "EUR", "VND", "JPY", "GBP"];
const COUNTRIES = ["US", "VN", "DE", "JP", "GB", "FR", "AU", "SG"];
const GENDERS = ["male", "female", "other"];
const TAGS = ["new", "sale", "hot", "clearance", "seasonal", "limited"];
const LOCALES = ["en", "vi", "ko", "tr", "zh"];
const TIMEZONES = ["UTC", "Asia/Ho_Chi_Minh", "America/New_York", "Europe/Berlin"];
const NANP_AREAS = [201, 310, 415, 512, 617, 702, 808];

// Vietnamese pools — selected when the hint mentions VN/Vietnam.
const VN_LAST_NAMES = [
  "Nguyen",
  "Tran",
  "Le",
  "Pham",
  "Hoang",
  "Huynh",
  "Phan",
  "Vu",
  "Vo",
  "Dang",
  "Bui",
  "Do",
  "Ho",
  "Ngo",
  "Duong",
  "Ly",
];
const VN_MIDDLE_NAMES = ["Van", "Thi", "Duc", "Minh", "Ngoc", "Thanh", "Quoc", "Huu"];
const VN_FIRST_NAMES = [
  "An",
  "Binh",
  "Chi",
  "Dung",
  "Ha",
  "Hai",
  "Hang",
  "Hieu",
  "Hoa",
  "Hung",
  "Khanh",
  "Lam",
  "Lan",
  "Linh",
  "Long",
  "Mai",
  "Minh",
  "Nam",
  "Nga",
  "Phong",
  "Phuong",
  "Quang",
  "Son",
  "Tam",
  "Thao",
  "Thien",
  "Thu",
  "Trang",
  "Tuan",
  "Vy",
];
const VN_CITIES = [
  "Ha Noi",
  "Ho Chi Minh",
  "Da Nang",
  "Hai Phong",
  "Can Tho",
  "Hue",
  "Nha Trang",
  "Da Lat",
  "Vung Tau",
  "Quy Nhon",
];
const VN_STREETS = [
  "Le Loi",
  "Nguyen Hue",
  "Tran Hung Dao",
  "Hai Ba Trung",
  "Dien Bien Phu",
  "Vo Thi Sau",
  "Phan Dinh Phung",
  "Ba Trieu",
  "Ly Thuong Kiet",
  "Nguyen Trai",
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function pick<T>(pool: readonly T[]): T {
  return pool[Math.floor(Math.random() * pool.length)];
}

function randomInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

/** Random instant within the last ~5 years, as "YYYY-MM-DD" + "HH:MM:SS" parts. */
function randomDateParts(): { date: string; time: string } {
  const d = new Date(Date.now() - Math.floor(Math.random() * 5 * 365 * 24 * 3600 * 1000));
  const p = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    time: `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`,
  };
}

/** Column type text: prefer the full declared type ("varchar(255)") over the base type. */
function columnTypeText(column: ColumnDetail): string {
  return (column.column_type || column.data_type || "").toLowerCase();
}

/** Declared char length from types like varchar(50) / char(2); undefined when absent. */
function declaredLength(column: ColumnDetail): number | undefined {
  const match = /\((\d+)\s*(?:,|\))/.exec(columnTypeText(column));
  if (!match) return undefined;
  const length = Number(match[1]);
  return Number.isFinite(length) && length > 0 ? length : undefined;
}

/** Decimal scale from types like decimal(10,2); 2 when absent. */
function declaredScale(column: ColumnDetail): number {
  const match = /\(\s*\d+\s*,\s*(\d+)\s*\)/.exec(columnTypeText(column));
  return match ? Number(match[1]) : 2;
}

/** Enum members from types like enum('a','b') or set('a','b'). */
function enumValues(column: ColumnDetail): string[] | null {
  const match = /^(?:enum|set)\s*\((.*)\)$/i.exec(columnTypeText(column).trim());
  if (!match) return null;
  const values = match[1]
    .split(",")
    .map((part) => part.trim().replace(/^'(.*)'$/, "$1"))
    .filter((part) => part.length > 0);
  return values.length > 0 ? values : null;
}

/**
 * Columns the database fills itself: auto-increment/identity/serial keys and
 * generated columns. Seeding them would fight the engine's own sequence.
 */
export function isAutoGeneratedColumn(column: ColumnDetail): boolean {
  const extra = (column.extra || "").toLowerCase();
  if (
    extra.includes("auto_increment") ||
    extra.includes("identity") ||
    extra.includes("generated")
  ) {
    return true;
  }
  if (/\b(?:bigserial|smallserial|serial)\b/.test(columnTypeText(column))) return true;
  const def = (column.default_value || "").toLowerCase();
  return def.includes("nextval(") || def.includes("auto_increment");
}

type ColumnKind =
  | "boolean"
  | "integer"
  | "decimal"
  | "date"
  | "datetime"
  | "time"
  | "uuid"
  | "json"
  | "enum"
  | "blob"
  | "text";

function classifyColumn(column: ColumnDetail): ColumnKind {
  const type = columnTypeText(column);
  if (enumValues(column)) return "enum";
  if (
    /^(?:bool|boolean)\b/.test(type) ||
    /^tinyint\s*\(\s*1\s*\)/.test(type) ||
    /^bit\s*\(\s*1\s*\)/.test(type)
  ) {
    return "boolean";
  }
  if (
    /\b(?:bigint|int|integer|smallint|tinyint|mediumint|int2|int4|int8|serial|bigserial|smallserial|year)\b/.test(
      type,
    )
  ) {
    return "integer";
  }
  if (/\b(?:decimal|numeric|float|double|real|money|number)\b/.test(type)) return "decimal";
  if (/\b(?:datetime|timestamp|timestamptz)\b/.test(type)) return "datetime";
  if (/\bdate\b/.test(type)) return "date";
  if (/\btime\b/.test(type)) return "time";
  if (/\buuid\b/.test(type)) return "uuid";
  if (/\b(?:json|jsonb)\b/.test(type)) return "json";
  if (/\b(?:bytea|blob|binary|varbinary|image|geometry|geography)\b/.test(type)) return "blob";
  return "text";
}

// ─── Text heuristics ─────────────────────────────────────────────────────────

interface LocalePools {
  fullName: () => string;
  firstName: () => string;
  lastName: () => string;
  phone: () => string;
  city: () => string;
  street: () => string;
}

const EN_POOLS: LocalePools = {
  fullName: () => `${pick(FAKE_FIRST_NAMES)} ${pick(FAKE_LAST_NAMES)}`,
  firstName: () => pick(FAKE_FIRST_NAMES),
  lastName: () => pick(FAKE_LAST_NAMES),
  // 555-01xx is the fictional NANP block — generated numbers never reach a subscriber.
  phone: () => `${pick(NANP_AREAS)}-555-01${String(randomInt(0, 99)).padStart(2, "0")}`,
  city: () => pick(CITIES),
  street: () => `${randomInt(1, 9999)} ${pick(STREETS)}`,
};

const VN_POOLS: LocalePools = {
  fullName: () => `${pick(VN_LAST_NAMES)} ${pick(VN_MIDDLE_NAMES)} ${pick(VN_FIRST_NAMES)}`,
  firstName: () => pick(VN_FIRST_NAMES),
  lastName: () => pick(VN_LAST_NAMES),
  phone: () => `0${pick([3, 5, 7, 8, 9])}${String(randomInt(0, 99999999)).padStart(8, "0")}`,
  city: () => pick(VN_CITIES),
  street: () => `${randomInt(1, 999)} ${pick(VN_STREETS)}`,
};

/** Cheap hint interpretation: a VN hint swaps the name/phone/address pools. */
function poolsForHint(hint: string | undefined): LocalePools {
  return /\b(vn|vietnam|vietnamese|việt)\b/i.test(hint || "") ? VN_POOLS : EN_POOLS;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function textValueFor(column: ColumnDetail, pools: LocalePools, rowIndex: number): string {
  const name = column.name.toLowerCase();

  if (/(e[-_]?mail|mail)/.test(name)) {
    return `${slugify(pools.fullName()).replace(/-/g, ".")}${randomInt(1, 999)}@${pick(FAKE_EMAIL_DOMAINS)}.invalid`;
  }
  if (/(phone|mobile|tel|fax|contact_number)/.test(name)) return pools.phone();
  if (/(first[-_]?name|given[-_]?name|fname)/.test(name)) return pools.firstName();
  if (/(last[-_]?name|family[-_]?name|surname|lname)/.test(name)) return pools.lastName();
  if (
    /(full[-_]?name|customer[-_]?name|user[-_]?name|contact[-_]?name|holder|recipient|author|owner|employee|person|^name$|_name$)/.test(
      name,
    )
  ) {
    return pools.fullName();
  }
  if (/(company|organization|organisation|vendor|supplier|merchant|business)/.test(name)) {
    return pick(COMPANIES);
  }
  if (/(street|address|addr)/.test(name)) return `${pools.street()}, ${pools.city()}`;
  if (/(city|town|province|state|region)/.test(name)) return pools.city();
  if (/(country|nationality)/.test(name)) return pick(COUNTRIES);
  if (/(zip|postal)/.test(name)) return String(randomInt(10000, 99999));
  if (/(url|website|link|homepage|site)/.test(name)) {
    return `https://www.${pick(FAKE_EMAIL_DOMAINS)}.example/${slugify(pick(WORDS))}`;
  }
  if (/(slug|permalink)/.test(name)) return `${slugify(pick(WORDS))}-${rowIndex + 1}`;
  if (/(username|login|handle|screen[-_]?name)/.test(name)) {
    return `${slugify(pools.fullName()).replace(/-/g, "_")}_${randomInt(10, 9999)}`;
  }
  if (/(password|passwd|secret|token|api[-_]?key)/.test(name)) {
    return crypto.randomUUID().replace(/-/g, "");
  }
  if (/(status|state$|_state)/.test(name)) return pick(STATUSES);
  if (/(gender|sex)/.test(name)) return pick(GENDERS);
  if (/(currency)/.test(name)) return pick(CURRENCIES);
  if (/(locale|language|lang)/.test(name)) return pick(LOCALES);
  if (/(timezone|tz)/.test(name)) return pick(TIMEZONES);
  if (/(color|colour)/.test(name)) {
    return `#${randomInt(0, 0xffffff).toString(16).padStart(6, "0")}`;
  }
  if (/(^|_)ip(_|$)|ipv4|host/.test(name)) {
    return `10.${randomInt(0, 255)}.${randomInt(0, 255)}.${randomInt(1, 254)}`;
  }
  if (/(category|type|kind|group|tier|level|role)/.test(name)) return pick(CATEGORIES);
  if (/(tag|label)/.test(name)) return pick(TAGS);
  if (/(title|subject|heading)/.test(name)) {
    return `${pick(WORDS)} ${pick(WORDS)} ${pick(WORDS)}`;
  }
  if (
    /(description|desc|bio|about|summary|note|comment|remark|content|body|text|message)/.test(name)
  ) {
    return `${pick(WORDS)} ${pick(WORDS)} ${pick(WORDS)} ${pick(WORDS)} ${pick(WORDS)}`;
  }
  if (/(code|sku|ref|number|no$|_no)/.test(name)) {
    return `${pick(WORDS).toUpperCase().slice(0, 3)}-${randomInt(10000, 99999)}`;
  }
  return `${pick(WORDS)} ${pick(WORDS)} ${rowIndex + 1}`;
}

// ─── Row generation ──────────────────────────────────────────────────────────

function generateValue(
  column: ColumnDetail,
  kind: ColumnKind,
  pools: LocalePools,
  rowIndex: number,
): SeedValue {
  switch (kind) {
    case "boolean":
      return Math.random() < 0.5;
    case "integer":
      return randomInt(1, 99999);
    case "decimal":
      return Number((Math.random() * 10000).toFixed(declaredScale(column)));
    case "date":
      return randomDateParts().date;
    case "datetime": {
      const parts = randomDateParts();
      return `${parts.date} ${parts.time}`;
    }
    case "time":
      return randomDateParts().time;
    case "uuid":
      return crypto.randomUUID();
    case "json":
      return JSON.stringify({ seed: pick(WORDS), index: rowIndex, flag: Math.random() < 0.5 });
    case "enum":
      return pick(enumValues(column)!);
    case "blob":
      // Rare in seed targets; emit a short hex token so NOT NULL blobs still get data.
      return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    case "text":
    default: {
      const text = textValueFor(column, pools, rowIndex);
      const maxLen = declaredLength(column);
      return maxLen !== undefined && text.length > maxLen ? text.slice(0, maxLen) : text;
    }
  }
}

/**
 * Generate `count` rows for `columns`. Auto-generated columns (serial PKs,
 * generated columns) are skipped so the database fills them. Primary-key
 * columns get collision-checked unique values; other nullable columns get a
 * small NULL sprinkle for realism.
 */
export function generateTestRows(
  columns: readonly ColumnDetail[],
  count: number,
  hint?: string,
): GeneratedRow[] {
  const pools = poolsForHint(hint);
  const seedable = columns.filter((column) => !isAutoGeneratedColumn(column));
  const pkSeen = new Map<string, Set<SeedValue>>();

  const uniqueFor = (column: ColumnDetail, kind: ColumnKind, rowIndex: number): SeedValue => {
    let seen = pkSeen.get(column.name);
    if (!seen) {
      seen = new Set();
      pkSeen.set(column.name, seen);
    }
    for (let attempt = 0; attempt < 32; attempt++) {
      let candidate: SeedValue;
      if (kind === "integer") {
        candidate = randomInt(1_000_000, 2_000_000_000);
      } else if (kind === "text") {
        const uuid = crypto.randomUUID();
        const maxLen = declaredLength(column);
        candidate = maxLen !== undefined && uuid.length > maxLen ? uuid.slice(0, maxLen) : uuid;
      } else {
        candidate = generateValue(column, kind, pools, rowIndex);
      }
      if (!seen.has(candidate)) {
        seen.add(candidate);
        return candidate;
      }
    }
    // Pool exhausted (e.g. a 2-value enum PK): fall back to a uuid-ish token.
    return crypto.randomUUID();
  };

  const rows: GeneratedRow[] = [];
  for (let rowIndex = 0; rowIndex < count; rowIndex++) {
    const row: GeneratedRow = {};
    for (const column of seedable) {
      const kind = classifyColumn(column);
      if (column.is_primary_key) {
        row[column.name] = uniqueFor(column, kind, rowIndex);
        continue;
      }
      // ~8% NULLs on nullable non-key columns keeps seeds realistic without
      // starving required fields.
      if (column.is_nullable && Math.random() < 0.08) {
        row[column.name] = null;
        continue;
      }
      row[column.name] = generateValue(column, kind, pools, rowIndex);
    }
    rows.push(row);
  }
  return rows;
}
