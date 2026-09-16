import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

import { ProgressiveDeliveryIndicator } from "@/components/SQLEditor/ProgressiveDeliveryIndicator";
import { useQueryStore } from "@/stores/queryStore";

afterEach(() => {
  cleanup();
  useQueryStore.setState({ progressiveRowCount: null });
});

describe("ProgressiveDeliveryIndicator (Phase 3C isolated subscription)", () => {
  it("renders nothing while idle (progressiveRowCount is null)", () => {
    useQueryStore.setState({ progressiveRowCount: null });
    const { container } = render(<ProgressiveDeliveryIndicator />);
    expect(container.firstChild).toBeNull();
  });

  it("shows the live, locale-formatted row count while delivering", () => {
    useQueryStore.setState({ progressiveRowCount: 12345 });
    render(<ProgressiveDeliveryIndicator />);
    // The number is localised (grouping separators) before interpolation, so
    // compare against the same call the component makes.
    expect(screen.getByRole("status").textContent).toContain((12345).toLocaleString());
  });

  it("reflects store updates without remounting", () => {
    useQueryStore.setState({ progressiveRowCount: 100 });
    render(<ProgressiveDeliveryIndicator />);
    expect(screen.getByRole("status").textContent).toContain((100).toLocaleString());
    // The isolated subscription must repaint on a plain store update (no
    // remount), which is the entire point of the Phase 3C narrow selector.
    act(() => {
      useQueryStore.setState({ progressiveRowCount: 2500 });
    });
    expect(screen.getByRole("status").textContent).toContain((2500).toLocaleString());
  });
});
