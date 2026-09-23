import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Code2, Copy, FileDown, ImageDown, Maximize2, RefreshCcw, Table2 } from "lucide-react";
import { exportToCSV } from "../../../utils/export-utils";
import { exportSvgAsPng } from "../../../utils/svg-png-export";
import { formatRelativeTime } from "../utils/metrics-board-io";
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
import { ChartBars, ChartLine, ChartPie, ChartRadial } from "../utils/chart-renderer";
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
  onOpenResult: (widget: MetricsWidgetDefinition, result: QueryResult) => void;
  onOpenQuery: (widget: MetricsWidgetDefinition) => void;
  selected: boolean;
  onSelect: () => void;
  layoutStyle: CSSProperties;
  dragging: boolean;
  resizing: boolean;
  onDragStart: (clientX: number, clientY: number) => void;
  onResizeStart: (clientX: number, clientY: number) => void;
  onContextMenu: (widgetId: string, clientX: number, clientY: number) => void;
  refreshToken: number;
  onFullscreen: (widget: MetricsWidgetDefinition) => void;
  onDrillDown: (widget: MetricsWidgetDefinition, label: string, result: QueryResult) => void;
  onWidgetRefreshed: () => void;
}

export function MetricsWidgetCard({
  widget,
  connectionId,
  onOpenResult,
  onOpenQuery,
  selected,
  onSelect,
  layoutStyle,
  dragging,
  resizing,
  onDragStart,
  onResizeStart,
  onContextMenu,
  refreshToken,
  onFullscreen,
  onDrillDown,
  onWidgetRefreshed,
}: MetricsWidgetCardProps) {
  const { t } = useI18n();
  const [state, setState] = useState<WidgetRunState>({
    result: null,
    loading: false,
    error: null,
    lastRunAt: null,
  });
  const requestIdRef = useRef(0);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const isRunningRef = useRef(false);
  const rerunRequestedRef = useRef(false);
  const holdTimerRef = useRef<number | null>(null);
  const suppressClickRef = useRef(false);

  const runWidgetQuery = useCallback(async () => {
    if (isRunningRef.current) {
      rerunRequestedRef.current = true;
      return;
    }

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
    isRunningRef.current = true;
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
      onWidgetRefreshed();
    } catch (error) {
      if (requestIdRef.current !== requestId) return;
      setState({
        result: null,
        loading: false,
        error: formatExecutionError(error),
        lastRunAt: Date.now(),
      });
    } finally {
      if (requestIdRef.current === requestId) {
        isRunningRef.current = false;
      }
      if (rerunRequestedRef.current) {
        rerunRequestedRef.current = false;
        window.setTimeout(() => {
          void runWidgetQuery();
        }, 0);
      }
    }
  }, [connectionId, widget.query, onWidgetRefreshed]);

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

  // Countdown to next auto-refresh.
  const [secondsUntilRefresh, setSecondsUntilRefresh] = useState<number | null>(null);
  useEffect(() => {
    if (widget.refresh_seconds <= 0 || !state.lastRunAt) {
      setSecondsUntilRefresh(null);
      return;
    }
    const tick = () => {
      const elapsed = Math.floor((Date.now() - state.lastRunAt!) / 1000);
      const remaining = Math.max(0, widget.refresh_seconds - elapsed);
      setSecondsUntilRefresh(remaining);
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [widget.refresh_seconds, state.lastRunAt]);

  // Board-level "refresh all" — re-run when the token bumps.
  const prevRefreshTokenRef = useRef(refreshToken);
  useEffect(() => {
    if (refreshToken === prevRefreshTokenRef.current) return;
    prevRefreshTokenRef.current = refreshToken;
    void runWidgetQuery();
  }, [refreshToken, runWidgetQuery]);

  const handleChartSelect = useCallback(
    (label: string) => {
      if (state.result) onDrillDown(widget, label, state.result);
    },
    [onDrillDown, state.result, widget],
  );

  const series = useMemo(() => getSeries(state.result), [state.result]);
  const metric = useMemo(() => getMetricValue(state.result), [state.result]);
  const validation = useMemo(() => validateMetricsQuery(widget.query), [widget.query]);
  const widgetLibraryItem = getWidgetLibraryItem(widget.type);
  const isStale = useMemo(() => {
    if (!state.lastRunAt || widget.refresh_seconds <= 0) return false;
    return Date.now() - state.lastRunAt > widget.refresh_seconds * 2000;
  }, [state.lastRunAt, widget.refresh_seconds]);

  const content = (() => {
    if (state.loading && !state.result) {
      return <div className="metrics-widget-empty">{t("metrics.widget.loading")}</div>;
    }

    if (!validation.ok) {
      return <div className="metrics-widget-empty error">{validation.error}</div>;
    }

    if (state.error) {
      return (
        <div className="metrics-widget-empty error">
          <span>{state.error}</span>
          <button
            type="button"
            className="metrics-widget-retry-btn"
            onClick={(event) => {
              event.stopPropagation();
              void runWidgetQuery();
            }}
          >
            {t("metrics.widget.retry")}
          </button>
        </div>
      );
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
      return <ChartBars series={series} onSelect={handleChartSelect} />;
    }

    if (widget.type === "horizontal-bar") {
      return <ChartBars series={series} horizontal onSelect={handleChartSelect} />;
    }

    if (widget.type === "line") {
      return <ChartLine series={series} onSelect={handleChartSelect} />;
    }

    if (widget.type === "area") {
      return <ChartLine series={series} area onSelect={handleChartSelect} />;
    }

    if (widget.type === "donut") {
      return <ChartPie series={series} donut onSelect={handleChartSelect} />;
    }

    if (widget.type === "radial") {
      return <ChartRadial series={series} />;
    }

    return <ChartPie series={series} onSelect={handleChartSelect} />;
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
      data-metrics-widget-id={widget.id}
      ref={cardRef}
      className={`metrics-widget-card ${selected ? "selected" : ""} ${dragging ? "dragging" : ""} ${resizing ? "resizing" : ""}`}
      style={{
        ...layoutStyle,
        ...(widget.color
          ? {
              borderColor: `${widget.color}66`,
              boxShadow: `0 0 0 1px ${widget.color}33, 0 6px 18px rgba(5, 10, 15, 0.14)`,
            }
          : {}),
      }}
      onPointerDown={beginCardHoldDrag}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onContextMenu(widget.id, event.clientX, event.clientY);
      }}
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
            <strong className="metrics-widget-card-title" title={widget.query}>
              {widget.title}
            </strong>
          </div>
          {widget.note ? (
            <span className="metrics-widget-card-note" title={widget.note}>
              {widget.note}
            </span>
          ) : null}
          {isStale ? (
            <span className="metrics-widget-stale" title={t("metrics.widget.stale")}>
              {t("metrics.widget.stale")}
            </span>
          ) : null}
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
        <div className="metrics-widget-foot-actions">
          {state.result && !state.error && (
            <button
              type="button"
              className="metrics-widget-workspace-btn"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onOpenResult(widget, state.result as QueryResult);
              }}
              title={t("metrics.widget.openResult")}
              aria-label={t("metrics.widget.openResult")}
            >
              <Table2 className="w-3.5 h-3.5" />
            </button>
          )}
          {state.result && !state.error && (
            <button
              type="button"
              className="metrics-widget-workspace-btn"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                void exportToCSV(
                  state.result!.columns.map((c) => c.name),
                  state.result!.rows as (string | number | boolean | null)[][],
                  `${widget.title || "metric"}.csv`,
                );
              }}
              title={t("metrics.widget.exportCsv")}
              aria-label={t("metrics.widget.exportCsv")}
            >
              <FileDown className="w-3.5 h-3.5" />
            </button>
          )}
          {state.result &&
            !state.error &&
            widget.type !== "table" &&
            widget.type !== "scoreboard" && (
              <button
                type="button"
                className="metrics-widget-workspace-btn"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  const svg = cardRef.current?.querySelector("svg");
                  if (svg) void exportSvgAsPng(svg, `${widget.title || "chart"}.png`);
                }}
                title={t("metrics.widget.exportPng")}
                aria-label={t("metrics.widget.exportPng")}
              >
                <ImageDown className="w-3.5 h-3.5" />
              </button>
            )}
          <button
            type="button"
            className="metrics-widget-workspace-btn"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              void navigator.clipboard.writeText(widget.query);
            }}
            title={t("metrics.widget.copyQuery")}
            aria-label={t("metrics.widget.copyQuery")}
          >
            <Copy className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            className="metrics-widget-workspace-btn"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onFullscreen(widget);
            }}
            title={t("metrics.widget.fullscreen")}
            aria-label={t("metrics.widget.fullscreen")}
          >
            <Maximize2 className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            className="metrics-widget-workspace-btn"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onOpenQuery(widget);
            }}
            title={t("metrics.widget.openSourceSql")}
            aria-label={t("metrics.widget.openSourceSql")}
          >
            <Code2 className="w-3.5 h-3.5" />
          </button>
          <span className="metrics-widget-foot-meta">
            {state.result
              ? `${state.result.execution_time_ms}ms`
              : widget.refresh_seconds > 0
                ? t("metrics.everySeconds", { seconds: widget.refresh_seconds })
                : t("metrics.manual")}
          </span>
          {state.lastRunAt ? (
            <span
              className="metrics-widget-foot-time"
              title={new Date(state.lastRunAt).toLocaleString()}
            >
              {formatRelativeTime(state.lastRunAt)}
            </span>
          ) : null}
          {secondsUntilRefresh !== null && secondsUntilRefresh > 0 ? (
            <span className="metrics-widget-foot-countdown" title={t("metrics.widget.nextRefresh")}>
              {secondsUntilRefresh}s
            </span>
          ) : null}
        </div>
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
