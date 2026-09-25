// Smoke: the onboarding tour walks the launcher → workspace funnel.
// Covers: click-through on the sample CTA, auto-advance on connection,
// missing-target skip, Skip/Esc completing, and the workspace step list
// finishing on "Done".
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

import { OnboardingTour } from "../../src/components/OnboardingTour/OnboardingTour";
import { useConnectionStore } from "../../src/stores/connectionStore";
import { useOnboardingStore } from "../../src/stores/onboarding-store";

function seedLauncherDom() {
  document.body.innerHTML = `
    <div id="app">
      <button data-tour="startup-sample-db">Try the sample data</button>
    </div>
  `;
}

function seedWorkspaceDom() {
  document.body.innerHTML = `
    <div id="app">
      <div data-tour="sidebar-tree">
        <div data-testid="table-main-customers">customers</div>
      </div>
      <div data-testid="data-grid"><div class="cell">cell</div></div>
      <div data-tour="grid-toolbar">toolbar</div>
      <button data-tour="new-query">+</button>
      <button data-tour="ai-trigger">AI</button>
    </div>
  `;
}

describe("OnboardingTour", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    useOnboardingStore.setState({
      hasCompletedTour: false,
      tourPhase: "launcher",
      tourStepIndex: 0,
    });
    useConnectionStore.setState({ activeConnectionId: null } as never);
  });

  it("renders the launcher step on the sample CTA", () => {
    seedLauncherDom();
    render(<OnboardingTour />);
    expect(screen.getByText("Start with the sample data")).toBeTruthy();
    expect(screen.getByLabelText("1 / 3")).toBeTruthy();
  });

  it("clicking the sample CTA advances to the creating step", () => {
    seedLauncherDom();
    render(<OnboardingTour />);
    fireEvent.click(document.querySelector('[data-tour="startup-sample-db"]')!);
    expect(useOnboardingStore.getState().tourStepIndex).toBe(1);
    expect(screen.getByText(/setting up/i)).toBeTruthy();
  });

  it("auto-advances to the workspace phase once a connection lands", () => {
    seedLauncherDom();
    render(<OnboardingTour />);
    fireEvent.click(document.querySelector('[data-tour="startup-sample-db"]')!);
    act(() => {
      useConnectionStore.setState({ activeConnectionId: "conn-1" } as never);
    });
    expect(useOnboardingStore.getState().tourPhase).toBe("workspace");
  });

  it("jumps straight to the workspace when a connection already exists", () => {
    useConnectionStore.setState({ activeConnectionId: "conn-1" } as never);
    seedWorkspaceDom();
    render(<OnboardingTour />);
    expect(useOnboardingStore.getState().tourPhase).toBe("workspace");
    expect(screen.getByText(/tables live here/i)).toBeTruthy();
  });

  it("skip completes the tour", () => {
    seedLauncherDom();
    render(<OnboardingTour />);
    fireEvent.click(screen.getByRole("button", { name: /skip/i }));
    expect(useOnboardingStore.getState().hasCompletedTour).toBe(true);
  });

  it("Escape completes the tour", () => {
    seedLauncherDom();
    render(<OnboardingTour />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useOnboardingStore.getState().hasCompletedTour).toBe(true);
  });

  it("walks the full workspace phase to Done", () => {
    useConnectionStore.setState({ activeConnectionId: "conn-1" } as never);
    seedWorkspaceDom();
    render(<OnboardingTour />);
    // B1 sidebar → Next
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    // B2 open table → click the customers row
    fireEvent.click(document.querySelector('[data-testid$="-customers"]')!);
    // B3 grid, B4 edit, B5 toolbar, B6 sql tab → Next ×4
    for (let i = 0; i < 4; i++) {
      fireEvent.click(screen.getByRole("button", { name: /next/i }));
    }
    // B7 ai → click the trigger
    fireEvent.click(document.querySelector('[data-tour="ai-trigger"]')!);
    expect(useOnboardingStore.getState().hasCompletedTour).toBe(true);
  });

  it("a missing target skips the step instead of stalling", () => {
    useConnectionStore.setState({ activeConnectionId: "conn-1" } as never);
    // Only the sidebar exists — the customers row never mounts.
    document.body.innerHTML = `<div data-tour="sidebar-tree"></div>`;
    // Fake timers must be on before the step mounts — the skip timeout is
    // scheduled in the step effect, not at click time.
    vi.useFakeTimers();
    render(<OnboardingTour />);
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    // workspace-open-table's target never appears → timeout auto-skips to grid.
    act(() => {
      vi.advanceTimersByTime(6000);
    });
    vi.useRealTimers();
    expect(useOnboardingStore.getState().tourStepIndex).toBe(2);
  });
});
