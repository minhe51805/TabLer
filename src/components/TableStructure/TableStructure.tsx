import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Check,
  Columns3,
  Link2,
  ListTree,
  Loader2,
  X,
} from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import type {
  ColumnDetail,
  ForeignKeyInfo,
  IndexInfo,
  StructureFocusSection,
  TableStructure as TableStructureType,
  TriggerInfo,
} from "../../types";
import type { SectionKey } from "./utils/dialect-sql-generator";
import {
  applyDraftToColumn,
  buildColumnAlterStatements,
  buildDropColumnStatements,
  createEditorState,
  formatDbError,
  getDefaultValueForType,
  quoteIdentifier,
  qualifyTableName,
  splitQualifiedTableName,
  summarizeToastMessage,
  ColumnEditorState,
  StagedColumnChange,
} from "./utils/dialect-sql-generator";
import { AlterColumnModal } from "./components/AlterColumnModal";
import { ColumnList } from "./components/ColumnList";
import { FKList, IndexList, TriggerList, ViewDefinitionSection } from "./components/StructureList";
import { ReviewPanel } from "./components/ReviewPanel";

interface Props {
  connectionId: string;
  tableName: string;
  database?: string;
  isActive?: boolean;
  structureFocusSection?: StructureFocusSection;
  structureFocusColumn?: string;
  structureFocusToken?: string;
}

type StructureToastTone = "success" | "info" | "error";

interface StructureToast {
  id: number;
  tone: StructureToastTone;
  title: string;
  description?: string;
  isClosing: boolean;
}

const DEFAULT_SECTION_STATE = new Set<SectionKey>(["columns"]);
const METADATA_LOAD_TIMEOUT_MS = 8000;

const columnCache = new Map<string, ColumnDetail[]>();
const fullStructureCache = new Map<string, TableStructureType>();

export function TableStructure({
  connectionId,
  tableName,
  database,
  isActive = true,
  structureFocusSection,
  structureFocusColumn,
  structureFocusToken,
}: Props) {
  const getTableStructure = useAppStore((state) => state.getTableStructure);
  const getTableColumnsPreview = useAppStore((state) => state.getTableColumnsPreview);
  const countTableNullValues = useAppStore((state) => state.countTableNullValues);
  const executeStructureStatements = useAppStore((state) => state.executeStructureStatements);
  const addTab = useAppStore((state) => state.addTab);
  const connections = useAppStore((state) => state.connections);

  const activeConnection = connections.find((connection) => connection.id === connectionId);
  const dbType = activeConnection?.db_type || "postgresql";
  const structureKey = `${connectionId}|${database || ""}|${tableName}`;
  const displayTableName = tableName.split(".").pop() || tableName;
  const { schema: tableSchema } = splitQualifiedTableName(tableName);

  const [columns, setColumns] = useState<ColumnDetail[]>([]);
  const [indexes, setIndexes] = useState<IndexInfo[]>([]);
  const [foreignKeys, setForeignKeys] = useState<ForeignKeyInfo[]>([]);
  const [triggers, setTriggers] = useState<TriggerInfo[]>([]);
  const [viewDefinition, setViewDefinition] = useState<string | null>(null);
  const [objectType, setObjectType] = useState<string | null>(null);
  const [hasLoadedMetadata, setHasLoadedMetadata] = useState(false);
  const [isLoadingColumns, setIsLoadingColumns] = useState(false);
  const [isLoadingMetadata, setIsLoadingMetadata] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [metadataError, setMetadataError] = useState<string | null>(null);

  const [activeSection, setActiveSection] = useState<SectionKey>("columns");
  const [expandedSections, setExpandedSections] = useState<Set<SectionKey>>(DEFAULT_SECTION_STATE);
  const [columnEditor, setColumnEditor] = useState<ColumnEditorState | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [stagedColumnChanges, setStagedColumnChanges] = useState<Record<string, StagedColumnChange>>(
    {}
  );
  const [isReviewOpen, setIsReviewOpen] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [isApplyingChanges, setIsApplyingChanges] = useState(false);
  const [isTopbarCondensed, setIsTopbarCondensed] = useState(false);
  const [toast, setToast] = useState<StructureToast | null>(null);
  const metadataStatusCopy = hasLoadedMetadata
    ? "Metadata is loaded and ready to inspect."
    : isLoadingMetadata
      ? "Metadata is loading now."
      : "Indexes, triggers, and view details stay deferred until you open them.";

  const shellRef = useRef<HTMLDivElement | null>(null);
  const columnsSectionRef = useRef<HTMLElement | null>(null);
  const sectionRefs = useRef<Record<Exclude<SectionKey, "columns">, HTMLElement | null>>({
    indexes: null,
    foreign_keys: null,
    triggers: null,
    view_definition: null,
  });
  const mountedRef = useRef(true);
  const structureVersionRef = useRef(0);
  const columnsRequestIdRef = useRef(0);
  const metadataRequestIdRef = useRef(0);
  const toastIdRef = useRef(0);
  const toastHideTimeoutRef = useRef<number | null>(null);
  const toastClearTimeoutRef = useRef<number | null>(null);
  const pendingExternalFocusRef = useRef<{
    token: string;
    section: StructureFocusSection;
    columnName?: string;
  } | null>(null);

  const stagedColumns = useMemo(
    () =>
      columns.flatMap((column) => {
        const change = stagedColumnChanges[column.name];
        if (!change) return [column];
        if (change.action === "drop") return [];
        return [applyDraftToColumn(column, change.draft)];
      }),
    [columns, stagedColumnChanges]
  );
  const pendingChangeCount = Object.keys(stagedColumnChanges).length;
  const reviewStatements = useMemo(
    () => Object.values(stagedColumnChanges).flatMap((change) => change.statements),
    [stagedColumnChanges]
  );
  const destructiveChanges = useMemo(
    () => Object.values(stagedColumnChanges).filter((change) => change.action === "drop"),
    [stagedColumnChanges]
  );
  const editorOriginalColumn =
    columns.find((column) => column.name === columnEditor?.originalName) || null;
  const sqlPreview =
    columnEditor && editorOriginalColumn
      ? buildColumnAlterStatements(dbType, tableName, database, editorOriginalColumn, columnEditor)
      : { statements: [] };

  const setFromFullStructure = useCallback((structure: TableStructureType) => {
    setColumns(structure.columns);
    setIndexes(structure.indexes);
    setForeignKeys(structure.foreign_keys);
    setTriggers(structure.triggers || []);
    setViewDefinition(structure.view_definition || null);
    setObjectType(structure.object_type || null);
    setHasLoadedMetadata(true);
  }, []);

  const setFromColumns = useCallback((nextColumns: ColumnDetail[]) => {
    setColumns(nextColumns);
    setIndexes([]);
    setForeignKeys([]);
    setTriggers([]);
    setViewDefinition(null);
    setObjectType(null);
    setHasLoadedMetadata(false);
  }, []);

  const invalidateStructureCache = useCallback(() => {
    columnCache.delete(structureKey);
    fullStructureCache.delete(structureKey);
  }, [structureKey]);

  const clearToastTimers = useCallback(() => {
    if (toastHideTimeoutRef.current !== null) {
      window.clearTimeout(toastHideTimeoutRef.current);
      toastHideTimeoutRef.current = null;
    }
    if (toastClearTimeoutRef.current !== null) {
      window.clearTimeout(toastClearTimeoutRef.current);
      toastClearTimeoutRef.current = null;
    }
  }, []);

  const dismissToast = useCallback(() => {
    clearToastTimers();
    setToast((prev) => (prev ? { ...prev, isClosing: true } : prev));
    toastClearTimeoutRef.current = window.setTimeout(() => {
      setToast(null);
      toastClearTimeoutRef.current = null;
    }, 220);
  }, [clearToastTimers]);

  const showToast = useCallback(
    (tone: StructureToastTone, title: string, description?: string) => {
      clearToastTimers();
      const toastId = ++toastIdRef.current;

      setToast({
        id: toastId,
        tone,
        title,
        description,
        isClosing: false,
      });

      toastHideTimeoutRef.current = window.setTimeout(() => {
        setToast((prev) => (prev?.id === toastId ? { ...prev, isClosing: true } : prev));
        toastHideTimeoutRef.current = null;
      }, 3200);

      toastClearTimeoutRef.current = window.setTimeout(() => {
        setToast((prev) => (prev?.id === toastId ? null : prev));
        toastClearTimeoutRef.current = null;
      }, 3440);
    },
    [clearToastTimers]
  );

  const loadColumns = useCallback(
    async (options: { force?: boolean } = {}) => {
      const viewVersion = structureVersionRef.current;
      const requestId = ++columnsRequestIdRef.current;

      if (!options.force) {
        const cachedFull = fullStructureCache.get(structureKey);
        if (cachedFull) {
          setFromFullStructure(cachedFull);
          setLoadError(null);
          return;
        }

        const cachedColumns = columnCache.get(structureKey);
        if (cachedColumns) {
          setFromColumns(cachedColumns);
          setLoadError(null);
          return;
        }
      }

      setIsLoadingColumns(true);
      setLoadError(null);

      try {
        const nextColumns = await getTableColumnsPreview(connectionId, tableName, database);

        if (
          !mountedRef.current ||
          viewVersion !== structureVersionRef.current ||
          requestId !== columnsRequestIdRef.current
        ) {
          return;
        }

        if (nextColumns.length === 0) {
          throw new Error(`No columns found for ${displayTableName}.`);
        }

        columnCache.set(structureKey, nextColumns);
        setFromColumns(nextColumns);
      } catch (error) {
        if (
          !mountedRef.current ||
          viewVersion !== structureVersionRef.current ||
          requestId !== columnsRequestIdRef.current
        ) {
          return;
        }

        setLoadError(formatDbError(error, tableName));
        setColumns([]);
        setIndexes([]);
        setForeignKeys([]);
        setTriggers([]);
        setViewDefinition(null);
        setObjectType(null);
        setHasLoadedMetadata(false);
      } finally {
        if (
          mountedRef.current &&
          viewVersion === structureVersionRef.current &&
          requestId === columnsRequestIdRef.current
        ) {
          setIsLoadingColumns(false);
        }
      }
    },
    [
      connectionId,
      database,
      displayTableName,
      getTableColumnsPreview,
      setFromColumns,
      structureKey,
      tableName,
    ]
  );

  // Inline timeout wrapper (localStorage-based structure loading doesn't need appStore timeout)
  const withTimeout = useAppStore((_state) => {
    // Access it from the store's closure - we use the function defined there
    return (promise: Promise<TableStructureType>, ms: number, label: string) =>
      new Promise<TableStructureType>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`));
        }, ms);
        promise.then(
          (value) => { window.clearTimeout(timer); resolve(value); },
          (error) => { window.clearTimeout(timer); reject(error); }
        );
      });
  });

  const loadMetadata = useCallback(
    async (options: { force?: boolean } = {}) => {
      if (!columns.length && !options.force) return;
      if (hasLoadedMetadata && !options.force) return;

      const viewVersion = structureVersionRef.current;
      const requestId = ++metadataRequestIdRef.current;
      setIsLoadingMetadata(true);
      setMetadataError(null);

      try {
        const result = await withTimeout(
          getTableStructure(connectionId, tableName, database),
          METADATA_LOAD_TIMEOUT_MS,
          `Timed out loading metadata for ${displayTableName}.`
        );

        if (
          !mountedRef.current ||
          viewVersion !== structureVersionRef.current ||
          requestId !== metadataRequestIdRef.current
        ) {
          return;
        }

        columnCache.set(structureKey, result.columns);
        fullStructureCache.set(structureKey, result);
        setFromFullStructure(result);
      } catch (error) {
        if (
          !mountedRef.current ||
          viewVersion !== structureVersionRef.current ||
          requestId !== metadataRequestIdRef.current
        ) {
          return;
        }

        setMetadataError(formatDbError(error, tableName));
      } finally {
        if (
          mountedRef.current &&
          viewVersion === structureVersionRef.current &&
          requestId === metadataRequestIdRef.current
        ) {
          setIsLoadingMetadata(false);
        }
      }
    },
    [
      columns.length,
      connectionId,
      database,
      displayTableName,
      getTableStructure,
      hasLoadedMetadata,
      setFromFullStructure,
      structureKey,
      tableName,
      withTimeout,
    ]
  );

  const reloadStructure = useCallback(async () => {
    invalidateStructureCache();
    columnsRequestIdRef.current += 1;
    metadataRequestIdRef.current += 1;
    setColumns([]);
    setIndexes([]);
    setForeignKeys([]);
    setTriggers([]);
    setViewDefinition(null);
    setObjectType(null);
    setHasLoadedMetadata(false);
    setMetadataError(null);
    await loadColumns({ force: true });
  }, [invalidateStructureCache, loadColumns]);

  const countNullValues = useCallback(
    (columnName: string) => countTableNullValues(connectionId, tableName, columnName, database),
    [connectionId, countTableNullValues, database, tableName]
  );

  const scrollToSection = (section: SectionKey) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (section === "columns") {
          columnsSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
        } else {
          sectionRefs.current[section]?.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      });
    });
  };

  const closeColumnEditor = useCallback(() => {
    if (isApplyingChanges) return;
    setEditorError(null);
    setColumnEditor(null);
  }, [isApplyingChanges]);

  const focusSection = useCallback(
    (section: SectionKey) => {
      setActiveSection(section);
      setExpandedSections((prev) => {
        if (prev.has(section)) return prev;
        const next = new Set(prev);
        next.add(section);
        return next;
      });

      if (section !== "columns" && !hasLoadedMetadata && !isLoadingMetadata) {
        void loadMetadata();
      }

      scrollToSection(section);
    },
    [hasLoadedMetadata, isLoadingMetadata, loadMetadata]
  );

  const toggleSection = (section: SectionKey) => {
    setActiveSection(section);
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(section)) {
        next.delete(section);
      } else {
        next.add(section);
      }
      return next;
    });

    if (section !== "columns" && !hasLoadedMetadata && !isLoadingMetadata) {
      void loadMetadata();
    }
  };

  const openColumnEditor = useCallback((column: ColumnDetail) => {
    setEditorError(null);
    setColumnEditor(createEditorState(column, stagedColumnChanges[column.name]?.draft));
    focusSection("columns");
  }, [focusSection, stagedColumnChanges]);

  const updateColumnEditor = (updates: Partial<ColumnEditorState>) => {
    setEditorError(null);
    setColumnEditor((prev) => (prev ? { ...prev, ...updates } : prev));
  };

  const stageColumnChange = () => {
    if (!columnEditor || !editorOriginalColumn) return;

    if (sqlPreview.error) {
      setEditorError(sqlPreview.error);
      showToast("error", "Cannot stage change", sqlPreview.error);
      return;
    }

    if (sqlPreview.statements.length === 0) {
      setEditorError("No changes to stage.");
      showToast("info", "No changes detected", "Edit at least one field before staging.");
      return;
    }

    setStagedColumnChanges((prev) => ({
      ...prev,
      [editorOriginalColumn.name]: {
        original: editorOriginalColumn,
        draft: { ...columnEditor },
        statements: [...sqlPreview.statements],
        action: "edit",
      },
    }));
    setEditorError(null);
    setColumnEditor(null);
    showToast("success", "Change staged", `${editorOriginalColumn.name} is ready for review.`);
  };

  const stageColumnDelete = () => {
    if (!columnEditor || !editorOriginalColumn) return;

    if (!hasLoadedMetadata) {
      const message = "Load full metadata first so indexes, foreign keys, and triggers can be checked before deleting a column.";
      setEditorError(message);
      showToast("info", "Load metadata first", message);
      void loadMetadata({ force: true });
      return;
    }

    const confirmed = window.confirm(
      `Stage deletion for column "${editorOriginalColumn.name}"?\n\nYou will still review the generated SQL before applying it.`,
    );
    if (!confirmed) {
      return;
    }

    const deletePreview = buildDropColumnStatements(
      dbType,
      tableName,
      database,
      editorOriginalColumn,
      indexes,
      foreignKeys,
      triggers
    );

    if (deletePreview.error) {
      setEditorError(deletePreview.error);
      showToast("error", "Cannot delete column", deletePreview.error);
      return;
    }

    setStagedColumnChanges((prev) => ({
      ...prev,
      [editorOriginalColumn.name]: {
        original: editorOriginalColumn,
        statements: [...deletePreview.statements],
        action: "drop",
      },
    }));
    setEditorError(null);
    setColumnEditor(null);
    setIsReviewOpen(true);
    showToast("success", "Delete staged", `${editorOriginalColumn.name} will be dropped after review.`);
  };

  const discardStagedChanges = () => {
    setStagedColumnChanges({});
    setReviewError(null);
  };

  const openColumnSqlDraft = () => {
    if (!columnEditor || sqlPreview.error || sqlPreview.statements.length === 0) return;

    addTab({
      id: `query-${crypto.randomUUID()}`,
      type: "query",
      title: `Alter ${columnEditor.name.trim() || columnEditor.originalName}`,
      connectionId,
      database,
      content: `${sqlPreview.statements.join(";\n")};`,
    });
  };

  const openReviewSqlDraft = () => {
    if (reviewStatements.length === 0) {
      showToast("info", "No staged SQL", "Stage a change first, then open the generated SQL.");
      return;
    }

    addTab({
      id: `query-${crypto.randomUUID()}`,
      type: "query",
      title: `Alter ${displayTableName}`,
      connectionId,
      database,
      content: `${reviewStatements.join(";\n")};`,
    });
  };

  const applyStagedChanges = async () => {
    if (pendingChangeCount === 0) {
      showToast("info", "Nothing to apply", "There are no staged structure changes yet.");
      return;
    }

    setReviewError(null);
    setIsApplyingChanges(true);
    const appliedChangeCount = pendingChangeCount;

    try {
      if (destructiveChanges.length > 0) {
        const destructiveColumns = destructiveChanges
          .map((change) => change.original.name)
          .join(", ");
        const confirmed = window.confirm(
          `Apply destructive change${destructiveChanges.length === 1 ? "" : "s"} now?\n\n` +
            `This will permanently remove column${destructiveChanges.length === 1 ? "" : "s"}: ${destructiveColumns}.\n\n` +
            `Make sure you reviewed the generated SQL and have a backup if needed.`
        );

        if (!confirmed) {
          throw new Error("Apply cancelled.");
        }
      }

      for (const change of Object.values(stagedColumnChanges)) {
        const shouldSetNotNull =
          change.action === "edit" &&
          !!change.draft &&
          !change.draft.nullable &&
          change.original.is_nullable;

        if (shouldSetNotNull) {
          const nullCount = await countNullValues(change.original.name);
          if (nullCount > 0) {
            const draft = change.draft;
            if (!draft) {
              throw new Error(
                `Missing staged draft for column "${change.original.name}".`
              );
            }
            const defaultValue = getDefaultValueForType(draft.dataType);
            const confirmed = window.confirm(
              `Column "${change.original.name}" has ${nullCount} NULL value(s).\n\n` +
                `To set NOT NULL, the app can update them to ${defaultValue} first.\n\n` +
                `Click OK to continue, or Cancel to stop.`
            );

            if (!confirmed) {
              throw new Error("Apply cancelled.");
            }

            const tableRef = qualifyTableName(dbType, tableName, database);
            const columnRef = quoteIdentifier(dbType, change.original.name);
            const fixSql = `UPDATE ${tableRef} SET ${columnRef} = ${defaultValue} WHERE ${columnRef} IS NULL`;
            await executeStructureStatements(connectionId, [fixSql]);
          }
        }

        if (change.statements.length > 0) {
          await executeStructureStatements(connectionId, change.statements);
        }
      }

      discardStagedChanges();
      setIsReviewOpen(false);
      await reloadStructure();
      window.dispatchEvent(
        new CustomEvent("table-structure-updated", {
          detail: {
            connectionId,
            tableName,
            database,
          },
        })
      );
      showToast(
        "success",
        "Structure updated",
        `${appliedChangeCount} change${appliedChangeCount === 1 ? "" : "s"} applied to ${displayTableName}.`
      );
    } catch (error) {
      const formattedError = formatDbError(error, tableName);
      if (formattedError === "Apply cancelled.") {
        showToast("info", "Apply cancelled", "No structure changes were sent to the database.");
      } else {
        setReviewError(formattedError);
        showToast("error", "Could not update structure", summarizeToastMessage(formattedError));
      }
    } finally {
      if (mountedRef.current) {
        setIsApplyingChanges(false);
      }
    }
  };

  // ---------------------------------------------------------------------------
  // Effects
  // ---------------------------------------------------------------------------

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      columnsRequestIdRef.current += 1;
      metadataRequestIdRef.current += 1;
      clearToastTimers();
    };
  }, [clearToastTimers]);

  useEffect(() => {
    structureVersionRef.current += 1;
    columnsRequestIdRef.current += 1;
    metadataRequestIdRef.current += 1;

    const cachedFull = fullStructureCache.get(structureKey);
    const cachedColumns = columnCache.get(structureKey);

    if (cachedFull) {
      setFromFullStructure(cachedFull);
    } else if (cachedColumns) {
      setFromColumns(cachedColumns);
    } else {
      setColumns([]);
      setIndexes([]);
      setForeignKeys([]);
      setTriggers([]);
      setViewDefinition(null);
      setObjectType(null);
      setHasLoadedMetadata(false);
    }

    setLoadError(null);
    setMetadataError(null);
    setIsLoadingColumns(false);
    setIsLoadingMetadata(false);
    setActiveSection("columns");
    setExpandedSections(new Set(DEFAULT_SECTION_STATE));
    setColumnEditor(null);
    setEditorError(null);
    setStagedColumnChanges({});
    setIsReviewOpen(false);
    setReviewError(null);
    setIsTopbarCondensed(false);
    pendingExternalFocusRef.current = null;
  }, [setFromColumns, setFromFullStructure, structureKey]);

  useEffect(() => {
    if (!isActive || !structureFocusToken) return;

    const section = structureFocusSection || "columns";
    pendingExternalFocusRef.current = {
      token: structureFocusToken,
      section,
      columnName: structureFocusColumn,
    };

    focusSection(section);

    if (!structureFocusColumn) {
      pendingExternalFocusRef.current = null;
    }
  }, [focusSection, isActive, structureFocusColumn, structureFocusSection, structureFocusToken]);

  useEffect(() => {
    const pendingRequest = pendingExternalFocusRef.current;
    if (!isActive || !pendingRequest?.columnName) return;
    if (pendingRequest.section !== "columns") return;
    if (isLoadingColumns) return;
    if (columns.length === 0) {
      if (!loadError) {
        void loadColumns();
      }
      return;
    }

    const matchingColumn = columns.find(
      (column) => column.name.toLowerCase() === pendingRequest.columnName?.toLowerCase()
    );
    if (!matchingColumn) {
      pendingExternalFocusRef.current = null;
      return;
    }

    openColumnEditor(matchingColumn);
    pendingExternalFocusRef.current = null;
  }, [columns, isActive, isLoadingColumns, loadColumns, loadError, openColumnEditor]);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;

    const handleScroll = () => {
      const nextCondensed = shell.scrollTop > 96;
      setIsTopbarCondensed((prev) => (prev === nextCondensed ? prev : nextCondensed));
    };

    handleScroll();
    shell.addEventListener("scroll", handleScroll, { passive: true });

    return () => {
      shell.removeEventListener("scroll", handleScroll);
    };
  }, [structureKey]);

  useEffect(() => {
    if (!isActive) return;
    if (columns.length > 0 || isLoadingColumns) return;
    if (loadError) return;
    void loadColumns();
  }, [columns.length, isActive, isLoadingColumns, loadError, loadColumns]);

  useEffect(() => {
    if (!isActive) return;
    if (hasLoadedMetadata || isLoadingMetadata) return;
    if (
      activeSection === "columns" &&
      !expandedSections.has("indexes") &&
      !expandedSections.has("foreign_keys") &&
      !expandedSections.has("triggers") &&
      !expandedSections.has("view_definition")
    ) {
      return;
    }
    void loadMetadata();
  }, [
    activeSection,
    expandedSections,
    hasLoadedMetadata,
    isActive,
    isLoadingMetadata,
    loadMetadata,
  ]);

  useEffect(() => {
    const handleTableDataUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{
        connectionId: string;
        database?: string;
        tableName?: string;
        invalidateStructure?: boolean;
      }>).detail;

      if (!detail?.invalidateStructure) return;
      if (detail.connectionId !== connectionId) return;
      if (detail.database !== undefined && (detail.database || "") !== (database || "")) return;
      if (detail.tableName && detail.tableName !== tableName) return;
      if (!isActive) return;

      void reloadStructure();
    };

    window.addEventListener("table-data-updated", handleTableDataUpdated);
    return () => window.removeEventListener("table-data-updated", handleTableDataUpdated);
  }, [connectionId, database, isActive, reloadStructure, tableName]);

  useEffect(() => {
    if (!columnEditor) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeColumnEditor();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [closeColumnEditor, columnEditor]);

  // ---------------------------------------------------------------------------
  // Loading / Error States
  // ---------------------------------------------------------------------------

  if (isLoadingColumns && columns.length === 0) {
    return (
      <div className="structure-state">
        <div className="structure-state-card">
          <Loader2 className="w-5 h-5 animate-spin text-[var(--accent)]" />
          <span>Loading columns...</span>
        </div>
      </div>
    );
  }

  if (!columns.length) {
    return (
      <div className="structure-state">
        <div className="structure-state-card error">
          <span>{loadError || "Failed to load structure"}</span>
          <button type="button" className="btn btn-secondary" onClick={() => void reloadStructure()}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <>
      <div ref={shellRef} className="structure-shell">
        {/* Condensed topbar */}
        <div className={`structure-topbar-mini ${isTopbarCondensed ? "active" : ""}`}>
          <div className="structure-topbar-mini-main">
            <div className="structure-topbar-mini-title-row">
              <span className="structure-topbar-mini-icon">
                <Columns3 className="w-4 h-4" />
              </span>
              <strong className="structure-topbar-mini-title">{displayTableName}</strong>
            </div>
            <div className="structure-topbar-mini-meta">
              <span className="structure-topbar-mini-badge accent">{dbType.toUpperCase()}</span>
              <span className="structure-topbar-mini-badge">{tableSchema}</span>
              <span className="structure-topbar-mini-badge">{columns.length} columns</span>
              {hasLoadedMetadata && (
                <span className="structure-topbar-mini-badge soft">
                  {indexes.length} idx / {foreignKeys.length} fk
                </span>
              )}
            </div>
          </div>

          <div className="structure-topbar-mini-actions">
            {pendingChangeCount > 0 ? (
              <>
                <span className="structure-pending-pill">{pendingChangeCount} pending</span>
                <button type="button" className="btn btn-secondary" onClick={() => setIsReviewOpen(true)}>
                  Review
                </button>
                <button type="button" className="btn btn-primary" onClick={() => void applyStagedChanges()}>
                  {isApplyingChanges ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Check className="w-4 h-4" />
                  )}
                  <span>Apply</span>
                </button>
              </>
            ) : (
              <>
                <button type="button" className="btn btn-secondary" onClick={() => focusSection("columns")}>
                  Edit
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => focusSection("indexes")}
                  disabled={isLoadingMetadata}
                >
                  {isLoadingMetadata ? "Loading..." : hasLoadedMetadata ? "Metadata" : "Load meta"}
                </button>
              </>
            )}
          </div>
        </div>

        {/* Full topbar */}
        <div className="structure-topbar">
          <div className="structure-topbar-copy">
            <span className="structure-topbar-kicker">Table Structure</span>
            <div className="structure-topbar-title-row">
              <Columns3 className="w-4 h-4 text-[var(--accent-hover)]" />
              <h3 className="structure-topbar-title">{displayTableName}</h3>
            </div>
            <p className="structure-topbar-subtitle">
              Columns load first. Indexes and foreign keys load when you open those sections.
            </p>
            <div className="structure-topbar-meta">
              <span className="structure-topbar-badge accent">{dbType.toUpperCase()}</span>
              <span className="structure-topbar-badge">{tableSchema} schema</span>
              <span className="structure-topbar-badge">{displayTableName}</span>
              {database && <span className="structure-topbar-badge soft">{database}</span>}
            </div>
            <div className="structure-topbar-story">
              <span className="structure-topbar-story-line">
                Edit columns in memory first, then review generated SQL before applying.
              </span>
              <span className="structure-topbar-story-line">{metadataStatusCopy}</span>
            </div>
          </div>

          <div className="structure-topbar-side">
            <div className="structure-topbar-insights">
              <button
                type="button"
                className={`structure-insight-card ${activeSection === "columns" ? "active" : ""}`}
                onClick={() => focusSection("columns")}
              >
                <span className="structure-insight-icon">
                  <Columns3 className="w-4 h-4" />
                </span>
                <span className="structure-insight-copy">
                  <span className="structure-insight-label">Columns</span>
                  <strong className="structure-insight-value">{columns.length}</strong>
                  <span className="structure-insight-meta">Ready to edit</span>
                </span>
              </button>
              <button
                type="button"
                className={`structure-insight-card ${activeSection === "indexes" ? "active" : ""}`}
                onClick={() => focusSection("indexes")}
              >
                <span className="structure-insight-icon">
                  <ListTree className="w-4 h-4" />
                </span>
                <span className="structure-insight-copy">
                  <span className="structure-insight-label">Indexes</span>
                  <strong className="structure-insight-value">
                    {hasLoadedMetadata ? indexes.length : isLoadingMetadata ? "..." : "Load"}
                  </strong>
                  <span className="structure-insight-meta">
                    {hasLoadedMetadata ? "Metadata ready" : isLoadingMetadata ? "Fetching now" : "Open to fetch"}
                  </span>
                </span>
              </button>
              <button
                type="button"
                className={`structure-insight-card ${activeSection === "foreign_keys" ? "active" : ""}`}
                onClick={() => focusSection("foreign_keys")}
              >
                <span className="structure-insight-icon">
                  <Link2 className="w-4 h-4" />
                </span>
                <span className="structure-insight-copy">
                  <span className="structure-insight-label">Foreign Keys</span>
                  <strong className="structure-insight-value">
                    {hasLoadedMetadata ? foreignKeys.length : isLoadingMetadata ? "..." : "Load"}
                  </strong>
                  <span className="structure-insight-meta">
                    {hasLoadedMetadata ? "Relations loaded" : isLoadingMetadata ? "Fetching now" : "Open to fetch"}
                  </span>
                </span>
              </button>
            </div>

            <div className={`structure-topbar-queue ${pendingChangeCount > 0 ? "active" : ""}`}>
              <div className="structure-topbar-queue-copy">
                <span className="structure-topbar-queue-kicker">
                  {pendingChangeCount > 0 ? "Staged changes" : "Working tree"}
                </span>
                <div className="structure-topbar-queue-title-row">
                  {pendingChangeCount > 0 && (
                    <span className="structure-pending-pill">{pendingChangeCount} pending</span>
                  )}
                  <strong className="structure-topbar-queue-title">
                    {pendingChangeCount > 0 ? "Review and apply when ready" : "Everything is synced"}
                  </strong>
                </div>
                <p className="structure-topbar-queue-description">
                  {pendingChangeCount > 0
                    ? "Your edits are staged in memory. Review the generated SQL, discard it, or apply it to the table."
                    : "Open a column to start composing structure changes. Nothing is waiting to be applied yet."}
                </p>
              </div>

              <div className="structure-topbar-actions">
                {pendingChangeCount > 0 ? (
                  <>
                    <button type="button" className="btn btn-secondary" onClick={() => setIsReviewOpen(true)}>
                      Review SQL
                    </button>
                    <button type="button" className="btn btn-secondary" onClick={discardStagedChanges}>
                      Discard
                    </button>
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => void applyStagedChanges()}
                    >
                      {isApplyingChanges ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Check className="w-4 h-4" />
                      )}
                      <span>Apply</span>
                    </button>
                  </>
                ) : (
                  <>
                    <button type="button" className="btn btn-secondary" onClick={() => focusSection("columns")}>
                      Edit Columns
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => focusSection("indexes")}
                      disabled={isLoadingMetadata}
                    >
                      {isLoadingMetadata ? "Loading..." : hasLoadedMetadata ? "Inspect Metadata" : "Load Metadata"}
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Structure sections */}
        <div className="structure-sections">
          <ColumnList
            columns={columns}
            stagedColumns={stagedColumns}
            stagedColumnChanges={stagedColumnChanges}
            onOpenEditor={openColumnEditor}
            sectionRef={columnsSectionRef}
            isActive={activeSection === "columns"}
            isExpanded={expandedSections.has("columns")}
            onToggle={() => toggleSection("columns")}
          />

          <IndexList
            indexes={indexes}
            sectionRefs={sectionRefs}
            isActive={activeSection === "indexes"}
            isExpanded={expandedSections.has("indexes")}
            hasLoadedMetadata={hasLoadedMetadata}
            isLoadingMetadata={isLoadingMetadata}
            metadataError={metadataError}
            onToggle={() => toggleSection("indexes")}
            onLoadMetadata={loadMetadata}
          />

          <FKList
            foreignKeys={foreignKeys}
            sectionRefs={sectionRefs}
            isActive={activeSection === "foreign_keys"}
            isExpanded={expandedSections.has("foreign_keys")}
            hasLoadedMetadata={hasLoadedMetadata}
            isLoadingMetadata={isLoadingMetadata}
            metadataError={metadataError}
            onToggle={() => toggleSection("foreign_keys")}
            onLoadMetadata={loadMetadata}
          />

          {(objectType === "VIEW" || !!viewDefinition || (isLoadingMetadata && !hasLoadedMetadata)) && (
            <ViewDefinitionSection
              viewDefinition={viewDefinition}
              sectionRefs={sectionRefs}
              isActive={activeSection === "view_definition"}
              isExpanded={expandedSections.has("view_definition")}
              hasLoadedMetadata={hasLoadedMetadata}
              isLoadingMetadata={isLoadingMetadata}
              metadataError={metadataError}
              onToggle={() => toggleSection("view_definition")}
              onLoadMetadata={loadMetadata}
            />
          )}

          <TriggerList
            triggers={triggers}
            sectionRefs={sectionRefs}
            isActive={activeSection === "triggers"}
            isExpanded={expandedSections.has("triggers")}
            hasLoadedMetadata={hasLoadedMetadata}
            isLoadingMetadata={isLoadingMetadata}
            metadataError={metadataError}
            onToggle={() => toggleSection("triggers")}
            onLoadMetadata={loadMetadata}
          />
        </div>
      </div>

      {/* Modals */}
      {columnEditor && (
        <AlterColumnModal
          columnEditor={columnEditor}
          sqlPreview={sqlPreview}
          editorError={editorError}
          dbType={dbType}
          onClose={closeColumnEditor}
          onUpdate={updateColumnEditor}
          onStageChange={stageColumnChange}
          onStageDelete={stageColumnDelete}
          onOpenSql={openColumnSqlDraft}
        />
      )}

      {isReviewOpen && (
        <ReviewPanel
          stagedColumnChanges={stagedColumnChanges}
          destructiveChanges={destructiveChanges}
          reviewError={reviewError}
          isApplyingChanges={isApplyingChanges}
          pendingChangeCount={pendingChangeCount}
          tableName={displayTableName}
          onDiscard={discardStagedChanges}
          onApply={applyStagedChanges}
          onOpenSql={openReviewSqlDraft}
          onClose={() => setIsReviewOpen(false)}
        />
      )}

      {/* Toast */}
      {toast && (
        <div
          className={`structure-toast ${toast.tone} ${toast.isClosing ? "closing" : ""}`}
          role="status"
          aria-live="polite"
        >
          <div className={`structure-toast-icon ${toast.tone}`}>
            {toast.tone === "success" ? (
              <Check className="w-4 h-4" />
            ) : (
              <AlertCircle className="w-4 h-4" />
            )}
          </div>

          <div className="structure-toast-copy">
            <span className="structure-toast-title">{toast.title}</span>
            {toast.description && (
              <span className="structure-toast-description">{toast.description}</span>
            )}
          </div>

          <button
            type="button"
            className="structure-toast-close"
            onClick={dismissToast}
            aria-label="Dismiss notification"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}
    </>
  );
}
