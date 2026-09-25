import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import Editor from "@monaco-editor/react";
import { FileCode, Loader2, Play, RefreshCw, Square, X } from "lucide-react";
import "../../utils/monaco-bundle";
import { defineTableRTheme } from "../SQLEditor/SQLEditorTheme";
import { useI18n } from "../../i18n";
import { useConnectionStore } from "../../stores/connectionStore";
import { useUIStore } from "../../stores/uiStore";
import { invokeMutation, invokeWithTimeout } from "../../utils/tauri-utils";
import { emitAppToast } from "../../utils/app-toast";
import { assertQueryAllowed, SafeModeCancelledError } from "../../utils/safe-mode-query-guard";
import type { QueryResult, RoutineDefinition, RoutineInfo } from "../../types";
import { getRoutineEditorCopy, type RoutineEditorCopy } from "./routine-editor-copy";
import { useRoutineEditorStore } from "./routineEditorStore";
import "./routine-editor.css";

const LIST_TIMEOUT_MS = 60_000;
/** Cap on rendered result rows — the backend already caps the fetch. */
const RESULT_ROW_RENDER_LIMIT = 200;

interface RoutineArg {
  /** Input label: the parameter name, or argN when unnamed. */
  label: string;
  /** IN / OUT / INOUT / VARIADIC when the signature declares one. */
  mode: string | null;
  /** Full signature fragment shown as the input tooltip. */
  hint: string;
}

/**
 * Splits a signature like `IN p_id int, p_name varchar(20) DEFAULT 'x'` on
 * top-level commas (paren depth aware) and labels each argument.
 */
function parseRoutineArgs(signature: string | undefined): RoutineArg[] {
  if (!signature) return [];
  // PostgreSQL overloads arrive joined by " | " — the form only feeds the
  // first variant's parameters.
  const first = signature.split(" | ")[0]?.trim();
  if (!first) return [];

  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of first) {
    if (char === "(") depth += 1;
    if (char === ")") depth = Math.max(0, depth - 1);
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) parts.push(current);

  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part, index) => {
      const tokens = part.split(/\s+/);
      let mode: string | null = null;
      if (["IN", "OUT", "INOUT", "VARIADIC"].includes(tokens[0]?.toUpperCase() ?? "")) {
        mode = tokens.shift()!.toUpperCase();
      }
      // Drop a DEFAULT clause before naming the argument.
      const defaultAt = tokens.findIndex((token) => token.toUpperCase() === "DEFAULT");
      const head = (defaultAt >= 0 ? tokens.slice(0, defaultAt) : tokens).join(" ");
      const headTokens = head.split(/\s+/);
      const firstToken = headTokens[0] ?? "";
      // A bare type (`int`, `character varying`) has no name; MSSQL params
      // always start with `@`, MySQL/PG names are plain identifiers.
      const looksNamed = firstToken.startsWith("@") || /^[a-zA-Z_][\w$]*$/.test(firstToken);
      const label = looksNamed && headTokens.length > 1 ? firstToken : `arg${index + 1}`;
      return { label, mode, hint: part };
    });
}

/** Turns a fetched definition into an editable CREATE OR REPLACE draft. */
function buildDraftSql(definition: RoutineDefinition, dbType: string | undefined): string {
  const text = definition.definition.trim();
  if (dbType === "mssql") {
    // CREATE OR ALTER needs SQL Server 2016 SP1+; older builds surface a
    // clear syntax error.
    return text.replace(/^\s*CREATE\s+(PROCEDURE|PROC|FUNCTION)\b/i, "CREATE OR ALTER $1");
  }
  if (dbType === "mysql" || dbType === "mariadb") {
    // MySQL has no CREATE OR REPLACE for routines — keep CREATE and note the
    // DROP needed before re-running.
    return `-- MySQL/MariaDB has no CREATE OR REPLACE for routines.\n-- DROP ${definition.kind === "procedure" ? "PROCEDURE" : "FUNCTION"} IF EXISTS ${definition.name}; first, then run:\n\n${text}`;
  }
  // PostgreSQL-family: pg_get_functiondef already emits CREATE OR REPLACE.
  return text;
}

function RoutineResultTable({ result, copy }: { result: QueryResult; copy: RoutineEditorCopy }) {
  const rows = result.rows.slice(0, RESULT_ROW_RENDER_LIMIT);
  return (
    <div className="routine-result">
      <div className="routine-result-meta">
        <span>{copy.executionMs(result.execution_time_ms)}</span>
        {result.affected_rows > 0 && <span>{copy.rowsAffected(result.affected_rows)}</span>}
        {(result.truncated || result.rows.length > RESULT_ROW_RENDER_LIMIT) && (
          <span className="routine-result-truncated">{copy.truncated}</span>
        )}
      </div>
      {result.columns.length === 0 ? (
        <div className="routine-result-empty">{copy.resultEmpty}</div>
      ) : (
        <div className="routine-result-scroll">
          <table className="routine-result-table">
            <thead>
              <tr>
                {result.columns.map((column, index) => (
                  <th key={`${column.name}-${index}`}>{column.name || `col${index + 1}`}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex}>{cell === null ? "NULL" : String(cell)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function RoutineEditorContent() {
  const { language } = useI18n();
  const copy = getRoutineEditorCopy(language);
  const { connectionId, routineName, routineSchema, close } = useRoutineEditorStore();
  const currentDatabase = useConnectionStore((state) => state.currentDatabase);
  const connection = useConnectionStore((state) =>
    state.connections.find((item) => item.id === connectionId),
  );
  const addTab = useUIStore((state) => state.addTab);

  const [routines, setRoutines] = useState<RoutineInfo[]>([]);
  const [isLoadingList, setIsLoadingList] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<RoutineInfo | null>(null);
  const [definition, setDefinition] = useState<RoutineDefinition | null>(null);
  const [isLoadingDefinition, setIsLoadingDefinition] = useState(false);
  const [definitionError, setDefinitionError] = useState<string | null>(null);
  const [argValues, setArgValues] = useState<string[]>([]);
  const [isExecuting, setIsExecuting] = useState(false);
  const [executionResult, setExecutionResult] = useState<QueryResult | null>(null);
  const [executionError, setExecutionError] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);

  const loadRoutines = useCallback(async () => {
    if (!connectionId) return;
    setIsLoadingList(true);
    setListError(null);
    try {
      const list = await invokeWithTimeout<RoutineInfo[]>(
        "list_routines",
        { connectionId, database: currentDatabase ?? null },
        LIST_TIMEOUT_MS,
        "Loading routines",
      );
      setRoutines(list);
    } catch (error) {
      setRoutines([]);
      setListError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsLoadingList(false);
    }
  }, [connectionId, currentDatabase]);

  useEffect(() => {
    void loadRoutines();
  }, [loadRoutines]);

  const selectRoutine = useCallback(
    async (routine: RoutineInfo) => {
      if (!connectionId) return;
      setSelected(routine);
      setDefinition(null);
      setDefinitionError(null);
      setExecutionResult(null);
      setExecutionError(null);
      setArgValues([]);
      setIsLoadingDefinition(true);
      try {
        const loaded = await invokeWithTimeout<RoutineDefinition>(
          "get_routine_definition",
          {
            connectionId,
            routineName: routine.name,
            schema: routine.schema ?? null,
            database: currentDatabase ?? null,
          },
          LIST_TIMEOUT_MS,
          "Loading routine definition",
        );
        setDefinition(loaded);
      } catch (error) {
        setDefinitionError(error instanceof Error ? error.message : String(error));
      } finally {
        setIsLoadingDefinition(false);
      }
    },
    [connectionId, currentDatabase],
  );

  // Preselect the routine the sidebar row was opened from.
  useEffect(() => {
    if (!routineName || isLoadingList || routines.length === 0) return;
    const match = routines.find(
      (routine) =>
        routine.name === routineName && (routineSchema == null || routine.schema === routineSchema),
    );
    if (match) void selectRoutine(match);
    // Only auto-select on the initial list load for this open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoadingList, routines]);

  const filteredRoutines = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return routines;
    return routines.filter(
      (routine) =>
        routine.name.toLowerCase().includes(needle) ||
        (routine.schema ?? "").toLowerCase().includes(needle),
    );
  }, [routines, filter]);

  const procedures = filteredRoutines.filter((routine) => routine.kind === "procedure");
  const functions = filteredRoutines.filter((routine) => routine.kind !== "procedure");

  const args = useMemo(() => parseRoutineArgs(selected?.arg_signature), [selected]);

  const openDraft = useCallback(() => {
    if (!connectionId || !definition) return;
    addTab({
      id: `query-${crypto.randomUUID()}`,
      type: "query",
      title: `${definition.name} (${definition.kind})`,
      connectionId,
      database: currentDatabase || undefined,
      content: buildDraftSql(definition, connection?.db_type),
    });
    emitAppToast({ tone: "success", title: copy.draftOpened });
  }, [connectionId, definition, addTab, currentDatabase, connection?.db_type, copy]);

  const execute = useCallback(async () => {
    if (!connectionId || !selected) return;
    const qualified = selected.schema ? `${selected.schema}.${selected.name}` : selected.name;
    // Probe the Safe Mode gate with the real invocation shape: CALL/EXEC for
    // procedures (a write), SELECT for functions. EXEC matches the MSSQL
    // dialect grammar; CALL parses under the SQL-standard dialects.
    const argList = args.map(() => "?").join(", ");
    const probe =
      selected.kind === "procedure"
        ? connection?.db_type === "mssql"
          ? `EXEC ${qualified} ${argList}`
          : `CALL ${qualified}(${argList})`
        : `SELECT ${qualified}(${argList})`;
    let approved = false;
    try {
      const safety = await assertQueryAllowed(probe, connectionId, { userInitiated: true });
      approved = safety.userConfirmed === true;
    } catch (error) {
      if (!(error instanceof SafeModeCancelledError)) {
        setExecutionError(error instanceof Error ? error.message : String(error));
      }
      return;
    }

    const nextRequestId = crypto.randomUUID();
    setRequestId(nextRequestId);
    setIsExecuting(true);
    setExecutionError(null);
    setExecutionResult(null);
    try {
      const result = await invokeMutation<QueryResult>("execute_routine", {
        connectionId,
        name: selected.name,
        kind: selected.kind,
        args: args.map((_, index) => argValues[index] ?? ""),
        schema: selected.schema ?? null,
        database: currentDatabase ?? null,
        requestId: nextRequestId,
        safeModeApprovedByUser: approved,
      });
      setExecutionResult(result);
    } catch (error) {
      setExecutionError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsExecuting(false);
      setRequestId(null);
    }
  }, [connectionId, selected, args, argValues, currentDatabase, connection?.db_type]);

  const cancelExecution = useCallback(() => {
    if (!requestId || !connectionId) return;
    void invokeMutation("cancel_query", { requestId, connectionId }).catch(() => undefined);
  }, [requestId, connectionId]);

  const renderRoutineRow = (routine: RoutineInfo) => (
    <button
      key={`${routine.schema ?? ""}.${routine.name}.${routine.kind}`}
      type="button"
      className={`routine-list-item ${
        selected?.name === routine.name &&
        selected?.schema === routine.schema &&
        selected?.kind === routine.kind
          ? "active"
          : ""
      }`}
      onClick={() => void selectRoutine(routine)}
    >
      <FileCode className="routine-list-icon" />
      <span className="routine-list-name">{routine.name}</span>
      {routine.schema && <span className="routine-list-schema">{routine.schema}</span>}
    </button>
  );

  return (
    <div className="app-help-modal-backdrop" onClick={close}>
      <div
        className="app-help-modal routine-editor-modal"
        role="dialog"
        aria-label={copy.title}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="app-help-modal-header">
          <div className="app-help-modal-copy">
            <span className="app-help-modal-kicker">{copy.kicker}</span>
            <h3 className="app-help-modal-title">{copy.title}</h3>
            <p className="app-help-modal-description">{copy.description}</p>
          </div>
          <button type="button" className="app-help-modal-close" onClick={close} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="routine-editor-body">
          <aside className="routine-list">
            <div className="routine-list-toolbar">
              <input
                className="routine-list-search"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder={copy.searchPlaceholder}
              />
              <button
                type="button"
                className="icon-btn"
                onClick={() => void loadRoutines()}
                disabled={isLoadingList}
                title={copy.refresh}
                aria-label={copy.refresh}
              >
                <RefreshCw className={`w-4 h-4 ${isLoadingList ? "animate-spin" : ""}`} />
              </button>
            </div>
            <div className="routine-list-scroll">
              {isLoadingList ? (
                <div className="routine-list-empty">
                  <Loader2 className="w-4 h-4 animate-spin" /> {copy.loading}
                </div>
              ) : listError ? (
                <div className="routine-list-empty routine-list-error">{listError}</div>
              ) : filteredRoutines.length === 0 ? (
                <div className="routine-list-empty">
                  {routines.length === 0 ? copy.empty : copy.emptyFiltered}
                </div>
              ) : (
                <>
                  {procedures.length > 0 && (
                    <div className="routine-list-group">
                      <div className="routine-list-group-label">
                        {copy.proceduresGroup} ({procedures.length})
                      </div>
                      {procedures.map(renderRoutineRow)}
                    </div>
                  )}
                  {functions.length > 0 && (
                    <div className="routine-list-group">
                      <div className="routine-list-group-label">
                        {copy.functionsGroup} ({functions.length})
                      </div>
                      {functions.map(renderRoutineRow)}
                    </div>
                  )}
                </>
              )}
            </div>
          </aside>

          <section className="routine-detail">
            {!selected ? (
              <div className="routine-detail-empty">{copy.selectRoutine}</div>
            ) : (
              <>
                <div className="routine-detail-header">
                  <div className="routine-detail-title">
                    <span className="routine-detail-name">
                      {selected.schema ? `${selected.schema}.` : ""}
                      {selected.name}
                    </span>
                    <span className="routine-detail-kind">
                      {selected.kind === "procedure" ? copy.kindProcedure : copy.kindFunction}
                      {selected.language ? ` · ${selected.language}` : ""}
                    </span>
                  </div>
                  <div className="routine-detail-actions">
                    <button
                      type="button"
                      className="routine-btn"
                      onClick={openDraft}
                      disabled={!definition}
                    >
                      <FileCode className="w-3.5 h-3.5" /> {copy.editAsDraft}
                    </button>
                    {isExecuting ? (
                      <button type="button" className="routine-btn" onClick={cancelExecution}>
                        <Square className="w-3.5 h-3.5" /> Cancel
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="routine-btn is-primary"
                        onClick={() => void execute()}
                      >
                        <Play className="w-3.5 h-3.5" /> {copy.execute}
                      </button>
                    )}
                  </div>
                </div>

                <div className="routine-definition">
                  {isLoadingDefinition ? (
                    <div className="routine-detail-empty">
                      <Loader2 className="w-4 h-4 animate-spin" /> {copy.loading}
                    </div>
                  ) : definitionError ? (
                    <div className="routine-detail-empty routine-list-error">{definitionError}</div>
                  ) : definition ? (
                    <Editor
                      language="sql"
                      value={definition.definition}
                      beforeMount={defineTableRTheme}
                      theme="tabler-dark"
                      options={{
                        readOnly: true,
                        minimap: { enabled: false },
                        fontSize: 12,
                        fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
                        lineNumbers: "on",
                        lineNumbersMinChars: 3,
                        scrollBeyondLastLine: false,
                        wordWrap: "on",
                        padding: { top: 8, bottom: 6 },
                        automaticLayout: true,
                        scrollbar: { verticalScrollbarSize: 7, horizontalScrollbarSize: 7 },
                      }}
                    />
                  ) : (
                    <div className="routine-detail-empty">{copy.definitionUnavailable}</div>
                  )}
                </div>

                <div className="routine-exec">
                  <div className="routine-exec-args">
                    <span className="routine-exec-label">{copy.argsTitle}</span>
                    {args.length === 0 ? (
                      <span className="routine-exec-noargs">{copy.noArgs}</span>
                    ) : (
                      args.map((arg, index) => (
                        <label key={`${arg.label}-${index}`} className="routine-arg">
                          <span className="routine-arg-label" title={arg.hint}>
                            {arg.label}
                            {arg.mode ? ` (${arg.mode})` : ""}
                          </span>
                          <input
                            className="routine-arg-input"
                            value={argValues[index] ?? ""}
                            placeholder={copy.argPlaceholder}
                            onChange={(event) =>
                              setArgValues((current) => {
                                const next = [...current];
                                next[index] = event.target.value;
                                return next;
                              })
                            }
                          />
                        </label>
                      ))
                    )}
                  </div>
                  {executionError && <div className="routine-exec-error">{executionError}</div>}
                  {isExecuting && (
                    <div className="routine-detail-empty">
                      <Loader2 className="w-4 h-4 animate-spin" /> {copy.executing}
                    </div>
                  )}
                  {executionResult && !isExecuting && (
                    <RoutineResultTable result={executionResult} copy={copy} />
                  )}
                </div>
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

export function RoutineEditorModal() {
  const isOpen = useRoutineEditorStore((state) => state.isOpen);
  if (!isOpen) return null;
  return createPortal(<RoutineEditorContent />, document.body);
}
