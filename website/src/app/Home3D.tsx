"use client";

import { ChevronDown, ChevronUp } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Collapse/expand toggle for the docked right-edge nav bar. Renders a small
 * round button that hangs off the bar's top-left corner; only visible while
 * the header is docked (.is-docked). Toggling flips .is-collapsed on the
 * header, which shrinks the bar to just the logo + this button.
 */
export function DockToggle() {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    const header = document.querySelector(".site-header");
    if (!header) return;
    header.classList.toggle("is-collapsed", collapsed);
    // the bar's height changes with collapse, so the dark/light boundary
    // must be re-sampled against the new rect once the transition settles
    const id = window.setTimeout(() => window.dispatchEvent(new Event("tabler:resample")), 480);
    return () => {
      window.clearTimeout(id);
      header.classList.remove("is-collapsed");
    };
  }, [collapsed]);

  return (
    <button
      type="button"
      className="dock-toggle"
      aria-expanded={!collapsed}
      aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
      title={collapsed ? "Expand navigation" : "Collapse navigation"}
      onClick={() => setCollapsed((v) => !v)}
    >
      {collapsed ? (
        <ChevronDown size={16} strokeWidth={2.2} aria-hidden="true" />
      ) : (
        <ChevronUp size={16} strokeWidth={2.2} aria-hidden="true" />
      )}
    </button>
  );
}

/**
 * Pointer-driven 3D tilt for the hero product frame. The frame rotates a few
 * degrees toward the cursor with a springy transition; it settles back when
 * the pointer leaves. Disabled for touch / reduced-motion users.
 */
export function TiltFrame({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (window.matchMedia("(pointer: coarse)").matches) return;

    let raf = 0;
    const onMove = (event: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      const px = (event.clientX - rect.left) / rect.width - 0.5;
      const py = (event.clientY - rect.top) / rect.height - 0.5;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        el.style.transform = `rotateX(${(-py * 7).toFixed(2)}deg) rotateY(${(px * 9).toFixed(2)}deg) translateZ(0)`;
      });
    };
    const onLeave = () => {
      cancelAnimationFrame(raf);
      el.style.transform = "rotateX(0deg) rotateY(0deg)";
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerleave", onLeave);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerleave", onLeave);
    };
  }, []);

  return (
    <div className="tilt-stage">
      <div ref={ref} className="tilt-frame">
        {children}
      </div>
    </div>
  );
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/**
 * Scroll effects for the page body below the hero:
 *   - section reveal: every .neu section fades/rises in on entry
 *   - stagger reveal: grid children cascade in with a per-item delay
 *   - count-up: .signal-grid strong numbers roll from 0 to their value
 *   - parallax: product frames drift ±22px against the scroll
 * All disabled under prefers-reduced-motion. Renders nothing.
 */
export function ScrollReveal() {
  useEffect(() => {
    const sections = document.querySelectorAll<HTMLElement>(".neu section, .neu .signal-strip");
    if (sections.length === 0) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      sections.forEach((el) => el.classList.add("is-revealed"));
      return;
    }

    // ---- section + stagger reveal ----
    const revealObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-revealed");
            revealObserver.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.1, rootMargin: "0px 0px -6% 0px" },
    );
    sections.forEach((el) => {
      el.classList.add("reveal-pending");
      revealObserver.observe(el);
    });

    const staggerObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const kids = Array.from(entry.target.children) as HTMLElement[];
          kids.forEach((kid, i) => {
            kid.style.transitionDelay = `${i * 70}ms`;
            kid.classList.add("is-revealed");
            // clear the delay after the cascade so hover transitions stay snappy
            window.setTimeout(
              () => {
                kid.style.transitionDelay = "";
              },
              i * 70 + 800,
            );
          });
          staggerObserver.unobserve(entry.target);
        }
      },
      { threshold: 0.15 },
    );
    document
      .querySelectorAll<HTMLElement>(
        ".neu .feature-grid, .neu .engine-grid, .neu .architecture-list, .neu .signal-grid",
      )
      .forEach((grid) => {
        Array.from(grid.children).forEach((kid) => kid.classList.add("reveal-pending"));
        staggerObserver.observe(grid);
      });

    // ---- count-up for numeric stats ----
    const counters = Array.from(
      document.querySelectorAll<HTMLElement>(".neu .signal-grid strong"),
    ).filter((el) => /^\d+$/.test(el.textContent?.trim() ?? ""));
    const counterObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const el = entry.target as HTMLElement;
          const target = Number(el.textContent);
          const start = performance.now();
          const tick = (now: number) => {
            const t = clamp01((now - start) / 900);
            el.textContent = String(Math.round(target * (1 - Math.pow(1 - t, 3))));
            if (t < 1) requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
          counterObserver.unobserve(el);
        }
      },
      { threshold: 0.6 },
    );
    counters.forEach((el) => counterObserver.observe(el));

    // ---- parallax on product frames ----
    const parallaxEls = Array.from(
      document.querySelectorAll<HTMLElement>(".neu .workflow-frame, .neu .erd-frame"),
    );
    let raf = 0;
    const parallax = () => {
      raf = 0;
      const vh = window.innerHeight;
      for (const el of parallaxEls) {
        const rect = el.getBoundingClientRect();
        if (rect.bottom < -80 || rect.top > vh + 80) continue;
        const progress = clamp01((vh - rect.top) / (vh + rect.height));
        el.style.transform = `translateY(${((0.5 - progress) * 44).toFixed(1)}px)`;
      }
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(parallax);
    };
    if (parallaxEls.length) {
      parallax();
      window.addEventListener("scroll", onScroll, { passive: true });
      window.addEventListener("resize", onScroll);
    }

    return () => {
      revealObserver.disconnect();
      staggerObserver.disconnect();
      counterObserver.disconnect();
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  return null;
}

type HeroPhase = { eyebrow: string; title: string; copy: string };

/**
 * Scrollytelling hero — a pinned stage telling the product story over a
 * 460vh scroll track (Apple-style scrub, DOM transforms only):
 *   1. hero copy fades/rises away (done by ~14%)
 *   2. the product frame opens like a laptop lid (rotateX 58° → 0°) and
 *      lifts to center stage by ~30%
 *   3. pinned scrub: three workflow phases (CONNECT → QUERY → UNDERSTAND)
 *      crossfade inside the frame while a caption + connector line + dots
 *      track the active phase (30% – 80%)
 *   4. the screen spins away (rotateX → -55°) revealing the engines grid
 * The floating header pill docks to the bottom of the viewport and the nav
 * labels collapse into icons as soon as scrolling starts.
 * Disabled for reduced-motion: the tall-hero CSS is gated behind .fx-on.
 */
export function HeroScrollFX({ phases }: { phases: HeroPhase[] }) {
  useEffect(() => {
    const hero = document.querySelector<HTMLElement>(".neu .hero");
    const copy = document.querySelector<HTMLElement>(".neu .hero-copy");
    const media = document.querySelector<HTMLElement>(".neu .hero-media-wrap");
    const frame = document.querySelector<HTMLElement>(".neu .product-frame-hero");
    const base = document.querySelector<HTMLElement>(".neu .laptop-base");
    const reveal = document.querySelector<HTMLElement>(".neu .hero-reveal");
    const header = document.querySelector<HTMLElement>(".neu .site-header");
    const caption = document.querySelector<HTMLElement>(".neu .hero-phase-caption");
    const line = document.querySelector<HTMLElement>(".neu .hero-phase-line");
    const dots = document.querySelector<HTMLElement>(".neu .hero-phase-dots");
    const frameTitle = document.querySelector<HTMLElement>(".neu .frame-title");
    const images = Array.from(document.querySelectorAll<HTMLElement>(".neu .hero-phase-image"));
    if (!hero || !copy || !media || !frame || !header) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    hero.classList.add("fx-on");
    frame.style.maxHeight = "none";

    const capEyebrow = caption?.querySelector<HTMLElement>(".hero-phase-eyebrow");
    const capTitle = caption?.querySelector<HTMLElement>(".hero-phase-title");
    const capCopy = caption?.querySelector<HTMLElement>(".hero-phase-copy");
    const dotEls = dots ? Array.from(dots.querySelectorAll("span")) : [];
    const titles = [
      "ant_language / Connection launcher",
      "ant_language / Query workspace",
      "ant_language / AI workspace",
    ];

    // layout metrics cached on resize — update() never forces reflow
    let range = 0;
    let liftTarget = 0;
    let shiftTarget = 0;
    const measure = () => {
      range = hero.offsetHeight - window.innerHeight;
      const mediaTop = media.offsetTop;
      const mediaHeight = media.offsetHeight;
      liftTarget = window.innerHeight * 0.55 - (mediaTop + mediaHeight / 2);
      shiftTarget = window.innerWidth > 980 ? 90 : 0;
    };
    measure();
    const easeInOut = (x: number) => x * x * (3 - 2 * x);
    // trapezoid window: caption fades in over the first 15% of a segment,
    // holds, then fades out over the last 15%
    const bell = (x: number) => clamp01(Math.min(x / 0.15, (1 - x) / 0.15));

    let phaseIndex = -1;
    let raf = 0;
    const update = () => {
      raf = 0;
      const p = range > 0 ? clamp01(window.scrollY / range) : 0;

      // beat 1 — copy fades out and drifts up, gone by ~14%
      const fade = clamp01(p * 7);
      copy.style.opacity = String(1 - fade);
      copy.style.transform = `translateY(${(-p * 120).toFixed(1)}px)`;
      copy.style.pointerEvents = fade >= 1 ? "none" : "";

      // beat 2 — laptop lid opens across p ∈ [0, 0.3], frame lifts + shifts
      const lid = easeInOut(clamp01(p / 0.3));
      // beat 4 — screen spins away across p ∈ [0.82, 0.98]
      const spin = easeInOut(clamp01((p - 0.82) / 0.16));
      const rotate = 58 * (1 - lid) - 55 * spin;
      const scale = 0.96 + 0.04 * lid - 0.08 * spin;
      const lift = lid * liftTarget;
      const shift = lid * shiftTarget;
      media.style.opacity = String(1 - spin);
      media.style.transform =
        `translate(${shift.toFixed(1)}px, ${lift.toFixed(1)}px) ` +
        `rotateX(${rotate.toFixed(2)}deg) scale(${scale.toFixed(4)})`;
      media.style.pointerEvents = spin > 0 ? "none" : "";
      if (base) {
        base.style.opacity = String(Math.max(0, 1 - spin * 1.6));
        base.style.transform = `translate(${shift.toFixed(1)}px, ${lift.toFixed(1)}px)`;
      }

      // beat 3 — pinned phase scrub across p ∈ [0.3, 0.8]
      const phaseP = clamp01((p - 0.3) / 0.5);
      const seg = Math.min(2, Math.floor(phaseP * 3));
      const segP = phaseP * 3 - seg;
      const capW = phaseP <= 0 || phaseP >= 1 ? 0 : bell(segP);
      const capO = capW * (1 - spin);

      if (caption && capEyebrow && capTitle && capCopy && phases.length === 3) {
        if (seg !== phaseIndex) {
          phaseIndex = seg;
          capEyebrow.textContent = phases[seg].eyebrow;
          capTitle.textContent = phases[seg].title;
          capCopy.textContent = phases[seg].copy;
          if (frameTitle) frameTitle.textContent = titles[seg];
        }
        caption.style.opacity = capO.toFixed(3);
        caption.style.setProperty("--cap-drift", `${((1 - capW) * 26).toFixed(1)}px`);
      }
      if (line) {
        line.style.opacity = capO.toFixed(3);
        line.style.transform = `scaleX(${capW.toFixed(3)})`;
      }
      if (dots) {
        dots.style.opacity = String(clamp01(phaseP * 8) * (1 - spin));
        dotEls.forEach((dot, i) => dot.classList.toggle("is-active", i === seg));
      }
      // crossfade the screenshot inside the frame — image i fades IN as the
      // scrub crosses into its phase; image 0 is the base layer
      images.forEach((img, i) => {
        if (i === 0) return;
        img.style.opacity = String(easeInOut(clamp01((phaseP * 3 - i) / 0.3)));
      });
      // engines reveal: fades/scales in only once the screen has left
      if (reveal) {
        const r = easeInOut(clamp01((p - 0.9) / 0.1));
        reveal.style.opacity = String(r);
        reveal.style.transform = `translate(-50%, -50%) scale(${(0.92 + 0.08 * r).toFixed(4)})`;
      }

      // header docks to the right edge + nav collapses to icons on first
      // scroll; near the page end it un-docks so it rides back up with the
      // footer
      const nearEnd =
        window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 160;
      const docked = window.scrollY > 8 && !nearEnd;
      header.classList.toggle("is-docked", docked);

      // adaptive bar color: find where the dark/light boundary crosses the
      // bar and expose it as --dock-dark (0..1 from the top) so the bar's
      // background splits exactly at the section edge — dark below the
      // boundary, light above
      if (docked) {
        const inner = header.querySelector<HTMLElement>(".header-inner");
        if (inner) {
          const rect = inner.getBoundingClientRect();
          const cx = Math.round(rect.left + rect.width / 2);
          // split a CSS list on top-level commas only (rgb() has commas)
          const splitTop = (s: string) => {
            const parts: string[] = [];
            let depth = 0;
            let cur = "";
            for (const ch of s) {
              if (ch === "(") depth++;
              else if (ch === ")") depth--;
              if (ch === "," && depth === 0) {
                parts.push(cur);
                cur = "";
              } else cur += ch;
            }
            parts.push(cur);
            return parts.map((p) => p.trim());
          };
          const parseRgb = (s: string): [number, number, number] | null => {
            const m = s.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
            return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
          };
          // effective background color of el at viewport point (px, py):
          // the topmost background layer wins - a linear-gradient is
          // interpolated at the point's projection on the gradient axis,
          // otherwise the opaque backgroundColor is used
          const colorAt = (
            el: HTMLElement,
            px: number,
            py: number,
          ): [number, number, number] | null => {
            const cs = getComputedStyle(el);
            const layer = splitTop(cs.backgroundImage)[0] ?? "";
            const grad = layer.match(/linear-gradient\((.*)\)$/);
            if (grad) {
              const parts = splitTop(grad[1]);
              let angle = 180;
              let stopStart = 0;
              const dir = parts[0];
              if (/deg\)?$/.test(dir)) {
                angle = parseFloat(dir);
                stopStart = 1;
              } else if (/^to /.test(dir)) {
                angle = dir.includes("bottom")
                  ? 180
                  : dir.includes("top")
                    ? 0
                    : dir.includes("right")
                      ? 90
                      : 270;
                stopStart = 1;
              }
              const stops = parts
                .slice(stopStart)
                .map((p) => {
                  const c = parseRgb(p);
                  const pm = p.match(/([\d.]+)%\s*$/);
                  return { c, pos: pm ? Number(pm[1]) / 100 : null };
                })
                .filter(
                  (s): s is { c: [number, number, number]; pos: number | null } => s.c !== null,
                );
              if (stops.length >= 2) {
                const r = el.getBoundingClientRect();
                const rad = (angle * Math.PI) / 180;
                const dx = Math.sin(rad);
                const dy = -Math.cos(rad);
                const len = Math.abs(r.width * dx) + Math.abs(r.height * dy);
                const s = (px - r.left - r.width / 2) * dx + (py - r.top - r.height / 2) * dy;
                const t = len > 0 ? Math.min(1, Math.max(0, 0.5 + s / len)) : 0.5;
                const n = stops.length;
                const pos = stops.map((st, i) => st.pos ?? i / (n - 1));
                let i = 0;
                while (i < n - 2 && t > pos[i + 1]) i++;
                const span = pos[i + 1] - pos[i] || 1;
                const k = Math.min(1, Math.max(0, (t - pos[i]) / span));
                const a = stops[i].c;
                const b = stops[i + 1].c;
                return [
                  a[0] + (b[0] - a[0]) * k,
                  a[1] + (b[1] - a[1]) * k,
                  a[2] + (b[2] - a[2]) * k,
                ];
              }
            }
            const m = cs.backgroundColor.match(/rgba?\(([^)]*)\)/);
            if (m) {
              const nums = m[1].split(/[,\s/]+/).filter(Boolean);
              const aRaw = nums[3];
              const alpha =
                aRaw === undefined ? 1 : aRaw.endsWith("%") ? parseFloat(aRaw) / 100 : Number(aRaw);
              if (alpha > 0.5) return [Number(nums[0]), Number(nums[1]), Number(nums[2])];
            }
            return null;
          };
          const isDarkAt = (cy: number) => {
            for (const el of document.elementsFromPoint(cx, cy)) {
              if (el === header || header.contains(el)) continue;
              let node: HTMLElement | null = el as HTMLElement;
              while (node && node !== document.documentElement) {
                const c = colorAt(node, cx, cy);
                if (c) {
                  const lum = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
                  return lum < 110;
                }
                node = node.parentElement;
              }
              break;
            }
            return false;
          };
          // binary-search the boundary between the bar's top and bottom
          let lo = rect.top;
          let hi = rect.bottom;
          const topDark = isDarkAt(Math.round(lo + 1));
          const botDark = isDarkAt(Math.round(hi - 1));
          // --dock-light = fraction of the bar (from the top) that stays
          // light; the rest renders dark
          let frac: number;
          if (topDark && botDark) {
            frac = 0;
          } else if (!topDark && !botDark) {
            frac = 1;
          } else {
            for (let i = 0; i < 8; i++) {
              const mid = (lo + hi) / 2;
              if (isDarkAt(Math.round(mid)) === topDark) lo = mid;
              else hi = mid;
            }
            frac = topDark
              ? (rect.bottom - hi) / rect.height // dark above, light below
              : (hi - rect.top) / rect.height; // light above, dark below
          }
          // a thin sliver of the opposite color reads as a stray line inside
          // the bar, not a split - snap to solid when the minority side is
          // under ~14px regardless of bar size
          if (Math.min(frac, 1 - frac) * rect.height < 14) {
            frac = frac < 0.5 ? 0 : 1;
          }
          header.style.setProperty("--dock-light", frac.toFixed(3));
          // hard edge at the snapped extremes, soft 6px blend mid-split -
          // keeps the gradient always on so there is no background-image
          // swap (which flashes) when the bar crosses a boundary
          header.style.setProperty("--dock-band", frac === 0 || frac === 1 ? "0px" : "3px");
          // flip the gradient's stop order when the dark region sits above
          // the light one (bar crossing the bottom edge of a dark section)
          header.classList.toggle("dock-flip", topDark !== botDark && topDark);
          // hysteresis: only flip the icon theme once the bar is clearly
          // mostly one tone, so it doesn't chatter near the midpoint
          if (frac < 0.35) header.classList.add("on-dark");
          else if (frac > 0.65) header.classList.remove("on-dark");
        }
      } else {
        header.classList.remove("on-dark", "dock-flip", "dock-solid-light", "dock-solid-dark");
      }
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    const onResize = () => {
      measure();
      onScroll();
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize);
    // collapse/expand changes the bar's height, so the dark/light boundary
    // must be re-sampled; DockToggle fires this after the transition and we
    // run update() directly (not via rAF, which can be throttled away)
    window.addEventListener("tabler:resample", update);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("tabler:resample", update);
    };
  }, [phases]);

  return null;
}
