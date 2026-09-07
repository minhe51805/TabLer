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
 * Purely presentational — keyboard navigation lives in the panel's composer
 * keydown handler so Enter-to-run and Enter-to-send never race.
 */
export function AISlashCommandMenu({
  title,
  emptyHint,
  query,
  commands,
  activeIndex,
  onSelect,
}: AISlashCommandMenuProps) {
  return (
    <div className="ai-slash-menu" role="listbox" aria-label={title}>
      <div className="ai-slash-menu-head">{title}</div>
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
