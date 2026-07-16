import { act, useCallback, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";

import { useWindowMenuDismiss } from "@/hooks/useWindowMenuDismiss";

describe("useWindowMenuDismiss", () => {
  it("dismisses an open menu on Escape", () => {
    const container = document.createElement("div");
    const root = createRoot(container);

    function Harness() {
      const [open, setOpen] = useState(true);
      const menuRef = useRef<HTMLDivElement>(null);
      const dismiss = useCallback(() => setOpen(false), []);
      useWindowMenuDismiss(open, menuRef, dismiss);
      return <div ref={menuRef}>{String(open)}</div>;
    }

    act(() => root.render(<Harness />));
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(container.textContent).toBe("false");
    act(() => root.unmount());
  });
});
