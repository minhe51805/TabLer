import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  Panel,
  MarkerType,
  type Node,
  type Edge,
  type Connection,
  type EdgeTypes,
  type NodeTypes,
  type OnConnect,
  BackgroundVariant,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import {
  Search,
  Database,
  RefreshCw,
  Download,
  Maximize2,
  Settings,
  CheckCheck,
  Square,
  GitBranch,
  Link2,
  X,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import type { ColumnDetail, TableInfo, TableStructure, ERDiagramSchema, TableSchema, ERRelationship } from "../../types/database";
import { ERDCompactSelect, type ERDSelectOption } from "./ERDCompactSelect";
import { EditableRelationEdge } from "./EditableRelationEdge";
import { TableNode, type TableNodeType } from "./TableNode";

interface Props {
  connectionId: string;
  database?: string;
}

interface DiagramPoint {
  x: number;
  y: number;
}

interface PendingRelationshipDraft {
  sourceTable: string;
  targetTable: string;
  sourceColumn: string;
  targetColumn: string;
  step: "select" | "confirm";
}

const TABLE_COLORS = ["#6366F1", "#8B5CF6", "#EC4899", "#F59E0B", "#10B981", "#3B82F6", "#EF4444", "#14B8A6"];
const DIAGRAM_LEFT_OFFSET = 244;
const DIAGRAM_TOP_OFFSET = 64;
const DIAGRAM_NODE_WIDTH = 196;
const DIAGRAM_HORIZONTAL_GAP = 24;
const DIAGRAM_VERTICAL_GAP = 30;
const DIAGRAM_VISIBLE_COLUMN_COUNT = 8;
const DIAGRAM_ESTIMATED_HEADER_HEIGHT = 72;
const DIAGRAM_ESTIMATED_COLUMN_ROW_HEIGHT = 18;
const DIAGRAM_INITIAL_FIT_PADDING = 0.2;
const DIAGRAM_INITIAL_FIT_MAX_ZOOM = 0.68;
const DIAGRAM_MIN_ZOOM = 0.18;
const DIAGRAM_MAX_ZOOM = 1.5;
const DIAGRAM_COLLISION_PADDING = 14;
const DIAGRAM_POSITION_SEARCH_RADIUS = 18;
const CUSTOM_ER_RELATIONSHIPS_STORAGE_KEY = "tabler.erd.customRelationships.v1";

function getTableColor(index: number): string {
  return TABLE_COLORS[index % TABLE_COLORS.length];
}

function getRelationshipSignature(relationship: Pick<ERRelationship, "fromTable" | "fromColumn" | "toTable" | "toColumn">) {
  return `${relationship.fromTable}|${relationship.fromColumn}|${relationship.toTable}|${relationship.toColumn}`;
}

function getRelationshipId(relationship: Pick<ERRelationship, "fromTable" | "fromColumn" | "toTable" | "toColumn">) {
  return `custom-er-${getRelationshipSignature(relationship)}`;
}

function getERDiagramScopeKey(connectionId: string, database?: string) {
  return `${connectionId}|${database || ""}`;
}

function readCustomRelationships(connectionId: string, database?: string): ERRelationship[] {
  try {
    const raw = window.localStorage.getItem(CUSTOM_ER_RELATIONSHIPS_STORAGE_KEY);
    if (!raw) return [];

    const parsed = JSON.parse(raw) as Record<string, ERRelationship[]>;
    const scopeKey = getERDiagramScopeKey(connectionId, database);
    return Array.isArray(parsed?.[scopeKey]) ? parsed[scopeKey] : [];
  } catch {
    return [];
  }
}

function persistCustomRelationships(connectionId: string, database: string | undefined, relationships: ERRelationship[]) {
  try {
    const raw = window.localStorage.getItem(CUSTOM_ER_RELATIONSHIPS_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, ERRelationship[]>) : {};
    const scopeKey = getERDiagramScopeKey(connectionId, database);

    parsed[scopeKey] = relationships;
    window.localStorage.setItem(CUSTOM_ER_RELATIONSHIPS_STORAGE_KEY, JSON.stringify(parsed));
  } catch {
    // Ignore storage failures and keep the in-memory graph responsive.
  }
}

function dedupeRelationships(relationships: ERRelationship[]) {
  const unique = new Map<string, ERRelationship>();

  relationships.forEach((relationship) => {
    unique.set(getRelationshipSignature(relationship), relationship);
  });

  return [...unique.values()];
}

function getPreferredRelationshipDraft(sourceTable: TableSchema, targetTable: TableSchema): Pick<PendingRelationshipDraft, "sourceColumn" | "targetColumn"> {
  const preferredSource = sourceTable.columns.find((column) => column.is_primary_key) || sourceTable.columns[0];
  const preferredNames = new Set(
    [
      preferredSource?.name,
      `${sourceTable.name}_id`,
      `${sourceTable.name.replace(/\s+/g, "_")}_id`,
    ]
      .filter(Boolean)
      .map((value) => value.toLowerCase())
  );

  const preferredTarget =
    targetTable.columns.find((column) => preferredNames.has(column.name.toLowerCase())) ||
    targetTable.columns.find((column) => !column.is_primary_key) ||
    targetTable.columns[0];

  return {
    sourceColumn: preferredSource?.name || "",
    targetColumn: preferredTarget?.name || "",
  };
}

function getColumnOptionLabel(column: ColumnDetail) {
  const parts = [column.data_type];

  if (column.is_primary_key) parts.push("PK");
  if (!column.is_nullable) parts.push("NOT NULL");

  return parts.join(" / ");
}

function getColumnSelectOption(column: ColumnDetail): ERDSelectOption {
  return {
    value: column.name,
    label: column.name,
    meta: getColumnOptionLabel(column),
  };
}

function isDiagramPositionOverlapping(
  candidate: DiagramPoint,
  occupiedPositions: DiagramPoint[],
  nodeWidth: number,
  nodeHeight: number
) {
  return occupiedPositions.some((occupied) => {
    const separatedHorizontally =
      candidate.x + nodeWidth + DIAGRAM_COLLISION_PADDING <= occupied.x ||
      occupied.x + nodeWidth + DIAGRAM_COLLISION_PADDING <= candidate.x;
    const separatedVertically =
      candidate.y + nodeHeight + DIAGRAM_COLLISION_PADDING <= occupied.y ||
      occupied.y + nodeHeight + DIAGRAM_COLLISION_PADDING <= candidate.y;

    return !(separatedHorizontally || separatedVertically);
  });
}

function findAvailableDiagramPosition(
  preferredPosition: DiagramPoint,
  occupiedPositions: DiagramPoint[],
  nodeWidth: number,
  nodeHeight: number,
  slotWidth: number,
  slotHeight: number
) {
  if (!isDiagramPositionOverlapping(preferredPosition, occupiedPositions, nodeWidth, nodeHeight)) {
    return preferredPosition;
  }

  const baseCol = Math.round((preferredPosition.x - DIAGRAM_LEFT_OFFSET) / slotWidth);
  const baseRow = Math.round((preferredPosition.y - DIAGRAM_TOP_OFFSET) / slotHeight);

  for (let radius = 0; radius <= DIAGRAM_POSITION_SEARCH_RADIUS; radius += 1) {
    for (let rowOffset = -radius; rowOffset <= radius; rowOffset += 1) {
      for (let colOffset = -radius; colOffset <= radius; colOffset += 1) {
        const isPerimeter = Math.abs(rowOffset) === radius || Math.abs(colOffset) === radius;
        if (!isPerimeter) continue;

        const candidate = {
          x: DIAGRAM_LEFT_OFFSET + (baseCol + colOffset) * slotWidth,
          y: DIAGRAM_TOP_OFFSET + (baseRow + rowOffset) * slotHeight,
        };

        if (!isDiagramPositionOverlapping(candidate, occupiedPositions, nodeWidth, nodeHeight)) {
          return candidate;
        }
      }
    }
  }

  return {
    x: preferredPosition.x + slotWidth,
    y: preferredPosition.y + slotHeight,
  };
}

function buildNodes(
  tables: TableSchema[],
  selectedTableNames: Set<string>,
  existingNodes: Node[],
  rememberedPositions: Map<string, DiagramPoint>
): TableNodeType[] {
  const filtered = tables.filter((table) => selectedTableNames.has(table.name));
  if (filtered.length === 0) return [];

  const existingPositions = new Map(existingNodes.map((node) => [node.id, node.position]));
  const tableOrder = new Map(tables.map((table, index) => [table.name, index]));
  const occupiedPositions: DiagramPoint[] = [];
  const maxNodeHeight = Math.max(
    ...filtered.map(
      (table) =>
        DIAGRAM_ESTIMATED_HEADER_HEIGHT +
        Math.min(table.columns.length, DIAGRAM_VISIBLE_COLUMN_COUNT) * DIAGRAM_ESTIMATED_COLUMN_ROW_HEIGHT
    ),
    138
  );
  const slotWidth = DIAGRAM_NODE_WIDTH + DIAGRAM_HORIZONTAL_GAP;
  const slotHeight = maxNodeHeight + DIAGRAM_VERTICAL_GAP;
  const colsCount = Math.max(1, Math.min(3, Math.ceil(Math.sqrt(filtered.length))));

  return filtered.map((table, index) => {
    const col = index % colsCount;
    const row = Math.floor(index / colsCount);
    const preferredPosition =
      existingPositions.get(table.name) ||
      rememberedPositions.get(table.name) || {
        x: DIAGRAM_LEFT_OFFSET + col * slotWidth,
        y: DIAGRAM_TOP_OFFSET + row * slotHeight,
      };
    const resolvedPosition = findAvailableDiagramPosition(
      preferredPosition,
      occupiedPositions,
      DIAGRAM_NODE_WIDTH,
      maxNodeHeight,
      slotWidth,
      slotHeight
    );
    occupiedPositions.push(resolvedPosition);

    return {
      id: table.name,
      type: "tableNode",
      position: { ...resolvedPosition },
      data: {
        label: table.name,
        columns: table.columns,
        rowCount: table.rowCount,
        color: getTableColor(tableOrder.get(table.name) ?? index),
      },
    };
  });
}

function buildEdges(
  relationships: ERRelationship[],
  selectedTableNames: Set<string>,
  existingEdges: Edge[],
  rememberedBends: Map<string, DiagramPoint>
): Edge[] {
  const existingBends = new Map(
    existingEdges.map((edge) => [edge.id, ((edge.data as { bendOffset?: DiagramPoint } | undefined)?.bendOffset || { x: 0, y: 0 })])
  );

  return relationships
    .filter((relationship) => selectedTableNames.has(relationship.fromTable) && selectedTableNames.has(relationship.toTable))
    .map((relationship) => ({
      id: relationship.id,
      source: relationship.fromTable,
      target: relationship.toTable,
      label: relationship.label || `${relationship.fromColumn} -> ${relationship.toColumn}`,
      type: "editableRelationEdge",
      animated: false,
      data: {
        bendOffset: existingBends.get(relationship.id) || rememberedBends.get(relationship.id) || { x: 0, y: 0 },
      },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        width: 18,
        height: 18,
        color: "#7BB1FF",
      },
      style: {
        stroke: "#7BB1FF",
        strokeWidth: 1.7,
      },
    }));
}

async function fetchSchema(connectionId: string, database?: string): Promise<ERDiagramSchema> {
  const tables = await invoke<TableInfo[]>("list_tables", { connectionId, database: database || null });

  const tableSchemas: TableSchema[] = [];
  const allRelationships: ERRelationship[] = [];
  const batchSize = 5;

  for (let index = 0; index < tables.length; index += batchSize) {
    const batch = tables.slice(index, index + batchSize);
    const structures = await Promise.all(
      batch.map((table) =>
        invoke<TableStructure>("get_table_structure", {
          connectionId,
          table: table.name,
          database: database || null,
        })
      )
    );

    batch.forEach((table, batchIndex) => {
      const structure = structures[batchIndex];
      tableSchemas.push({
        name: table.name,
        schema: table.schema,
        columns: structure.columns,
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

  return { tables: tableSchemas, relationships: allRelationships };
}

export function ERDiagram({ connectionId, database }: Props) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const hasInitializedSelectionRef = useRef(false);
  const rememberedNodePositionsRef = useRef<Map<string, DiagramPoint>>(new Map());
  const rememberedEdgeBendsRef = useRef<Map<string, DiagramPoint>>(new Map());
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [schema, setSchema] = useState<ERDiagramSchema | null>(null);
  const [customRelationships, setCustomRelationships] = useState<ERRelationship[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedTables, setSelectedTables] = useState<Set<string>>(new Set());
  const [showMinimap, setShowMinimap] = useState(true);
  const [showControls, setShowControls] = useState(true);
  const [tableFilter, setTableFilter] = useState("");
  const [pendingRelationship, setPendingRelationship] = useState<PendingRelationshipDraft | null>(null);
  const [relationshipModalError, setRelationshipModalError] = useState<string | null>(null);

  const nodeTypes = useMemo<NodeTypes>(() => ({ tableNode: TableNode }), []);
  const edgeTypes = useMemo<EdgeTypes>(() => ({ editableRelationEdge: EditableRelationEdge }), []);
  const allRelationships = useMemo(
    () => dedupeRelationships([...(schema?.relationships || []), ...customRelationships]),
    [customRelationships, schema]
  );

  useEffect(() => {
    hasInitializedSelectionRef.current = false;
    rememberedNodePositionsRef.current.clear();
    rememberedEdgeBendsRef.current.clear();
    setCustomRelationships(readCustomRelationships(connectionId, database));
    setPendingRelationship(null);
    setRelationshipModalError(null);
  }, [connectionId, database]);

  const loadSchema = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const data = await fetchSchema(connectionId, database);
      setSchema(data);
      setSelectedTables((current) => {
        const allTableNames = data.tables.map((table) => table.name);
        if (!hasInitializedSelectionRef.current) {
          hasInitializedSelectionRef.current = true;
          return new Set(allTableNames);
        }

        if (current.size === 0) return current;

        const availableNames = new Set(allTableNames);
        const preservedNames = [...current].filter((tableName) => availableNames.has(tableName));
        return preservedNames.length > 0 ? new Set(preservedNames) : new Set(allTableNames);
      });
    } catch (reason) {
      setError(String(reason));
    } finally {
      setLoading(false);
    }
  }, [connectionId, database]);

  useEffect(() => {
    loadSchema();
  }, [loadSchema]);

  useEffect(() => {
    if (!schema) return;

    setNodes((existing) => {
      existing.forEach((node) => {
        rememberedNodePositionsRef.current.set(node.id, { ...node.position });
      });

      return buildNodes(schema.tables, selectedTables, existing, rememberedNodePositionsRef.current);
    });

    setEdges((existing) => {
      existing.forEach((edge) => {
        const bendOffset = (edge.data as { bendOffset?: DiagramPoint } | undefined)?.bendOffset;
        if (bendOffset) {
          rememberedEdgeBendsRef.current.set(edge.id, { ...bendOffset });
        }
      });

      return buildEdges(allRelationships, selectedTables, existing, rememberedEdgeBendsRef.current);
    });
  }, [allRelationships, schema, selectedTables, setNodes, setEdges]);

  useEffect(() => {
    nodes.forEach((node) => {
      rememberedNodePositionsRef.current.set(node.id, { ...node.position });
    });
  }, [nodes]);

  useEffect(() => {
    edges.forEach((edge) => {
      const bendOffset = (edge.data as { bendOffset?: DiagramPoint } | undefined)?.bendOffset;
      if (bendOffset) {
        rememberedEdgeBendsRef.current.set(edge.id, { ...bendOffset });
      }
    });
  }, [edges]);

  const onConnect: OnConnect = useCallback(
    (connection: Connection) => {
      if (!schema || !connection.source || !connection.target) return;

      const sourceTable = schema.tables.find((table) => table.name === connection.source);
      const targetTable = schema.tables.find((table) => table.name === connection.target);
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
    [schema]
  );

  const closeRelationshipModal = useCallback(() => {
    setPendingRelationship(null);
    setRelationshipModalError(null);
  }, []);

  const sourceTableForDraft = pendingRelationship
    ? schema?.tables.find((table) => table.name === pendingRelationship.sourceTable) || null
    : null;
  const targetTableForDraft = pendingRelationship
    ? schema?.tables.find((table) => table.name === pendingRelationship.targetTable) || null
    : null;
  const sourceColumnOptions = useMemo(
    () => sourceTableForDraft?.columns.map(getColumnSelectOption) || [],
    [sourceTableForDraft]
  );
  const targetColumnOptions = useMemo(
    () => targetTableForDraft?.columns.map(getColumnSelectOption) || [],
    [targetTableForDraft]
  );
  const canAdvanceRelationshipDraft = Boolean(
    pendingRelationship?.sourceColumn &&
      pendingRelationship?.targetColumn &&
      sourceTableForDraft &&
      targetTableForDraft
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
      label: `${pendingRelationship.sourceColumn} -> ${pendingRelationship.targetColumn}`,
      isCustom: true,
    };

    const signature = getRelationshipSignature(relationship);
    const alreadyExists = allRelationships.some((item) => getRelationshipSignature(item) === signature);

    if (alreadyExists) {
      setRelationshipModalError("This relationship already exists in the diagram.");
      return;
    }

    const nextRelationships = dedupeRelationships([...customRelationships, relationship]);
    setCustomRelationships(nextRelationships);
    persistCustomRelationships(connectionId, database, nextRelationships);
    rememberedEdgeBendsRef.current.set(relationship.id, { x: 0, y: 0 });
    setPendingRelationship(null);
    setRelationshipModalError(null);
  }, [allRelationships, connectionId, customRelationships, database, pendingRelationship]);

  const openRelationshipConfirmation = useCallback(() => {
    if (!canAdvanceRelationshipDraft || !pendingRelationship) {
      setRelationshipModalError("Choose both columns before continuing.");
      return;
    }

    setRelationshipModalError(null);
    setPendingRelationship((current) => (current ? { ...current, step: "confirm" } : current));
  }, [canAdvanceRelationshipDraft, pendingRelationship]);

  const handleTableToggle = (tableName: string) => {
    setSelectedTables((current) => {
      const next = new Set(current);

      if (next.has(tableName)) next.delete(tableName);
      else next.add(tableName);

      return next;
    });
  };

  const handleSelectAll = () => {
    if (!schema) return;
    setSelectedTables(new Set(schema.tables.map((table) => table.name)));
  };

  const handleClearAll = () => {
    setSelectedTables(new Set());
  };

  const handleExportPNG = () => {
    const flowElement = shellRef.current?.querySelector(".react-flow") as HTMLElement | null;
    if (!flowElement) return;

    const canvas = flowElement.querySelector("canvas");
    if (!canvas) return;

    const link = document.createElement("a");
    link.download = "er-diagram.png";
    link.href = canvas.toDataURL("image/png");
    link.click();
  };

  const filteredTables = useMemo(() => {
    if (!schema) return [];

    const keyword = tableFilter.trim().toLowerCase();
    if (!keyword) return schema.tables;

    return schema.tables.filter((table) => table.name.toLowerCase().includes(keyword));
  }, [schema, tableFilter]);

  const tableColorMap = useMemo(() => {
    return new Map((schema?.tables || []).map((table, index) => [table.name, getTableColor(index)]));
  }, [schema]);

  const visibleRelationshipCount = useMemo(() => {
    if (!schema) return 0;

    return allRelationships.filter(
      (relationship) => selectedTables.has(relationship.fromTable) && selectedTables.has(relationship.toTable)
    ).length;
  }, [allRelationships, schema, selectedTables]);

  const activeDatabaseLabel = database || schema?.tables[0]?.schema || "Current database";

  return (
    <div ref={shellRef} className="erd-shell">
      <div className="erd-topbar">
        <div className="erd-topbar-heading">
          <span className="erd-topbar-kicker">Entity Relationship View</span>
          <strong className="erd-topbar-title">{activeDatabaseLabel}</strong>
        </div>

        <div className="erd-toolbar-group">
          <button
            type="button"
            onClick={loadSchema}
            disabled={loading}
            className="erd-toolbar-button"
          >
            <RefreshCw className={`erd-toolbar-icon ${loading ? "is-spinning" : ""}`} />
            {loading ? "Refreshing" : "Refresh"}
          </button>

          <button
            type="button"
            onClick={() => setShowMinimap((value) => !value)}
            className={`erd-toolbar-button ${showMinimap ? "is-active" : ""}`}
          >
            <Maximize2 className="erd-toolbar-icon" />
            Minimap
          </button>

          <button
            type="button"
            onClick={() => setShowControls((value) => !value)}
            className={`erd-toolbar-button ${showControls ? "is-active" : ""}`}
          >
            <Settings className="erd-toolbar-icon" />
            Controls
          </button>
        </div>

        <div className="erd-toolbar-spacer" />

        <div className="erd-toolbar-stats">
          <span className="erd-toolbar-stat">
            <Database className="erd-toolbar-icon" />
            {schema ? `${selectedTables.size} / ${schema.tables.length} tables` : "Preparing schema"}
          </span>
          <span className="erd-toolbar-stat">
            <GitBranch className="erd-toolbar-icon" />
            {schema ? `${visibleRelationshipCount} links` : "Checking links"}
          </span>
        </div>

        <button
          type="button"
          onClick={handleExportPNG}
          className="erd-toolbar-button is-primary"
        >
          <Download className="erd-toolbar-icon" />
          Export PNG
        </button>
      </div>

      {error && <div className="erd-error-banner">{error}</div>}

      {loading && !schema && (
        <div className="erd-loading-state">
          <RefreshCw className="erd-loading-icon" />
          <div className="erd-loading-copy">
            <strong>Loading diagram data</strong>
            <span>Reading tables, columns, and relationships from the current database.</span>
          </div>
        </div>
      )}

      {!loading && schema && (
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          fitView
          fitViewOptions={{ padding: DIAGRAM_INITIAL_FIT_PADDING, maxZoom: DIAGRAM_INITIAL_FIT_MAX_ZOOM }}
          minZoom={DIAGRAM_MIN_ZOOM}
          maxZoom={DIAGRAM_MAX_ZOOM}
          className="erd-flow"
          proOptions={{ hideAttribution: true }}
        >
          {showMinimap && (
            <MiniMap
              className="erd-minimap"
              nodeColor={(node) => (node.data as { color?: string }).color || "#60A5FA"}
              maskColor="rgba(9, 12, 18, 0.76)"
            />
          )}

          {showControls && <Controls className="erd-controls" showInteractive={false} />}

          <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="#1C2433" />

          <Panel position="top-left">
            <div className="erd-sidepanel">
              <div className="erd-sidepanel-header">
                <div className="erd-sidepanel-copy">
                  <strong className="erd-sidepanel-title">Tables</strong>
                  <span className="erd-sidepanel-meta">{activeDatabaseLabel}</span>
                </div>
                <span className="erd-sidepanel-pill">{selectedTables.size} shown</span>
              </div>

              <div className="erd-sidepanel-actions">
                <button type="button" onClick={handleSelectAll} className="erd-sidepanel-action">
                  <CheckCheck className="erd-sidepanel-action-icon" />
                  All
                </button>
                <button type="button" onClick={handleClearAll} className="erd-sidepanel-action">
                  <Square className="erd-sidepanel-action-icon" />
                  None
                </button>
              </div>

              <label className="erd-filter">
                <Search className="erd-filter-icon" />
                <input
                  type="text"
                  value={tableFilter}
                  onChange={(event) => setTableFilter(event.target.value)}
                  placeholder="Filter tables"
                  className="erd-filter-input"
                />
              </label>

              <div className="erd-table-list">
                {filteredTables.length === 0 ? (
                  <div className="erd-empty-list">
                    <Search className="erd-empty-list-icon" />
                    <strong>No matching tables</strong>
                    <span>Try a shorter name or clear the current filter.</span>
                  </div>
                ) : (
                  filteredTables.map((table) => {
                    const checked = selectedTables.has(table.name);
                    const accent = tableColorMap.get(table.name) || TABLE_COLORS[0];

                    return (
                      <button
                        key={table.name}
                        type="button"
                        onClick={() => handleTableToggle(table.name)}
                        aria-pressed={checked}
                        className={`erd-table-toggle ${checked ? "is-active" : ""}`}
                        style={{ "--erd-table-accent": accent } as CSSProperties}
                      >
                        <span className="erd-table-toggle-check" />
                        <span className="erd-table-toggle-dot" />
                        <div className="erd-table-toggle-copy">
                          <span className="erd-table-toggle-name">{table.name}</span>
                          <span className="erd-table-toggle-meta">{table.schema || "Table"}</span>
                        </div>
                        <span className="erd-table-toggle-count">{table.columns.length}</span>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          </Panel>
        </ReactFlow>
      )}

      {!loading && schema && selectedTables.size === 0 && (
        <div className="erd-canvas-empty">
          <Database className="erd-canvas-empty-icon" />
          <strong>Select tables to build the diagram</strong>
          <span>Use the schema list on the left to add tables back onto the canvas.</span>
        </div>
      )}

      {pendingRelationship && sourceTableForDraft && targetTableForDraft && (
        <div className="erd-modal-backdrop" onClick={closeRelationshipModal}>
          <div className="erd-modal-shell" onClick={(event) => event.stopPropagation()}>
            <div className="erd-modal-header">
              <div className="erd-modal-header-copy">
                <span className="erd-modal-kicker">
                  {pendingRelationship.step === "select" ? "Step 1 of 2" : "Step 2 of 2"}
                </span>
                <strong className="erd-modal-title">
                  {pendingRelationship.step === "select" ? "Create custom relationship" : "Confirm relationship"}
                </strong>
              </div>

              <button type="button" className="erd-modal-close" onClick={closeRelationshipModal}>
                <X className="erd-modal-close-icon" />
              </button>
            </div>

            {pendingRelationship.step === "select" ? (
              <div className="erd-modal-body">
                <div className="erd-modal-summary">
                  <span className="erd-modal-chip">{sourceTableForDraft.name}</span>
                  <Link2 className="erd-modal-link-icon" />
                  <span className="erd-modal-chip">{targetTableForDraft.name}</span>
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
                          current ? { ...current, sourceColumn: value } : current
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
                          current ? { ...current, targetColumn: value } : current
                        );
                      }}
                    />
                  </label>
                </div>

                <p className="erd-modal-help">
                  This saves a persistent custom relationship for the current connection and database.
                </p>

                {relationshipModalError && <div className="erd-modal-error">{relationshipModalError}</div>}

                <div className="erd-modal-actions">
                  <button type="button" className="erd-modal-btn" onClick={closeRelationshipModal}>
                    Cancel
                  </button>
                  <button type="button" className="erd-modal-btn is-primary" onClick={openRelationshipConfirmation}>
                    Continue
                  </button>
                </div>
              </div>
            ) : (
              <div className="erd-modal-body">
                <div className="erd-modal-confirm-card">
                  <span className="erd-modal-confirm-label">Source</span>
                  <strong className="erd-modal-confirm-value">
                    {pendingRelationship.sourceTable}.{pendingRelationship.sourceColumn}
                  </strong>
                </div>

                <div className="erd-modal-confirm-card">
                  <span className="erd-modal-confirm-label">Target</span>
                  <strong className="erd-modal-confirm-value">
                    {pendingRelationship.targetTable}.{pendingRelationship.targetColumn}
                  </strong>
                </div>

                <p className="erd-modal-help">
                  Confirm to save this relationship into TableR for this connection. This does not alter the database
                  schema itself.
                </p>

                {relationshipModalError && <div className="erd-modal-error">{relationshipModalError}</div>}

                <div className="erd-modal-actions">
                  <button
                    type="button"
                    className="erd-modal-btn"
                    onClick={() =>
                      setPendingRelationship((current) => (current ? { ...current, step: "select" } : current))
                    }
                  >
                    Back
                  </button>
                  <button type="button" className="erd-modal-btn" onClick={closeRelationshipModal}>
                    Cancel
                  </button>
                  <button type="button" className="erd-modal-btn is-primary" onClick={confirmRelationshipDraft}>
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
