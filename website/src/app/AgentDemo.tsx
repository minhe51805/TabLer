"use client";

import { useEffect, useRef, useState } from "react";
import { Bot, Check, ShieldCheck, UserRound } from "lucide-react";

/**
 * Live agent-loop storyboard inside the agent section's product frame.
 * The scene replays the real tool chain as a little performance:
 *   1. the user's question types into the prompt bar
 *   2. the agent avatar drops into center stage — scales up, spins once,
 *      then settles onto the work track
 *   3. it walks station to station (inspect → draft → verify → run); each
 *      station pops a thought bubble showing what the agent is doing,
 *      then closes as the agent moves on
 *   4. at the last station it slides right to the client avatar and a chat
 *      bubble pops open — the handover message slides out, then the result
 *      table streams in row by row
 *   5. pause, fade, replay
 * Pure CSS/timeout choreography — no animation library. The loop only runs
 * while the frame is on screen (IntersectionObserver); reduced-motion users
 * see the finished scene.
 */
type Phase = "prompt" | "arrive" | "station" | "handover" | "done";

const ARRIVE_MS = 1700;
const STATION_MS = 1600;
const HANDOVER_MS = 3400;
const DONE_MS = 2400;

/** Track x-positions (%) for the four stations and the client avatar. */
const STATION_X = [12, 31, 50, 69];
const CLIENT_X = 90;

const RESULT_ROWS: [string, string][] = [
  ["Acme Corporation", "$48,210"],
  ["Northwind Traders", "$41,875"],
  ["Globex GmbH", "$36,540"],
  ["Initech LLC", "$29,314"],
  ["Umbrella Ltd", "$24,908"],
];

const STATION_ICONS = ["schema", "sql", "check", "rows"] as const;

export type AgentDemoCopy = {
  prompt: string;
  steps: [string, string, string, string];
  /** one-line activity shown inside each station's thought bubble */
  activities: [string, string, string, string];
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

  // Prompt types character by character, then the agent arrives.
  useEffect(() => {
    if (!active || reduced || phase !== "prompt") return;
    if (typed >= copy.prompt.length) {
      const t = setTimeout(() => setPhase("arrive"), 550);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setTyped((n) => n + 1), 26);
    return () => clearTimeout(t);
  }, [active, reduced, phase, typed, copy.prompt]);

  // Phase machine: arrive → stations 0..3 → handover → done → loop.
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
        if (station < STATION_X.length - 1) {
          setStation((s) => s + 1);
        } else {
          setPhase("handover");
        }
      }, STATION_MS);
      return () => clearTimeout(t);
    }
    if (phase === "handover") {
      const t = setTimeout(() => setPhase("done"), HANDOVER_MS);
      return () => clearTimeout(t);
    }
    // done → reset everything and replay
    const t = setTimeout(() => {
      setTyped(0);
      setRowCount(0);
      setStation(0);
      setPhase("prompt");
    }, DONE_MS);
    return () => clearTimeout(t);
  }, [active, reduced, phase, station]);

  // Result rows stream in during the handover.
  useEffect(() => {
    if (!active || reduced || phase !== "handover") return;
    if (rowCount >= RESULT_ROWS.length) return;
    const t = setTimeout(() => setRowCount((n) => n + 1), 240);
    return () => clearTimeout(t);
  }, [active, reduced, phase, rowCount]);

  const done = reduced || phase === "done" || phase === "handover";

  // Avatar x-position per scene: hidden above center → center → stations → client.
  const avatarX =
    phase === "station"
      ? STATION_X[station]
      : phase === "handover" || phase === "done"
        ? CLIENT_X - 12
        : 50;
  const avatarGone = !reduced && phase === "prompt";
  const avatarDropping = !reduced && phase === "arrive";

  return (
    <div className="agent-demo" ref={rootRef} aria-label={copy.prompt}>
      {/* typed user request */}
      <div className="agent-demo-prompt">
        <span className="agent-demo-prompt-text">
          {reduced ? copy.prompt : copy.prompt.slice(0, typed)}
        </span>
        {!reduced && phase === "prompt" && <span className="agent-demo-caret" aria-hidden="true" />}
      </div>

      {/* the stage — track, stations, agent, client, bubbles */}
      <div className="agent-demo-stage">
        <div className="agent-demo-track" aria-hidden="true" />

        {/* stations the agent walks through */}
        <ol className="agent-demo-stations">
          {copy.steps.map((label, i) => {
            const visited =
              reduced || done || phase === "station"
                ? i <= (done ? STATION_X.length : station)
                : i < 0;
            const current = !reduced && phase === "station" && i === station;
            return (
              <li
                className={`agent-demo-station ${visited ? "is-visited" : ""} ${current ? "is-current" : ""}`}
                style={{ left: `${STATION_X[i]}%` }}
                key={label}
              >
                <span className="agent-demo-node" aria-hidden="true">
                  {visited && !current && <Check size={10} strokeWidth={3.5} />}
                </span>
                <span className="agent-demo-station-label">{label}</span>

                {/* thought bubble — opens while the agent works this station */}
                <span
                  className={`agent-demo-bubble ${current ? "is-open" : ""}`}
                  aria-hidden={!current}
                >
                  <span className="agent-demo-bubble-icon" aria-hidden="true">
                    {STATION_ICONS[i] === "check" ? <ShieldCheck size={12} /> : <Bot size={12} />}
                  </span>
                  <span className="agent-demo-bubble-text">{copy.activities[i]}</span>
                </span>
              </li>
            );
          })}
        </ol>

        {/* client avatar — the handover target */}
        <div className="agent-demo-client" style={{ left: `${CLIENT_X}%` }} aria-hidden="true">
          <UserRound size={16} />
        </div>

        {/* agent avatar — drops in, walks the track, hands off */}
        <div
          className={`agent-demo-avatar ${avatarGone ? "is-gone" : ""} ${avatarDropping ? "is-arriving" : ""}`}
          style={{ left: `${avatarX}%` }}
          aria-hidden="true"
        >
          <span className="agent-demo-avatar-icon">
            <Bot size={18} />
          </span>
        </div>

        {/* handover chat bubble — text slides out, rows stream in */}
        <div
          className={`agent-demo-chat ${done ? "is-open" : ""}`}
          style={{ left: `${CLIENT_X}%` }}
          aria-hidden={!done}
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
  );
}
