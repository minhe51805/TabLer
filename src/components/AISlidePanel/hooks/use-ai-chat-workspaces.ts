import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  inferDatabaseFromWorkspaceName,
  selectActiveAIChatWorkspace,
  useAIChatWorkspaceStore,
} from "../../../stores/aiChatWorkspaceStore";
import { useConnectionStore } from "../../../stores/connectionStore";
import { invokeMutation } from "../../../utils/tauri-utils";
import { buildAIWorkspaceKey, createChatThread, type AIChatThread } from "../ai-conversation-state";
import type { getAIWorkspaceCopy } from "../ai-workspace-copy";

export interface ThreadMemoryEntry {
  title: string;
  keywords: string[];
  summary: string;
}

interface UseAIChatWorkspacesOptions {
  connectionId: string | null;
  currentDatabase: string | null;
  isOpen: boolean;
  isGenerating: boolean;
  isRunning: boolean;
  historyHydrated: boolean;
  aiCopy: ReturnType<typeof getAIWorkspaceCopy>;
}

/**
 * Chat-workspace lifecycle: the store subscription, database re-scoping on
 * activation, workspace CRUD, and hydration of compacted digests + thread
 * memories from the SQLite cache. A chat workspace owns its database context
 * (like separate SSMS windows), so activating one re-scopes the connection.
 */
export function useAIChatWorkspaces({
  connectionId,
  currentDatabase,
  isOpen,
  isGenerating,
  isRunning,
  historyHydrated,
  aiCopy,
}: UseAIChatWorkspacesOptions) {
  const chatWorkspaces = useAIChatWorkspaceStore((state) => state.workspaces);
  const activeChatWorkspaceId = useAIChatWorkspaceStore((state) => state.activeWorkspaceId);
  const createChatWorkspace = useAIChatWorkspaceStore((state) => state.createWorkspace);
  const renameChatWorkspace = useAIChatWorkspaceStore((state) => state.renameWorkspace);
  const deleteChatWorkspace = useAIChatWorkspaceStore((state) => state.deleteWorkspace);
  const setActiveChatWorkspace = useAIChatWorkspaceStore((state) => state.setActiveWorkspace);
  const saveChatContextDigest = useAIChatWorkspaceStore((state) => state.saveContextDigest);
  const hydrateChatContextDigests = useAIChatWorkspaceStore((state) => state.hydrateDigests);
  const bindChatWorkspaceDatabase = useAIChatWorkspaceStore((state) => state.bindWorkspaceDatabase);
  const chatDatabaseCatalog = useConnectionStore((state) => state.databases);

  const [threadMemories, setThreadMemories] = useState<Record<string, ThreadMemoryEntry>>({});

  const activeChatWorkspace = useMemo(
    () =>
      selectActiveAIChatWorkspace({
        workspaces: chatWorkspaces,
        activeWorkspaceId: activeChatWorkspaceId,
      }),
    [chatWorkspaces, activeChatWorkspaceId],
  );
  const currentWorkspaceKey = useMemo(
    () => buildAIWorkspaceKey(connectionId, currentDatabase, activeChatWorkspaceId),
    [connectionId, currentDatabase, activeChatWorkspaceId],
  );
  const lastWorkspaceKeyRef = useRef(currentWorkspaceKey);
  const initialThreadRef = useRef<AIChatThread | null>(null);
  if (!initialThreadRef.current) {
    initialThreadRef.current = createChatThread(1, currentWorkspaceKey);
  }

  // A chat workspace owns its database context (like separate SSMS windows):
  // activating a workspace must re-scope the connection to that workspace's
  // database so tables/schemaObjects and the AI schema capsule follow it.
  const ensureWorkspaceDatabase = useCallback(
    (workspaceId: string | null) => {
      if (!workspaceId || !connectionId) return;
      const workspace = chatWorkspaces.find((item) => item.id === workspaceId);
      if (!workspace) return;

      void (async () => {
        let boundDatabase = workspace.database ?? null;
        let catalog = chatDatabaseCatalog;

        // The catalog may be empty right after an app restart (the connection
        // store keeps no per-session database list until it is fetched); legacy
        // workspaces also need it to backfill their database from the name.
        if (!boundDatabase || catalog.length === 0) {
          if (catalog.length === 0) {
            await useConnectionStore.getState().fetchDatabases(connectionId);
            catalog = useConnectionStore.getState().databases;
          }
          if (!boundDatabase) {
            const inferred = inferDatabaseFromWorkspaceName(workspace.name, catalog);
            if (inferred) {
              boundDatabase = inferred;
              bindChatWorkspaceDatabase(workspace.id, inferred);
            }
          }
        }

        if (!boundDatabase) return;
        // The workspace is bound to a database this server does not expose
        // (e.g. the binding came from a different connection): leave the
        // current context untouched instead of erroring on `use_database`.
        if (catalog.length > 0 && !catalog.some((item) => item.name === boundDatabase)) return;
        if (boundDatabase === useConnectionStore.getState().currentDatabase) return;
        await useConnectionStore.getState().switchDatabase(connectionId, boundDatabase);
      })();
    },
    [bindChatWorkspaceDatabase, chatDatabaseCatalog, chatWorkspaces, connectionId],
  );

  const handleSelectChatWorkspace = useCallback(
    (workspaceId: string | null) => {
      setActiveChatWorkspace(workspaceId);
      ensureWorkspaceDatabase(workspaceId);
    },
    [ensureWorkspaceDatabase, setActiveChatWorkspace],
  );

  // Re-scopes the database once per workspace activation (panel open or
  // workspace switch); manual database changes elsewhere are never reverted.
  const syncedWorkspaceIdRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!isOpen) return;
    if (syncedWorkspaceIdRef.current === activeChatWorkspaceId) return;
    syncedWorkspaceIdRef.current = activeChatWorkspaceId;
    // Only adopt the workspace's own database when the connection has no active
    // database yet. If the user already selected a database (e.g. from the
    // sidebar), that explicit choice is authoritative: merely opening the panel
    // must not silently re-scope the shared connection session — on SQL Server
    // a single session backs the whole workspace, so overriding it here makes
    // the AI read a database the user never picked. Explicitly switching chat
    // workspaces (handleSelectChatWorkspace) still re-scopes on purpose.
    if (useConnectionStore.getState().currentDatabase) return;
    ensureWorkspaceDatabase(activeChatWorkspaceId);
  }, [activeChatWorkspaceId, ensureWorkspaceDatabase, isOpen]);

  const handleCreateUserWorkspace = useCallback(() => {
    // New workspaces start unbound (database: null) — NOT bound to the current
    // database. Binding at creation time is what made every later activation
    // yank the connection back to that database. The user can pin a database
    // via the switcher's DB chip; naming the workspace "db C" also binds it
    // via name inference.
    createChatWorkspace(
      `${aiCopy.workspace.defaultName} ${chatWorkspaces.length + 1}`,
      connectionId,
      null,
    );
  }, [aiCopy.workspace.defaultName, chatWorkspaces.length, connectionId, createChatWorkspace]);

  // Rebind (or unbind) a workspace's database from the switcher's DB chip.
  // Binding to a new database also clears the workspace's compacted digest
  // (store handles that) so the old database's context cannot leak through.
  const handleRebindChatWorkspaceDatabase = useCallback(
    (workspaceId: string, database: string) => {
      // Audit fix: rebinding re-scopes the connection/schema immediately, which
      // would make an in-flight agent run read evidence from a database it never
      // verified. The switcher chip is disabled during runs; this guard is the
      // backstop for programmatic calls.
      if (isGenerating || isRunning) {
        console.warn("[AIWorkspace] Rebind ignored while an agent run is active.");
        return;
      }
      bindChatWorkspaceDatabase(workspaceId, database);
      if (database) {
        // Re-scope the connection immediately so the schema capsule and
        // tables/schemaObjects follow the new binding.
        ensureWorkspaceDatabase(workspaceId);
      }
    },
    [bindChatWorkspaceDatabase, ensureWorkspaceDatabase, isGenerating, isRunning],
  );

  const handleDeleteUserWorkspace = useCallback(
    (workspaceId: string) => {
      deleteChatWorkspace(workspaceId);
      invokeMutation("delete_workspace_context_snapshots", { workspaceId }).catch(
        (error: unknown) => console.error("[AIWorkspace] Failed to delete workspace cache:", error),
      );
      invokeMutation("delete_thread_memories_for_workspace", { workspaceId }).catch(
        (error: unknown) =>
          console.error("[AIWorkspace] Failed to delete workspace memories:", error),
      );
      invokeMutation("delete_ai_attachments_for_workspace", { workspaceKey: workspaceId }).catch(
        (error: unknown) =>
          console.error("[AIWorkspace] Failed to delete workspace attachments:", error),
      );
    },
    [deleteChatWorkspace],
  );

  // Hydrate compacted digests from the SQLite cache so workspace context
  // survives restarts and localStorage clears.
  useEffect(() => {
    if (!historyHydrated || !isOpen || chatWorkspaces.length === 0) return;
    let cancelled = false;
    invokeMutation<{ workspaceId: string; digest: string; updatedAt: number }[]>(
      "list_latest_workspace_digests",
      {},
    )
      .then((entries) => {
        if (!cancelled && Array.isArray(entries) && entries.length > 0) {
          hydrateChatContextDigests(entries);
        }
      })
      .catch((error: unknown) => {
        console.error("[AIWorkspace] Failed to hydrate context digests:", error);
      });

    invokeMutation<{ threadId: string; title: string; keywords: string[]; summary: string }[]>(
      "list_thread_memories",
      {},
    )
      .then((memories) => {
        if (cancelled || !Array.isArray(memories)) return;
        const mapped: Record<string, ThreadMemoryEntry> = {};
        memories.forEach((memory) => {
          if (memory.threadId) {
            mapped[memory.threadId] = {
              title: memory.title,
              keywords: Array.isArray(memory.keywords) ? memory.keywords : [],
              summary: memory.summary ?? "",
            };
          }
        });
        setThreadMemories(mapped);
      })
      .catch((error: unknown) => {
        console.error("[AIWorkspace] Failed to hydrate thread memories:", error);
      });

    return () => {
      cancelled = true;
    };
  }, [chatWorkspaces.length, historyHydrated, hydrateChatContextDigests, isOpen]);

  return {
    activeChatWorkspace,
    activeChatWorkspaceId,
    chatDatabaseCatalog,
    chatWorkspaces,
    currentWorkspaceKey,
    handleCreateUserWorkspace,
    handleDeleteUserWorkspace,
    handleRebindChatWorkspaceDatabase,
    handleSelectChatWorkspace,
    initialThreadRef,
    lastWorkspaceKeyRef,
    renameChatWorkspace,
    saveChatContextDigest,
    setThreadMemories,
    threadMemories,
  };
}
