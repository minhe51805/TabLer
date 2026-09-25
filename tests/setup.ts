import "@testing-library/jest-dom";

// jsdom lacks ResizeObserver — minimal stub so components that measure
// (grid, tour overlay, …) can mount in tests.
if (typeof globalThis.ResizeObserver === "undefined") {
  class TestResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
}

// jsdom lacks scrollIntoView — a no-op keeps the tour's scroll step safe.
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}
