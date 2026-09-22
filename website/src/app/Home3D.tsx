"use client";

import { useEffect, useRef, type ReactNode } from "react";

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

/**
 * Scroll-reveal: observes every section inside .neu and adds
 * .is-revealed when it enters the viewport — no JSX wrapping needed.
 * Renders nothing.
 */
export function ScrollReveal() {
  useEffect(() => {
    const sections = document.querySelectorAll<HTMLElement>(".neu section, .neu .signal-strip");
    if (sections.length === 0) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      sections.forEach((el) => el.classList.add("is-revealed"));
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-revealed");
            observer.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.1, rootMargin: "0px 0px -6% 0px" },
    );
    sections.forEach((el) => {
      el.classList.add("reveal-pending");
      observer.observe(el);
    });
    return () => observer.disconnect();
  }, []);

  return null;
}

/**
 * Scrollytelling hero: the hero section is 220vh tall with a sticky 100vh
 * stage. Scrolling the first ~1.2 viewports drives progress p in [0,1]:
 *   - hero copy fades/rises away (done by ~60%)
 *   - the product frame reveals its full image and scales up until it
 *     covers the viewport — only then does the page scroll on
 *   - the floating header pill docks to the bottom of the viewport and the
 *     nav labels collapse into icons as soon as scrolling starts
 * Disabled for reduced-motion: the tall-hero CSS is gated behind .fx-on.
 */
export function HeroScrollFX() {
  useEffect(() => {
    const hero = document.querySelector<HTMLElement>(".neu .hero");
    const copy = document.querySelector<HTMLElement>(".neu .hero-copy");
    const media = document.querySelector<HTMLElement>(".neu .hero-media-wrap");
    const frame = document.querySelector<HTMLElement>(".neu .product-frame-hero");
    const header = document.querySelector<HTMLElement>(".neu .site-header");
    if (!hero || !copy || !media || !frame || !header) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    hero.classList.add("fx-on");
    frame.style.maxHeight = "none";

    let raf = 0;
    const update = () => {
      raf = 0;
      const range = hero.offsetHeight - window.innerHeight;
      const p = range > 0 ? Math.min(1, Math.max(0, window.scrollY / range)) : 0;

      // copy fades out and drifts up, gone by ~60% of the range
      const fade = Math.min(1, p * 1.7);
      copy.style.opacity = String(1 - fade);
      copy.style.transform = `translateY(${(-p * 70).toFixed(1)}px)`;
      copy.style.pointerEvents = fade >= 1 ? "none" : "";

      // frame scales until it fills the viewport (contain — full image stays
      // visible, never cropped), centered in the viewport minus a 6rem gap
      // reserved at the bottom
      const vw = window.innerWidth;
      const vh = window.innerHeight - 96; // 6rem bottom gap
      const fw = media.offsetWidth;
      const fh = media.offsetHeight;
      const cover = Math.min(vw / fw, vh / fh);
      const scale = 1 + (cover - 1) * p;
      const frameTop = media.offsetTop;
      const targetY = vh / 2 - (frameTop + fh / 2);
      media.style.transform = `translateY(${(p * targetY).toFixed(1)}px) scale(${scale.toFixed(4)})`;

      // header docks to bottom + nav collapses to icons on first scroll;
      // near the page end it un-docks so it rides back up with the footer
      // instead of covering it
      const nearEnd =
        window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 160;
      header.classList.toggle("is-docked", window.scrollY > 8 && !nearEnd);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  return null;
}
