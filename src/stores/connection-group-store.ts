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
  // Unassign connections in this group
  const connections = getAllConnections();
  const updated = connections.map((c) =>
    c.groupId === id ? { ...c, groupId: undefined } : c,
  );
  saveAllConnections(updated);
  // Remove from collapsed
  const collapsed = loadCollapsed();
  collapsed.delete(id);
  saveCollapsed(collapsed);
}

export function assignConnectionToGroup(connectionId: string, groupId: string | null): void {
  const connections = getAllConnections();
  const updated = connections.map((c) =>
    c.id === connectionId ? { ...c, groupId: groupId ?? undefined } : c,
  );
  saveAllConnections(updated);
}

export function assignConnectionToTag(connectionId: string, tagId: string | null): void {
  const connections = getAllConnections();
  const updated = connections.map((c) =>
    c.id === connectionId ? { ...c, tagId: tagId ?? undefined } : c,
  );
  saveAllConnections(updated);
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

// ─── Connection storage access ────────────────────────────────────────────────

function getAllConnections(): ConnectionConfig[] {
  try {
    const raw = window.localStorage.getItem("tabler.connections");
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveAllConnections(connections: ConnectionConfig[]): void {
  window.localStorage.setItem("tabler.connections", JSON.stringify(connections));
}
