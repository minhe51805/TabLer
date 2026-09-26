"use client";

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import {
  BarChart3,
  Check,
  ChevronRight,
  Circle,
  CornerDownRight,
  Loader2,
  Sparkles,
  UserRound,
} from "lucide-react";
import { CountUp, ShinyText, TextType } from "./bits";

/**
 * Split-pane live session — the shape Anthropic's launch demos use:
 * work streams down a glowing spine on the left while a deliverable
 * materializes on the right.
 *
 *   left  — a command bar with the request typing out, then the agent's
 *           steps as spine nodes: hollow → pulsing (with a mini terminal
 *           expanding beneath it) → filled check. A "thinking" caption
 *           types under the active step.
 *   right — an artifact stage. While the agent works it idles as a
 *           dashed preview; on handover the result card lands — title,
 *           data table, a self-drawing bar chart — then a DELIVERED
 *           foot with the client chip.
 *   bottom — a mono status strip reads engine · rows · latency.
 *
 * Pure CSS/timeout choreography; runs only on screen; reduced-motion
 * users get the finished state.
 */
type Phase = "prompt" | "arrive" | "station" | "handover" | "done";

const ARRIVE_MS = 1500;
const STATION_MS = 2500;
const HANDOVER_MS = 3600;
const DONE_MS = 3000;
const STATION_COUNT = 4;

const THINK = ["resolving schema…", "composing query…", "checking the plan…", "streaming result…"];

const STEP_MS = ["0.1 s", "1.4 s", "0.2 s", "38 ms"];

const RESULT_ROWS: [string, string][] = [
  ["Acme Corporation", "$48,210"],
  ["Northwind Traders", "$41,875"],
  ["Globex GmbH", "$36,540"],
  ["Initech LLC", "$29,314"],
  ["Umbrella Ltd", "$24,908"],
];

const MAX_REV = 48210;

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
  const [spineFill, setSpineFill] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const spineRef = useRef<HTMLOListElement>(null);

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

  // Phase machine: prompt → arrive → station 0..3 → handover → done →
  // replay. The prompt phase advances via TextType's onDone.
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
      setSpineFill(0);
      setRunId((n) => n + 1);
      setPhase("prompt");
    }, DONE_MS);
    return () => clearTimeout(t);
  }, [active, reduced, phase, station]);

  // Result rows stream into the artifact during the handover.
  useEffect(() => {
    if (!active || reduced || phase !== "handover") return;
    if (rowCount >= RESULT_ROWS.length) return;
    const t = setTimeout(() => setRowCount((n) => n + 1), 240);
    return () => clearTimeout(t);
  }, [active, reduced, phase, rowCount]);

  // The spine's fill tracks the active node's vertical center — the
  // glowing line literally chases the work.
  useLayoutEffect(() => {
    const spine = spineRef.current;
    if (!spine) return;
    const idx = reduced
      ? STATION_COUNT - 1
      : phase === "prompt"
        ? 0
        : Math.min(station, STATION_COUNT - 1);
    const node = spine.children[idx]?.querySelector(".agent-demo-node");
    if (!node) return;
    const nodeRect = node.getBoundingClientRect();
    const spineRect = spine.getBoundingClientRect();
    const pct = Math.max(
      0,
      Math.min(1, (nodeRect.top + nodeRect.height / 2 - spineRect.top) / spineRect.height),
    );
    setSpineFill(phase === "handover" || phase === "done" || reduced ? 1 : pct);
  }, [station, phase, reduced]);

  const shownStation = reduced ? STATION_COUNT - 1 : station;
  const shownPhase: Phase = reduced ? "done" : phase;
  const shownRows = reduced ? RESULT_ROWS.length : rowCount;
  const inScene = shownPhase !== "prompt";
  const inStation = shownPhase === "station";
  const handedOff = shownPhase === "handover" || shownPhase === "done";
  const working = inScene && !handedOff;

  const startRun = () => {
    if (phase === "prompt") setPhase("arrive");
  };

  return (
    <div
      className={`agent-demo ${working ? "is-live" : ""}`}
      ref={rootRef}
      aria-label={copy.prompt}
    >
      {/* command bar — the request the session took on */}
      <div className="agent-demo-ask">
        <span className="agent-demo-ask-glyph" aria-hidden="true">
          <Sparkles size={13} />
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
        <span className={`agent-demo-live ${inScene ? "is-on" : ""} ${handedOff ? "is-done" : ""}`}>
          {handedOff ? (
            <>
              <Check size={10} strokeWidth={3} /> done
            </>
          ) : inScene ? (
            <>
              <span className="agent-demo-pulse" aria-hidden="true" /> working
            </>
          ) : null}
        </span>
      </div>

      <div className="agent-demo-body">
        {/* spine — work streams down it; the fill chases the active node */}
        <ol className={`agent-demo-spine ${inScene || reduced ? "is-on" : ""}`} ref={spineRef}>
          <span
            className="agent-demo-spine-fill"
            aria-hidden="true"
            style={{ transform: `scaleY(${spineFill})` }}
          />
          {copy.steps.map((label, i) => {
            const state =
              reduced || handedOff || i < shownStation
                ? "done"
                : inStation && i === shownStation
                  ? "on"
                  : "todo";
            const showBody = !reduced && inStation && i === shownStation;
            return (
              <li className={`agent-demo-step is-${state}`} key={`${runId}-${i}`}>
                <span className="agent-demo-node" aria-hidden="true">
                  {state === "done" ? (
                    <Check size={10} strokeWidth={3.5} />
                  ) : state === "on" ? (
                    <Loader2 size={11} className="agent-demo-spin" />
                  ) : (
                    <Circle size={5} strokeWidth={2} />
                  )}
                </span>
                <div className="agent-demo-step-body">
                  <div className="agent-demo-step-head">
                    <span className="agent-demo-step-label">{label}</span>
                    {state === "done" && <span className="agent-demo-step-ms">{STEP_MS[i]}</span>}
                    {state === "on" && (
                      <ChevronRight size={11} className="agent-demo-step-more" aria-hidden="true" />
                    )}
                  </div>
                  {showBody && (
                    <div className="agent-demo-step-think">
                      <TextType
                        key={`think-${runId}-${i}`}
                        text={THINK[i]}
                        speed={34}
                        showCaret={false}
                      />
                    </div>
                  )}
                  <div className={`agent-demo-term ${showBody ? "is-open" : ""}`}>
                    <div className="agent-demo-term-inner">
                      {(copy.term[i] ?? []).map((line, j) => (
                        <span
                          className={`agent-demo-term-line ${line.startsWith("$") ? "is-cmd" : ""} ${
                            line.includes("✓") ? "is-ok" : ""
                          }`}
                          style={{ animationDelay: `${0.3 + j * 0.5}s` }}
                          key={j}
                        >
                          {line}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
        </ol>

        {/* artifact stage — idle preview until the agent delivers */}
        <div className={`agent-demo-stage ${handedOff || reduced ? "is-on" : ""}`}>
          <div className="agent-demo-stage-empty" aria-hidden="true">
            <BarChart3 size={18} />
            <span>result preview</span>
          </div>
          <div className="agent-demo-card" aria-hidden={!handedOff && !reduced}>
            <div className="agent-demo-card-head">
              <CornerDownRight size={11} aria-hidden="true" />
              <p>{copy.handover}</p>
            </div>
            <table className="agent-demo-rows">
              <tbody>
                {(reduced ? RESULT_ROWS : RESULT_ROWS.slice(0, shownRows)).map(
                  ([name, revenue]) => {
                    const n = parseInt(revenue.replace(/[$,]/g, ""), 10);
                    return (
                      <tr key={name}>
                        <td className="is-name">{name}</td>
                        <td className="is-bar">
                          <span
                            className="agent-demo-bar"
                            style={{ "--bar": `${(n / MAX_REV) * 100}%` } as CSSProperties}
                          />
                        </td>
                        <td className="is-num">
                          {reduced ? (
                            revenue
                          ) : (
                            <CountUp
                              to={n}
                              format={(v) => `$${Math.round(v).toLocaleString("en-US")}`}
                              duration={800}
                            />
                          )}
                        </td>
                      </tr>
                    );
                  },
                )}
              </tbody>
            </table>
            <div className="agent-demo-card-foot">
              {handedOff || reduced ? (
                <ShinyText>✓ {copy.done} · delivered</ShinyText>
              ) : (
                <span aria-hidden="true">&nbsp;</span>
              )}
              <span
                className={`agent-demo-client ${handedOff || reduced ? "is-on" : ""}`}
                aria-hidden="true"
              >
                <UserRound size={10} />
                {copy.client}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
