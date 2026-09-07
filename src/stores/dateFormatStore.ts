import { create } from "zustand";
import { persist } from "zustand/middleware";

/** Default date formats per database engine */
export const DEFAULT_DATE_FORMATS: Record<string, string> = {
  postgresql: "yyyy-MM-dd",
  mysql:      "%Y-%m-%d",
  sqlite:     "YYYY-MM-DD",
  mssql:      "yyyy-MM-dd",
  clickhouse: "yyyy-MM-dd",
  default:    "yyyy-MM-dd",
};

export type DateFormatConfig = {
  /** The active format string for the current connection */
  connectionFormats: Record<string, string>;
  /** Global fallback format */
  globalFormat: string;
  /** Whether to use database-native format (no reformatting) */
  useNativeFormat: boolean;
};

const DEFAULT_CONFIG: DateFormatConfig = {
  connectionFormats: {},
  globalFormat: "yyyy-MM-dd",
  useNativeFormat: false,
};

function loadConfig(): DateFormatConfig {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      return { ...DEFAULT_CONFIG, ...JSON.parse(stored) };
    }
  } catch {
    // ignore
  }
  return DEFAULT_CONFIG;
}

function saveConfig(config: DateFormatConfig) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    // ignore
  }
}

const STORAGE_KEY = "tabler.date-format";

interface DateFormatState {
  config: DateFormatConfig;
  /** Get the format string for a given connection + dbType */
  getFormat: (connectionId: string, dbType?: string) => string;
  /** Set format for a specific connection */
  setConnectionFormat: (connectionId: string, format: string) => void;
  /** Set the global fallback format */
  setGlobalFormat: (format: string) => void;
  /** Toggle native format mode */
  setUseNativeFormat: (useNative: boolean) => void;
  /** Reset connection format to default for dbType */
  resetConnectionFormat: (connectionId: string, dbType: string) => void;
  /** Available format token info */
  formatTokens: readonly { token: string; description: string; example: string }[];
}

/** Format token documentation */
export const FORMAT_TOKENS = [
  { token: "yyyy", description: "Full year (4 digits)", example: "2026" },
  { token: "yy",   description: "Short year (2 digits)",   example: "26" },
  { token: "MM",   description: "Month (2 digits)",        example: "04" },
  { token: "MMM",  description: "Month abbreviation",    example: "Apr" },
  { token: "MMMM", description: "Full month name",         example: "April" },
  { token: "dd",   description: "Day (2 digits)",         example: "05" },
  { token: "d",    description: "Day (1-2 digits)",       example: "5" },
  { token: "HH",   description: "Hours 24h (2 digits)",  example: "14" },
  { token: "hh",   description: "Hours 12h (2 digits)",   example: "02" },
  { token: "mm",   description: "Minutes",               example: "30" },
  { token: "ss",   description: "Seconds",               example: "45" },
  { token: "SSS",  description: "Milliseconds",           example: "123" },
  { token: "a",    description: "AM/PM marker",           example: "PM" },
  { token: "Z",    description: "Timezone offset",         example: "+07:00" },
  // MySQL format tokens (may coexist)
  { token: "%Y",   description: "MySQL year (4 digits)", example: "2026" },
  { token: "%m",   description: "MySQL month (2 digits)", example: "04" },
  { token: "%d",   description: "MySQL day (2 digits)",   example: "05" },
  { token: "%H",   description: "MySQL hour (24h)",       example: "14" },
  { token: "%i",   description: "MySQL minutes",          example: "30" },
  { token: "%s",   description: "MySQL seconds",           example: "45" },
] as const;

/** Format a JavaScript Date using a custom format string */
export function formatDate(value: Date, format: string): string {
  // Replace tokens in descending length order to avoid partial matches
  // e.g., "MMM" before "MM", "MMMM" before "MMM"/"MM"
  const replacements: [string, string][] = [
    ["MMMM", LONG_MONTH_NAMES[value.getMonth()] ?? ""],
    ["MMM", SHORT_MONTH_NAMES[value.getMonth()] ?? ""],
    ["yyyy", String(value.getFullYear())],
    ["yy", String(value.getFullYear()).slice(-2)],
    ["dd", pad(value.getDate())],
    ["HH", pad(value.getHours())],
    ["hh", pad(value.getHours() % 12 || 12)],
    ["mm", pad(value.getMinutes())],
    ["ss", pad(value.getSeconds())],
    ["SSS", String(value.getMilliseconds()).padStart(3, "0")],
    ["d", String(value.getDate())],
    ["MM", pad(value.getMonth() + 1)],
    ["a", value.getHours() < 12 ? "AM" : "PM"],
    ["Z", getTimezoneOffset(value)],
    // MySQL compat tokens
    ["%Y", String(value.getFullYear())],
    ["%m", pad(value.getMonth() + 1)],
    ["%d", pad(value.getDate())],
    ["%H", pad(value.getHours())],
    ["%i", pad(value.getMinutes())],
    ["%s", pad(value.getSeconds())],
  ];

  let result = format;
  for (const [token, replacement] of replacements) {
    result = result.split(token).join(replacement);
  }
  return result;
}

/** Parse a date string (ISO 8601 / common DB formats) into a JS Date */
export function parseDate(value: string): Date | null {
  if (!value) return null;
  // Try ISO 8601
  const iso = Date.parse(value);
  if (!isNaN(iso)) return new Date(iso);
  // Try common DB datetime: "2026-04-05 14:30:00"
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})\s+T?(\d{2}):?(\d{2}):?(\d{2})?/);
  if (m) {
    return new Date(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4] ?? 0),
      Number(m[5] ?? 0),
      Number(m[6] ?? 0)
    );
  }
  return null;
}

/** Format token arrays */
const LONG_MONTH_NAMES = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December"
];
const SHORT_MONTH_NAMES = [
  "Jan","Feb","Mar","Apr","May","Jun",
  "Jul","Aug","Sep","Oct","Nov","Dec"
];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function getTimezoneOffset(date: Date): string {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const absH = Math.floor(Math.abs(offset) / 60);
  const absM = Math.abs(offset) % 60;
  return `${sign}${pad(absH)}:${pad(absM)}`;
}

/** Get the default format for a database type */
export function getDefaultFormat(dbType: string): string {
  const key = dbType?.toLowerCase() ?? "default";
  return DEFAULT_DATE_FORMATS[key] ?? DEFAULT_DATE_FORMATS.default;
}

/** Preview: show an example formatted date for a format string */
export function formatDatePreview(format: string): string {
  return formatDate(new Date(2026, 3, 5, 14, 30, 45, 123), format);
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

let cachedConfig: DateFormatConfig | null = null;

export const useDateFormatStore = create<DateFormatState>()(
  persist(
    (set, get) => ({
      config: (() => {
        if (!cachedConfig) {
          cachedConfig = loadConfig();
        }
        return cachedConfig;
      })(),

      getFormat: (connectionId, dbType) => {
        const { config } = get();
        if (config.useNativeFormat) return "";
        if (connectionId && config.connectionFormats[connectionId]) {
          return config.connectionFormats[connectionId];
        }
        return dbType ? getDefaultFormat(dbType) : config.globalFormat;
      },

      setConnectionFormat: (connectionId, format) => {
        set((state) => {
          const next = {
            ...state.config,
            connectionFormats: {
              ...state.config.connectionFormats,
              [connectionId]: format,
            },
          };
          cachedConfig = next;
          saveConfig(next);
          return { config: next };
        });
      },

      setGlobalFormat: (format) => {
        set((state) => {
          const next = { ...state.config, globalFormat: format };
          cachedConfig = next;
          saveConfig(next);
          return { config: next };
        });
      },

      setUseNativeFormat: (useNative) => {
        set((state) => {
          const next = { ...state.config, useNativeFormat: useNative };
          cachedConfig = next;
          saveConfig(next);
          return { config: next };
        });
      },

      resetConnectionFormat: (connectionId, _dbType) => {
        set((state) => {
          const next = {
            ...state.config,
            connectionFormats: {
              ...state.config.connectionFormats,
            },
          };
          delete next.connectionFormats[connectionId];
          cachedConfig = next;
          saveConfig(next);
          return { config: next };
        });
      },

      formatTokens: FORMAT_TOKENS,
    }),
    {
      name: STORAGE_KEY,
      partialize: (state) => ({ config: state.config }),
    }
  )
);