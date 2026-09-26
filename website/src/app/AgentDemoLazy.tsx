"use client";

import dynamic from "next/dynamic";

/**
 * The agent demo is an 17KB client island far below the fold — the live
 * trace only starts once its IntersectionObserver fires anyway. Loading
 * it client-side-only keeps its code (AgentDemo + bits.tsx) out of the
 * initial script payload entirely.
 */
export const AgentDemoLazy = dynamic(() => import("./AgentDemo").then((m) => m.AgentDemo), {
  ssr: false,
});
