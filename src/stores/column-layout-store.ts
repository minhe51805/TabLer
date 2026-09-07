export interface PersistedColumnLayout {
  order: string[];
  visibility: Record<string, boolean>;
  pinning: { left: string[]; right: string[] };
  sort: { column: string; direction: "ASC" | "DESC" } | null;
  filter: string;
}

const STORAGE_KEY = "tabler.column-layouts.v1";

const EMPTY_LAYOUT: PersistedColumnLayout = {
  order: [],
  visibility: {},
  pinning: { left: ["_row_num"], right: [] },
  sort: null,
  filter: "",
};

type LayoutCollection = Record<string, PersistedColumnLayout>;
let cache: LayoutCollection | null = null;

export function buildColumnLayoutScopeKey(
  connectionId: string,
  tableName: string,
  database?: string,
): string {
  return JSON.stringify([connectionId, database ?? "", tableName]);
}

function loadCollection(): LayoutCollection {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as LayoutCollection;
    cache = parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    cache = {};
  }
  return cache;
}

function cloneLayout(layout?: Partial<PersistedColumnLayout>): PersistedColumnLayout {
  return {
    order: [...(layout?.order ?? EMPTY_LAYOUT.order)],
    visibility: { ...(layout?.visibility ?? EMPTY_LAYOUT.visibility) },
    pinning: {
      left: [...(layout?.pinning?.left ?? EMPTY_LAYOUT.pinning.left)],
      right: [...(layout?.pinning?.right ?? EMPTY_LAYOUT.pinning.right)],
    },
    sort: layout?.sort ? { ...layout.sort } : null,
    filter: layout?.filter ?? "",
  };
}

export function getColumnLayout(
  connectionId: string,
  tableName: string,
  database?: string,
): PersistedColumnLayout {
  return cloneLayout(loadCollection()[buildColumnLayoutScopeKey(connectionId, tableName, database)]);
}

export function saveColumnLayout(
  connectionId: string,
  tableName: string,
  layout: PersistedColumnLayout,
  database?: string,
): void {
  const collection = loadCollection();
  collection[buildColumnLayoutScopeKey(connectionId, tableName, database)] = cloneLayout(layout);
  cache = collection;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(collection));
  } catch {
    // Storage exhaustion must not make the grid unusable.
  }
}

export function clearColumnLayout(
  connectionId: string,
  tableName: string,
  database?: string,
): void {
  const collection = loadCollection();
  delete collection[buildColumnLayoutScopeKey(connectionId, tableName, database)];
  cache = collection;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(collection));
  } catch {
    // Ignore storage failures; the in-memory reset still applies.
  }
}

export function resetColumnLayoutCacheForTests(): void {
  cache = null;
}

