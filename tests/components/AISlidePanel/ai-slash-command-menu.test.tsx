import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { AISlashCommandMenu } from "@/components/AISlidePanel/AISlashCommandMenu";
import type { AISlashCommand } from "@/components/AISlidePanel/ai-slash-commands";

const COMMANDS: AISlashCommand[] = [
  { name: "backup", description: "Checkpoint the database" },
  { name: "rollback", description: "Restore a checkpoint" },
  { name: "compact", description: "Compact this conversation" },
  { name: "explain", description: "Explain the active query" },
  { name: "indexes", description: "Propose index candidates" },
  { name: "plan", description: "Write a multi-step plan" },
];

// The real menu is a 264px scroller; here it only needs a band smaller than the
// list so that rows can fall outside it. The header is sticky, so the rows start
// below it and are laid out from the scrollport top (the menu has no top
// padding — the header owns it).
const MENU_TOP = 100;
const MENU_HEIGHT = 200;
const HEADER_HEIGHT = 30;
const ROW_HEIGHT = 40;
const LIST_PADDING_BOTTOM = 6;
const SCROLL_MIN = 0;
// Models the full 6-row list; filtering only ever shrinks it, and the bounds are
// used solely for the honest clamp a real scroll container applies.
const SCROLL_MAX = HEADER_HEIGHT + COMMANDS.length * ROW_HEIGHT + LIST_PADDING_BOTTOM - MENU_HEIGHT;

function band(top: number, height: number): DOMRect {
  return {
    top,
    bottom: top + height,
    height,
    left: 0,
    right: 0,
    width: 0,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function menuProps(overrides: Partial<React.ComponentProps<typeof AISlashCommandMenu>> = {}) {
  return {
    title: "Commands",
    emptyHint: "No matching command",
    query: "",
    commands: COMMANDS,
    activeIndex: 0,
    onSelect: () => {},
    ...overrides,
  };
}

/**
 * jsdom has no layout, so the menu is given a real scroll position and every row
 * a band that moves with it. Without this the follow-scroll effect is a no-op
 * (every rect is zero) and nothing could be asserted.
 */
function installMenuLayout(container: HTMLElement) {
  const menu = container.querySelector<HTMLElement>(".ai-slash-menu");
  const head = container.querySelector<HTMLElement>(".ai-slash-menu-head");
  if (!menu || !head) throw new Error("the slash menu did not render");
  const rows = Array.from(container.querySelectorAll<HTMLElement>(".ai-slash-menu-item"));
  let scrollTop = 0;
  // A real scroll container clamps; the header height shrinks the usable band.
  Object.defineProperty(menu, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = Math.min(Math.max(value, SCROLL_MIN), SCROLL_MAX);
    },
  });
  vi.spyOn(menu, "getBoundingClientRect").mockReturnValue(band(MENU_TOP, MENU_HEIGHT));
  // jsdom reports a zero-height viewport and header; the component measures both,
  // so they have to be real for the effect to have a band to work with.
  Object.defineProperty(menu, "clientTop", { configurable: true, get: () => 0 });
  Object.defineProperty(menu, "clientHeight", { configurable: true, get: () => MENU_HEIGHT });
  Object.defineProperty(head, "offsetHeight", { configurable: true, get: () => HEADER_HEIGHT });
  rows.forEach((row, index) => {
    vi.spyOn(row, "getBoundingClientRect").mockImplementation(() =>
      band(MENU_TOP + HEADER_HEIGHT + index * ROW_HEIGHT - scrollTop, ROW_HEIGHT),
    );
  });
  return {
    menu,
    head,
    rows,
    /** Top of the scrollport, where the sticky header pins itself. */
    scrollportTop: MENU_TOP,
    /** First pixel a row may occupy without hiding behind the header. */
    bandTop: MENU_TOP + HEADER_HEIGHT,
    bandBottom: MENU_TOP + MENU_HEIGHT,
    scrollTop: () => scrollTop,
    setScrollTop: (value: number) => {
      menu.scrollTop = value;
    },
  };
}

describe("AISlashCommandMenu", () => {
  it("renders the pinned header above the rows", () => {
    const { container } = render(<AISlashCommandMenu {...menuProps()} />);
    const menu = container.querySelector(".ai-slash-menu");

    // The header is the first child of the scroller and the element the
    // follow-scroll measures: keeping the order is what makes it stick on top.
    expect(menu?.firstElementChild).toHaveClass("ai-slash-menu-head");
    expect(screen.getByText("Commands")).toBeInTheDocument();
  });

  it("marks only the highlighted row as selected", () => {
    const { container } = render(<AISlashCommandMenu {...menuProps({ activeIndex: 1 })} />);
    const rows = Array.from(container.querySelectorAll<HTMLElement>(".ai-slash-menu-item"));

    expect(rows).toHaveLength(COMMANDS.length);
    expect(rows[1]).toHaveAttribute("aria-selected", "true");
    expect(rows[1].className).toContain("is-active");
    expect(rows[0]).toHaveAttribute("aria-selected", "false");
    expect(rows[0].className).not.toContain("is-active");
  });

  it("selects the row the pointer presses without stealing focus from the composer", () => {
    const onSelect = vi.fn();
    const { container } = render(<AISlashCommandMenu {...menuProps({ onSelect })} />);
    const row = container.querySelectorAll<HTMLElement>(".ai-slash-menu-item")[2];

    // mousedown (not click) so the textarea keeps focus; the handler must stop
    // the default focus shift itself.
    const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    row.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(onSelect).toHaveBeenCalledWith("compact");
  });

  it("shows the empty hint plus the typed query when nothing matches", () => {
    render(<AISlashCommandMenu {...menuProps({ commands: [], query: "zzz" })} />);

    expect(screen.getByText("No matching command")).toBeInTheDocument();
    expect(screen.getByText("/zzz")).toBeInTheDocument();
  });

  it("scrolls itself so the highlight stays visible when the arrows walk past the end", () => {
    const { container, rerender } = render(
      <AISlashCommandMenu {...menuProps({ activeIndex: 0 })} />,
    );
    const layout = installMenuLayout(container);

    // Row 5 sits below the menu's bottom edge before the move: only the
    // follow-scroll can bring it into view (the rows never take focus, so the
    // browser's own "scroll the focused element into view" never fires).
    rerender(<AISlashCommandMenu {...menuProps({ activeIndex: 5 })} />);

    const activeRow = layout.rows[5].getBoundingClientRect();
    expect(layout.scrollTop()).toBe(HEADER_HEIGHT + ROW_HEIGHT);
    expect(activeRow.bottom).toBeLessThanOrEqual(layout.bandBottom);
    expect(activeRow.top).toBeGreaterThanOrEqual(layout.bandTop);
  });

  it("scrolls back up when the highlight returns to the first row", () => {
    const { container, rerender } = render(
      <AISlashCommandMenu {...menuProps({ activeIndex: 5 })} />,
    );
    const layout = installMenuLayout(container);
    layout.setScrollTop(HEADER_HEIGHT + ROW_HEIGHT);

    rerender(<AISlashCommandMenu {...menuProps({ activeIndex: 0 })} />);

    // The first row is home, but the header already covers the scrollport top:
    // it has to stop under the header, not at the very top of the box.
    const activeRow = layout.rows[0].getBoundingClientRect();
    expect(layout.scrollTop()).toBe(0);
    expect(activeRow.top).toBe(layout.bandTop);
  });

  it("parks the highlight below the sticky header, not under it", () => {
    const { container, rerender } = render(
      <AISlashCommandMenu {...menuProps({ activeIndex: 0 })} />,
    );
    const layout = installMenuLayout(container);
    layout.setScrollTop(60);

    // ArrowDown onto row 1 while the list is scrolled: the row spans 110..150,
    // inside the scrollport (100..300) but its top 30px sit behind the header
    // (100..130), so the list gives back 20px. Reading the scrollport alone would
    // have called this row perfectly visible.
    rerender(<AISlashCommandMenu {...menuProps({ activeIndex: 1 })} />);

    expect(layout.scrollTop()).toBe(40);
    expect(layout.rows[1].getBoundingClientRect().top).toBe(layout.bandTop);
  });

  it("keeps the wheel position while the highlight is already inside the menu", () => {
    const { container, rerender } = render(
      <AISlashCommandMenu {...menuProps({ activeIndex: 2 })} />,
    );
    const layout = installMenuLayout(container);
    layout.setScrollTop(60);
    const before = layout.scrollTop();

    // Row 3 spans 190..230 inside the 130..300 band: no scrolling is needed, so
    // nothing may move.
    rerender(<AISlashCommandMenu {...menuProps({ activeIndex: 3 })} />);

    expect(layout.scrollTop()).toBe(before);
  });

  it("returns to the top when filtering shrinks the list under the same index", () => {
    const { container, rerender } = render(
      <AISlashCommandMenu {...menuProps({ activeIndex: 0 })} />,
    );
    const layout = installMenuLayout(container);
    layout.setScrollTop(60);

    // The index is still 0, so only the row list itself can trigger the follow.
    rerender(<AISlashCommandMenu {...menuProps({ activeIndex: 0, commands: [COMMANDS[0]] })} />);

    expect(container.querySelectorAll(".ai-slash-menu-item")).toHaveLength(1);
    expect(layout.scrollTop()).toBe(0);
    expect(layout.rows[0].getBoundingClientRect().top).toBe(layout.bandTop);
  });

  it("leaves the wheel position alone on an unrelated re-render", () => {
    const { container, rerender } = render(
      <AISlashCommandMenu {...menuProps({ activeIndex: 5 })} />,
    );
    const layout = installMenuLayout(container);
    // Scrolled 10px short of the row that would be needed: only an effect that
    // fires on array identity would move it.
    layout.setScrollTop(60);

    // Same rows in a freshly built array (the panel rebuilds `commands` every
    // render) and the same highlight: the user's own scroll must be left alone
    // even though the highlighted row is outside the band.
    rerender(<AISlashCommandMenu {...menuProps({ activeIndex: 5, commands: [...COMMANDS] })} />);

    expect(layout.scrollTop()).toBe(60);
  });
});
