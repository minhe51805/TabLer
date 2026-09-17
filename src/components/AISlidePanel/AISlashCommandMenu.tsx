import { useEffect, useRef } from "react";

import "../../styles/ai-slash-menu.css";
import type { AISlashCommand } from "./ai-slash-commands";

interface AISlashCommandMenuProps {
  title: string;
  emptyHint: string;
  /** Text typed after the leading "/" — shown as the search echo. */
  query: string;
  commands: AISlashCommand[];
  activeIndex: number;
  onSelect: (name: string) => void;
}

/**
 * COMMANDS popover above the AI composer (reference: Claude Code style).
 * Presentational apart from one piece of state the panel cannot own: keeping the
 * highlighted row inside the menu's own scroller. Keyboard navigation itself
 * lives in the panel's composer keydown handler, where Enter-to-pick and
 * Enter-to-send can be told apart — picking only parks the command in the
 * composer, so a second Enter is what runs it.
 */
export function AISlashCommandMenu({
  title,
  emptyHint,
  query,
  commands,
  activeIndex,
  onSelect,
}: AISlashCommandMenuProps) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const headRef = useRef<HTMLDivElement | null>(null);
  // Filtered by name, not by array identity: the panel rebuilds `commands` on
  // every render, and the follow-scroll must run when the highlight or the
  // visible set changes — never on an unrelated re-render, which would yank the
  // user's own wheel position back.
  const commandKey = commands.map((command) => command.name).join("\n");

  /**
   * Keeps the highlighted command inside the menu's own scroll area
   * (`.ai-slash-menu` is the 264px-tall scroller). The rows are buttons but
   * never take focus — `mousedown` is prevented so the composer keeps it — so
   * the browser's "scroll the focused element into view" never fires and the
   * highlight would otherwise walk out of the window while the list stayed put.
   *
   * The menu scrolls itself instead of calling `scrollIntoView`, which also
   * scrolls whichever ancestors it deems out of view and would move the
   * conversation the user is reading.
   */
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const active = list.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!active) return;
    const listRect = list.getBoundingClientRect();
    // The band the browser scrolls against: the menu's padding box, i.e. its
    // border box minus the 1px border (`clientTop`/`clientHeight`). Aligning to
    // the border box instead would park the row 1px under the border.
    const scrollportTop = listRect.top + list.clientTop;
    const scrollportBottom = scrollportTop + list.clientHeight;
    // The title is sticky, so the usable band starts under it: a row aligned with
    // the scrollport top would be hidden behind the header.
    const bandTop = scrollportTop + (headRef.current?.offsetHeight ?? 0);
    const activeRect = active.getBoundingClientRect();
    if (activeRect.top < bandTop) {
      list.scrollTop -= bandTop - activeRect.top;
    } else if (activeRect.bottom > scrollportBottom) {
      list.scrollTop += activeRect.bottom - scrollportBottom;
    }
  }, [activeIndex, commandKey]);

  return (
    <div className="ai-slash-menu" role="listbox" aria-label={title} ref={listRef}>
      <div className="ai-slash-menu-head" ref={headRef}>
        {title}
      </div>
      {commands.length === 0 ? (
        <div className="ai-slash-menu-empty">
          {emptyHint}
          {query.trim() ? <span className="ai-slash-menu-query"> /{query.trim()}</span> : null}
        </div>
      ) : (
        commands.map((command, index) => (
          <button
            key={command.name}
            type="button"
            role="option"
            aria-selected={index === activeIndex}
            className={`ai-slash-menu-item ${index === activeIndex ? "is-active" : ""}`}
            // mousedown so the textarea keeps focus and the composer keydown
            // flow stays uninterrupted.
            onMouseDown={(event) => {
              event.preventDefault();
              onSelect(command.name);
            }}
          >
            <span className="ai-slash-menu-name">/{command.name}</span>
            <span className="ai-slash-menu-description">{command.description}</span>
          </button>
        ))
      )}
    </div>
  );
}
