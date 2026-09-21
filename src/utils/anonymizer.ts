/**
 * Data anonymizer for exports and clipboard copies (Group-2 Feature 8).
 *
 * Deterministic, dependency-free PII masking: the same value with the same
 * salt always produces the same output, so masked exports still support
 * joins and diffing, while never leaking the original value of a masked
 * column. Hashing prefers Web Crypto SHA-256 and falls back to a
 * synchronous FNV-1a where subtle crypto is unavailable (old WebViews,
 * some test environments). Callers should always pass a non-empty salt —
 * see generateSalt() for the UI-side default.
 */

export type AnonymizerStrategy =
  "hash" | "redact" | "null" | "fake-email" | "fake-name" | "fake-phone" | "noise";

export type AnonymizerValue = string | number | boolean | null;

const REDACTED = "***";

/** FNV-1a 64-bit as hex — deterministic fallback when SHA-256 is unavailable. */
function fnv1a64Hex(text: string, seed = 0xcbf29ce484222325n): string {
  let hash = seed;
  const prime = 0x100000001b3n;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

async function sha256Hex(text: string): Promise<string> {
  const globalCrypto =
    typeof globalThis !== "undefined" ? (globalThis as { crypto?: Crypto }).crypto : undefined;
  if (globalCrypto?.subtle) {
    const bytes = new TextEncoder().encode(text);
    const digest = await globalCrypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }
  // Two differently-seeded FNV passes keep the fallback at 32 hex chars.
  return fnv1a64Hex(text) + fnv1a64Hex(text, 0x84222325cbf29ce4n);
}

/**
 * Full SHA-256 hex of `salt:value` (64 chars; 32 under the FNV fallback).
 * The digest is never truncated — a short token over low-entropy inputs
 * like names or phone numbers would be trivially brute-forceable.
 */
async function stableToken(value: string, salt: string): Promise<string> {
  return sha256Hex(`${salt}:${value}`);
}

/**
 * Random 128-bit salt as hex. The UI uses this when the salt field is left
 * empty so masking never runs unsalted; the generated value is shown to the
 * user so the same masks can be reproduced later.
 */
export function generateSalt(): string {
  const globalCrypto =
    typeof globalThis !== "undefined" ? (globalThis as { crypto?: Crypto }).crypto : undefined;
  if (globalCrypto?.getRandomValues) {
    const bytes = new Uint8Array(16);
    globalCrypto.getRandomValues(bytes);
    return Array.from(bytes)
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }
  // Non-crypto fallback: still unpredictable enough for a masking salt.
  return Array.from({ length: 4 }, () =>
    Math.floor(Math.random() * 0xffffffff)
      .toString(16)
      .padStart(8, "0"),
  ).join("");
}

/** Deterministic pool index from a 48-bit slice of the token. */
function tokenIndex(token: string, offset: number, modulo: number): number {
  return parseInt(token.slice(offset, offset + 12), 16) % modulo;
}

export const FAKE_FIRST_NAMES = [
  "Aaron",
  "Abigail",
  "Ada",
  "Adam",
  "Adrian",
  "Adriana",
  "Aisha",
  "Alan",
  "Albert",
  "Alejandro",
  "Alex",
  "Alexa",
  "Alexander",
  "Alexandra",
  "Alfred",
  "Alice",
  "Alicia",
  "Alina",
  "Allison",
  "Alvin",
  "Amanda",
  "Amber",
  "Amelia",
  "Amir",
  "Amy",
  "Ana",
  "Andre",
  "Andrea",
  "Andrew",
  "Angela",
  "Anita",
  "Anna",
  "Anthony",
  "Anton",
  "Antonio",
  "April",
  "Archie",
  "Ariana",
  "Ariel",
  "Arjun",
  "Arthur",
  "Ashley",
  "Athena",
  "Audrey",
  "Austin",
  "Autumn",
  "Ava",
  "Barbara",
  "Beatrice",
  "Benjamin",
  "Bernard",
  "Beth",
  "Bianca",
  "Blake",
  "Bonnie",
  "Brandon",
  "Brenda",
  "Brian",
  "Bridget",
  "Brooke",
  "Bruce",
  "Bryan",
  "Caleb",
  "Calvin",
  "Camila",
  "Carl",
  "Carla",
  "Carlos",
  "Carmen",
  "Carol",
  "Caroline",
  "Carrie",
  "Casey",
  "Cassandra",
  "Catherine",
  "Cecil",
  "Cedric",
  "Celia",
  "Chad",
  "Charlene",
  "Charles",
  "Charlotte",
  "Chelsea",
  "Cheryl",
  "Chloe",
  "Christian",
  "Christina",
  "Christopher",
  "Cindy",
  "Clara",
  "Clarence",
  "Claudia",
  "Clifford",
  "Cody",
  "Colin",
  "Colleen",
  "Connie",
  "Conrad",
  "Cora",
  "Corey",
  "Craig",
  "Crystal",
  "Curtis",
  "Cynthia",
  "Dale",
  "Damian",
  "Dana",
  "Daniel",
  "Danielle",
  "Danny",
  "Daphne",
  "Darlene",
  "Darrell",
  "Darren",
  "David",
  "Dawn",
  "Dean",
  "Deborah",
  "Denise",
  "Dennis",
  "Derek",
  "Desiree",
  "Diana",
  "Diane",
  "Diego",
  "Dominic",
  "Donald",
  "Donna",
  "Doris",
  "Dorothy",
  "Douglas",
  "Duane",
  "Dustin",
  "Dylan",
  "Earl",
  "Edgar",
  "Edith",
  "Edmund",
  "Eduardo",
  "Edward",
  "Edwin",
  "Elaine",
  "Eleanor",
  "Elena",
  "Elias",
  "Elijah",
  "Ella",
  "Ellen",
  "Elliot",
  "Eloise",
  "Emanuel",
  "Emily",
  "Emma",
  "Eric",
  "Erica",
  "Erik",
  "Erin",
  "Ernest",
  "Esther",
  "Ethan",
  "Eugene",
  "Eunice",
  "Eva",
  "Evan",
  "Evelyn",
  "Everett",
  "Ezra",
  "Faith",
  "Felix",
  "Fernando",
  "Fiona",
  "Flora",
  "Florence",
  "Frances",
  "Francis",
  "Frank",
  "Franklin",
  "Fred",
  "Freda",
  "Frederick",
  "Gabriel",
  "Gail",
  "Garrett",
  "Gary",
  "Gavin",
  "Geoffrey",
  "George",
  "Gerald",
  "Geraldine",
  "Gilbert",
  "Gina",
  "Gladys",
  "Glen",
  "Glenda",
  "Glenn",
  "Gloria",
  "Gordon",
  "Grace",
  "Grant",
  "Gregory",
  "Greta",
  "Guillermo",
  "Gustavo",
  "Gwen",
  "Hannah",
  "Harold",
  "Harriet",
  "Harry",
  "Harvey",
  "Hazel",
  "Heather",
  "Hector",
  "Helen",
  "Henry",
  "Herbert",
  "Herman",
];

export const FAKE_LAST_NAMES = [
  "Smith",
  "Johnson",
  "Williams",
  "Brown",
  "Jones",
  "Garcia",
  "Miller",
  "Davis",
  "Rodriguez",
  "Martinez",
  "Hernandez",
  "Lopez",
  "Gonzalez",
  "Wilson",
  "Anderson",
  "Thomas",
  "Taylor",
  "Moore",
  "Jackson",
  "Martin",
  "Lee",
  "Perez",
  "Thompson",
  "White",
  "Harris",
  "Sanchez",
  "Clark",
  "Ramirez",
  "Lewis",
  "Robinson",
  "Walker",
  "Young",
  "Allen",
  "King",
  "Wright",
  "Scott",
  "Torres",
  "Nguyen",
  "Hill",
  "Flores",
  "Green",
  "Adams",
  "Nelson",
  "Baker",
  "Hall",
  "Rivera",
  "Campbell",
  "Mitchell",
  "Carter",
  "Roberts",
  "Gomez",
  "Phillips",
  "Evans",
  "Turner",
  "Diaz",
  "Parker",
  "Cruz",
  "Edwards",
  "Collins",
  "Reyes",
  "Stewart",
  "Morris",
  "Morales",
  "Murphy",
  "Cook",
  "Rogers",
  "Gutierrez",
  "Ortiz",
  "Morgan",
  "Cooper",
  "Peterson",
  "Bailey",
  "Reed",
  "Kelly",
  "Howard",
  "Ramos",
  "Kim",
  "Cox",
  "Ward",
  "Richardson",
  "Watson",
  "Brooks",
  "Chavez",
  "Wood",
  "James",
  "Bennett",
  "Gray",
  "Mendoza",
  "Ruiz",
  "Hughes",
  "Price",
  "Alvarez",
  "Castillo",
  "Sanders",
  "Patel",
  "Myers",
  "Long",
  "Ross",
  "Foster",
  "Jimenez",
  "Powell",
  "Jenkins",
  "Perry",
  "Russell",
  "Sullivan",
  "Bell",
  "Coleman",
  "Butler",
  "Henderson",
  "Barnes",
  "Gonzales",
  "Fisher",
  "Vasquez",
  "Simmons",
  "Romero",
  "Jordan",
  "Patterson",
  "Alexander",
  "Hamilton",
  "Graham",
  "Reynolds",
  "Griffin",
  "Wallace",
  "Moreno",
  "West",
  "Cole",
  "Hayes",
  "Bryant",
  "Herrera",
  "Gibson",
  "Ellis",
  "Tran",
  "Medina",
  "Aguilar",
  "Stevens",
  "Murray",
  "Ford",
  "Castro",
  "Marshall",
  "Owens",
  "Harrison",
  "Fernandez",
  "Mcdonald",
  "Woods",
  "Washington",
  "Kennedy",
  "Wells",
  "Vargas",
  "Henry",
  "Chen",
  "Freeman",
  "Webb",
  "Tucker",
  "Guzman",
  "Burns",
  "Crawford",
  "Olson",
  "Simpson",
  "Porter",
  "Hunter",
  "Gordon",
  "Mendez",
  "Silva",
  "Shaw",
  "Snyder",
  "Mason",
  "Dixon",
  "Munoz",
  "Hunt",
  "Hicks",
  "Holmes",
  "Palmer",
  "Wagner",
  "Black",
  "Robertson",
  "Boyd",
  "Rose",
  "Stone",
  "Salazar",
  "Fox",
  "Warren",
  "Mills",
  "Meyer",
  "Rice",
  "Schmidt",
  "Garza",
  "Daniels",
  "Ferguson",
  "Nichols",
  "Stephens",
  "Soto",
  "Weaver",
  "Ryan",
  "Gardner",
  "Payne",
  "Grant",
  "Dunn",
  "Kelley",
  "Spencer",
  "Hawkins",
  "Arnold",
  "Pierce",
  "Vazquez",
  "Hansen",
  "Peters",
  "Santos",
  "Hart",
  "Bradley",
  "Knight",
  "Elliott",
  "Cunningham",
  "Duncan",
  "Armstrong",
  "Hudson",
  "Carroll",
  "Lane",
];

/** Reserved-domain stems; ".invalid" is appended so mail can never be delivered. */
export const FAKE_EMAIL_DOMAINS = [
  "acorn",
  "alder",
  "alpine",
  "amber",
  "anvil",
  "apex",
  "arbor",
  "archer",
  "arctic",
  "aspen",
  "atlas",
  "aurora",
  "autumn",
  "avalanche",
  "badger",
  "bamboo",
  "basalt",
  "basil",
  "beacon",
  "beaver",
  "beech",
  "birch",
  "blossom",
  "bluebird",
  "boulder",
  "bramble",
  "breeze",
  "brook",
  "buffalo",
  "butte",
  "cactus",
  "canyon",
  "cardinal",
  "cascade",
  "cedar",
  "cherry",
  "chestnut",
  "cinder",
  "citadel",
  "cliff",
  "clover",
  "cobalt",
  "comet",
  "compass",
  "condor",
  "copper",
  "coral",
  "coyote",
  "crater",
  "creek",
  "crescent",
  "cricket",
  "crystal",
  "cypress",
  "daisy",
  "dawn",
  "delta",
  "desert",
  "dolphin",
  "dove",
  "dragonfly",
  "driftwood",
  "dune",
  "eagle",
  "echo",
  "elm",
  "ember",
  "emerald",
  "estuary",
  "falcon",
  "fawn",
  "fern",
  "finch",
  "fjord",
  "flint",
  "foxglove",
  "frontier",
  "garnet",
  "gecko",
  "glacier",
  "glen",
  "granite",
  "grove",
  "gull",
  "harbor",
  "hawk",
  "hazel",
  "heather",
  "hedgehog",
  "hemlock",
  "heron",
  "holly",
  "horizon",
  "hornet",
  "iceberg",
  "indigo",
  "island",
  "ivory",
  "ivy",
  "jade",
  "jaguar",
  "jasmine",
  "juniper",
  "kelp",
  "kestrel",
  "lagoon",
  "larch",
  "lark",
  "laurel",
  "lava",
  "leopard",
  "lilac",
  "lily",
  "linden",
  "lodestar",
  "lotus",
  "lunar",
  "magnolia",
  "mallard",
  "maple",
  "marble",
  "marlin",
  "meadow",
  "meridian",
  "mesa",
  "meteor",
  "mistral",
  "monarch",
  "monsoon",
  "moose",
  "moss",
  "mulberry",
  "narwhal",
  "nebula",
  "nightingale",
  "northstar",
  "oak",
  "oasis",
  "obsidian",
  "ocean",
  "olive",
  "onyx",
  "opal",
  "orchid",
  "oriole",
  "osprey",
  "otter",
  "owl",
  "palm",
  "panther",
  "papyrus",
  "pebble",
  "pelican",
  "penguin",
  "pepper",
  "peridot",
  "petrel",
  "pine",
  "pinnacle",
  "pioneer",
  "plover",
  "plum",
  "polaris",
  "poplar",
  "poppy",
  "prairie",
  "puffin",
  "quartz",
  "quasar",
  "quill",
  "rabbit",
  "raccoon",
  "rain",
  "raven",
  "redwood",
  "reed",
  "ridge",
  "river",
  "robin",
  "rosewood",
  "rowan",
  "sage",
  "salmon",
  "sandpiper",
  "sapphire",
  "savanna",
  "sequoia",
  "shadow",
  "sherwood",
  "sierra",
  "silver",
  "skylark",
  "slate",
  "snowdrop",
  "solar",
  "sparrow",
  "spruce",
  "starling",
  "summit",
  "sunflower",
  "swallow",
  "sycamore",
  "tamarack",
  "teal",
  "tempest",
  "terra",
  "thistle",
  "thorn",
  "thunder",
  "tide",
  "timber",
  "topaz",
  "tornado",
  "trail",
  "trillium",
  "tundra",
];

/** NANP area codes; combined with the reserved 555-01xx fictional block. */
const FAKE_AREA_CODES = [
  201, 202, 203, 205, 206, 207, 208, 209, 210, 212, 213, 214, 215, 216, 217, 218, 219, 224, 225,
  228, 229, 231, 234, 239, 240, 248, 251, 252, 253, 254, 256, 260, 262, 267, 269, 270, 272, 276,
  281, 301, 302, 303, 304, 305, 307, 308, 309, 310, 312, 313, 314, 315, 316, 317, 318, 319, 320,
  321, 323, 325, 330, 331, 334, 336, 337, 339, 346, 351, 352, 360, 361, 364, 380, 385, 386, 401,
  402, 404, 405, 406, 407, 408, 409, 410, 412, 413, 414, 415, 417, 419, 423, 424, 425, 430, 432,
  434, 435, 440, 442, 443, 458, 469, 470, 475, 478, 479, 480, 484, 501, 502, 503, 504, 505, 507,
  508, 509, 510, 512, 513, 515, 516, 517, 518, 520, 530, 531, 540, 541, 551, 559, 561, 562, 563,
  564, 567, 570, 571, 573, 574, 575, 580, 585, 586, 601, 602, 603, 605, 606, 607, 608, 609, 610,
  612, 614, 615, 616, 617, 618, 619, 620, 623, 626, 628, 629, 630, 631, 636, 641, 646, 650, 651,
  657, 660, 661, 662, 667, 669, 678, 681, 682, 701, 702, 703, 704, 706, 707, 708, 712, 713, 714,
  715, 716, 717, 718, 719, 720, 724, 725, 727, 731, 732, 734, 737, 740, 743, 747, 754, 757, 760,
  762, 763, 765, 769, 770, 772, 773,
];

async function fakeEmail(value: string, salt: string): Promise<string> {
  const token = await stableToken(value, salt);
  // .invalid is reserved by RFC 2606 — masked addresses can never receive mail.
  const domain = FAKE_EMAIL_DOMAINS[tokenIndex(token, 16, FAKE_EMAIL_DOMAINS.length)];
  return `user${token.slice(0, 16)}@${domain}.invalid`;
}

async function fakeName(value: string, salt: string): Promise<string> {
  const token = await stableToken(value, salt);
  const first = FAKE_FIRST_NAMES[tokenIndex(token, 0, FAKE_FIRST_NAMES.length)];
  const last = FAKE_LAST_NAMES[tokenIndex(token, 12, FAKE_LAST_NAMES.length)];
  return `${first} ${last}`;
}

async function fakePhone(value: string, salt: string): Promise<string> {
  // 555-01xx is the fictional number block, so no real subscriber is hit.
  const token = await stableToken(value, salt);
  const area = FAKE_AREA_CODES[tokenIndex(token, 0, FAKE_AREA_CODES.length)];
  const line = tokenIndex(token, 12, 100);
  return `${area}-555-01${String(line).padStart(2, "0")}`;
}

async function noisyNumber(value: number, salt: string): Promise<number> {
  const token = await stableToken(String(value), salt);
  // Deterministic jitter within ±15%.
  const factor = 0.85 + (tokenIndex(token, 0, 1000) / 1000) * 0.3;
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
        next[columnIndex] = await anonymizeValue(next[columnIndex] ?? null, strategy, salt);
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
