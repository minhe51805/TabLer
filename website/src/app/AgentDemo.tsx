"use client";

import { useEffect, useRef, useState } from "react";
import { Bot, Code2, Play, ShieldCheck, Table2, UserRound } from "lucide-react";

/**
 * Live agent-loop storyboard inside the agent section's product frame.
 *
 * Scene sequence:
 *   1. prompt — only the input bar exists; the user's question types in,
 *      then the bar fades away entirely
 *   2. arrive — the agent avatar drops into the left pane center, scales
 *      up, spins once, and settles onto the work line
 *   3. station ×4 — the pane splits: on the left the current step node
 *      (unreached and finished steps stay out of sight — a thin progress
 *      rail tracks them) with the agent beside it; on the right a mock
 *      terminal streams what the agent is doing at that step. The step
 *      advances and the terminal swaps its log.
 *   4. handover — the node fades out, the agent slides right toward the
 *      client avatar, and the terminal crossfades into a chat bubble:
 *      the handover line slides out and the result table streams in
 *   5. done — hold, then reset and replay
 *
 * Pure CSS/timeout choreography — no animation library. Runs only while
 * on screen (IntersectionObserver); reduced-motion users get the final
 * scene rendered statically.
 */
type Phase = "prompt" | "arrive" | "station" | "handover" | "done";

const ARRIVE_MS = 1700;
const STATION_MS = 2400;
const HANDOVER_MS = 3600;
const DONE_MS = 2400;
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
  /** terminal log lines per step — first char "$" renders as a command */
  term: string[][];
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

  // Result rows stream into the chat during the handover.
  useEffect(() => {
    if (!active || reduced || phase !== "handover") return;
    if (rowCount >= RESULT_ROWS.length) return;
    const t = setTimeout(() => setRowCount((n) => n + 1), 240);
    return () => clearTimeout(t);
  }, [active, reduced, phase, rowCount]);

  const inScene = phase !== "prompt";
  const inStation = phase === "station";
  const handedOff = phase === "handover" || phase === "done";
  const StepIcon = STEP_ICONS[Math.min(station, STEP_ICONS.length - 1)];

  const avatarGone = !inScene;

  return (
    <div className="agent-demo" ref={rootRef} aria-label={copy.prompt}>
      {/* intro: the prompt bar alone — it leaves once the question lands */}
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

      {/* main scene: node + agent (left) | terminal → chat (right) */}
      <div className={`agent-demo-scene ${inScene || reduced ? "is-on" : ""}`}>
        <div className="agent-demo-left">
          {/* thin progress rail — the only trace of past/future steps */}
          <ol className="agent-demo-progress" aria-hidden="true">
            {copy.steps.map((label, i) => {
              const state =
                reduced || handedOff || i < station ? "done" : i === station ? "on" : "todo";
              return <li className={`agent-demo-dot is-${state}`} key={label} title={label} />;
            })}
          </ol>

          {/* center stage — node card with the agent orbiting it */}
          <div className="agent-demo-orbit" aria-hidden={!inScene || handedOff}>
            <div
              className={`agent-demo-node-card ${handedOff ? "is-out" : ""}`}
              key={reduced ? "r" : station}
            >
              <span className="agent-demo-node-icon">
                <StepIcon size={20} strokeWidth={1.9} aria-hidden="true" />
              </span>
              <span className="agent-demo-node-label">
                {reduced ? copy.steps[3] : copy.steps[Math.min(station, 3)]}
              </span>
            </div>

            {/* agent avatar — orbits the node on stations, slides right
                to the client for the handover */}
            <div
              className={`agent-demo-avatar ${avatarGone && !reduced ? "is-gone" : ""} ${
                phase === "arrive" && !reduced ? "is-arriving" : ""
              } ${inStation && !reduced ? "is-working" : ""} ${handedOff ? "is-handing" : ""}`}
              aria-hidden="true"
            >
              <span className="agent-demo-avatar-icon">
                <Bot size={18} />
              </span>
            </div>

            {/* client avatar — slides in at the right edge for the handover */}
            <div
              className={`agent-demo-client ${handedOff || reduced ? "is-on" : ""}`}
              aria-hidden="true"
            >
              <UserRound size={16} />
            </div>
          </div>
        </div>

        <div className="agent-demo-right">
          {/* mock terminal — one log per station, swapped on advance */}
          <div
            className={`agent-demo-terminal ${handedOff || reduced ? "is-off" : ""}`}
            aria-hidden={handedOff}
          >
            <div className="agent-demo-term-bar">
              <span />
              <span />
              <span />
              <strong>{reduced ? copy.steps[3] : copy.steps[Math.min(station, 3)]}</strong>
            </div>
            <div className="agent-demo-term-body" key={reduced ? 3 : station}>
              {(reduced ? copy.term[3] : copy.term[Math.min(station, 3)]).map((line, i) => (
                <div
                  className={`agent-demo-term-line ${line.startsWith("$") ? "is-cmd" : ""} ${
                    line.includes("✓") ? "is-ok" : ""
                  }`}
                  style={{ animationDelay: `${0.3 + i * 0.55}s` }}
                  key={i}
                >
                  {line}
                </div>
              ))}
            </div>
          </div>

          {/* handover chat — replaces the terminal for the final beat */}
          <div
            className={`agent-demo-chat ${handedOff || reduced ? "is-open" : ""}`}
            aria-hidden={!handedOff && !reduced}
          >
            <span className="agent-demo-chat-text">{copy.handover}</span>
            <table className="agent-demo-chat-rows">
              <tbody>
                {(reduced ? RESULT_ROWS : RESULT_ROWS.slice(0, rowCount)).map(([name, revenue]) => (
                  <tr key={name}>
                    <td>{name}</td>
                    <td>{revenue}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <span className="agent-demo-chat-foot">{copy.done}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
