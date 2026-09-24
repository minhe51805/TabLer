import { lazy, Suspense } from "react";
import { ErrorBoundary } from "./ErrorBoundary";
import type { Tab } from "../types";
import type { QueryEditorSessionState } from "./SQLEditor";
import type { QueryChromeState } from "./AppWorkspacePanel";

const DataGrid = lazy(() => import("./DataGrid/DataGrid").then((m) => ({ default: m.DataGrid })));
const ERDiagram = lazy(() => import("./ERDiagram/ERDiagram").then((m) => ({ default: m.default })));
const SQLEditor = lazy(() =>
  import("./SQLEditor").then((module) => ({ default: module.SQLEditor })),
);
const TableStructure = lazy(() =>
  import("./TableStructure/TableStructure").then((module) => ({
    default: module.TableStructure,
  })),
);
const MetricsBoard = lazy(() =>
  import("./MetricsBoard/MetricsBoard").then((module) => ({
    default: module.MetricsBoard,
  })),
);

function LazyPanelFallback() {
  return (
    <div className="workspace-tab-loading">
      <div className="workspace-tab-loading-spinner" />
    </div>
  );
}

/** Renders one workspace tab's content by type (query editor, data grid,
 *  structure, metrics board, ER diagram), each behind its own lazy boundary. */
export function WorkspaceTabContent({
  tab,
  isActive,
  querySessionByTab,
  queryRunRequestByTab,
  onHandleQueryChromeChange,
  onHandleQuerySessionChange,
}: {
  tab: Tab;
  isActive: boolean;
  querySessionByTab: Record<string, QueryEditorSessionState | undefined>;
  queryRunRequestByTab: Record<string, number | undefined>;
  onHandleQueryChromeChange: (tabId: string, state: QueryChromeState) => void;
  onHandleQuerySessionChange: (tabId: string, state: QueryEditorSessionState) => void;
}) {
  switch (tab.type) {
    case "query":
      return (
        <ErrorBoundary>
          <Suspense fallback={<LazyPanelFallback />}>
            <SQLEditor
              key={tab.id}
              connectionId={tab.connectionId}
              initialContent={tab.content || ""}
              initialCursor={tab.editorCursor}
              tabId={tab.id}
              tabSource={tab.source}
              initialState={querySessionByTab[tab.id]}
              runRequestNonce={queryRunRequestByTab[tab.id] ?? 0}
              onChromeChange={(state) => onHandleQueryChromeChange(tab.id, state)}
              onStateChange={(state) => onHandleQuerySessionChange(tab.id, state)}
            />
          </Suspense>
        </ErrorBoundary>
      );
    case "table":
      return (
        <ErrorBoundary>
          <Suspense fallback={<LazyPanelFallback />}>
            <DataGrid
              key={tab.id}
              connectionId={tab.connectionId}
              tableName={tab.tableName}
              database={tab.database}
              queryResult={tab.queryResult}
              rowFocus={tab.rowFocus}
              isActive={isActive}
            />
          </Suspense>
        </ErrorBoundary>
      );
    case "structure":
      return (
        <ErrorBoundary>
          <Suspense fallback={<LazyPanelFallback />}>
            <TableStructure
              key={tab.id}
              connectionId={tab.connectionId}
              tableName={tab.tableName || ""}
              database={tab.database}
              isActive={isActive}
              structureFocusSection={tab.structureFocusSection}
              structureFocusColumn={tab.structureFocusColumn}
              structureFocusToken={tab.structureFocusToken}
            />
          </Suspense>
        </ErrorBoundary>
      );
    case "metrics":
      return (
        <ErrorBoundary>
          <Suspense fallback={<LazyPanelFallback />}>
            <MetricsBoard
              key={tab.id}
              connectionId={tab.connectionId}
              database={tab.database}
              tabId={tab.id}
              boardId={tab.metricsBoardId}
              integratedSidebar={false}
            />
          </Suspense>
        </ErrorBoundary>
      );
    case "er-diagram":
      return (
        <ErrorBoundary>
          <Suspense fallback={<LazyPanelFallback />}>
            <ERDiagram key={tab.id} connectionId={tab.connectionId} database={tab.database} />
          </Suspense>
        </ErrorBoundary>
      );
    default:
      return null;
  }
}
