import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { MousePointerClick } from "lucide-react";
import { createPortal } from "react-dom";
import { getCurrentAppLanguage } from "../../i18n";
import { useConnectionStore } from "../../stores/connectionStore";
import { useOnboardingStore } from "../../stores/onboarding-store";
import { getOnboardingCopy } from "./onboarding-tour-copy";
import { TOUR_STEPS, type TourStep } from "./tour-steps";
import { openExternalUrl } from "../../utils/tauri-utils";
import "./OnboardingTour.css";

/** The repo README is the documentation entry point today. */
const ONBOARDING_DOCS_URL = "https://github.com/minhe51805/TabLer";

const CUTOUT_PAD = 8;
const POPOVER_W = 320;
const POPOVER_GAP = 14;
const STEP_WAIT_MS = 5000;

interface CutoutRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/**
 * Resolve the active step: a step with a selector waits for its target (up to
 * `STEP_WAIT_MS`); a missing or timed-out target is skipped silently so a
 * hidden affordance never stalls the tour.
 */
function useResolvedStep(step: TourStep | undefined, onMissing: () => void): HTMLElement | null {
  const [target, setTarget] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setTarget(null);
    if (!step || !step.selector) return undefined;
    const selector = step.selector;
    const skipIf = step.skipIfSelector;

    // A target that detached (e.g. the empty-state sample card unmounting
    // when the connection list hydrates) counts as missing — the skip
    // timeout must still be armed for it. No size check: jsdom reports 0
    // offsets for everything.
    const usable = (el: HTMLElement | null): el is HTMLElement => Boolean(el && el.isConnected);

    // `skipIfSelector` marks the step already satisfied (e.g. the Tables
    // folder is already expanded) — advance immediately.
    if (skipIf && usable(document.querySelector<HTMLElement>(skipIf))) {
      onMissing();
      return undefined;
    }

    const sync = () => {
      setTarget((prev) => {
        if (usable(prev)) return prev;
        const found = document.querySelector<HTMLElement>(selector);
        return usable(found) ? found : null;
      });
    };

    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [step, onMissing]);

  // Arm the skip timeout while no usable target exists; disarms itself the
  // moment one mounts.
  useEffect(() => {
    if (!step?.selector || target) return undefined;
    const timeout = window.setTimeout(onMissing, step.waitMs ?? STEP_WAIT_MS);
    return () => window.clearTimeout(timeout);
  }, [step, target, onMissing]);

  return target;
}

/** Track the target's rect through resize/scroll/re-render. */
function useCutoutRect(target: HTMLElement | null): CutoutRect | null {
  const [rect, setRect] = useState<CutoutRect | null>(null);

  useLayoutEffect(() => {
    if (!target) {
      setRect(null);
      return undefined;
    }
    const measure = () => {
      const box = target.getBoundingClientRect();
      setRect({
        top: Math.max(0, box.top - CUTOUT_PAD),
        left: Math.max(0, box.left - CUTOUT_PAD),
        width: box.width + CUTOUT_PAD * 2,
        height: box.height + CUTOUT_PAD * 2,
      });
    };
    target.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(target);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [target]);

  return rect;
}

export function OnboardingTour() {
  const {
    hasCompletedTour,
    tourPhase,
    tourStepIndex,
    completeTour,
    setTourPhase,
    setTourStepIndex,
  } = useOnboardingStore();
  const activeConnectionId = useConnectionStore((s) => s.activeConnectionId);

  // A user who already has a connection should not sit through the launcher
  // phase — jump straight to the workspace steps.
  useEffect(() => {
    if (!hasCompletedTour && tourPhase === "launcher" && activeConnectionId) {
      setTourPhase("workspace");
    }
  }, [hasCompletedTour, tourPhase, activeConnectionId, setTourPhase]);

  const steps = useMemo(() => TOUR_STEPS.filter((step) => step.phase === tourPhase), [tourPhase]);
  const step = steps[tourStepIndex];
  const copy = getOnboardingCopy(getCurrentAppLanguage());

  // Set when the sample CTA was actually clicked — without it the
  // `launcher-creating` step would sit waiting on a connection that was
  // never started (e.g. the step was reached by skipping a missing target).
  const samplePending = useRef(false);

  const advance = useCallback(() => {
    if (tourStepIndex + 1 >= steps.length) {
      if (tourPhase === "launcher") {
        // The "pick" step is the launcher tail: hold until the connection
        // actually lands, then move to the workspace phase.
        return;
      }
      completeTour();
      return;
    }
    setTourStepIndex(tourStepIndex + 1);
  }, [tourStepIndex, steps.length, tourPhase, completeTour, setTourStepIndex]);

  const back = useCallback(() => {
    setTourStepIndex(Math.max(0, tourStepIndex - 1));
  }, [tourStepIndex, setTourStepIndex]);

  // `auto` steps advance when their trigger fires. The creating step only
  // makes sense while a sample creation is genuinely in flight; otherwise
  // skip it (e.g. it was reached after the sample CTA failed to render).
  useEffect(() => {
    if (step?.advanceOn !== "auto") return;
    if (step.id === "launcher-creating" && !samplePending.current && !activeConnectionId) {
      advance();
      return;
    }
    if (activeConnectionId) {
      setTourPhase("workspace");
    }
  }, [step, activeConnectionId, advance, setTourPhase]);

  const handleMissingTarget = useCallback(() => {
    advance();
  }, [advance]);

  const target = useResolvedStep(step, handleMissingTarget);
  const rect = useCutoutRect(target);

  // Click-advance: a real click inside the spotlight target moves the tour
  // forward. We listen passively — the element keeps its own behaviour.
  useEffect(() => {
    if (step?.advanceOn !== "click" || !target) return undefined;
    const onClick = (event: MouseEvent) => {
      if (event.target instanceof Node && target.contains(event.target)) {
        if (step.id === "launcher-sample") {
          // The sample creation is genuinely in flight — the "creating"
          // step should wait for `activeConnectionId`, not skip itself.
          samplePending.current = true;
        }
        advance();
      }
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [step, target, advance]);

  // Keyboard: Esc skips, arrows navigate. Focus stays in the popover.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        completeTour();
      } else if (event.key === "ArrowRight" || event.key === "Enter") {
        if (step?.advanceOn !== "click") advance();
      } else if (event.key === "ArrowLeft") {
        back();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step?.advanceOn, advance, back, completeTour]);

  const popoverRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    popoverRef.current?.focus({ preventScroll: true });
  }, [step?.id]);

  // Workspace-phase steps only make sense once the workspace is actually
  // mounted — stay dormant on the launcher until a connection lands.
  if (hasCompletedTour || !step || (tourPhase === "workspace" && !activeConnectionId)) {
    return null;
  }

  const stepCopy = copyForStep(step.id, copy);
  if (!stepCopy) return null;

  const isLast = tourStepIndex === steps.length - 1;
  const clickable = step.advanceOn === "click";
  // Popover placement: preferred side, flipped when it would clip the
  // viewport; centered when there is no spotlight target. The resolved
  // placement drives the arrow edge via `data-placement`.
  const { style: popoverStyle, placement: effectivePlacement } = rect
    ? placePopover(rect, step.placement ?? "bottom")
    : {
        style: {
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
        } as React.CSSProperties,
        placement: "none" as const,
      };

  return createPortal(
    <div className="onboarding-tour" role="dialog" aria-modal="true" aria-label={stepCopy.title}>
      {/* Four dim rects leave a real hole around the target — the cutout is
          pointer-events:none so click-through steps keep the target live. */}
      {rect ? (
        <>
          <div className="onboarding-dim" style={{ top: 0, left: 0, right: 0, height: rect.top }} />
          <div
            className="onboarding-dim"
            style={{
              top: rect.top,
              left: 0,
              width: rect.left,
              height: rect.height,
            }}
          />
          <div
            className="onboarding-dim"
            style={{
              top: rect.top,
              left: rect.left + rect.width,
              right: 0,
              height: rect.height,
            }}
          />
          <div
            className="onboarding-dim"
            style={{
              top: rect.top + rect.height,
              left: 0,
              right: 0,
              bottom: 0,
            }}
          />
          <div
            className="onboarding-cutout"
            style={{
              top: rect.top,
              left: rect.left,
              width: rect.width,
              height: rect.height,
            }}
          />
        </>
      ) : (
        <div className="onboarding-dim onboarding-dim--full" />
      )}

      <div
        ref={popoverRef}
        className="onboarding-popover"
        style={popoverStyle}
        data-placement={rect ? effectivePlacement : "none"}
        tabIndex={-1}
      >
        {rect && <span className="onboarding-arrow" aria-hidden="true" />}
        <button
          type="button"
          className="onboarding-skip"
          onClick={completeTour}
          aria-label={copy.skip}
        >
          {copy.skip}
        </button>
        <div
          className="onboarding-step-count"
          aria-label={copy.stepOf(tourStepIndex + 1, steps.length)}
        >
          {steps.map((s, i) => (
            <span
              key={s.id}
              className={`onboarding-dot ${
                i < tourStepIndex ? "done" : i === tourStepIndex ? "active" : ""
              }`}
            />
          ))}
        </div>
        <h3 className="onboarding-title">{stepCopy.title}</h3>
        <p className="onboarding-body">{renderCopyBody(stepCopy.body)}</p>
        <div className="onboarding-actions">
          <button
            type="button"
            className="onboarding-docs-link"
            onClick={() => void openExternalUrl(ONBOARDING_DOCS_URL)}
          >
            {copy.docsLink}
          </button>
          <span className="onboarding-actions-spacer" />
          {tourStepIndex > 0 && (
            <button type="button" className="btn" onClick={back}>
              {copy.back}
            </button>
          )}
          {step.advanceOn === "next" && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={isLast ? completeTour : advance}
            >
              {isLast ? copy.done : copy.next}
            </button>
          )}
          {clickable && (
            <span className="onboarding-click-hint" aria-hidden="true">
              <MousePointerClick className="onboarding-click-icon" />
              <span>{copy.clickHint}</span>
            </span>
          )}
          {step.advanceOn === "auto" && <span className="onboarding-spinner" aria-hidden="true" />}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function copyForStep(id: string, copy: ReturnType<typeof getOnboardingCopy>) {
  switch (id) {
    case "launcher-sample":
      return copy.stepLauncherSample;
    case "launcher-creating":
      return copy.stepLauncherCreating;
    case "launcher-pick":
      return copy.stepLauncherPick;
    case "workspace-sidebar":
      return copy.stepWorkspaceSidebar;
    case "workspace-expand-tables":
      return copy.stepWorkspaceExpandTables;
    case "workspace-open-table":
      return copy.stepWorkspaceOpenTable;
    case "workspace-grid":
      return copy.stepWorkspaceGrid;
    case "workspace-edit":
      return copy.stepWorkspaceEdit;
    case "workspace-toolbar":
      return copy.stepWorkspaceToolbar;
    case "workspace-sql-tab":
      return copy.stepWorkspaceSqlTab;
    case "workspace-ai":
      return copy.stepWorkspaceAi;
    default:
      return null;
  }
}

/** Position the popover beside the cutout, flipping when it would clip. */
function placePopover(
  rect: CutoutRect,
  preferred: string,
): { style: React.CSSProperties; placement: string } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = Math.min(POPOVER_W, vw - 32);
  const below = rect.top + rect.height + POPOVER_GAP;
  const above = rect.top - POPOVER_GAP;
  const right = rect.left + rect.width + POPOVER_GAP;
  const left = rect.left - POPOVER_GAP;

  const fitsBelow = below + 160 < vh;
  const fitsAbove = above - 160 > 0;
  const fitsRight = right + w < vw;
  const fitsLeft = left - w > 0;

  let top: number;
  let leftPos: number;
  let transform: string | undefined;
  let placement: string;
  const centerX = () => clamp(rect.left + rect.width / 2 - w / 2, 16, vw - w - 16);
  const centerY = () => clamp(rect.top + rect.height / 2 - 70, 16, vh - 180);

  if (preferred === "bottom" && fitsBelow) {
    top = below;
    leftPos = centerX();
    placement = "bottom";
  } else if (preferred === "top" && fitsAbove) {
    top = above;
    transform = "translateY(-100%)";
    leftPos = centerX();
    placement = "top";
  } else if (preferred === "right" && fitsRight) {
    top = centerY();
    leftPos = right;
    placement = "right";
  } else if (preferred === "left" && fitsLeft) {
    top = centerY();
    leftPos = left - w;
    placement = "left";
  } else if (fitsBelow) {
    top = below;
    leftPos = centerX();
    placement = "bottom";
  } else if (fitsAbove) {
    top = above;
    transform = "translateY(-100%)";
    leftPos = centerX();
    placement = "top";
  } else {
    top = vh / 2;
    leftPos = vw / 2 - w / 2;
    transform = "translateY(-50%)";
    placement = "none";
  }
  return { style: { position: "fixed", top, left: leftPos, width: w, transform }, placement };
}

/**
 * Render `inline code` spans inside step copy — markdown-lite for the tour
 * so identifiers don't show raw backticks.
 */
function renderCopyBody(body: string): React.ReactNode {
  const parts = body.split(/`([^`]+)`/);
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <code key={i} className="onboarding-code">
        {part}
      </code>
    ) : (
      part
    ),
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
