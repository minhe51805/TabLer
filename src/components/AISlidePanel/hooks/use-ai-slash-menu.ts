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

interface UseAISlashMenuOptions {
  promptDraft: string;
  setPromptDraft: (value: string) => void;
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
 * handlers. A picked command parks in the composer (`commitSlashCommand`)
 * except `/rollback`, whose checkpoint picker is itself the confirmation.
 */
export function useAISlashMenu({
  promptDraft,
  setPromptDraft,
  connectionId,
  activeConnectionDbType,
  currentDatabase,
  language,
  aiCopy,
  setError,
  composerTextareaRef,
}: UseAISlashMenuOptions) {
  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
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
          // Linked-folder commands only load when the workspace dir is passed;
          // without it the registry silently sees builtin/global commands only.
          workspaceDir: await getLinkedWorkspaceDir(),
        });
        if (cancelled) return;
        setFileCommands(registry.commands ?? []);
        // A file that failed to parse is skipped by the loader; surface it so
        // "the command is not in the menu" is diagnosable instead of silent.
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
        // A missing registry must never break the composer: the native commands
        // still work and plain prompts still go through untouched.
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
  // Menu opens only while the draft is exactly "/<name chars>" — plain typing,
  // not mid-sentence slashes, so normal prompts are never interrupted. Command
  // names allow letters, digits, dashes and underscores (review-sql etc.).
  const slashQueryMatch = /^\/([a-zA-Z0-9_-]*)$/.exec(promptDraft.trim());
  const slashMatches = useMemo(
    () => (slashQueryMatch ? matchSlashCommands(slashQueryMatch[1], slashCommands) : []),
    [slashCommands, slashQueryMatch],
  );
  const slashMenuOpen = slashQueryMatch !== null && slashMatches.length > 0 && !slashDismissed;

  const handleBackupCommand = useCallback(async () => {
    if (isBackingUp) return;
    if (!connectionId || !activeConnectionDbType) {
      setError(aiCopy.composer.noDatabaseSelected);
      return;
    }
    setIsBackingUp(true);
    try {
      // "/backup <note>" — the trailing note becomes the checkpoint label.
      const noteMatch = /^\/backup\s+(.+)$/i.exec(promptDraft.trim());
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
    promptDraft,
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
      // Schema caches across the app must not keep serving pre-rollback data.
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

  /**
   * A command picked from the "/" menu lands in the composer, it does not run:
   * the draft becomes `/name`, the caret follows it, and the user runs it with an
   * ordinary Enter through `handleGenerate` — the one path that expands
   * file-backed runbooks and handles `/backup`, `/compact` and `/rollback`. That
   * keeps arguments reachable (`/backup nightly`, `/profile orders`) and stops a
   * mis-click from starting work the user never confirmed.
   *
   * `/rollback` is the exception: it opens the checkpoint picker, which is itself
   * the confirmation step (`runsSlashCommandImmediately`).
   */
  const commitSlashCommand = useCallback(
    (name: string) => {
      // Dismissed for the same keystroke, or the freshly inserted `/help` would be
      // read as a search prefix and immediately re-open the menu over the caret.
      setSlashDismissed(true);
      setSlashActiveIndex(0);
      if (runsSlashCommandImmediately(name)) {
        setPromptDraft("");
        void handleRollbackCommand();
        return;
      }
      const draft = slashCommandDraft(name);
      setPromptDraft(draft);
      // Same idiom as the panel's initial prompt: the caret must sit after the
      // inserted command, so the next keystroke types an argument instead of
      // being swallowed before the text.
      window.requestAnimationFrame(() => {
        const composer = composerTextareaRef.current;
        if (!composer) return;
        composer.focus();
        composer.setSelectionRange(draft.length, draft.length);
      });
    },
    [composerTextareaRef, handleRollbackCommand, setPromptDraft],
  );

  // Composer edits re-arm the "/" menu (Escape dismissal lasts one keystroke).
  const handleComposerPromptChange = useCallback(
    (value: string) => {
      setSlashDismissed(false);
      setSlashActiveIndex(0);
      setPromptDraft(value);
    },
    [setPromptDraft],
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
