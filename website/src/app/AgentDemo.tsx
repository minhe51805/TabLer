"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Bot, Check, ChevronRight, Circle, Loader2, UserRound } from "lucide-react";
import { CountUp, ShinyText, TextType } from "./bits";

/**
 * Live agent session inside the agent section's product frame — styled
 * after Anthropic's task demos: a calm session panel — the request on
 * top, a numbered trace of the agent's work with the active step's log
 * expanding in place, and the deliverable card handed to the client at
 * the end. Quiet borders, no glow — the work is the spectacle.
 *
 *   1. ask — the request types out in the session header
 *   2. arrive — the agent avatar fades in beside "working…" status
 *   3. step ×4 — each numbered row activates; its mono log expands in
 *      place and the trace auto-scrolls like a real session view
 *   4. handover — the deliverable card opens with the answer and the
 *      client's avatar claim
 *   5. hold, reset, replay
 *
 * Pure CSS/timeout choreography — no animation library; runs only while
 * on screen; reduced-motion users get the finished transcript.
 */
type Phase = "prompt" | "arrive" | "station" | "handover" | "done";

const ARRIVE_MS = 1400;
const STATION_MS = 2400;
const HANDOVER_MS = 3400;
const DONE_MS = 2800;
const STATION_COUNT = 4;

const STEP_MS = ["0.1 s", "1.4 s", "0.2 s", "38 ms"];

const RESULT_ROWS: [string, string][] = [
  ["Acme Corporation", "$48,210"],
  ["Northwind Traders", "$41,875"],
  ["Globex GmbH", "$36,540"],
  ["Initech LLC", "$29,314"],
  ["Umbrella Ltd", "$24,908"],
];

export type AgentDemoCopy = {
  prompt: string;
  steps: [string, string, string, string];
  /** activity log lines per step — "$" lines render as commands, "✓" as success */
  term: string[][];
  client: string;
  handover: string;
  done: string;
};

export function AgentDemo({ copy }: { copy: AgentDemoCopy }) {
  const [phase, setPhase] = useState<Phase>("prompt");
  const [station, setStation] = useState(0);
  const [rowCount, setRowCount] = useState(0);
  const [runId, setRunId] = useState(0);
  const [active, setActive] = useState(false);
  const [traceShift, setTraceShift] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const traceRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);

  const reduced =
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Only perform while the frame is on screen.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) => setActive(entry.isIntersecting), {
      threshold: 0.25,
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Phase machine: prompt typing ends → arrive → station 0..3 →
  // handover → done → replay. The prompt phase advances from TextType's
  // onDone callback (startRun below).
  useEffect(() => {
    if (!active || reduced || phase === "prompt") return;
    if (phase === "arrive") {
      const t = setTimeout(() => {
        setStation(0);
        setPhase("station");
      }, ARRIVE_MS);
      return () => clearTimeout(t);
    }
    if (phase === "station") {
      const t = setTimeout(() => {
        if (station < STATION_COUNT - 1) setStation((s) => s + 1);
        else setPhase("handover");
      }, STATION_MS);
      return () => clearTimeout(t);
    }
    if (phase === "handover") {
      const t = setTimeout(() => setPhase("done"), HANDOVER_MS);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => {
      setRowCount(0);
      setStation(0);
      setRunId((n) => n + 1);
      setPhase("prompt");
    }, DONE_MS);
    return () => clearTimeout(t);
  }, [active, reduced, phase, station]);

  // Result rows stream into the deliverable during the handover.
  useEffect(() => {
    if (!active || reduced || phase !== "handover") return;
    if (rowCount >= RESULT_ROWS.length) return;
    const t = setTimeout(() => setRowCount((n) => n + 1), 220);
    return () => clearTimeout(t);
  }, [active, reduced, phase, rowCount]);

  // Reduced-motion users get the finished session at once — derived
  // directly, no effect.
  const shownStation = reduced ? STATION_COUNT - 1 : station;
  const shownPhase: Phase = reduced ? "done" : phase;
  const shownRows = reduced ? RESULT_ROWS.length : rowCount;
  const inScene = shownPhase !== "prompt";
  const inStation = shownPhase === "station";
  const handedOff = shownPhase === "handover" || shownPhase === "done";

  // Auto-scroll: the inner column is bottom-pinned; translate it up as
  // content grows so the newest work stays in view — like the product's
  // own session view.
  useLayoutEffect(() => {
    const trace = traceRef.current;
    const inner = innerRef.current;
    if (!trace || !inner) return;
    const observer = new ResizeObserver(() => {
      setTraceShift(Math.max(0, inner.scrollHeight - trace.clientHeight));
    });
    observer.observe(inner);
    observer.observe(trace);
    return () => observer.disconnect();
  }, []);

  const startRun = () => {
    if (phase === "prompt") setPhase("arrive");
  };

  return (
    <div className="agent-demo" ref={rootRef} aria-label={copy.prompt}>
      {/* session header — agent avatar + the request it took on */}
      <div className="agent-demo-ask">
        <span className="agent-demo-ask-icon" aria-hidden="true">
          <Bot size={13} />
        </span>
        {reduced ? (
          <span className="agent-demo-ask-text">{copy.prompt}</span>
        ) : (
          <TextType
            key={runId}
            className="agent-demo-ask-text"
            text={copy.prompt}
            speed={26}
            onDone={startRun}
          />
        )}
        <span
          className={`agent-demo-live ${inScene && !handedOff ? "is-on" : ""}`}
          aria-hidden="true"
        >
          {handedOff ? (
            <>
              <Check size={10} strokeWidth={3} /> done
            </>
          ) : inScene ? (
            <>
              <Loader2 size={10} className="agent-demo-spin" /> working
            </>
          ) : null}
        </span>
      </div>

      {/* trace — bottom-pinned, auto-scrolling list of the session's
          work; a top mask fades whatever scrolled past */}
      <div className={`agent-demo-trace ${inScene || reduced ? "is-on" : ""}`} ref={traceRef}>
        <div
          className="agent-demo-trace-inner"
          ref={innerRef}
          style={{ transform: `translateY(${reduced ? 0 : -traceShift}px)` }}
        >
          <ol className="agent-demo-steps">
            {copy.steps.map((label, i) => {
              const state =
                reduced || handedOff || i < shownStation
                  ? "done"
                  : inStation && i === shownStation
                    ? "on"
                    : "todo";
              // the log block only lives under the step being worked —
              // it collapses as the agent moves on
              const showBody = !reduced && inStation && i === shownStation;
              return (
                <li className={`agent-demo-row is-${state}`} key={`${runId}-${i}`}>
                  <div className="agent-demo-row-head">
                    <span className="agent-demo-row-status" aria-hidden="true">
                      {state === "done" ? (
                        <Check size={11} strokeWidth={3} />
                      ) : state === "on" ? (
                        <Loader2 size={12} className="agent-demo-spin" />
                      ) : (
                        <Circle size={8} strokeWidth={1.5} />
                      )}
                    </span>
                    <span className="agent-demo-row-label">{label}</span>
                    {state === "done" && <span className="agent-demo-row-ms">{STEP_MS[i]}</span>}
                    {state === "on" && (
                      <ChevronRight size={12} className="agent-demo-row-more" aria-hidden="true" />
                    )}
                  </div>
                  <div className={`agent-demo-card ${showBody ? "is-open" : ""}`}>
                    <div className="agent-demo-card-inner">
                      {(copy.term[i] ?? []).map((line, j) => (
                        <span
                          className={`agent-demo-card-line ${line.startsWith("$") ? "is-cmd" : ""} ${
                            line.includes("✓") ? "is-ok" : ""
                          }`}
                          style={{ animationDelay: `${0.15 + j * 0.45}s` }}
                          key={j}
                        >
                          {line}
                        </span>
                      ))}
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>

          {/* deliverable — the final answer handed to the client */}
          <div
            className={`agent-demo-answer ${handedOff || reduced ? "is-open" : ""}`}
            aria-hidden={!handedOff && !reduced}
          >
            <div className="agent-demo-answer-inner">
              <div className="agent-demo-answer-head">
                <Check size={11} strokeWidth={3} aria-hidden="true" />
                <span>{copy.done}</span>
              </div>
              <p className="agent-demo-answer-text">{copy.handover}</p>
              <table className="agent-demo-answer-rows">
                <tbody>
                  {(reduced ? RESULT_ROWS : RESULT_ROWS.slice(0, shownRows)).map(
                    ([name, revenue]) => (
                      <tr key={name}>
                        <td>{name}</td>
                        <td>
                          {reduced ? (
                            revenue
                          ) : (
                            <CountUp
                              to={parseInt(revenue.replace(/[$,]/g, ""), 10)}
                              format={(n) => `$${Math.round(n).toLocaleString("en-US")}`}
                              duration={800}
                            />
                          )}
                        </td>
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
              <div className="agent-demo-answer-foot">
                {handedOff || reduced ? (
                  <ShinyText>delivered</ShinyText>
                ) : (
                  <span aria-hidden="true">&nbsp;</span>
                )}
                <span
                  className={`agent-demo-client ${handedOff || reduced ? "is-on" : ""}`}
                  aria-hidden="true"
                >
                  <UserRound size={11} />
                  {copy.client}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
