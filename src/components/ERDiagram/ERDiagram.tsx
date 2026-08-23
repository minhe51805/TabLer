import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type Connection,
  type EdgeTypes,
  type NodeTypes,
  type OnConnect,
  type ReactFlowInstance,
  BackgroundVariant,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import {
  Database,
  RefreshCw,
  Download,
  FileText,
  GitBranch,
  Link2,
  PanelLeftClose,
  PanelLeftOpen,
  LayoutGrid,
  ScanSearch,
  Map as MapIcon,
  SlidersHorizontal,
  Sparkles,
  X,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useConnectionStore } from "../../stores/connectionStore";
import { useUIStore } from "../../stores/uiStore";
import { useQueryStore } from "../../stores/queryStore";
import {
  getOrLoadSchemaTables,
  getOrLoadTableStructure,
  invalidateSchemaCache,
} from "../../utils/schema-cache";
import type {
  ColumnDetail,
  DatabaseType,
  TableInfo,
  TableStructure,
  ERDiagramSchema,
  TableSchema,
  ERRelationship,
} from "../../types/database";
import { ERDCompactSelect } from "./ERDCompactSelect";
import {
  ERDContextMenu,
  type ERDContextMenuState,
  type ERDContextMenuItem,
} from "./ERDContextMenu";
import { ERDQuickColumnModal } from "./ERDQuickColumnModal";
import { ERDSidePanel } from "./ERDSidePanel";
import { buildERDiagramSqlExport } from "./erd-sql-export";
import {
  buildDrawioDiagramXml,
  buildERDiagramExportSnapshot,
  renderERDiagramCanvas,
} from "./erd-export";
import {
  buildEdges,
  buildNodes,
  getRecommendedTableSelection,
  getRelationshipId,
  getRelationshipSignature,
  getTableColor,
} from "./erd-graph";
import {
  dedupeRelationships,
  getColumnSelectOption,
  getPreferredRelationshipDraft,
  getQualifiedTableName,
  persistCustomRelationships,
  readCustomRelationships,
  sanitizeFileName,
} from "./erd-ui-helpers";
import {
  ER_DIAGRAM_STRUCTURE_BATCH_SIZE,
  erDiagramSchemaRequests,
  getCachedERDiagramSchema,
  getERDiagramScopeKey,
  invalidateCachedERDiagramSchema,
  setCachedERDiagramSchema,
} from "./erd-schema-cache";
import { EditableRelationEdge } from "./EditableRelationEdge";
import {
  TableNode,
  type ERDNodeContextPayload,
} from "./TableNode";
import {
  type DiagramPoint,
} from "./layout";
import {
  formatERRelationshipSummary,
  inferERRelationshipNotation,
} from "./relationshipNotation";
import {
  buildColumnAlterStatements,
  createEditorState,
  formatDbError,
  getDefaultValueForType,
  qualifyTableName,
  quoteIdentifier,
  type ColumnEditorState,
} from "../TableStructure/utils/dialect-sql-generator";

interface Props {
  connectionId: string;
  database?: string;
}

export interface PendingRelationshipDraft {
  sourceTable: string;
  targetTable: string;
  sourceColumn: string;
  targetColumn: string;
  step: "select" | "confirm";
}

interface QuickColumnEditorState {
  tableName: string;
  schemaName?: string;
  originalColumn: ColumnDetail;
  editor: ColumnEditorState;
}

const DIAGRAM_INITIAL_FIT_PADDING = 0.14;
const DIAGRAM_INITIAL_FIT_MAX_ZOOM = 0.86;
const DIAGRAM_MIN_ZOOM = 0.1;
const DIAGRAM_MAX_ZOOM = 1.5;
const DIAGRAM_RECOMMENDED_TABLE_COUNT = 12;
async function fetchSchema(
  connectionId: string,
  database?: string,
  options?: { force?: boolean },
): Promise<ERDiagramSchema> {
  const scopeKey = getERDiagramScopeKey(connectionId, database);

  if (!options?.force) {
    const cachedSchema = getCachedERDiagramSchema(connectionId, database);
    if (cachedSchema) {
      return cachedSchema;
    }
  }

  const existingRequest = erDiagramSchemaRequests.get(scopeKey);
  if (existingRequest) {
    return existingRequest;
  }

  if (options?.force) {
    invalidateCachedERDiagramSchema(connectionId, database);
    invalidateSchemaCache(connectionId, database);
  }

  const request = (async () => {
    const tables = await getOrLoadSchemaTables({ connectionId, database }, () =>
      invoke<TableInfo[]>("list_tables", {
        connectionId,
        database: database || null,
      }),
    );

    const tableSchemas: TableSchema[] = [];
    const allRelationships: ERRelationship[] = [];

    for (
      let index = 0;
      index < tables.length;
      index += ER_DIAGRAM_STRUCTURE_BATCH_SIZE
    ) {
      const batch = tables.slice(
        index,
        index + ER_DIAGRAM_STRUCTURE_BATCH_SIZE,
      );
      const structures = await Promise.all(
        batch.map((table) =>
          getOrLoadTableStructure({ connectionId, database }, table.name, () =>
            invoke<TableStructure>("get_table_structure", {
              connectionId,
              table: table.name,
              database: database || null,
            }),
          ),
        ),
      );

      batch.forEach((table, batchIndex) => {
        const structure = structures[batchIndex];
        tableSchemas.push({
          name: table.name,
          schema: table.schema,
          columns: structure.columns,
          indexes: structure.indexes,
          rowCount: table.row_count,
        });

        structure.foreign_keys.forEach((foreignKey, foreignKeyIndex) => {
          allRelationships.push({
            id: `fk-${table.name}-${foreignKey.column}-${foreignKeyIndex}`,
            fromTable: table.name,
            fromColumn: foreignKey.column,
            toTable: foreignKey.referenced_table,
            toColumn: foreignKey.referenced_column,
          });
        });
      });
    }

    const schema = { tables: tableSchemas, relationships: allRelationships };
    setCachedERDiagramSchema(connectionId, database, schema);
    return schema;
  })();

  erDiagramSchemaRequests.set(scopeKey, request);

  try {
    return await request;
  } finally {
    if (erDiagramSchemaRequests.get(scopeKey) === request) {
      erDiagramSchemaRequests.delete(scopeKey);
    }
  }
}

export function ERDiagram({ connectionId, database }: Props) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const reactFlowInstanceRef = useRef<ReactFlowInstance | null>(null);
  const hasInitializedSelectionRef = useRef(false);
  const rememberedNodePositionsRef = useRef<Map<string, DiagramPoint>>(
    new Map(),
  );
  const rememberedEdgeBendsRef = useRef<Map<string, DiagramPoint>>(new Map());
  const loadRequestIdRef = useRef(0);
  const addTab = useUIStore((state) => state.addTab);
  const setActiveTab = useUIStore((state) => state.setActiveTab);
  const updateTab = useUIStore((state) => state.updateTab);
  const connections = useConnectionStore((state) => state.connections);
  const countTableNullValues = useQueryStore(
    (state) => state.countTableNullValues,
  );
  const executeStructureStatements = useQueryStore(
    (state) => state.executeStructureStatements,
  );
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [schema, setSchema] = useState<ERDiagramSchema | null>(null);
  const [customRelationships, setCustomRelationships] = useState<
    ERRelationship[]
  >([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedTables, setSelectedTables] = useState<Set<string>>(new Set());
  const [expandedTables, setExpandedTables] = useState<Set<string>>(new Set());
  const [showMinimap, setShowMinimap] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [isSidePanelCollapsed, setIsSidePanelCollapsed] = useState(false);
  const [exportFormat, setExportFormat] = useState<"png" | "drawio" | null>(
    null,
  );
  const [tableFilter, setTableFilter] = useState("");
  const [pendingRelationship, setPendingRelationship] =
    useState<PendingRelationshipDraft | null>(null);
  const [relationshipModalError, setRelationshipModalError] = useState<
    string | null
  >(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ERDContextMenuState | null>(
    null,
  );
  const [quickColumnEditor, setQuickColumnEditor] =
    useState<QuickColumnEditorState | null>(null);
  const [quickColumnEditorError, setQuickColumnEditorError] = useState<
    string | null
  >(null);
  const [isApplyingQuickColumnEdit, setIsApplyingQuickColumnEdit] =
    useState(false);

  const nodeTypes = useMemo<NodeTypes>(() => ({ tableNode: TableNode }), []);
  const edgeTypes = useMemo<EdgeTypes>(
    () => ({ editableRelationEdge: EditableRelationEdge }),
    [],
  );
  const allRelationships = useMemo(
    () =>
      dedupeRelationships([
        ...(schema?.relationships || []),
        ...customRelationships,
      ]),
    [customRelationships, schema],
  );
  const activeConnection = useMemo(
    () => connections.find((item) => item.id === connectionId),
    [connectionId, connections],
  );
  const activeDbType = (activeConnection?.db_type ||
    "postgresql") as DatabaseType;
  const activeDatabaseLabel =
    database || schema?.tables[0]?.schema || "Current database";

  useEffect(() => {
    hasInitializedSelectionRef.current = false;
    rememberedNodePositionsRef.current.clear();
    rememberedEdgeBendsRef.current.clear();
    setCustomRelationships(readCustomRelationships(connectionId, database));
    setPendingRelationship(null);
    setRelationshipModalError(null);
    setExportError(null);
    setContextMenu(null);
    setQuickColumnEditor(null);
    setQuickColumnEditorError(null);
    setIsApplyingQuickColumnEdit(false);
    setExpandedTables(new Set());
  }, [connectionId, database]);

  const loadSchema = useCallback(
    async (options?: { force?: boolean }) => {
      const cachedSchema = !options?.force
        ? getCachedERDiagramSchema(connectionId, database)
        : null;
      if (cachedSchema) {
        setSchema(cachedSchema);
        setError(null);
        setLoading(false);
        return;
      }

      const requestId = ++loadRequestIdRef.current;
      setLoading(true);
      setError(null);

      try {
        const data = await fetchSchema(connectionId, database, options);
        if (requestId !== loadRequestIdRef.current) return;
        setSchema(data);
        setSelectedTables((current) => {
          const allTableNames = data.tables.map((table) => table.name);
          if (!hasInitializedSelectionRef.current) {
            hasInitializedSelectionRef.current = true;
            return getRecommendedTableSelection(data);
          }

          if (current.size === 0) return current;

          const availableNames = new Set(allTableNames);
          const preservedNames = [...current].filter((tableName) =>
            availableNames.has(tableName),
          );
          return preservedNames.length > 0
            ? new Set(preservedNames)
            : new Set(allTableNames);
        });
      } catch (reason) {
        if (requestId !== loadRequestIdRef.current) return;
        setError(String(reason));
      } finally {
        if (requestId === loadRequestIdRef.current) {
          setLoading(false);
        }
      }
    },
    [connectionId, database],
  );

  useEffect(() => {
    loadSchema();
  }, [loadSchema]);

  useEffect(() => {
    const handleSchemaInvalidation = (event: Event) => {
      const detail = (
        event as CustomEvent<{ connectionId?: string; database?: string }>
      ).detail;
      if (detail?.connectionId !== connectionId) return;
      if (detail.database !== undefined && detail.database !== database) return;
      invalidateCachedERDiagramSchema(connectionId, database);
      void loadSchema();
    };

    window.addEventListener(
      "schema-cache-invalidated",
      handleSchemaInvalidation,
    );
    return () =>
      window.removeEventListener(
        "schema-cache-invalidated",
        handleSchemaInvalidation,
      );
  }, [connectionId, database, loadSchema]);

  const handleTableExpandToggle = useCallback((tableName: string) => {
    setExpandedTables((current) => {
      const next = new Set(current);

      if (next.has(tableName)) next.delete(tableName);
      else next.add(tableName);

      return next;
    });
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const tableMap = useMemo(() => {
    return new Map((schema?.tables || []).map((table) => [table.name, table]));
  }, [schema]);

  const openTableDataTab = useCallback(
    (tableName: string) => {
      const table = tableMap.get(tableName);
      if (!table) return;

      const qualifiedName = getQualifiedTableName(table);
      const tabId = `table-${connectionId}-${database || ""}-${qualifiedName}`;
      addTab({
        id: tabId,
        type: "table",
        title: table.name,
        connectionId,
        tableName: qualifiedName,
        database: database || undefined,
      });
      setActiveTab(tabId);
    },
    [addTab, connectionId, database, setActiveTab, tableMap],
  );

  const openStructureEditor = useCallback(
    (
      tableName: string,
      section:
        "columns" | "indexes" | "foreign_keys" | "triggers" | "view_definition",
      columnName?: string,
    ) => {
      const table = tableMap.get(tableName);
      if (!table) return;

      const qualifiedName = getQualifiedTableName(table);
      const tabId = `structure-${connectionId}-${database || ""}-${qualifiedName}`;
      const focusToken = crypto.randomUUID();
      const focusState = {
        structureFocusSection: section,
        structureFocusColumn: columnName,
        structureFocusToken: focusToken,
      } as const;
      const existingTab = useUIStore
        .getState()
        .tabs.find((tab) => tab.id === tabId);

      if (existingTab) {
        updateTab(tabId, focusState);
        setActiveTab(tabId);
        return;
      }

      addTab({
        id: tabId,
        type: "structure",
        title: `${table.name} (structure)`,
        connectionId,
        tableName: qualifiedName,
        database: database || undefined,
        ...focusState,
      });
      setActiveTab(tabId);
    },
    [addTab, connectionId, database, setActiveTab, tableMap, updateTab],
  );

  const handleNodeContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLElement>, payload: ERDNodeContextPayload) => {
      setContextMenu({
        x: event.clientX,
        y: event.clientY,
        tableName: payload.tableName,
        schemaName: payload.schemaName,
        columnName: payload.columnName,
      });
    },
    [],
  );

  const openQuickColumnEditor = useCallback(
    (tableName: string, columnName: string) => {
      const table = tableMap.get(tableName);
      const column = table?.columns.find(
        (item) => item.name.toLowerCase() === columnName.toLowerCase(),
      );
      if (!table || !column) return;

      setQuickColumnEditor({
        tableName: table.name,
        schemaName: table.schema,
        originalColumn: column,
        editor: createEditorState(column),
      });
      setQuickColumnEditorError(null);
      setIsApplyingQuickColumnEdit(false);
    },
    [tableMap],
  );

  const closeQuickColumnEditor = useCallback(() => {
    if (isApplyingQuickColumnEdit) return;
    setQuickColumnEditor(null);
    setQuickColumnEditorError(null);
  }, [isApplyingQuickColumnEdit]);

  const updateQuickColumnEditor = useCallback(
    (updates: Partial<ColumnEditorState>) => {
      setQuickColumnEditorError(null);
      setQuickColumnEditor((current) =>
        current
          ? {
              ...current,
              editor: {
                ...current.editor,
                ...updates,
              },
            }
          : current,
      );
    },
    [],
  );

  const quickColumnSqlPreview = useMemo(() => {
    if (!quickColumnEditor) {
      return { statements: [] };
    }

    return buildColumnAlterStatements(
      activeDbType,
      getQualifiedTableName({
        name: quickColumnEditor.tableName,
        schema: quickColumnEditor.schemaName,
      }),
      database || undefined,
      quickColumnEditor.originalColumn,
      quickColumnEditor.editor,
    );
  }, [activeDbType, database, quickColumnEditor]);

  const handleApplyQuickColumnEdit = useCallback(async () => {
    if (!quickColumnEditor) return;

    if (quickColumnSqlPreview.error) {
      setQuickColumnEditorError(quickColumnSqlPreview.error);
      return;
    }

    if (quickColumnSqlPreview.statements.length === 0) {
      setQuickColumnEditorError("No changes to apply.");
      return;
    }

    const qualifiedTableName = getQualifiedTableName({
      name: quickColumnEditor.tableName,
      schema: quickColumnEditor.schemaName,
    });

    setQuickColumnEditorError(null);
    setIsApplyingQuickColumnEdit(true);

    try {
      const shouldSetNotNull =
        !quickColumnEditor.editor.isPrimaryKey &&
        !quickColumnEditor.editor.nullable &&
        quickColumnEditor.originalColumn.is_nullable;

      if (shouldSetNotNull) {
        const nullCount = await countTableNullValues(
          connectionId,
          qualifiedTableName,
          quickColumnEditor.originalColumn.name,
          database || undefined,
        );

        if (nullCount > 0) {
          const defaultValue = getDefaultValueForType(
            quickColumnEditor.editor.dataType,
          );
          const confirmed = window.confirm(
            `Column "${quickColumnEditor.originalColumn.name}" has ${nullCount} NULL value(s).\n\n` +
              `To set NOT NULL, TableR can update them to ${defaultValue} first.\n\n` +
              `Click OK to continue, or Cancel to stop.`,
          );

          if (!confirmed) {
            throw new Error("Apply cancelled.");
          }

          const tableRef = qualifyTableName(
            activeDbType,
            qualifiedTableName,
            database || undefined,
          );
          const columnRef = quoteIdentifier(
            activeDbType,
            quickColumnEditor.originalColumn.name,
          );
          const fixSql = `UPDATE ${tableRef} SET ${columnRef} = ${defaultValue} WHERE ${columnRef} IS NULL`;
          await executeStructureStatements(connectionId, [fixSql]);
        }
      }

      await executeStructureStatements(
        connectionId,
        quickColumnSqlPreview.statements,
      );
      invalidateCachedERDiagramSchema(connectionId, database);
      await loadSchema({ force: true });
      window.dispatchEvent(
        new CustomEvent("table-structure-updated", {
          detail: {
            connectionId,
            tableName: qualifiedTableName,
            database: database || undefined,
          },
        }),
      );
      setQuickColumnEditor(null);
      setQuickColumnEditorError(null);
    } catch (reason) {
      const formattedError = formatDbError(reason, qualifiedTableName);
      if (formattedError !== "Apply cancelled.") {
        setQuickColumnEditorError(formattedError);
      }
    } finally {
      setIsApplyingQuickColumnEdit(false);
    }
  }, [
    activeDbType,
    connectionId,
    countTableNullValues,
    database,
    executeStructureStatements,
    loadSchema,
    quickColumnEditor,
    quickColumnSqlPreview.error,
    quickColumnSqlPreview.statements,
  ]);

  useEffect(() => {
    if (!contextMenu) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".erd-context-menu")) return;
      setContextMenu(null);
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setContextMenu(null);
      }
    };

    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);

    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!schema) return;

    setNodes((existing) => {
      existing.forEach((node) => {
        rememberedNodePositionsRef.current.set(node.id, { ...node.position });
      });

      return buildNodes(
        schema.tables,
        allRelationships,
        selectedTables,
        expandedTables,
        existing,
        rememberedNodePositionsRef.current,
        handleTableExpandToggle,
        handleNodeContextMenu,
      );
    });

    setEdges((existing) => {
      existing.forEach((edge) => {
        const bendOffset = (
          edge.data as { bendOffset?: DiagramPoint } | undefined
        )?.bendOffset;
        if (bendOffset) {
          rememberedEdgeBendsRef.current.set(edge.id, { ...bendOffset });
        }
      });

      return buildEdges(
        schema.tables,
        allRelationships,
        selectedTables,
        existing,
        rememberedEdgeBendsRef.current,
      );
    });
  }, [
    allRelationships,
    expandedTables,
    handleNodeContextMenu,
    handleTableExpandToggle,
    schema,
    selectedTables,
    setNodes,
    setEdges,
  ]);

  useEffect(() => {
    nodes.forEach((node) => {
      rememberedNodePositionsRef.current.set(node.id, { ...node.position });
    });
  }, [nodes]);

  useEffect(() => {
    edges.forEach((edge) => {
      const bendOffset = (
        edge.data as { bendOffset?: DiagramPoint } | undefined
      )?.bendOffset;
      if (bendOffset) {
        rememberedEdgeBendsRef.current.set(edge.id, { ...bendOffset });
      }
    });
  }, [edges]);

  const onConnect: OnConnect = useCallback(
    (connection: Connection) => {
      if (!schema || !connection.source || !connection.target) return;

      const sourceTable = schema.tables.find(
        (table) => table.name === connection.source,
      );
      const targetTable = schema.tables.find(
        (table) => table.name === connection.target,
      );
      if (!sourceTable || !targetTable) return;

      const defaults = getPreferredRelationshipDraft(sourceTable, targetTable);
      setRelationshipModalError(null);
      setPendingRelationship({
        sourceTable: sourceTable.name,
        targetTable: targetTable.name,
        sourceColumn: defaults.sourceColumn,
        targetColumn: defaults.targetColumn,
        step: "select",
      });
    },
    [schema],
  );

  const closeRelationshipModal = useCallback(() => {
    setPendingRelationship(null);
    setRelationshipModalError(null);
  }, []);

  const sourceTableForDraft = pendingRelationship
    ? schema?.tables.find(
        (table) => table.name === pendingRelationship.sourceTable,
      ) || null
    : null;
  const targetTableForDraft = pendingRelationship
    ? schema?.tables.find(
        (table) => table.name === pendingRelationship.targetTable,
      ) || null
    : null;
  const sourceColumnOptions = useMemo(
    () => sourceTableForDraft?.columns.map(getColumnSelectOption) || [],
    [sourceTableForDraft],
  );
  const targetColumnOptions = useMemo(
    () => targetTableForDraft?.columns.map(getColumnSelectOption) || [],
    [targetTableForDraft],
  );
  const pendingRelationshipNotation = useMemo(() => {
    if (!pendingRelationship || !sourceTableForDraft || !targetTableForDraft)
      return null;
    if (!pendingRelationship.sourceColumn || !pendingRelationship.targetColumn)
      return null;

    return inferERRelationshipNotation(
      sourceTableForDraft,
      pendingRelationship.sourceColumn,
      targetTableForDraft,
      pendingRelationship.targetColumn,
      { enforceReferenceConstraint: false },
    );
  }, [pendingRelationship, sourceTableForDraft, targetTableForDraft]);
  const canAdvanceRelationshipDraft = Boolean(
    pendingRelationship?.sourceColumn &&
    pendingRelationship?.targetColumn &&
    sourceTableForDraft &&
    targetTableForDraft,
  );

  const confirmRelationshipDraft = useCallback(() => {
    if (!pendingRelationship) return;

    const relationship: ERRelationship = {
      id: getRelationshipId({
        fromTable: pendingRelationship.sourceTable,
        fromColumn: pendingRelationship.sourceColumn,
        toTable: pendingRelationship.targetTable,
        toColumn: pendingRelationship.targetColumn,
      }),
      fromTable: pendingRelationship.sourceTable,
      fromColumn: pendingRelationship.sourceColumn,
      toTable: pendingRelationship.targetTable,
      toColumn: pendingRelationship.targetColumn,
      label: `${pendingRelationship.sourceColumn} = ${pendingRelationship.targetColumn}`,
      isCustom: true,
    };

    const signature = getRelationshipSignature(relationship);
    const alreadyExists = allRelationships.some(
      (item) => getRelationshipSignature(item) === signature,
    );

    if (alreadyExists) {
      setRelationshipModalError(
        "This relationship already exists in the diagram.",
      );
      return;
    }

    const nextRelationships = dedupeRelationships([
      ...customRelationships,
      relationship,
    ]);
    setCustomRelationships(nextRelationships);
    persistCustomRelationships(connectionId, database, nextRelationships);
    rememberedEdgeBendsRef.current.set(relationship.id, { x: 0, y: 0 });
    setPendingRelationship(null);
    setRelationshipModalError(null);
  }, [
    allRelationships,
    connectionId,
    customRelationships,
    database,
    pendingRelationship,
  ]);

  const openRelationshipConfirmation = useCallback(() => {
    if (!canAdvanceRelationshipDraft || !pendingRelationship) {
      setRelationshipModalError("Choose both columns before continuing.");
      return;
    }

    setRelationshipModalError(null);
    setPendingRelationship((current) =>
      current ? { ...current, step: "confirm" } : current,
    );
  }, [canAdvanceRelationshipDraft, pendingRelationship]);

  const handleTableToggle = (tableName: string) => {
    setSelectedTables((current) => {
      const next = new Set(current);

      if (next.has(tableName)) next.delete(tableName);
      else next.add(tableName);

      return next;
    });
  };

  const fitDiagram = useCallback((maxZoom = 0.92) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        void reactFlowInstanceRef.current?.fitView({
          padding: 0.14,
          maxZoom,
          duration: 260,
        });
      });
    });
  }, []);

  const handleRecommendedSelection = useCallback(() => {
    if (!schema) return;
    setSelectedTables(getRecommendedTableSelection(schema));
    fitDiagram();
  }, [fitDiagram, schema]);

  const handleSelectAll = () => {
    if (!schema) return;
    setSelectedTables(new Set(schema.tables.map((table) => table.name)));
    fitDiagram(0.48);
  };

  const handleClearAll = () => {
    setSelectedTables(new Set());
  };

  const handleAutoLayout = useCallback(() => {
    if (!schema || selectedTables.size === 0) return;

    rememberedNodePositionsRef.current.clear();
    rememberedEdgeBendsRef.current.clear();
    setNodes(
      buildNodes(
        schema.tables,
        allRelationships,
        selectedTables,
        expandedTables,
        [],
        new Map(),
        handleTableExpandToggle,
        handleNodeContextMenu,
      ),
    );
    setEdges((existing) =>
      buildEdges(
        schema.tables,
        allRelationships,
        selectedTables,
        existing,
        new Map(),
      ),
    );
    fitDiagram(
      selectedTables.size > DIAGRAM_RECOMMENDED_TABLE_COUNT ? 0.62 : 0.92,
    );
  }, [
    allRelationships,
    expandedTables,
    fitDiagram,
    handleNodeContextMenu,
    handleTableExpandToggle,
    schema,
    selectedTables,
    setEdges,
    setNodes,
  ]);

  const handleExportPNG = useCallback(async () => {
    if (nodes.length === 0) {
      setExportError("Select at least one table before exporting the diagram.");
      return;
    }

    try {
      setExportFormat("png");
      setExportError(null);

      const canvas = renderERDiagramCanvas(nodes, edges);
      if (!canvas) {
        throw new Error("Could not prepare the ER diagram export image.");
      }

      const fileName = `${sanitizeFileName(activeDatabaseLabel || "er-diagram") || "er-diagram"}.png`;
      const blob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob((value) => resolve(value), "image/png");
      });
      const downloadLink = document.createElement("a");
      downloadLink.download = fileName;
      downloadLink.style.display = "none";

      if (blob) {
        const objectUrl = URL.createObjectURL(blob);
        downloadLink.href = objectUrl;
        document.body.appendChild(downloadLink);
        downloadLink.click();
        downloadLink.remove();
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      } else {
        downloadLink.href = canvas.toDataURL("image/png");
        document.body.appendChild(downloadLink);
        downloadLink.click();
        downloadLink.remove();
      }
    } catch (reason) {
      setExportError(
        reason instanceof Error
          ? reason.message
          : "Could not export the ER diagram PNG.",
      );
    } finally {
      setExportFormat(null);
    }
  }, [activeDatabaseLabel, edges, nodes]);

  const handleExportDrawio = useCallback(async () => {
    if (nodes.length === 0) {
      setExportError("Select at least one table before exporting the diagram.");
      return;
    }

    try {
      setExportFormat("drawio");
      setExportError(null);

      const snapshot = buildERDiagramExportSnapshot(nodes, edges);
      if (!snapshot) {
        throw new Error("Could not prepare the ER diagram export file.");
      }

      const xml = buildDrawioDiagramXml(snapshot);
      const fileName = `${sanitizeFileName(activeDatabaseLabel || "er-diagram") || "er-diagram"}.drawio`;
      const blob = new Blob([xml], {
        type: "application/vnd.jgraph.mxfile+xml;charset=utf-8",
      });
      const objectUrl = URL.createObjectURL(blob);
      const downloadLink = document.createElement("a");

      downloadLink.download = fileName;
      downloadLink.href = objectUrl;
      downloadLink.style.display = "none";
      document.body.appendChild(downloadLink);
      downloadLink.click();
      downloadLink.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch (reason) {
      setExportError(
        reason instanceof Error
          ? reason.message
          : "Could not export the ER diagram draw.io file.",
      );
    } finally {
      setExportFormat(null);
    }
  }, [activeDatabaseLabel, edges, nodes]);

  const handleOpenRelationshipSql = useCallback(() => {
    const sql = buildERDiagramSqlExport(
      activeDbType,
      allRelationships,
      database,
    );
    const tabId = `query-${crypto.randomUUID()}`;
    addTab({
      id: tabId,
      type: "query",
      title: "ER relationship review",
      connectionId,
      database: database || undefined,
      content: sql,
    });
    setActiveTab(tabId);
  }, [
    activeDbType,
    addTab,
    allRelationships,
    connectionId,
    database,
    setActiveTab,
  ]);

  const buildSelectionQuery = useCallback(
    (tableName: string, columnName?: string) => {
      const table = tableMap.get(tableName);
      if (!table) return null;

      const qualifiedTable = qualifyTableName(
        activeDbType,
        getQualifiedTableName(table),
        database,
      );
      const selectedColumns = columnName
        ? quoteIdentifier(activeDbType, columnName)
        : "*";
      return `SELECT ${selectedColumns}\nFROM ${qualifiedTable}\nLIMIT 100;`;
    },
    [activeDbType, database, tableMap],
  );

  const openSelectionQuery = useCallback(
    (tableName: string, columnName?: string, explain = false) => {
      const query = buildSelectionQuery(tableName, columnName);
      if (!query) return;

      const content = explain
        ? activeDbType === "mssql"
          ? `SET SHOWPLAN_XML ON;\n${query}\nSET SHOWPLAN_XML OFF;`
          : `EXPLAIN\n${query}`
        : query;
      const tabId = `erd-${explain ? "explain" : "query"}-${crypto.randomUUID()}`;
      const scope = columnName ? `${tableName}.${columnName}` : tableName;

      addTab({
        id: tabId,
        type: "query",
        title: explain ? `Explain ${scope}` : `Query ${scope}`,
        connectionId,
        database: database || undefined,
        content,
      });
      setActiveTab(tabId);
    },
    [
      activeDbType,
      addTab,
      buildSelectionQuery,
      connectionId,
      database,
      setActiveTab,
    ],
  );

  const attachSelectionToAI = useCallback(
    (tableName: string, columnName?: string) => {
      const query = buildSelectionQuery(tableName, columnName);
      if (!query) return;

      const selectionLabel = columnName
        ? `${tableName}.${columnName}`
        : tableName;
      window.dispatchEvent(
        new CustomEvent("open-ai-slide-panel", {
          detail: {
            prompt: `Review the ER diagram selection ${selectionLabel}.`,
            attachment: {
              source: `ER Diagram: ${selectionLabel}`,
              text: [
                "ER diagram selection:",
                `Database: ${database || "current database"}`,
                `Table: ${tableName}`,
                columnName ? `Column: ${columnName}` : "",
                "Suggested read-only query:",
                query,
              ]
                .filter(Boolean)
                .join("\n"),
            },
          },
        }),
      );
    },
    [buildSelectionQuery, database],
  );

  const contextMenuItems = useMemo<ERDContextMenuItem[]>(() => {
    if (!contextMenu) return [];

    if (contextMenu.columnName) {
      return [
        {
          key: "edit-column",
          label: `Edit column ${contextMenu.columnName}`,
          action: () =>
            openQuickColumnEditor(
              contextMenu.tableName,
              contextMenu.columnName || "",
            ),
        },
        {
          key: "edit-columns",
          label: "Open columns editor",
          action: () => openStructureEditor(contextMenu.tableName, "columns"),
        },
        {
          key: "edit-indexes",
          label: "Edit indexes",
          action: () => openStructureEditor(contextMenu.tableName, "indexes"),
        },
        {
          key: "edit-foreign-keys",
          label: "Edit foreign keys",
          action: () =>
            openStructureEditor(contextMenu.tableName, "foreign_keys"),
        },
        { key: "divider-open", divider: true },
        {
          key: "open-data",
          label: "Open table data",
          action: () => openTableDataTab(contextMenu.tableName),
        },
        {
          key: "seed-query",
          label: "Open SELECT query",
          action: () =>
            openSelectionQuery(contextMenu.tableName, contextMenu.columnName),
        },
        {
          key: "seed-explain",
          label: "Open explain plan",
          action: () =>
            openSelectionQuery(
              contextMenu.tableName,
              contextMenu.columnName,
              true,
            ),
        },
        {
          key: "ask-ai",
          label: "Ask AI about selection",
          action: () =>
            attachSelectionToAI(contextMenu.tableName, contextMenu.columnName),
        },
      ];
    }

    return [
      {
        key: "edit-columns",
        label: "Edit columns",
        action: () => openStructureEditor(contextMenu.tableName, "columns"),
      },
      {
        key: "edit-indexes",
        label: "Edit indexes",
        action: () => openStructureEditor(contextMenu.tableName, "indexes"),
      },
      {
        key: "edit-foreign-keys",
        label: "Edit foreign keys",
        action: () =>
          openStructureEditor(contextMenu.tableName, "foreign_keys"),
      },
      {
        key: "inspect-triggers",
        label: "Inspect triggers",
        action: () => openStructureEditor(contextMenu.tableName, "triggers"),
      },
      { key: "divider-open", divider: true },
      {
        key: "open-data",
        label: "Open table data",
        action: () => openTableDataTab(contextMenu.tableName),
      },
      {
        key: "seed-query",
        label: "Open SELECT query",
        action: () => openSelectionQuery(contextMenu.tableName),
      },
      {
        key: "seed-explain",
        label: "Open explain plan",
        action: () =>
          openSelectionQuery(contextMenu.tableName, undefined, true),
      },
      {
        key: "ask-ai",
        label: "Ask AI about selection",
        action: () => attachSelectionToAI(contextMenu.tableName),
      },
    ];
  }, [
    attachSelectionToAI,
    contextMenu,
    openQuickColumnEditor,
    openSelectionQuery,
    openStructureEditor,
    openTableDataTab,
  ]);

  const handleOpenFullEditorFromQuickModal = useCallback(() => {
    if (!quickColumnEditor) return;

    openStructureEditor(
      quickColumnEditor.tableName,
      "columns",
      quickColumnEditor.originalColumn.name,
    );
    setQuickColumnEditor(null);
    setQuickColumnEditorError(null);
  }, [openStructureEditor, quickColumnEditor]);

  const filteredTables = useMemo(() => {
    if (!schema) return [];

    const keyword = tableFilter.trim().toLowerCase();
    if (!keyword) return schema.tables;

    return schema.tables.filter((table) =>
      table.name.toLowerCase().includes(keyword),
    );
  }, [schema, tableFilter]);

  const tableColorMap = useMemo(() => {
    return new Map(
      (schema?.tables || []).map((table, index) => [
        table.name,
        getTableColor(index),
      ]),
    );
  }, [schema]);

  const visibleRelationshipCount = useMemo(() => {
    if (!schema) return 0;

    return allRelationships.filter(
      (relationship) =>
        selectedTables.has(relationship.fromTable) &&
        selectedTables.has(relationship.toTable),
    ).length;
  }, [allRelationships, schema, selectedTables]);
  const bannerError = error || exportError;

  return (
    <div ref={shellRef} className="erd-shell">
      <header className="erd-topbar">
        <div className="erd-topbar-heading">
          <span className="erd-topbar-mark">
            <GitBranch className="erd-topbar-mark-icon" />
          </span>
          <div className="erd-topbar-copy">
            <strong className="erd-topbar-title">ER Diagram</strong>
            <span className="erd-topbar-database">{activeDatabaseLabel}</span>
          </div>
        </div>

        <div className="erd-toolbar-stats" aria-label="Diagram summary">
          <span className="erd-toolbar-stat">
            <Database className="erd-toolbar-icon" />
            {schema
              ? `${selectedTables.size} of ${schema.tables.length}`
              : "Loading"}
          </span>
          <span className="erd-toolbar-stat">
            <GitBranch className="erd-toolbar-icon" />
            {schema ? visibleRelationshipCount : 0}
          </span>
        </div>

        <div className="erd-toolbar-spacer" />

        <div
          className="erd-toolbar-group"
          role="group"
          aria-label="Diagram layout"
        >
          <button
            type="button"
            onClick={() => {
              invalidateCachedERDiagramSchema(connectionId, database);
              void loadSchema({ force: true });
            }}
            disabled={loading}
            className="erd-toolbar-button is-icon-only"
            title={loading ? "Refreshing schema" : "Refresh schema"}
            aria-label={loading ? "Refreshing schema" : "Refresh schema"}
          >
            <RefreshCw
              className={`erd-toolbar-icon ${loading ? "is-spinning" : ""}`}
            />
          </button>

          <button
            type="button"
            onClick={handleAutoLayout}
            disabled={selectedTables.size === 0}
            className="erd-toolbar-button"
            title="Arrange selected tables"
          >
            <LayoutGrid className="erd-toolbar-icon" />
            Auto layout
          </button>

          <button
            type="button"
            onClick={() => fitDiagram()}
            disabled={selectedTables.size === 0}
            className="erd-toolbar-button"
            title="Fit selected tables in view"
          >
            <ScanSearch className="erd-toolbar-icon" />
            Fit
          </button>
        </div>

        <div className="erd-toolbar-divider" />

        <div
          className="erd-toolbar-group"
          role="group"
          aria-label="Diagram view"
        >
          <button
            type="button"
            onClick={() => setIsSidePanelCollapsed((value) => !value)}
            className={`erd-toolbar-button is-icon-only ${!isSidePanelCollapsed ? "is-active" : ""}`}
            title={
              isSidePanelCollapsed ? "Show table browser" : "Hide table browser"
            }
            aria-label={
              isSidePanelCollapsed ? "Show table browser" : "Hide table browser"
            }
            aria-pressed={!isSidePanelCollapsed}
          >
            {isSidePanelCollapsed ? (
              <PanelLeftOpen className="erd-toolbar-icon" />
            ) : (
              <PanelLeftClose className="erd-toolbar-icon" />
            )}
          </button>

          <button
            type="button"
            onClick={() => setShowMinimap((value) => !value)}
            className={`erd-toolbar-button is-icon-only ${showMinimap ? "is-active" : ""}`}
            title={showMinimap ? "Hide minimap" : "Show minimap"}
            aria-label={showMinimap ? "Hide minimap" : "Show minimap"}
            aria-pressed={showMinimap}
          >
            <MapIcon className="erd-toolbar-icon" />
          </button>

          <button
            type="button"
            onClick={() => setShowControls((value) => !value)}
            className={`erd-toolbar-button is-icon-only ${showControls ? "is-active" : ""}`}
            title={showControls ? "Hide zoom controls" : "Show zoom controls"}
            aria-label={
              showControls ? "Hide zoom controls" : "Show zoom controls"
            }
            aria-pressed={showControls}
          >
            <SlidersHorizontal className="erd-toolbar-icon" />
          </button>
        </div>

        <div className="erd-toolbar-divider" />

        <div
          className="erd-toolbar-group"
          role="group"
          aria-label="Export diagram"
        >
          <button
            type="button"
            onClick={handleExportPNG}
            disabled={exportFormat !== null || nodes.length === 0}
            className="erd-toolbar-button is-primary"
          >
            <Download className="erd-toolbar-icon" />
            {exportFormat === "png" ? "Exporting" : "PNG"}
          </button>

          <button
            type="button"
            onClick={handleExportDrawio}
            disabled={exportFormat !== null || nodes.length === 0}
            className="erd-toolbar-button is-icon-only"
            title={
              exportFormat === "drawio" ? "Exporting Draw.io" : "Export Draw.io"
            }
            aria-label={
              exportFormat === "drawio" ? "Exporting Draw.io" : "Export Draw.io"
            }
          >
            <FileText className="erd-toolbar-icon" />
          </button>
          <button
            type="button"
            onClick={handleOpenRelationshipSql}
            disabled={allRelationships.length === 0}
            className="erd-toolbar-button"
            title="Open relationship SQL review"
          >
            <FileText className="erd-toolbar-icon" />
            SQL
          </button>
        </div>
      </header>

      {bannerError && <div className="erd-error-banner">{bannerError}</div>}

      {loading && !schema && (
        <div className="erd-loading-state">
          <RefreshCw className="erd-loading-icon" />
          <div className="erd-loading-copy">
            <strong>Loading diagram data</strong>
            <span>
              Reading tables, columns, and relationships from the current
              database.
            </span>
          </div>
        </div>
      )}

      {!loading && schema && (
        <div
          className={`erd-workspace ${isSidePanelCollapsed ? "is-sidebar-collapsed" : ""}`}
        >
          <ERDSidePanel
            isSidePanelCollapsed={isSidePanelCollapsed}
            setIsSidePanelCollapsed={setIsSidePanelCollapsed}
            selectedTables={selectedTables}
            filteredTables={filteredTables}
            tableColorMap={tableColorMap}
            tableFilter={tableFilter}
            setTableFilter={setTableFilter}
            handleRecommendedSelection={handleRecommendedSelection}
            handleSelectAll={handleSelectAll}
            handleClearAll={handleClearAll}
            handleTableToggle={handleTableToggle}
          />

          <main className="erd-canvas">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onInit={(instance) => {
                reactFlowInstanceRef.current = instance;
              }}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              fitView
              fitViewOptions={{
                padding: DIAGRAM_INITIAL_FIT_PADDING,
                maxZoom: DIAGRAM_INITIAL_FIT_MAX_ZOOM,
              }}
              minZoom={DIAGRAM_MIN_ZOOM}
              maxZoom={DIAGRAM_MAX_ZOOM}
              className="erd-flow"
              proOptions={{ hideAttribution: true }}
              onlyRenderVisibleElements
              selectionOnDrag
            >
              {showMinimap && (
                <MiniMap
                  className="erd-minimap"
                  nodeColor={(node) =>
                    (node.data as { color?: string }).color || "#60A5FA"
                  }
                  maskColor="rgba(248, 250, 252, 0.74)"
                  pannable
                  zoomable
                />
              )}

              {showControls && (
                <Controls className="erd-controls" showInteractive={false} />
              )}

              <Background
                variant={BackgroundVariant.Dots}
                gap={22}
                size={1.15}
                color="var(--mm-border)"
              />
            </ReactFlow>

            {selectedTables.size === 0 && (
              <div className="erd-canvas-empty">
                <Database className="erd-canvas-empty-icon" />
                <strong>No tables on the canvas</strong>
                <span>
                  Select tables from the browser or restore the recommended
                  overview.
                </span>
                <button
                  type="button"
                  className="erd-canvas-empty-action"
                  onClick={handleRecommendedSelection}
                >
                  <Sparkles className="erd-toolbar-icon" />
                  Restore overview
                </button>
              </div>
            )}
          </main>
        </div>
      )}

      <ERDContextMenu
        contextMenu={contextMenu}
        items={contextMenuItems}
        onClose={closeContextMenu}
      />

      {quickColumnEditor && (
        <ERDQuickColumnModal
          tableName={quickColumnEditor.tableName}
          columnName={quickColumnEditor.originalColumn.name}
          dbType={activeDbType}
          editor={quickColumnEditor.editor}
          sqlPreview={quickColumnSqlPreview}
          editorError={quickColumnEditorError}
          isSaving={isApplyingQuickColumnEdit}
          onClose={closeQuickColumnEditor}
          onUpdate={updateQuickColumnEditor}
          onApply={() => void handleApplyQuickColumnEdit()}
          onOpenFullEditor={handleOpenFullEditorFromQuickModal}
        />
      )}

      {pendingRelationship && sourceTableForDraft && targetTableForDraft && (
        <div className="erd-modal-backdrop" onClick={closeRelationshipModal}>
          <div
            className="erd-modal-shell"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="erd-modal-header">
              <div className="erd-modal-header-copy">
                <span className="erd-modal-kicker">
                  {pendingRelationship.step === "select"
                    ? "Step 1 of 2"
                    : "Step 2 of 2"}
                </span>
                <strong className="erd-modal-title">
                  {pendingRelationship.step === "select"
                    ? "Create custom relationship"
                    : "Confirm relationship"}
                </strong>
              </div>

              <button
                type="button"
                className="erd-modal-close"
                onClick={closeRelationshipModal}
              >
                <X className="erd-modal-close-icon" />
              </button>
            </div>

            {pendingRelationship.step === "select" ? (
              <div className="erd-modal-body">
                <div className="erd-modal-summary">
                  <span className="erd-modal-chip">
                    {sourceTableForDraft.name}
                  </span>
                  <Link2 className="erd-modal-link-icon" />
                  <span className="erd-modal-chip">
                    {targetTableForDraft.name}
                  </span>
                </div>

                <div className="erd-modal-grid">
                  <label className="erd-modal-field">
                    <span className="erd-modal-label">Source column</span>
                    <ERDCompactSelect
                      value={pendingRelationship.sourceColumn}
                      options={sourceColumnOptions}
                      ariaLabel="Source column"
                      onChange={(value) => {
                        setRelationshipModalError(null);
                        setPendingRelationship((current) =>
                          current
                            ? { ...current, sourceColumn: value }
                            : current,
                        );
                      }}
                    />
                  </label>

                  <label className="erd-modal-field">
                    <span className="erd-modal-label">Target column</span>
                    <ERDCompactSelect
                      value={pendingRelationship.targetColumn}
                      options={targetColumnOptions}
                      ariaLabel="Target column"
                      onChange={(value) => {
                        setRelationshipModalError(null);
                        setPendingRelationship((current) =>
                          current
                            ? { ...current, targetColumn: value }
                            : current,
                        );
                      }}
                    />
                  </label>
                </div>

                <p className="erd-modal-help">
                  {pendingRelationshipNotation
                    ? `Detected notation: ${formatERRelationshipSummary(pendingRelationshipNotation)}. This saves a persistent custom relationship for the current connection and database.`
                    : "This saves a persistent custom relationship for the current connection and database."}
                </p>

                {relationshipModalError && (
                  <div className="erd-modal-error">
                    {relationshipModalError}
                  </div>
                )}

                <div className="erd-modal-actions">
                  <button
                    type="button"
                    className="erd-modal-btn"
                    onClick={closeRelationshipModal}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="erd-modal-btn is-primary"
                    onClick={openRelationshipConfirmation}
                  >
                    Continue
                  </button>
                </div>
              </div>
            ) : (
              <div className="erd-modal-body">
                <div className="erd-modal-confirm-card">
                  <span className="erd-modal-confirm-label">Source</span>
                  <strong className="erd-modal-confirm-value">
                    {pendingRelationship.sourceTable}.
                    {pendingRelationship.sourceColumn}
                  </strong>
                </div>

                <div className="erd-modal-confirm-card">
                  <span className="erd-modal-confirm-label">Target</span>
                  <strong className="erd-modal-confirm-value">
                    {pendingRelationship.targetTable}.
                    {pendingRelationship.targetColumn}
                  </strong>
                </div>

                <p className="erd-modal-help">
                  {pendingRelationshipNotation
                    ? `Confirm to save this ${formatERRelationshipSummary(pendingRelationshipNotation)} relationship into TableR for this connection. This does not alter the database schema itself.`
                    : "Confirm to save this relationship into TableR for this connection. This does not alter the database schema itself."}
                </p>

                {relationshipModalError && (
                  <div className="erd-modal-error">
                    {relationshipModalError}
                  </div>
                )}

                <div className="erd-modal-actions">
                  <button
                    type="button"
                    className="erd-modal-btn"
                    onClick={() =>
                      setPendingRelationship((current) =>
                        current ? { ...current, step: "select" } : current,
                      )
                    }
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    className="erd-modal-btn"
                    onClick={closeRelationshipModal}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="erd-modal-btn is-primary"
                    onClick={confirmRelationshipDraft}
                  >
                    Save relationship
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default ERDiagram;
