/**
 * Favorite folders — frontend-only grouping for SQL favorites.
 *
 * The backend `SqlFavorite` model (src-tauri/src/storage/sql_favorites.rs) has
 * no folder field, so folder definitions and favorite→folder assignments live
 * in localStorage, mirroring the connection-group pattern in
 * `connection-group-store.ts`.
 */

export interface FavoriteFolder {
  id: string;
  name: string;
}

const STORAGE_KEY = "tabler.favoriteFolders";
const ASSIGNMENT_KEY = "tabler.favoriteFolderAssignments";
const COLLAPSED_KEY = "tabler.collapsedFavoriteFolderIds";

type AssignmentMap = Record<string, string>;

// ─── Storage helpers ───────────────────────────────────────────────────────────

function loadFolders(): FavoriteFolder[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (f): f is FavoriteFolder => !!f && typeof f.id === "string" && typeof f.name === "string",
    );
  } catch (error) {
    console.warn("[FavoriteFolders] Failed to load folders:", error);
    return [];
  }
}

function saveFolders(folders: FavoriteFolder[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(folders));
  } catch {
    /* storage unavailable — state still applies for this session */
  }
}

function loadAssignments(): AssignmentMap {
  try {
    const raw = window.localStorage.getItem(ASSIGNMENT_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as AssignmentMap).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0,
      ),
    );
  } catch (error) {
    console.warn("[FavoriteFolders] Failed to read assignments:", error);
    return {};
  }
}

function saveAssignments(assignments: AssignmentMap): void {
  try {
    window.localStorage.setItem(ASSIGNMENT_KEY, JSON.stringify(assignments));
  } catch {
    /* storage unavailable */
  }
}

function loadCollapsed(): Set<string> {
  try {
    const raw = window.localStorage.getItem(COLLAPSED_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch (error) {
    console.warn("[FavoriteFolders] Failed to load collapsed state:", error);
    return new Set();
  }
}

function saveCollapsed(ids: Set<string>): void {
  try {
    window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...ids]));
  } catch {
    /* storage unavailable */
  }
}

// ─── Folder CRUD ──────────────────────────────────────────────────────────────

export function getFavoriteFolders(): FavoriteFolder[] {
  return loadFolders();
}

export function createFavoriteFolder(name: string): FavoriteFolder {
  const folders = loadFolders();
  const folder: FavoriteFolder = { id: crypto.randomUUID(), name };
  folders.push(folder);
  saveFolders(folders);
  return folder;
}

export function renameFavoriteFolder(id: string, name: string): FavoriteFolder | null {
  const folders = loadFolders();
  const folder = folders.find((f) => f.id === id);
  if (!folder) return null;
  folder.name = name;
  saveFolders(folders);
  return folder;
}

/** Deletes the folder; favorites assigned to it become ungrouped. */
export function deleteFavoriteFolder(id: string): void {
  saveFolders(loadFolders().filter((f) => f.id !== id));
  const assignments = loadAssignments();
  for (const [favoriteId, folderId] of Object.entries(assignments)) {
    if (folderId === id) delete assignments[favoriteId];
  }
  saveAssignments(assignments);
  const collapsed = loadCollapsed();
  collapsed.delete(id);
  saveCollapsed(collapsed);
}

// ─── Assignments ──────────────────────────────────────────────────────────────

export function getFavoriteFolderAssignments(): AssignmentMap {
  return loadAssignments();
}

/** Assign a favorite to a folder (null clears the assignment). */
export function assignFavoriteToFolder(favoriteId: string, folderId: string | null): void {
  const assignments = loadAssignments();
  if (folderId) assignments[favoriteId] = folderId;
  else delete assignments[favoriteId];
  saveAssignments(assignments);
}

/** Drop a favorite's folder assignment — call when the favorite is deleted. */
export function removeFavoriteAssignment(favoriteId: string): void {
  const assignments = loadAssignments();
  if (!(favoriteId in assignments)) return;
  delete assignments[favoriteId];
  saveAssignments(assignments);
}

// ─── Collapse state ───────────────────────────────────────────────────────────

export function getCollapsedFavoriteFolderIds(): Set<string> {
  return loadCollapsed();
}

export function toggleFavoriteFolderCollapse(id: string): boolean {
  const collapsed = loadCollapsed();
  const isCollapsed = collapsed.has(id);
  if (isCollapsed) {
    collapsed.delete(id);
  } else {
    collapsed.add(id);
  }
  saveCollapsed(collapsed);
  return !isCollapsed;
}
