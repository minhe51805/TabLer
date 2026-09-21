export interface ConnectionTag {
  id: string;
  name: string;
  color: string;
}

const STORAGE_KEY = "tabler.connectionTags";

function loadTags(): ConnectionTag[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (error) {
    console.warn("[ConnectionTags] Failed to load tags:", error);
    return [];
  }
}

function saveTags(tags: ConnectionTag[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(tags));
  } catch (error) {
    console.warn("[ConnectionTags] Failed to persist tags:", error);
  }
}

export function getTags(): ConnectionTag[] {
  return loadTags();
}

export function createTag(name: string, color: string): ConnectionTag {
  const tags = loadTags();
  const tag: ConnectionTag = { id: crypto.randomUUID(), name, color };
  tags.push(tag);
  saveTags(tags);
  return tag;
}

export function renameTag(id: string, name: string): ConnectionTag | null {
  const tags = loadTags();
  const tag = tags.find((t) => t.id === id);
  if (!tag) return null;
  tag.name = name;
  saveTags(tags);
  return tag;
}

export function changeTagColor(id: string, color: string): ConnectionTag | null {
  const tags = loadTags();
  const tag = tags.find((t) => t.id === id);
  if (!tag) return null;
  tag.color = color;
  saveTags(tags);
  return tag;
}

export function deleteTag(id: string): void {
  saveTags(loadTags().filter((t) => t.id !== id));
}
