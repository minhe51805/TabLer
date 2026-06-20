import { useCallback, useEffect, useMemo, useState } from "react";
import { Folder, FolderOpen, FileCode, FileJson, Plus, X, RefreshCw, FolderSearch, ChevronRight } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { useLinkedFolders } from "../../hooks/useLinkedFolders";
import { emitAppToast } from "../../utils/app-toast";
import type { Tab } from "../../types/database";

export interface LinkedFileInfo {
  path: string;
  name: string;
  is_dir: boolean;
  extension: string;
}

interface LinkedFoldersPanelProps {
  activeConnectionId?: string | null;
  currentDatabase?: string | null;
  addTab?: (tab: Tab) => void;
  language?: string;
}

export function LinkedFoldersPanel({
  activeConnectionId,
  currentDatabase,
  addTab,
  language = "en",
}: LinkedFoldersPanelProps) {
  const { folders, addFolder, removeFolder, lastEvent } = useLinkedFolders();
  // Contents keyed by directory path so both top-level folders and drilled-in
  // subdirectories share the same cache.
  const [contents, setContents] = useState<Record<string, LinkedFileInfo[]>>({});
  const [loadingPaths, setLoadingPaths] = useState<Record<string, boolean>>({});
  const [expandedDirs, setExpandedDirs] = useState<Record<string, boolean>>({});
  const isVietnamese = language === "vi";

  const loadContents = useCallback(async (path: string) => {
    setLoadingPaths((prev) => ({ ...prev, [path]: true }));
    try {
      const files = await invoke<LinkedFileInfo[]>("scan_linked_folder", { folderPath: path });
      setContents((prev) => ({ ...prev, [path]: files }));
    } catch (e) {
      console.error("Failed to scan folder", path, e);
      emitAppToast({
        tone: "error",
        title: isVietnamese ? "Khong doc duoc thu muc" : "Could not read folder",
        description: path,
      });
    } finally {
      setLoadingPaths((prev) => ({ ...prev, [path]: false }));
    }
  }, [isVietnamese]);

  useEffect(() => {
    folders.forEach((folder) => {
      void loadContents(folder);
    });
  }, [folders, lastEvent, loadContents]);

  const handleAddFolder = useCallback(async () => {
    const selected = await openDialog({ directory: true, multiple: false });
    if (selected && typeof selected === "string") {
      await addFolder(selected);
    }
  }, [addFolder]);

  const handleToggleDir = useCallback((dirPath: string) => {
    setExpandedDirs((prev) => {
      const next = { ...prev, [dirPath]: !prev[dirPath] };
      if (next[dirPath] && !contents[dirPath]) {
        void loadContents(dirPath);
      }
      return next;
    });
  }, [contents, loadContents]);

  const handleOpenFile = useCallback(async (file: LinkedFileInfo) => {
    if (!activeConnectionId) {
      emitAppToast({
        tone: "info",
        title: isVietnamese ? "Chua mo workspace" : "Open a workspace first",
        description: isVietnamese
          ? "Hay mo mot ket noi truoc khi mo tep."
          : "Open a connection before opening a file.",
      });
      return;
    }
    if (!addTab) return;

    try {
      const result = await invoke<{ fileName?: string; file_name?: string; content: string }>(
        "read_sql_file_from_path",
        { path: file.path },
      );
      const fileName = result?.fileName || result?.file_name || file.name;
      addTab({
        id: `query-${crypto.randomUUID()}`,
        type: "query",
        title: fileName,
        connectionId: activeConnectionId,
        database: currentDatabase || undefined,
        filePath: file.path,
        content: result?.content ?? "",
      });
      emitAppToast({
        tone: "success",
        title: isVietnamese ? "Da mo tep" : "File opened",
        description: isVietnamese
          ? `${fileName} da duoc mo trong mot tab moi.`
          : `${fileName} opened in a new tab.`,
      });
    } catch (e) {
      console.error("Failed to open linked file", file.path, e);
      emitAppToast({
        tone: "error",
        title: isVietnamese ? "Khong mo duoc tep" : "Could not open file",
        description: file.name,
      });
    }
  }, [activeConnectionId, addTab, currentDatabase, isVietnamese]);

  const handleEntryClick = useCallback((entry: LinkedFileInfo) => {
    if (entry.is_dir) {
      handleToggleDir(entry.path);
    } else {
      void handleOpenFile(entry);
    }
  }, [handleToggleDir, handleOpenFile]);

  const renderEntries = useCallback((dirPath: string, depth: number) => {
    const entries = contents[dirPath];
    const loading = loadingPaths[dirPath];

    if (loading && !entries) {
      return <div className="linked-folder-file-empty">{isVietnamese ? "Dang doc..." : "Loading..."}</div>;
    }
    if (entries && entries.length === 0) {
      return <div className="linked-folder-file-empty">{isVietnamese ? "Trong" : "Empty"}</div>;
    }
    if (!entries) return null;

    return entries.map((entry) => {
      const isOpen = expandedDirs[entry.path];
      return (
        <div key={entry.path} className="linked-folder-entry">
          <button
            type="button"
            onClick={() => handleEntryClick(entry)}
            className={`linked-folder-file ${entry.is_dir ? "is-dir" : ""}`}
            style={{ paddingLeft: `${8 + depth * 12}px` }}
            title={entry.path}
          >
            {entry.is_dir ? (
              <>
                <ChevronRight className={`linked-folder-chevron ${isOpen ? "is-open" : ""}`} />
                {isOpen ? (
                  <FolderOpen className="linked-folder-file-icon is-dir" />
                ) : (
                  <Folder className="linked-folder-file-icon is-dir" />
                )}
              </>
            ) : entry.extension === "json" ? (
              <FileJson className="linked-folder-file-icon is-json" />
            ) : (
              <FileCode className="linked-folder-file-icon is-sql" />
            )}
            <span className="linked-folder-file-name">{entry.name}</span>
            {!entry.is_dir && <span className="linked-folder-file-ext">{entry.extension}</span>}
          </button>

          {entry.is_dir && isOpen && (
            <div className="linked-folder-children">{renderEntries(entry.path, depth + 1)}</div>
          )}
        </div>
      );
    });
  }, [contents, loadingPaths, expandedDirs, handleEntryClick, isVietnamese]);

  const hasFolders = useMemo(() => folders.length > 0, [folders]);

  return (
    <div className="linked-folders-panel">
      <div className="linked-folders-header">
        <div className="linked-folders-title">
          <span className="linked-folders-title-icon" aria-hidden="true">
            <FolderSearch className="w-4 h-4" />
          </span>
          {isVietnamese ? "Thu muc da lien ket" : "Linked Folders"}
        </div>
        <button
          type="button"
          onClick={() => void handleAddFolder()}
          className="linked-folders-add"
          title={isVietnamese ? "Theo doi thu muc" : "Watch local directory"}
          aria-label={isVietnamese ? "Theo doi thu muc" : "Watch local directory"}
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>

      <div className="linked-folders-body">
        {!hasFolders ? (
          <div className="linked-folders-empty">
            <FolderSearch className="w-7 h-7" />
            <p>{isVietnamese ? "Chua lien ket thu muc nao." : "No directories linked."}</p>
            <button type="button" className="linked-folders-empty-action" onClick={() => void handleAddFolder()}>
              <Plus className="w-3.5 h-3.5" />
              {isVietnamese ? "Them thu muc" : "Add folder"}
            </button>
          </div>
        ) : (
          <div className="linked-folders-list">
            {folders.map((folder) => (
              <div key={folder} className="linked-folder-group">
                <div className="linked-folder-row group">
                  <div className="linked-folder-copy" title={folder}>
                    <Folder className="w-4 h-4 text-[var(--accent)] flex-shrink-0" />
                    <span>{folder.split(/[/\\]/).pop() || folder}</span>
                  </div>
                  <div className="linked-folder-actions">
                    <button
                      type="button"
                      onClick={() => void loadContents(folder)}
                      title={isVietnamese ? "Lam moi" : "Refresh"}
                      aria-label={isVietnamese ? "Lam moi" : "Refresh folder"}
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${loadingPaths[folder] ? "animate-spin" : ""}`} />
                    </button>
                    <button
                      type="button"
                      onClick={() => void removeFolder(folder)}
                      className="danger"
                      title={isVietnamese ? "Bo lien ket" : "Unlink"}
                      aria-label={isVietnamese ? "Bo lien ket" : "Unlink folder"}
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                <div className="linked-folder-files">{renderEntries(folder, 0)}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
