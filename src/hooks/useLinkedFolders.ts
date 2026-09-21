import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface FileEventPayload {
  path: string;
  kind: string; // 'created' | 'modified' | 'removed'
}
/**
 * Resolve the workspace directory for per-project agent resources (rules,
 * skills, commands): the first linked folder, or null when none is linked.
 * Linked folders are a global list, so this is a plain fetch rather than a
 * hook — call sites outside React render (agent run paths) can await it.
 */
export async function getLinkedWorkspaceDir(): Promise<string | null> {
  try {
    const folders = await invoke<string[]>("get_linked_folders");
    return folders[0] ?? null;
  } catch (e) {
    console.error("Failed to resolve linked workspace dir:", e);
    return null;
  }
}

export function useLinkedFolders() {
  const [folders, setFolders] = useState<string[]>([]);
  const [lastEvent, setLastEvent] = useState<FileEventPayload | null>(null);

  const fetchFolders = useCallback(async () => {
    try {
      const result = await invoke<string[]>("get_linked_folders");
      setFolders(result);
    } catch (e) {
      console.error("Failed to get linked folders:", e);
    }
  }, []);

  const addFolder = useCallback(
    async (path: string) => {
      try {
        await invoke("add_linked_folder", { path });
        await fetchFolders();
      } catch (e) {
        console.error("Failed to add linked folder:", e);
        throw e;
      }
    },
    [fetchFolders],
  );

  const removeFolder = useCallback(
    async (path: string) => {
      try {
        await invoke("remove_linked_folder", { path });
        await fetchFolders();
      } catch (e) {
        console.error("Failed to remove linked folder:", e);
        throw e;
      }
    },
    [fetchFolders],
  );

  useEffect(() => {
    fetchFolders();

    const unlistenPromise = listen<FileEventPayload>("linked-folder-change", (event) => {
      // Trigger a re-fetch or state update
      setLastEvent(event.payload);
      // Let the consumer of this hook decide what to do and refresh lists if needed
    });

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [fetchFolders]);

  return {
    folders,
    lastEvent,
    addFolder,
    removeFolder,
    refreshFolders: fetchFolders,
  };
}
