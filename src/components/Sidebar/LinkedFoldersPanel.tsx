import { useEffect, useState } from "react";
import { Folder, FileCode, Plus, X, RefreshCw, FolderSearch } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useLinkedFolders } from "../../hooks/useLinkedFolders";
import { invoke } from "@tauri-apps/api/core";

export interface LinkedFileInfo {
  path: string;
  name: string;
  is_dir: boolean;
  extension: string;
}

export function LinkedFoldersPanel() {
  const { folders, addFolder, removeFolder, lastEvent } = useLinkedFolders();
  const [folderContents, setFolderContents] = useState<Record<string, LinkedFileInfo[]>>({});
  const [isLoading, setIsLoading] = useState<Record<string, boolean>>({});

  const loadContents = async (path: string) => {
    setIsLoading(prev => ({ ...prev, [path]: true }));
    try {
      const files = await invoke<LinkedFileInfo[]>("scan_linked_folder", { folderPath: path });
      setFolderContents((prev) => ({ ...prev, [path]: files }));
    } catch (e) {
      console.error("Failed to scan folder", path, e);
    } finally {
      setIsLoading(prev => ({ ...prev, [path]: false }));
    }
  };

  useEffect(() => {
    folders.forEach((folder) => {
      loadContents(folder);
    });
  }, [folders, lastEvent]);

  const handleAddFolder = async () => {
    const selected = await openDialog({
      directory: true,
      multiple: false,
    });
    if (selected && typeof selected === "string") {
      await addFolder(selected);
    }
  };

  const handleFileClick = (file: LinkedFileInfo) => {
    if (file.extension === "sql") {
      // Fire generic event to open file tab
      window.dispatchEvent(new CustomEvent("open-sql-file-palette", { detail: { path: file.path } }));
    }
  };

  return (
    <div className="flex flex-col h-full bg-[var(--bg-primary)] overflow-hidden text-sm">
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border-color)]">
        <div className="font-semibold text-[var(--accent)] flex items-center justify-center gap-2">
          <FolderSearch className="w-4 h-4" />
          Linked Folders
        </div>
        <button
          onClick={handleAddFolder}
          className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
          title="Watch local directory"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {folders.length === 0 ? (
          <div className="text-[var(--text-secondary)] text-center mt-6 px-4">
            <FolderSearch className="w-8 h-8 opacity-50 mx-auto mb-2" />
            <p>No directories linked.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {folders.map((folder) => (
              <div key={folder} className="flex flex-col">
                <div className="group flex items-center justify-between rounded p-1 hover:bg-[var(--bg-hover)]">
                  <div className="flex items-center gap-1.5 flex-1 overflow-hidden" title={folder}>
                    <Folder className="w-4 h-4 text-[var(--accent)] flex-shrink-0" />
                    <span className="truncate text-xs font-medium text-[var(--text-primary)]">
                      {folder.split(/[/\\]/).pop() || folder}
                    </span>
                  </div>
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={() => loadContents(folder)}
                      className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] p-0.5"
                      title="Refresh"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${isLoading[folder] ? 'animate-spin' : ''}`} />
                    </button>
                    <button
                      onClick={() => removeFolder(folder)}
                      className="text-[var(--text-secondary)] hover:text-red-400 p-0.5"
                      title="Unlink"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                <div className="pl-4 py-1 flex flex-col gap-[2px]">
                  {folderContents[folder]?.length === 0 && !isLoading[folder] && (
                    <div className="text-[11px] text-[var(--text-muted)] italic px-2">No .sql or .json files</div>
                  )}
                  {folderContents[folder]?.map((file) => (
                    <div
                      key={file.path}
                      onClick={() => handleFileClick(file)}
                      className="flex items-center gap-1.5 px-2 py-1 rounded cursor-pointer hover:bg-[var(--bg-hover)] group/file"
                    >
                      {file.is_dir ? (
                        <Folder className="w-3.5 h-3.5 text-[var(--text-secondary)]" />
                      ) : (
                        <FileCode className="w-3.5 h-3.5 text-[var(--text-secondary)] group-hover/file:text-[var(--accent)] transition-colors" />
                      )}
                      <span className="truncate text-xs text-[var(--text-secondary)] group-hover/file:text-[var(--text-primary)]">
                        {file.name}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
