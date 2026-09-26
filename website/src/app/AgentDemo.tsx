"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Bot, Check, Code2, Play, ShieldCheck, Table2, UserRound } from "lucide-react";

/**
 * Live agent-loop demo inside the agent section's product frame, styled
 * after Claude.ai's agent transcript: one quiet column — the user bubble
 * types in, then each tool step opens in place while the agent dot orbits
 * its node, and a final response card hands the answer to the client.
 *
 *   1. prompt — the user bubble types in
 *   2. arrive — the trace fades in and the agent drops to the first node
 *   3. step ×4 — the connector fills to the step, the agent orbits its
 *      node, and the step's card streams a few log lines (pushing the
 *      later steps down, like a real expanding trace)
 *   4. handover — the response card opens with the answer + table while
 *      the agent slides to the connector's end node beside the client chip
 *   5. hold, reset, replay
 *
 * The scene is a natural document flow (steps are real flex rows, not
 * absolutely positioned), so an opening card pushes later rows down like
 * Claude's tool-call expansion. The agent dot's pivot follows the active
 * node via DOM measurements — no hardcoded offsets.
 *
 * Pure CSS/timeout choreography — no animation library; runs only while
 * on screen; reduced-motion users get the finished transcript.
 */
type Phase = "prompt" | "arrive" | "station" | "handover" | "done";

const ARRIVE_MS = 1400;
const STATION_MS = 2400;
const HANDOVER_MS = 3200;
const DONE_MS = 2600;
const STATION_COUNT = 4;

const STEP_ICONS = [Table2, Code2, ShieldCheck, Play];

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
  const [typed, setTyped] = useState(0);
  const [rowCount, setRowCount] = useState(0);
  const [active, setActive] = useState(false);
  const [agentY, setAgentY] = useState(0);
  const [fillY, setFillY] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const traceRef = useRef<HTMLDivElement>(null);
  const stepRefs = useRef<(HTMLLIElement | null)[]>([]);
  const responseRef = useRef<HTMLDivElement>(null);

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

  // The user bubble types in, then the transcript begins.
  useEffect(() => {
    if (!active || reduced || phase !== "prompt") return;
    if (typed >= copy.prompt.length) {
      const t = setTimeout(() => setPhase("arrive"), 600);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setTyped((n) => n + 1), 26);
    return () => clearTimeout(t);
  }, [active, reduced, phase, typed, copy.prompt]);

  // Phase machine: arrive → station 0..3 → handover → done → replay.
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
      setTyped(0);
      setRowCount(0);
      setStation(0);
      setPhase("prompt");
    }, DONE_MS);
    return () => clearTimeout(t);
  }, [active, reduced, phase, station]);

  // Result rows stream into the response during the handover.
  useEffect(() => {
    if (!active || reduced || phase !== "handover") return;
    if (rowCount >= RESULT_ROWS.length) return;
    const t = setTimeout(() => setRowCount((n) => n + 1), 220);
    return () => clearTimeout(t);
  }, [active, reduced, phase, rowCount]);

  const inScene = phase !== "prompt";
  const inStation = phase === "station";
  const handedOff = phase === "handover" || phase === "done";

  // Follow the real layout: the agent orbits the active node's center
  // and the connector fill reaches the same node. A ResizeObserver keeps
  // it glued while expanding cards shift the rows below mid-animation.
  useLayoutEffect(() => {
    const trace = traceRef.current;
    if (!trace) return;
    const measure = () => {
      const traceBox = trace.getBoundingClientRect();
      const target = handedOff ? responseRef.current : stepRefs.current[station];
      if (!target) return;
      const box = target.getBoundingClientRect();
      // node center = the 24px dot at the row's left edge
      const nodeCenter = box.top - traceBox.top + 12;
      setAgentY(nodeCenter);
      setFillY(Math.max(0, nodeCenter - 12));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(trace);
  }, [phase, station, handedOff, active]);

  const avatarX = 30; // connector x — the agent rides the trace

  return (
    <div className="agent-demo" ref={rootRef} aria-label={copy.prompt}>
      {/* user bubble — the request that starts the run; exits once done */}
      <div className={`agent-demo-user ${phase !== "prompt" || reduced ? "is-done" : ""}`}>
        <span className="agent-demo-user-text">
          {reduced ? copy.prompt : copy.prompt.slice(0, typed)}
        </span>
        {!reduced && phase === "prompt" && <span className="agent-demo-caret" aria-hidden="true" />}
      </div>

      {/* transcript — connector + steps + response */}
      <div className={`agent-demo-trace ${inScene || reduced ? "is-on" : ""}`} ref={traceRef}>
        <div className="agent-demo-line" aria-hidden="true">
          <div className="agent-demo-line-fill" style={{ height: `${fillY}px` }} />
        </div>

        <ol className="agent-demo-steps">
          {copy.steps.map((label, i) => {
            const Icon = STEP_ICONS[i];
            const state =
              reduced || handedOff || i < station
                ? "done"
                : inStation && i === station
                  ? "on"
                  : "todo";
            // the detail card only lives under the step being worked —
            // it closes as the agent moves on
            const showBody = !reduced && inStation && i === station;
            return (
              <li
                className={`agent-demo-step is-${state}`}
                ref={(el) => {
                  stepRefs.current[i] = el;
                }}
                key={label}
              >
                <div className="agent-demo-step-row">
                  <span className="agent-demo-dot" aria-hidden="true">
                    {state === "done" ? <Check size={10} strokeWidth={3.5} /> : <Icon size={11} />}
                  </span>
                  <span className="agent-demo-step-label">{label}</span>
                  <span className="agent-demo-step-state" aria-hidden="true">
                    {state === "on" ? (
                      <span className="agent-demo-typing">
                        <i />
                        <i />
                        <i />
                      </span>
                    ) : state === "done" ? (
                      <Check size={11} strokeWidth={3} />
                    ) : null}
                  </span>
                </div>
                {/* step detail — expands in place while the agent works,
                    pushing the next rows down like a real tool call */}
                <div className={`agent-demo-card ${showBody ? "is-open" : ""}`}>
                  <div className="agent-demo-card-inner">
                    {(copy.term[i] ?? []).map((line, j) => (
                      <span
                        className={`agent-demo-card-line ${line.startsWith("$") ? "is-cmd" : ""} ${
                          line.includes("✓") ? "is-ok" : ""
                        }`}
                        style={{ animationDelay: `${0.2 + j * 0.45}s` }}
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

        {/* response — the answer handed to the client; the last node on
            the trace is the connector's end */}
        <div
          className={`agent-demo-response ${handedOff || reduced ? "is-open" : ""}`}
          ref={responseRef}
          aria-hidden={!handedOff && !reduced}
        >
          <div className="agent-demo-response-dot" aria-hidden="true">
            <Bot size={11} />
          </div>
          <div className="agent-demo-response-body">
            <span className="agent-demo-response-text">{copy.handover}</span>
            <table className="agent-demo-response-rows">
              <tbody>
                {(reduced ? RESULT_ROWS : RESULT_ROWS.slice(0, rowCount)).map(([name, revenue]) => (
                  <tr key={name}>
                    <td>{name}</td>
                    <td>{revenue}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <span className="agent-demo-response-foot">
              {copy.done}
              <span
                className={`agent-demo-client ${handedOff || reduced ? "is-on" : ""}`}
                aria-hidden="true"
              >
                <UserRound size={12} />
                {copy.client}
              </span>
            </span>
          </div>
        </div>

        {/* agent dot — arrives on the first node, orbits the one it's
            running, slides to the response node for the handover */}
        <div
          className={`agent-demo-avatar ${!inScene && !reduced ? "is-gone" : ""} ${
            phase === "arrive" && !reduced ? "is-arriving" : ""
          } ${inStation && !reduced ? "is-working" : ""}`}
          style={{ top: `${agentY}px`, left: `${avatarX}px` }}
          aria-hidden="true"
        >
          <span className="agent-demo-avatar-icon">
            <Bot size={13} />
          </span>
        </div>
      </div>
    </div>
  );
}
