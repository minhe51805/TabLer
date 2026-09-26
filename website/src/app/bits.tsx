"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Minimal dependency-free ports of reactbits.dev text effects —
 * same spirit (drop-in, no library), adapted to this site's design tokens.
 */

/**
 * TextType — types `text` out character by character with a blinking
 * caret. `speed` is ms per character; `variable` adds a human jitter.
 * Calls `onDone` once the full text is on screen.
 */
export function TextType({
  text,
  speed = 26,
  variable = 14,
  className,
  caretClassName = "type-caret",
  showCaret = true,
  onDone,
}: {
  text: string;
  speed?: number;
  /** extra random ms jitter per char for a human cadence */
  variable?: number;
  className?: string;
  caretClassName?: string;
  showCaret?: boolean;
  onDone?: () => void;
}) {
  const [count, setCount] = useState(0);
  const doneRef = useRef(false);

  useEffect(() => {
    if (count >= text.length) {
      if (!doneRef.current) {
        doneRef.current = true;
        onDone?.();
      }
      return;
    }
    const t = setTimeout(
      () => setCount((n) => n + 1),
      speed + (variable ? Math.random() * variable : 0),
    );
    return () => clearTimeout(t);
  }, [count, text, speed, variable, onDone]);

  return (
    <span className={className} aria-label={text}>
      <span aria-hidden="true">{text.slice(0, count)}</span>
      {showCaret && count < text.length && <span className={caretClassName} aria-hidden="true" />}
      <span className="sr-only">{text}</span>
    </span>
  );
}

const GLYPHS = "!<>-_\\/[]{}—=+*^?#01";

/**
 * DecryptedText — reactbits' scramble reveal: characters cycle through
 * random glyphs, locking left→right (or right→left with `rtl`). Pure
 * interval logic — no animation library.
 */
export function DecryptedText({
  text,
  duration = 600,
  className,
  rtl = false,
}: {
  text: string;
  /** total settle time in ms */
  duration?: number;
  className?: string;
  rtl?: boolean;
}) {
  const [out, setOut] = useState(text);

  // mount-time scramble; the parent remounts via key to replay
  useEffect(() => {
    const chars = text.split("");
    const start = performance.now();
    const id = setInterval(() => {
      const p = Math.min(1, (performance.now() - start) / duration);
      const locked = Math.floor(p * chars.length);
      setOut(
        chars
          .map((ch, i) => {
            const settled = rtl ? i >= chars.length - locked : i < locked;
            if (settled || ch === " ") return ch;
            return GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
          })
          .join(""),
      );
      if (p >= 1) clearInterval(id);
    }, 40);
    return () => clearInterval(id);
  }, [text, duration, rtl]);

  return (
    <span className={className} aria-label={text}>
      <span aria-hidden="true">{out}</span>
      <span className="sr-only">{text}</span>
    </span>
  );
}

/**
 * ShinyText — reactbits' gradient sweep across inline text; pure CSS,
 * just mark the element.
 */
export function ShinyText({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <span className={`shiny-text ${className}`}>{children}</span>;
}

/**
 * CountUp — reactbits' numeric tick-up: eases from 0 to `to` when
 * `start` flips true. `format` renders the value (prefix, separators).
 */
export function CountUp({
  to,
  start = true,
  duration = 900,
  format = (n: number) => `${Math.round(n)}`,
  className,
}: {
  to: number;
  start?: boolean;
  duration?: number;
  format?: (n: number) => string;
  className?: string;
}) {
  const [value, setValue] = useState(0);

  useEffect(() => {
    if (!start) return;
    const t0 = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / duration);
      setValue(to * (1 - Math.pow(1 - p, 3))); // ease-out cubic
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [start, to, duration]);

  return <span className={className}>{format(start ? value : 0)}</span>;
}

/**
 * SplitText — reactbits' staggered reveal: each character animates in
 * on its own delay. `on` re-runs the reveal when it flips true.
 */
export function SplitText({
  text,
  on = true,
  step = 24,
  className,
}: {
  text: string;
  on?: boolean;
  /** ms between characters */
  step?: number;
  className?: string;
}) {
  return (
    <span className={className} aria-label={text}>
      {text.split("").map((ch, i) => (
        <span
          aria-hidden="true"
          className={`split-char ${on ? "is-in" : ""}`}
          style={{ transitionDelay: `${i * step}ms` }}
          key={i}
        >
          {ch === " " ? " " : ch}
        </span>
      ))}
    </span>
  );
}

/**
 * Magnet — reactbits' magnetic hover: the child drifts toward the
 * pointer inside its trigger zone and springs back on leave. Used for
 * the client chip so it feels "alive" when the cursor passes.
 */
export function Magnet({
  children,
  strength = 0.4,
  radius = 70,
  className,
}: {
  children: ReactNode;
  /** fraction of the pointer offset applied to the drift */
  strength?: number;
  /** px around the element where the magnet engages */
  radius?: number;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia("(pointer: coarse)").matches) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0;
    const onMove = (event: PointerEvent) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const box = el.getBoundingClientRect();
        const cx = box.left + box.width / 2;
        const cy = box.top + box.height / 2;
        const dx = event.clientX - cx;
        const dy = event.clientY - cy;
        const dist = Math.hypot(dx, dy);
        if (dist < radius) {
          el.style.transform = `translate(${dx * strength}px, ${dy * strength}px)`;
        } else {
          el.style.transform = "";
        }
      });
    };
    const clear = () => {
      el.style.transform = "";
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerdown", clear);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerdown", clear);
    };
  }, [strength, radius]);

  return (
    <span className={`magnet ${className ?? ""}`} ref={ref}>
      {children}
    </span>
  );
}

/**
 * DotGrid — reactbits' signature canvas background: a field of dots on a
 * regular grid that swell toward the pointer with an accent tint inside
 * the glow radius. Pure canvas — no physics library; static when the
 * pointer is coarse or motion is reduced.
 */
export function DotGrid({
  className,
  spacing = 22,
  baseRadius = 1.4,
  glowRadius = 90,
  dotColor = "#9fb0c2",
  glowColor = "#0067d7",
}: {
  className?: string;
  spacing?: number;
  baseRadius?: number;
  glowRadius?: number;
  dotColor?: string;
  glowColor?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const parent = canvas.parentElement;
    if (!parent) return;

    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const coarse = typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;

    let width = 0;
    let height = 0;
    let raf = 0;
    const pointer = { x: -9999, y: -9999 };

    const hex = (c: string) => {
      const n = parseInt(c.slice(1), 16);
      return [n >> 16, (n >> 8) & 255, n & 255];
    };
    const [br, bg, bb] = hex(dotColor);
    const [gr, gg, gb] = hex(glowColor);

    const resize = () => {
      const box = parent.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      width = box.width;
      height = box.height;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw();
    };

    const draw = () => {
      ctx.clearRect(0, 0, width, height);
      for (let y = spacing / 2; y < height; y += spacing) {
        for (let x = spacing / 2; x < width; x += spacing) {
          const dist = Math.hypot(x - pointer.x, y - pointer.y);
          const influence = Math.max(0, 1 - dist / glowRadius);
          const r = baseRadius + influence * 1.6;
          const mix = influence;
          ctx.fillStyle = `rgb(${Math.round(br + (gr - br) * mix)},${Math.round(
            bg + (gg - bg) * mix,
          )},${Math.round(bb + (gb - bb) * mix)})`;
          ctx.globalAlpha = 0.35 + influence * 0.55;
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    };

    const onMove = (event: PointerEvent) => {
      const box = canvas.getBoundingClientRect();
      pointer.x = event.clientX - box.left;
      pointer.y = event.clientY - box.top;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(draw);
    };
    const onLeave = () => {
      pointer.x = -9999;
      pointer.y = -9999;
      raf = requestAnimationFrame(draw);
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(parent);
    if (!reduced && !coarse) {
      parent.addEventListener("pointermove", onMove);
      parent.addEventListener("pointerleave", onLeave);
    }
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      parent.removeEventListener("pointermove", onMove);
      parent.removeEventListener("pointerleave", onLeave);
    };
  }, [spacing, baseRadius, glowRadius, dotColor, glowColor]);

  return <canvas className={`dot-grid ${className ?? ""}`} ref={canvasRef} aria-hidden="true" />;
}
