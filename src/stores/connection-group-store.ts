import type { ConnectionConfig } from "../types";

export interface ConnectionGroup {
  id: string;
  name: string;
  color: string;
}

const STORAGE_KEY = "tabler.connectionGroups";
const COLLAPSED_KEY = "tabler.collapsedGroupIds";

// ─── Storage helpers ───────────────────────────────────────────────────────────

function loadGroups(): ConnectionGroup[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveGroups(groups: ConnectionGroup[]): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(groups));
}

function loadCollapsed(): Set<string> {
  try {
    const raw = window.localStorage.getItem(COLLAPSED_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set();
  }
}

function saveCollapsed(ids: Set<string>): void {
  window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...ids]));
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

export function getGroups(): ConnectionGroup[] {
  return loadGroups();
}

export function createGroup(name: string, color: string): ConnectionGroup {
  const groups = loadGroups();
  const group: ConnectionGroup = { id: crypto.randomUUID(), name, color };
  groups.push(group);
  saveGroups(groups);
  return group;
}

export function renameGroup(id: string, name: string): ConnectionGroup | null {
  const groups = loadGroups();
  const group = groups.find((g) => g.id === id);
  if (!group) return null;
  group.name = name;
  saveGroups(groups);
  return group;
}

export function changeGroupColor(id: string, color: string): ConnectionGroup | null {
  const groups = loadGroups();
  const group = groups.find((g) => g.id === id);
  if (!group) return null;
  group.color = color;
  saveGroups(groups);
  return group;
}

export function deleteGroup(id: string): void {
  saveGroups(loadGroups().filter((g) => g.id !== id));
  const groups = loadGroupAssignments();
  for (const [connectionId, groupId] of Object.entries(groups)) {
    if (groupId === id) delete groups[connectionId];
  }
  saveGroupAssignments(groups);
  patchLiveConnections((connection) =>
    connection.groupId === id ? { ...connection, groupId: undefined } : connection,
  );
  const collapsed = loadCollapsed();
  collapsed.delete(id);
  saveCollapsed(collapsed);
}

export function assignConnectionToGroup(connectionId: string, groupId: string | null): void {
  const groups = loadGroupAssignments();
  if (groupId) groups[connectionId] = groupId;
  else delete groups[connectionId];
  saveGroupAssignments(groups);
  patchLiveConnections((connection) =>
    connection.id === connectionId ? { ...connection, groupId: groupId ?? undefined } : connection,
  );
}

export function assignConnectionToTag(connectionId: string, tagId: string | null): void {
  const tags = loadTagAssignments();
  if (tagId) tags[connectionId] = tagId;
  else delete tags[connectionId];
  saveTagAssignments(tags);
  patchLiveConnections((connection) =>
    connection.id === connectionId ? { ...connection, tagId: tagId ?? undefined } : connection,
  );
}

export function applyConnectionAssignments(connections: ConnectionConfig[]): ConnectionConfig[] {
  migrateLegacyConnectionAssignments();
  const groups = loadGroupAssignments();
  const tags = loadTagAssignments();
  return connections.map((connection) => ({
    ...connection,
    groupId: groups[connection.id] ?? connection.groupId,
    tagId: tags[connection.id] ?? connection.tagId,
  }));
}

// ─── Collapse state ───────────────────────────────────────────────────────────

export function getCollapsedGroupIds(): Set<string> {
  return loadCollapsed();
}

export function toggleGroupCollapse(id: string): boolean {
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

export function setGroupCollapsed(id: string, collapsed: boolean): void {
  const ids = loadCollapsed();
  if (collapsed) {
    ids.add(id);
  } else {
    ids.delete(id);
  }
  saveCollapsed(ids);
}

// ─── Connection assignment storage ────────────────────────────────────────────

const GROUP_ASSIGNMENT_KEY = "tabler.connectionGroupAssignments";
const TAG_ASSIGNMENT_KEY = "tabler.connectionTagAssignments";
const LEGACY_CONNECTIONS_KEY = "tabler.connections";

type AssignmentMap = Record<string, string>;

function readAssignmentMap(key: string): AssignmentMap {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as AssignmentMap).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0,
      ),
    );
  } catch {
    return {};
  }
}

function loadGroupAssignments(): AssignmentMap {
  return readAssignmentMap(GROUP_ASSIGNMENT_KEY);
}

function saveGroupAssignments(assignments: AssignmentMap): void {
  window.localStorage.setItem(GROUP_ASSIGNMENT_KEY, JSON.stringify(assignments));
}

function loadTagAssignments(): AssignmentMap {
  return readAssignmentMap(TAG_ASSIGNMENT_KEY);
}

function saveTagAssignments(assignments: AssignmentMap): void {
  window.localStorage.setItem(TAG_ASSIGNMENT_KEY, JSON.stringify(assignments));
}

function migrateLegacyConnectionAssignments(): void {
  if (typeof window === "undefined") return;
  if (window.localStorage.getItem(GROUP_ASSIGNMENT_KEY) || window.localStorage.getItem(TAG_ASSIGNMENT_KEY)) {
    return;
  }
  try {
    const raw = window.localStorage.getItem(LEGACY_CONNECTIONS_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Array<{ id?: string; groupId?: string; tagId?: string }>;
    if (!Array.isArray(parsed)) return;
    const groups: AssignmentMap = {};
    const tags: AssignmentMap = {};
    for (const connection of parsed) {
      if (!connection?.id) continue;
      if (connection.groupId) groups[connection.id] = connection.groupId;
      if (connection.tagId) tags[connection.id] = connection.tagId;
    }
    if (Object.keys(groups).length > 0) saveGroupAssignments(groups);
    if (Object.keys(tags).length > 0) saveTagAssignments(tags);
  } catch {
    // ignore corrupt legacy payloads
  }
}

function patchLiveConnections(
  update: (connection: ConnectionConfig) => ConnectionConfig,
): void {
  void import("./connectionStore").then(({ useConnectionStore }) => {
    const { connections } = useConnectionStore.getState();
    useConnectionStore.setState({ connections: connections.map(update) });
  });
}
