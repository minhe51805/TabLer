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

export function getTags(): ConnectionTag[] {
  return loadTags();
}
