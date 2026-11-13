import { useCallback, useEffect, useMemo, useState, type RefObject } from "react";
import { emitAppToast } from "../../../utils/app-toast";
import { invokeMutation, invokeWithTimeout } from "../../../utils/tauri-utils";
import { getLinkedWorkspaceDir } from "../../../hooks/useLinkedFolders";
import { useCommandPrefsStore } from "../../../stores/commandPrefsStore";
import { requestAICheckpointPick } from "../ai-checkpoint-picker";
import {
  matchSlashCommands,
  mergeSlashCommands,
  runsSlashCommandImmediately,
  slashCommandDraft,
  type AIDatabaseCheckpoint,
  type AISlashCommand,
  type AgentFileCommand,
} from "../ai-slash-commands";
import type { getAIWorkspaceCopy } from "../ai-workspace-copy";
import type { AppLanguage } from "../../../i18n";
import type { DatabaseType } from "../../../types";
import { useAIPanelStore } from "../store/aiPanelStore";

const SLASH_PREFIX_RE = /^\/([a-zA-Z0-9_-]*)$/;

interface UseAISlashMenuOptions {
  connectionId: string | null;
  activeConnectionDbType: DatabaseType | null | undefined;
  currentDatabase: string | null;
  language: AppLanguage;
  aiCopy: ReturnType<typeof getAIWorkspaceCopy>;
  setError: (message: string | null) => void;
  composerTextareaRef: RefObject<HTMLTextAreaElement | null>;
}

/**
 * The composer "/" command surface: the file-backed command registry, the
 * menu's open/match/dismiss state, and the built-in `/backup` + `/rollback`
 * handlers. Subscribes only to the derived slash-query prefix in
 * `useAIPanelStore` so ordinary composer typing causes ZERO re-renders in the
 * parent panel.
 */
export function useAISlashMenu({
  connectionId,
  activeConnectionDbType,
  currentDatabase,
  language,
  aiCopy,
  setError,
  composerTextareaRef,
}: UseAISlashMenuOptions) {
  const slashQueryPrefix = useAIPanelStore((state) => {
    const match = SLASH_PREFIX_RE.exec(state.promptDraft.trim());
    return match ? match[1] : null;
  });
  const slashActiveIndex = useAIPanelStore((state) =>
    SLASH_PREFIX_RE.test(state.promptDraft.trim()) ? state.slashActiveIndex : 0,
  );
  const slashDismissed = useAIPanelStore((state) =>
    SLASH_PREFIX_RE.test(state.promptDraft.trim()) ? state.slashDismissed : false,
  );
  const setPromptDraft = useAIPanelStore((state) => state.setPromptDraft);
  const updateComposerDraft = useAIPanelStore((state) => state.updateComposerDraft);
  const setSlashActiveIndex = useAIPanelStore((state) => state.setSlashActiveIndex);
  const setSlashDismissed = useAIPanelStore((state) => state.setSlashDismissed);

  const [isBackingUp, setIsBackingUp] = useState(false);
  const [fileCommands, setFileCommands] = useState<AgentFileCommand[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const registry = await invokeMutation<{
          commands: AgentFileCommand[];
          report?: { errors?: { path: string; reason: string }[] };
        }>("list_user_slash_commands", {
          workspaceDir: await getLinkedWorkspaceDir(),
        });
        if (cancelled) return;
        setFileCommands(registry.commands ?? []);
        const loadErrors = registry.report?.errors ?? [];
        for (const error of loadErrors) {
          console.warn(`[AIWorkspace] skipped slash command ${error.path}: ${error.reason}`);
        }
        if (loadErrors.length > 0) {
          emitAppToast({
            tone: "error",
            title: "Some slash commands failed to load",
            description: loadErrors
              .slice(0, 3)
              .map((error) => `${error.path}: ${error.reason}`)
              .join("\n"),
            durationMs: 8_000,
          });
        }
      } catch (error) {
        console.warn("[AIWorkspace] command registry unavailable:", error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const slashCommands = useMemo<AISlashCommand[]>(
    () =>
      mergeSlashCommands(
        [
          { name: "backup", description: aiCopy.composer.slashBackupDescription },
          { name: "rollback", description: aiCopy.composer.slashRollbackDescription },
          { name: "compact", description: aiCopy.composer.slashCompactDescription },
          { name: "explain", description: aiCopy.composer.slashExplainDescription },
          { name: "optimize", description: aiCopy.composer.slashOptimizeDescription },
          { name: "fix", description: aiCopy.composer.slashFixDescription },
        ],
        fileCommands,
        (name) => useCommandPrefsStore.getState().isEnabled(name),
        aiCopy.composer.slashCustomBadge,
      ),
    [aiCopy, fileCommands],
  );

  const slashMatches = useMemo(
    () => (slashQueryPrefix !== null ? matchSlashCommands(slashQueryPrefix, slashCommands) : []),
    [slashCommands, slashQueryPrefix],
  );
  const slashMenuOpen = slashQueryPrefix !== null && slashMatches.length > 0 && !slashDismissed;

  const handleBackupCommand = useCallback(async () => {
    if (isBackingUp) return;
    if (!connectionId || !activeConnectionDbType) {
      setError(aiCopy.composer.noDatabaseSelected);
      return;
    }
    setIsBackingUp(true);
    try {
      const currentDraft = useAIPanelStore.getState().promptDraft;
      const noteMatch = /^\/backup\s+(.+)$/i.exec(currentDraft.trim());
      const result = await invokeWithTimeout<{
        fileName: string;
        label: string;
        createdAt: number;
        engine: string;
        database: string | null;
        tableCount: number;
        rowCount: number;
        sizeBytes: number;
      }>(
        "create_database_checkpoint",
        {
          connectionId,
          database: currentDatabase || null,
          dbType: activeConnectionDbType,
          label: noteMatch?.[1]?.trim() || null,
        },
        120_000,
        "Creating checkpoint",
      );
      emitAppToast({
        tone: "success",
        title: language === "vi" ? "Đã tạo điểm khôi phục" : "Restore checkpoint created",
        description:
          language === "vi"
            ? `${result.tableCount} bảng · ${result.rowCount} dòng — dùng /rollback để khôi phục khi cần.`
            : `${result.tableCount} tables · ${result.rowCount} rows — use /rollback to restore when needed.`,
        durationMs: 10_000,
      });
    } catch (errorValue) {
      const message = errorValue instanceof Error ? errorValue.message : String(errorValue);
      emitAppToast({
        tone: "error",
        title: language === "vi" ? "Tạo checkpoint thất bại" : "Checkpoint failed",
        description: message,
        durationMs: 10_000,
      });
    } finally {
      setIsBackingUp(false);
    }
  }, [
    activeConnectionDbType,
    aiCopy.composer.noDatabaseSelected,
    connectionId,
    currentDatabase,
    isBackingUp,
    language,
    setError,
  ]);

  const handleRollbackCommand = useCallback(async () => {
    if (!connectionId || !activeConnectionDbType) {
      setError(aiCopy.composer.noDatabaseSelected);
      return;
    }
    try {
      const checkpoints = await invokeWithTimeout<AIDatabaseCheckpoint[]>(
        "list_database_checkpoints",
        { connectionId },
        60_000,
        "Listing checkpoints",
      );
      const fileName = await requestAICheckpointPick(
        checkpoints ?? [],
        language,
        connectionId,
        activeConnectionDbType,
      );
      if (!fileName) return;
      const restoreResult = await invokeWithTimeout<{
        warning?: string | null;
      }>(
        "restore_database_checkpoint",
        {
          connectionId,
          fileName,
          dbType: activeConnectionDbType,
        },
        120_000,
        "Restoring checkpoint",
      );
      if (restoreResult?.warning) {
        emitAppToast({
          tone: "error",
          title:
            language === "vi" ? "Snapshot pre-restore thất bại" : "Pre-restore snapshot failed",
          description: restoreResult.warning,
          durationMs: 10_000,
        });
      }
      window.dispatchEvent(
        new CustomEvent("table-data-updated", {
          detail: { connectionId, invalidateStructure: true },
        }),
      );
      emitAppToast({
        tone: "success",
        title: language === "vi" ? "Đã rollback database" : "Database restored",
        description:
          language === "vi"
            ? "Database đã quay về điểm checkpoint. Hãy refresh explorer nếu cần."
            : "The database was restored to the checkpoint. Refresh the explorer if needed.",
        durationMs: 10_000,
      });
    } catch (errorValue) {
      const message = errorValue instanceof Error ? errorValue.message : String(errorValue);
      emitAppToast({
        tone: "error",
        title: language === "vi" ? "Rollback thất bại" : "Rollback failed",
        description: message,
        durationMs: 10_000,
      });
    }
  }, [
    activeConnectionDbType,
    aiCopy.composer.noDatabaseSelected,
    connectionId,
    language,
    setError,
  ]);

  const commitSlashCommand = useCallback(
    (name: string) => {
      setSlashDismissed(true);
      setSlashActiveIndex(0);
      if (runsSlashCommandImmediately(name)) {
        setPromptDraft("");
        void handleRollbackCommand();
        return;
      }
      const draft = slashCommandDraft(name);
      setPromptDraft(draft);
      window.requestAnimationFrame(() => {
        const composer = composerTextareaRef.current;
        if (!composer) return;
        composer.focus();
        composer.setSelectionRange(draft.length, draft.length);
      });
    },
    [
      composerTextareaRef,
      handleRollbackCommand,
      setPromptDraft,
      setSlashActiveIndex,
      setSlashDismissed,
    ],
  );

  const handleComposerPromptChange = useCallback(
    (value: string) => {
      updateComposerDraft(value);
    },
    [updateComposerDraft],
  );

  return {
    commitSlashCommand,
    fileCommands,
    handleBackupCommand,
    handleComposerPromptChange,
    handleRollbackCommand,
    setSlashActiveIndex,
    setSlashDismissed,
    slashActiveIndex,
    slashMatches,
    slashMenuOpen,
  };
}
