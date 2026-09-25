"use client";

import { useEffect, useRef, useState } from "react";
import { Check, CircleDashed, Loader2, ShieldCheck, Table2 } from "lucide-react";

/**
 * Live agent-loop demo inside the agent section's product frame. Replays the
 * real tool chain on a fixed script: the user's question types in, the agent
 * inspects the schema, drafts SQL line by line, marks it verified/read-only,
 * runs it, and rows stream in. Loops with a pause. Pure CSS/timeout motion —
 * no animation library; renders the finished state for reduced-motion users
 * and only animates while the frame is on screen.
 *
 * Timing model: a single `phase` state drives everything; each phase owns its
 * duration via a timeout registered per phase change.
 */
type Phase = "prompt" | "inspect" | "draft" | "verify" | "run" | "done";

const PHASE_MS: Record<Exclude<Phase, "prompt">, number> = {
  inspect: 1300,
  draft: 2100,
  verify: 1000,
  run: 1400,
  done: 2600,
};

const SQL_LINES = [
  "SELECT c.name, SUM(oi.amount) AS revenue",
  "FROM customers c",
  "JOIN orders o ON o.customer_id = c.id",
  "JOIN order_items oi ON oi.order_id = o.id",
  "WHERE o.created_at >= date_trunc('quarter', now())",
  "GROUP BY 1 ORDER BY revenue DESC LIMIT 5",
];

const RESULT_ROWS: [string, string][] = [
  ["Acme Corporation", "$48,210"],
  ["Northwind Traders", "$41,875"],
  ["Globex GmbH", "$36,540"],
  ["Initech LLC", "$29,314"],
  ["Umbrella Ltd", "$24,908"],
];

export type AgentDemoCopy = {
  prompt: string;
  steps: [string, string, string, string, string];
  inspecting: string;
  verified: string;
  running: string;
  done: string;
};

export function AgentDemo({ copy }: { copy: AgentDemoCopy }) {
  const [phase, setPhase] = useState<Phase>("prompt");
  const [typed, setTyped] = useState(0);
  const [sqlCount, setSqlCount] = useState(0);
  const [rowCount, setRowCount] = useState(0);
  const [active, setActive] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const reduced =
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Only run the loop while the frame is visible — no background timers.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) => setActive(entry.isIntersecting), {
      threshold: 0.25,
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Prompt types character by character, then hands off to the inspect phase.
  useEffect(() => {
    if (!active || reduced || phase !== "prompt") return;
    if (typed >= copy.prompt.length) {
      const t = setTimeout(() => setPhase("inspect"), 500);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setTyped((n) => n + 1), 26);
    return () => clearTimeout(t);
  }, [active, reduced, phase, typed, copy.prompt]);

  // Each later phase waits its slot, then advances. `done` loops the script.
  useEffect(() => {
    if (!active || reduced || phase === "prompt") return;
    const next: Phase =
      phase === "inspect"
        ? "draft"
        : phase === "draft"
          ? "verify"
          : phase === "verify"
            ? "run"
            : phase === "run"
              ? "done"
              : "prompt";
    const t = setTimeout(() => {
      if (phase === "done") {
        setTyped(0);
        setSqlCount(0);
        setRowCount(0);
      }
      setPhase(next);
    }, PHASE_MS[phase]);
    return () => clearTimeout(t);
  }, [active, reduced, phase]);

  // SQL reveals line by line during draft; result rows stream during run.
  useEffect(() => {
    if (!active || reduced) return;
    if (phase === "draft" && sqlCount < SQL_LINES.length) {
      const t = setTimeout(() => setSqlCount((n) => n + 1), 260);
      return () => clearTimeout(t);
    }
    if (phase === "run" && rowCount < RESULT_ROWS.length) {
      const t = setTimeout(() => setRowCount((n) => n + 1), 220);
      return () => clearTimeout(t);
    }
  }, [active, reduced, phase, sqlCount, rowCount]);

  const shown = reduced ? copy.prompt : copy.prompt.slice(0, typed);
  const order: Phase[] = ["prompt", "inspect", "draft", "verify", "run"];
  const phaseIdx = reduced || phase === "done" ? order.length : order.indexOf(phase);
  const sqlVisible = reduced || phaseIdx > 3 ? SQL_LINES.length : phase === "draft" ? sqlCount : 0;
  const rowsVisible =
    reduced || phase === "done" ? RESULT_ROWS.length : phase === "run" ? rowCount : 0;

  return (
    <div className="agent-demo" ref={rootRef} aria-label={copy.prompt}>
      {/* step rail — the agent loop as five visible beats */}
      <ol className="agent-demo-steps">
        {copy.steps.map((label, i) => {
          const state = i < phaseIdx ? "done" : i === phaseIdx ? "active" : "todo";
          return (
            <li className={`agent-demo-step is-${state}`} key={label}>
              <span className="agent-demo-step-icon" aria-hidden="true">
                {state === "done" ? (
                  <Check size={12} strokeWidth={3} />
                ) : state === "active" ? (
                  <Loader2 size={12} className="agent-demo-spin" />
                ) : (
                  <CircleDashed size={12} />
                )}
              </span>
              <span>{label}</span>
            </li>
          );
        })}
      </ol>

      {/* typed user request */}
      <div className="agent-demo-prompt">
        <span className="agent-demo-prompt-text">{shown}</span>
        {!reduced && phase === "prompt" && <span className="agent-demo-caret" aria-hidden="true" />}
      </div>

      {/* schema chips the agent discovered */}
      <div
        className={`agent-demo-zone ${phaseIdx >= 1 || reduced ? "is-on" : ""}`}
        aria-hidden={phaseIdx < 1 && !reduced}
      >
        <div className="agent-demo-status">
          <Table2 size={13} aria-hidden="true" />
          {copy.inspecting}
        </div>
        <div className="agent-demo-chips">
          {["customers", "orders", "order_items"].map((table, i) => (
            <span
              className="agent-demo-chip"
              key={table}
              style={{ transitionDelay: `${i * 140}ms` }}
            >
              {table}
            </span>
          ))}
        </div>
      </div>

      {/* drafted SQL, revealed line by line */}
      <div
        className={`agent-demo-zone ${phaseIdx >= 2 || reduced ? "is-on" : ""}`}
        aria-hidden={phaseIdx < 2 && !reduced}
      >
        <pre className="agent-demo-sql">
          {SQL_LINES.slice(0, sqlVisible).map((line, i) => (
            <code key={i} style={{ transitionDelay: `${i * 90}ms` }}>
              {line}
            </code>
          ))}
        </pre>
        <div className={`agent-demo-verified ${phaseIdx >= 3 || reduced ? "is-on" : ""}`}>
          <ShieldCheck size={13} aria-hidden="true" />
          {copy.verified}
        </div>
      </div>
      {/* streamed result rows */}
      <div
        className={`agent-demo-zone ${phaseIdx >= 4 || reduced ? "is-on" : ""}`}
        aria-hidden={phaseIdx < 4 && !reduced}
      >
        <div className="agent-demo-status">
          {phase === "done" || reduced ? (
            <>
              <Check size={13} aria-hidden="true" />
              {copy.done}
            </>
          ) : (
            <>
              <Loader2 size={13} className="agent-demo-spin" aria-hidden="true" />
              {copy.running}…
            </>
          )}
        </div>
        <table className="agent-demo-rows">
          <tbody>
            {RESULT_ROWS.slice(0, rowsVisible).map(([name, revenue], i) => (
              <tr key={name} style={{ transitionDelay: `${i * 130}ms` }}>
                <td>{name}</td>
                <td>{revenue}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
