import { describe, expect, it } from "vitest";
import panelSource from "@/components/AISlidePanel/AISlidePanel.tsx?raw";

describe("AISlidePanel render safety pin (currentThread can be null)", () => {
  // Regression pin for the 2026-09-09 crash: opening the AI panel in a
  // workspace whose persisted history contains no thread for the current key
  // crashed the whole workspace ("Cannot read properties of null (reading
  // 'id')"). currentThread is `?? workspaceThreads[0] ?? null`, and the
  // handleCompactContext deps array dereferenced currentThread.id /
  // currentThread.label at RENDER time — dep arrays evaluate during render,
  // so a null thread blew up before any guard inside the callback could run.
  it("compact callback deps array never dereferences a null currentThread", () => {
    expect(panelSource).toContain("currentThread?.id, currentThread?.label, currentWorkspaceKey");
    expect(panelSource).not.toContain("currentThread.id, currentThread.label, currentWorkspaceKey");
  });
});
