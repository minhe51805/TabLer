/**
 * EXPLAIN query plan visualizer.
 * Renders a parsed explain plan as an interactive, collapsible tree.
 */

import { useState, useCallback, useMemo } from "react";
import {
  ChevronRight,
  ChevronDown,
  AlertTriangle,
  Info,
  X,
  TreePine,
  ScrollText,
  Workflow,
} from "lucide-react";
import type { ParsedExplainPlan, ExplainNode } from "../../utils/explain-parser";
import { getNodeCategory } from "../../utils/explain-parser";
import { ExplainDiagram } from "./ExplainDiagram";

type ExplainViewMode = "tree" | "diagram" | "raw";

interface ExplainVisualizerProps {
  plan: ParsedExplainPlan;
  onClose?: () => void;
}

const CATEGORY_COLORS: Record<string, string> = {
  scan:      "explain-node-scan",
  join:      "explain-node-join",
  sort:      "explain-node-sort",
  index:     "explain-node-index",
  aggregate: "explain-node-aggregate",
  other:     "explain-node-other",
};

const CATEGORY_LABELS: Record<string, string> = {
  scan:      "Scan",
  join:      "Join",
  sort:      "Sort",
  index:     "Index",
  aggregate: "Aggregate",
  other:     "Other",
};

function formatCost(cost: number | undefined): string {
  if (cost === undefined) return "—";
  if (cost >= 1_000_000) return `${(cost / 1_000_000).toFixed(2)}M`;
  if (cost >= 1_000) return `${(cost / 1_000).toFixed(1)}K`;
  return cost.toFixed(2);
}

function formatRows(rows: number | undefined): string {
  if (rows === undefined) return "—";
  if (rows >= 1_000_000) return `${(rows / 1_000_000).toFixed(2)}M`;
  if (rows >= 1_000) return `${(rows / 1_000).toFixed(1)}K`;
  return rows.toLocaleString();
}

/** Single plan node component */
function PlanNode({
  node,
  plan,
  depth,
  expanded,
  onToggle,
}: {
  node: ExplainNode;
  plan: ParsedPlanState;
  depth: number;
  expanded: boolean;
  onToggle: (id: string) => void;
}) {
  const category = getNodeCategory(node.operation);
  const colorClass = CATEGORY_COLORS[category] || CATEGORY_COLORS.other;
  const childNodes = node.children
    .map((cid) => plan.nodes.get(cid))
    .filter((n): n is ExplainNode => Boolean(n));

  const hasChildren = childNodes.length > 0;

  return (
    <div className="explain-node-container">
      <div
        className={`explain-node ${colorClass}`}
        style={{ marginLeft: depth * 20 }}
        onClick={() => hasChildren && onToggle(node.id)}
        role={hasChildren ? "button" : undefined}
        tabIndex={hasChildren ? 0 : undefined}
        onKeyDown={
          hasChildren
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") onToggle(node.id);
              }
            : undefined
        }
        title={buildTooltip(node)}
      >
        {hasChildren ? (
          <span className="explain-node-toggle">
            {expanded ? (
              <ChevronDown className="!w-3 !h-3" />
            ) : (
              <ChevronRight className="!w-3 !h-3" />
            )}
          </span>
        ) : (
          <span className="explain-node-toggle-spacer" />
        )}

        <span className={`explain-node-badge explain-badge-${category}`}>
          {CATEGORY_LABELS[category]}
        </span>

        <span className="explain-node-op">{node.operation}</span>

        {node.estimatedRows !== undefined && (
          <span className="explain-node-metric">
            <span className="explain-metric-label">rows</span>
            <span className="explain-metric-value">{formatRows(node.estimatedRows)}</span>
          </span>
        )}

        {node.cost !== undefined && (
          <span className="explain-node-metric">
            <span className="explain-metric-label">cost</span>
            <span className="explain-metric-value">{formatCost(node.cost)}</span>
          </span>
        )}

        {plan.analyzed && node.actualRows !== undefined && (
          <span
            className={`explain-node-metric ${
              node.estimatedRows !== undefined &&
              Math.abs(node.actualRows - node.estimatedRows) / Math.max(node.estimatedRows, 1) > 0.3
                ? "explain-metric-diff"
                : ""
            }`}
          >
            <span className="explain-metric-label">actual</span>
            <span className="explain-metric-value">{formatRows(node.actualRows)}</span>
          </span>
        )}

        {Object.entries(node.extras).slice(0, 4).map(([k, v]) =>
          v !== null ? (
            <span key={k} className="explain-node-extra" title={`${k}: ${v}`}>
              {k}={String(v).length > 20 ? String(v).slice(0, 20) + "..." : String(v)}
            </span>
          ) : null,
        )}
      </div>

      {expanded && hasChildren && (
        <div className="explain-node-children">
          {childNodes.map((child) => (
            <PlanNode
              key={child.id}
              node={child}
              plan={plan}
              depth={depth + 1}
              expanded={plan.expandedIds.has(child.id)}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** Minimal plan state for rendering */
interface ParsedPlanState {
  analyzed: boolean;
  nodes: Map<string, ExplainNode>;
  expandedIds: Set<string>;
}

function buildTooltip(node: ExplainNode): string {
  const parts: string[] = [];
  if (node.cost !== undefined) parts.push(`Cost: ${node.cost.toFixed(4)}`);
  if (node.startupCost !== undefined) parts.push(`Startup: ${node.startupCost.toFixed(4)}`);
  if (node.estimatedRows !== undefined) parts.push(`Est. Rows: ${node.estimatedRows.toLocaleString()}`);
  if (node.actualRows !== undefined) parts.push(`Actual Rows: ${node.actualRows.toLocaleString()}`);
  if (node.estimatedRowWidth !== undefined) parts.push(`Width: ${node.estimatedRowWidth} bytes`);
  if (Object.keys(node.extras).length > 0) {
    parts.push(...Object.entries(node.extras).map(([k, v]) => `${k}: ${v}`));
  }
  return parts.join(" | ");
}

export function ExplainVisualizer({ plan, onClose }: ExplainVisualizerProps) {
  const nodeMap = useMemo(() => {
    const map = new Map<string, ExplainNode>();
    for (const node of plan.nodes) {
      map.set(node.id, node);
    }
    return map;
  }, [plan.nodes]);

  const allNodeIds = useMemo(() => new Set(nodeMap.keys()), [nodeMap]);

  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => {
    // Expand first two levels by default
    const initial = new Set<string>();
    for (const rootId of plan.rootIds) {
      initial.add(rootId);
      const root = nodeMap.get(rootId);
      if (root) {
        for (const childId of root.children.slice(0, 3)) {
          initial.add(childId);
        }
      }
    }
    return initial;
  });

  const [viewMode, setViewMode] = useState<ExplainViewMode>("tree");

  const handleToggle = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleExpandAll = useCallback(() => {
    setExpandedIds(new Set(allNodeIds));
  }, [allNodeIds]);

  const handleCollapseAll = useCallback(() => {
    setExpandedIds(new Set(plan.rootIds));
  }, [plan.rootIds]);

  const planState: ParsedPlanState = { analyzed: plan.analyzed, nodes: nodeMap, expandedIds };

  return (
    <div className="explain-visualizer-shell">
      <div className="explain-visualizer-header">
        <div className="explain-visualizer-header-left">
          <TreePine className="!w-4 !h-4 text-[var(--fintech-green)]" />
          <span className="explain-visualizer-title">Query Plan</span>
          <span className={`explain-visualizer-badge ${plan.analyzed ? "analyzed" : "estimated"}`}>
            {plan.analyzed ? "ANALYZE" : "ESTIMATED"}
          </span>
          {plan.dbType && (
            <span className="explain-visualizer-db-badge">{plan.dbType}</span>
          )}
          {plan.totalCost !== undefined && (
            <span className="explain-visualizer-total-cost">
              Total cost: {formatCost(plan.totalCost)}
            </span>
          )}
        </div>

        <div className="explain-visualizer-header-right">
          <div className="explain-view-mode-tabs">
            <button
              type="button"
              className={`explain-view-mode-tab ${viewMode === "tree" ? "active" : ""}`}
              onClick={() => setViewMode("tree")}
              title="Tree view"
            >
              <TreePine className="!w-3.5 !h-3.5" />
              <span>Tree</span>
            </button>
            <button
              type="button"
              className={`explain-view-mode-tab ${viewMode === "diagram" ? "active" : ""}`}
              onClick={() => setViewMode("diagram")}
              title="Diagram view"
            >
              <Workflow className="!w-3.5 !h-3.5" />
              <span>Diagram</span>
            </button>
            <button
              type="button"
              className={`explain-view-mode-tab ${viewMode === "raw" ? "active" : ""}`}
              onClick={() => setViewMode("raw")}
              title="Raw output"
            >
              <ScrollText className="!w-3.5 !h-3.5" />
              <span>Raw</span>
            </button>
          </div>
          {viewMode === "tree" && (
            <>
              <button
                type="button"
                className="explain-header-btn"
                onClick={handleExpandAll}
                title="Expand all nodes"
              >
                Expand All
              </button>
              <button
                type="button"
                className="explain-header-btn"
                onClick={handleCollapseAll}
                title="Collapse all nodes"
              >
                Collapse All
              </button>
            </>
          )}
          {onClose && (
            <button
              type="button"
              className="explain-header-btn"
              onClick={onClose}
              title="Close"
            >
              <X className="!w-3.5 !h-3.5" />
            </button>
          )}
        </div>
      </div>

      {plan.warnings.length > 0 && (
        <div className="explain-warnings">
          {plan.warnings.map((w, i) => (
            <div key={i} className="explain-warning-item">
              <AlertTriangle className="!w-3 !h-3 text-yellow-500" />
              <span>{w}</span>
            </div>
          ))}
        </div>
      )}

      <div className="explain-legend">
        {Object.entries(CATEGORY_LABELS).map(([cat, label]) => (
          <span key={cat} className="explain-legend-item">
            <span className={`explain-legend-dot explain-badge-${cat}`} />
            <span>{label}</span>
          </span>
        ))}
      </div>

      {plan.analyzed && (
        <div className="explain-analyze-notice">
          <Info className="!w-3.5 !h-3.5 text-blue-400" />
          <span>
            Red highlights indicate actual vs estimated row counts differ by &gt;30%.
            Run ANALYZE to update statistics.
          </span>
        </div>
      )}

      <div className="explain-plan-body">
        {viewMode === "raw" ? (
          <pre className="explain-raw-output">{plan.rawText}</pre>
        ) : viewMode === "diagram" ? (
          plan.nodes.length === 0 ? (
            <div className="explain-empty">No plan data available.</div>
          ) : (
            <ExplainDiagram plan={plan} />
          )
        ) : plan.nodes.length === 0 ? (
          <div className="explain-empty">No plan data available.</div>
        ) : (
          <div className="explain-tree">
            {plan.rootIds.map((rootId) => {
              const root = nodeMap.get(rootId);
              if (!root) return null;
              return (
                <PlanNode
                  key={root.id}
                  node={root}
                  plan={planState}
                  depth={0}
                  expanded={expandedIds.has(root.id)}
                  onToggle={handleToggle}
                />
              );
            })}
          </div>
        )}
      </div>

    </div>
  );
}
