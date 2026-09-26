"use client";

import { useEffect, useRef, useState } from "react";
import { Bot, Check, Code2, Play, ShieldCheck, Table2, UserRound } from "lucide-react";

/**
 * Live agent-loop storyboard inside the agent section's product frame.
 *
 * Scene sequence (one stage, no split):
 *   1. prompt — a lone input bar types the user's question, then exits
 *   2. arrive — the agent drops into center stage, scales up, spins once,
 *      and slides down onto the work rail
 *   3. station ×4 — the agent walks the rail and orbits the node it's
 *      working on; an activity card slides along underneath, its tail
 *      pinned to the node, streaming that step's log. Past nodes turn
 *      green + check; the rail fill chases the agent.
 *   4. handover — past the last node the agent slides right to the client
 *      avatar; a result bubble pops under it — handover line slides out,
 *      result table streams in
 *   5. done — hold, reset, replay
 *
 * Pure CSS/timeout choreography — no animation library. Runs only while
 * on screen (IntersectionObserver); reduced-motion users get the final
 * scene rendered statically.
 */
type Phase = "prompt" | "arrive" | "station" | "handover" | "done";

const ARRIVE_MS = 1700;
const STATION_MS = 2600;
const HANDOVER_MS = 3400;
const DONE_MS = 2600;

/** Rail x-positions (%) — four work stations, then the client at the end. */
const STATION_X = [16, 37, 58, 79];
const CLIENT_X = 93;
const STATION_COUNT = STATION_X.length;

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
  const rootRef = useRef<HTMLDivElement>(null);

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

  // Prompt types character by character, then the bar exits and the
  // agent drops in.
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

  // Result rows stream into the bubble during the handover.
  useEffect(() => {
    if (!active || reduced || phase !== "handover") return;
    if (rowCount >= RESULT_ROWS.length) return;
    const t = setTimeout(() => setRowCount((n) => n + 1), 240);
    return () => clearTimeout(t);
  }, [active, reduced, phase, rowCount]);

  const inScene = phase !== "prompt";
  const inStation = phase === "station";
  const handedOff = phase === "handover" || phase === "done";

  // The agent rides the rail: arrive at center, then walk station→station,
  // finally reach the client. Same position drives the rail fill.
  const agentX = reduced
    ? CLIENT_X
    : handedOff
      ? CLIENT_X - 6
      : inStation
        ? STATION_X[station]
        : 50;
  const fillX = reduced ? 100 : handedOff ? CLIENT_X : inStation ? STATION_X[station] : 0;
  const StepIcon = STEP_ICONS[Math.min(station, STEP_ICONS.length - 1)];

  return (
    <div className="agent-demo" ref={rootRef} aria-label={copy.prompt}>
      {/* intro — the prompt bar alone, centered; leaves once typed */}
      <div className={`agent-demo-intro ${inScene || reduced ? "is-out" : ""}`}>
        <div className="agent-demo-prompt">
          <span className="agent-demo-prompt-text">
            {reduced ? copy.prompt : copy.prompt.slice(0, typed)}
          </span>
          {!reduced && phase === "prompt" && (
            <span className="agent-demo-caret" aria-hidden="true" />
          )}
        </div>
      </div>

      {/* the stage — one rail the agent walks */}
      <div className={`agent-demo-scene ${inScene || reduced ? "is-on" : ""}`}>
        {/* rail + progress fill chasing the agent */}
        <div className="agent-demo-rail" aria-hidden="true">
          <div className="agent-demo-rail-fill" style={{ width: `${fillX}%` }} />
        </div>

        {/* step nodes on the rail */}
        <ol className="agent-demo-stations">
          {copy.steps.map((label, i) => {
            const Icon = STEP_ICONS[i];
            const state =
              reduced || handedOff || i < station
                ? "done"
                : inStation && i === station
                  ? "on"
                  : "todo";
            return (
              <li
                className={`agent-demo-station is-${state}`}
                style={{ left: `${STATION_X[i]}%` }}
                key={label}
              >
                <span className="agent-demo-node" aria-hidden="true">
                  {state === "done" ? <Check size={11} strokeWidth={3} /> : <Icon size={13} />}
                </span>
                <span className="agent-demo-station-label">{label}</span>
              </li>
            );
          })}
          {/* client node at the rail's end */}
          <li
            className={`agent-demo-station is-client ${handedOff || reduced ? "is-on" : ""}`}
            style={{ left: `${CLIENT_X}%` }}
          >
            <span className="agent-demo-node" aria-hidden="true">
              <UserRound size={13} />
            </span>
            <span className="agent-demo-station-label">{copy.client}</span>
          </li>
        </ol>

        {/* activity card — slides along under the working node */}
        <div
          className={`agent-demo-card ${inStation && !reduced ? "is-open" : ""}`}
          style={{ left: `clamp(132px, ${STATION_X[station]}%, calc(100% - 132px))` }}
          aria-hidden={!inStation}
        >
          <div className="agent-demo-card-head">
            <StepIcon size={14} aria-hidden="true" />
            <span>{copy.steps[Math.min(station, 3)]}</span>
            <span className="agent-demo-card-status">
              {handedOff ? <Check size={12} strokeWidth={3} /> : "…"}
            </span>
          </div>
          <div className="agent-demo-card-body" key={station}>
            {copy.term[Math.min(station, 3)].map((line, i) => (
              <div
                className={`agent-demo-card-line ${line.startsWith("$") ? "is-cmd" : ""} ${
                  line.includes("✓") ? "is-ok" : ""
                }`}
                style={{ animationDelay: `${0.25 + i * 0.5}s` }}
                key={i}
              >
                {line}
              </div>
            ))}
          </div>
        </div>

        {/* agent avatar — pivot on the rail, icon orbits the node, parks at client */}
        <div
          className={`agent-demo-avatar ${!inScene && !reduced ? "is-gone" : ""} ${
            phase === "arrive" && !reduced ? "is-arriving" : ""
          } ${inStation && !reduced ? "is-working" : ""}`}
          style={{ left: `${agentX}%` }}
          aria-hidden="true"
        >
          <span className="agent-demo-avatar-icon">
            <Bot size={17} />
          </span>
        </div>

        {/* result bubble — pops under the client for the handover */}
        <div
          className={`agent-demo-result ${handedOff || reduced ? "is-open" : ""}`}
          style={{ left: `${CLIENT_X}%` }}
          aria-hidden={!handedOff && !reduced}
        >
          <span className="agent-demo-result-text">{copy.handover}</span>
          <table className="agent-demo-result-rows">
            <tbody>
              {(reduced ? RESULT_ROWS : RESULT_ROWS.slice(0, rowCount)).map(([name, revenue]) => (
                <tr key={name}>
                  <td>{name}</td>
                  <td>{revenue}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <span className="agent-demo-result-foot">{copy.done}</span>
        </div>
      </div>
    </div>
  );
}
