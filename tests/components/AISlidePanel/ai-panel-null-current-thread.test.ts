import { describe, expect, it } from "vitest";
import compactSource from "@/components/AISlidePanel/hooks/use-ai-compact-context.ts?raw";

describe("AISlidePanel render safety pin (currentThread can be null)", () => {
  // Regression pin for the 2026-09-09 crash: opening the AI panel in a
  // workspace whose persisted history contains no thread for the current key
  // crashed the whole workspace ("Cannot read properties of null (reading
  // 'id')"). currentThread is `?? workspaceThreads[0] ?? null`, and the
  // handleCompactContext deps array dereferenced currentThread.id /
  // currentThread.label at RENDER time — dep arrays evaluate during render,
  // so a null thread blew up before any guard inside the callback could run.
  // The handler now lives in use-ai-compact-context.ts; the pin follows it.
  it("compact callback deps array never dereferences a null currentThread", () => {
    // Prettier owns the layout of this array (it reflows it to one entry per
    // line once the array is multi-line), so compare whitespace-insensitively:
    // the pin is *which expressions* reach the deps array, not how they wrap.
    // Collapsing whitespace keeps both directions of the assertion meaningful,
    // including a dereference split across lines.
    const flattened = compactSource.replace(/\s+/g, " ");
    expect(flattened).toContain("currentThread?.id, currentThread?.label, currentWorkspaceKey");
    expect(flattened).not.toContain("currentThread.id, currentThread.label, currentWorkspaceKey");
  });
});
