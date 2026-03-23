import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCcw } from "lucide-react";
import { useI18n } from "../../../i18n";
import type { MetricsWidgetDefinition, QueryResult } from "../../../types";
import {
  executeMetricsQuery,
  formatExecutionError,
  getMetricValue,
  getSeries,
  getWidgetLibraryItem,
  METRICS_DRAG_HOLD_MS,
  validateMetricsQuery,
} from "../utils/query-builder";
import { ChartBars, ChartLine, ChartPie } from "../utils/chart-renderer";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WidgetRunState {
  result: QueryResult | null;
  loading: boolean;
  error: string | null;
  lastRunAt: number | null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface MetricsWidgetCardProps {
  widget: MetricsWidgetDefinition;
  connectionId: string;
  selected: boolean;
  onSelect: () => void;
  layoutStyle: CSSProperties;
  dragging: boolean;
  resizing: boolean;
  onDragStart: (clientX: number, clientY: number) => void;
  onResizeStart: (clientX: number, clientY: number) => void;
}

export function MetricsWidgetCard({
  widget,
  connectionId,
  selected,
  onSelect,
  layoutStyle,
  dragging,
  resizing,
  onDragStart,
  onResizeStart,
}: MetricsWidgetCardProps) {
  const { language, t } = useI18n();
  const [state, setState] = useState<WidgetRunState>({
    result: null,
    loading: false,
    error: null,
    lastRunAt: null,
  });
  const requestIdRef = useRef(0);
  const holdTimerRef = useRef<number | null>(null);
  const suppressClickRef = useRef(false);

  const runWidgetQuery = useCallback(async () => {
    const validation = validateMetricsQuery(widget.query);
    if (!validation.ok) {
      setState({
        result: null,
        loading: false,
        error: validation.error,
        lastRunAt: null,
      });
      return;
    }

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setState((prev) => ({ ...prev, loading: true, error: null }));

    try {
      const result = await executeMetricsQuery(connectionId, validation.statement);

      if (requestIdRef.current !== requestId) return;
      setState({
        result,
        loading: false,
        error: null,
        lastRunAt: Date.now(),
      });
    } catch (error) {
      if (requestIdRef.current !== requestId) return;
      setState({
        result: null,
        loading: false,
        error: formatExecutionError(error),
        lastRunAt: Date.now(),
      });
    }
  }, [connectionId, widget.query]);

  useEffect(() => {
    void runWidgetQuery();
  }, [runWidgetQuery]);

  useEffect(() => {
    if (widget.refresh_seconds <= 0) return;

    const timer = window.setInterval(() => {
      void runWidgetQuery();
    }, widget.refresh_seconds * 1000);

    return () => {
      window.clearInterval(timer);
    };
  }, [runWidgetQuery, widget.refresh_seconds]);

  const series = useMemo(() => getSeries(state.result), [state.result]);
  const metric = useMemo(() => getMetricValue(state.result), [state.result]);
  const validation = useMemo(() => validateMetricsQuery(widget.query), [language, widget.query]);
  const widgetLibraryItem = getWidgetLibraryItem(widget.type);

  const content = (() => {
    if (state.loading && !state.result) {
      return <div className="metrics-widget-empty">{t("metrics.widget.loading")}</div>;
    }

    if (!validation.ok) {
      return <div className="metrics-widget-empty error">{validation.error}</div>;
    }

    if (state.error) {
      return <div className="metrics-widget-empty error">{state.error}</div>;
    }

    if (!state.result || state.result.rows.length === 0) {
      return <div className="metrics-widget-empty">{t("metrics.widget.noData")}</div>;
    }

    if (widget.type === "scoreboard") {
      return (
        <div className="metrics-widget-score">
          <span className="metrics-widget-score-value">{metric.primary}</span>
          <span className="metrics-widget-score-label">{metric.secondary}</span>
        </div>
      );
    }

    if (widget.type === "table") {
      return (
        <div className="metrics-widget-table-wrap">
          <table className="metrics-widget-table">
            <thead>
              <tr>
                {state.result.columns.slice(0, 4).map((column) => (
                  <th key={column.name}>{column.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {state.result.rows.slice(0, 5).map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.slice(0, 4).map((cell, cellIndex) => (
                    <td key={cellIndex}>{cell === null ? "NULL" : String(cell)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }

    if (series.length === 0) {
      return <div className="metrics-widget-empty">{t("metrics.widget.queryNeedsSeries")}</div>;
    }

    if (widget.type === "bar") {
      return <ChartBars series={series} />;
    }

    if (widget.type === "line") {
      return <ChartLine series={series} />;
    }

    return <ChartPie series={series} />;
  })();

  const clearPendingHold = useCallback(() => {
    if (holdTimerRef.current !== null) {
      window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  }, []);

  useEffect(() => clearPendingHold, [clearPendingHold]);

  const beginCardHoldDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      if (event.defaultPrevented) return;

      let latestX = event.clientX;
      let latestY = event.clientY;

      clearPendingHold();

      const cancelPendingHold = () => {
        clearPendingHold();
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
        window.removeEventListener("pointercancel", handlePointerUp);
      };

      const handlePointerMove = (nativeEvent: PointerEvent) => {
        latestX = nativeEvent.clientX;
        latestY = nativeEvent.clientY;
      };

      const handlePointerUp = () => {
        cancelPendingHold();
      };

      holdTimerRef.current = window.setTimeout(() => {
        suppressClickRef.current = true;
        cancelPendingHold();
        onDragStart(latestX, latestY);
      }, METRICS_DRAG_HOLD_MS);

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp, { once: true });
      window.addEventListener("pointercancel", handlePointerUp, { once: true });
    },
    [clearPendingHold, onDragStart],
  );

  return (
    <div
      role="button"
      tabIndex={0}
      className={`metrics-widget-card ${selected ? "selected" : ""} ${dragging ? "dragging" : ""} ${resizing ? "resizing" : ""}`}
      style={layoutStyle}
      onPointerDown={beginCardHoldDrag}
      onClick={() => {
        if (suppressClickRef.current) {
          suppressClickRef.current = false;
          return;
        }
        onSelect();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      <div className="metrics-widget-card-head">
        <div className="metrics-widget-card-head-main">
          <div className="metrics-widget-card-title-wrap">
            <span className="metrics-widget-card-type">{widgetLibraryItem.label}</span>
            <strong className="metrics-widget-card-title">{widget.title}</strong>
          </div>
        </div>
        <button
          type="button"
          className="metrics-widget-refresh-btn"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            void runWidgetQuery();
          }}
          title={t("metrics.widget.refresh")}
        >
          <RefreshCcw className={`w-3.5 h-3.5 ${state.loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      <div className="metrics-widget-card-body">{content}</div>

      <div className="metrics-widget-card-foot">
        <span className={`metrics-widget-status ${state.error ? "error" : ""}`}>
          {state.error
            ? t("metrics.widget.issue")
            : state.loading
              ? t("metrics.widget.refreshing")
              : t("metrics.widget.live")}
        </span>
        <span className="metrics-widget-foot-meta">
          {state.result
            ? `${state.result.execution_time_ms}ms`
            : widget.refresh_seconds > 0
              ? t("metrics.everySeconds", { seconds: widget.refresh_seconds })
              : t("metrics.manual")}
        </span>
      </div>

      <button
        type="button"
        className="metrics-widget-resize-handle"
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onResizeStart(event.clientX, event.clientY);
        }}
        onClick={(event) => event.stopPropagation()}
        title={t("common.size")}
      />
    </div>
  );
}
