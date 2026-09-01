/**
 * Composer slash commands. Typing "/" at the start of the AI composer opens a
 * filterable command menu (like the reference "COMMANDS" popover); a typed
 * command plus Enter also works without the menu. Commands are zero-arg:
 * selecting one runs it immediately instead of inserting text.
 */

export interface AISlashCommand {
  /** Command name without the leading slash. */
  name: string;
  /** Localized one-line description shown in the menu. */
  description: string;
}

/** "/backup" or "/backup <ignored note>" — the command itself takes no args. */
export function isBackupCommand(text: string) {
  const trimmed = text.trim().toLowerCase();
  return trimmed === "/backup" || trimmed.startsWith("/backup ");
}

/** Filters the registry by the text typed after the leading "/". */
export function matchSlashCommands(query: string, commands: AISlashCommand[]): AISlashCommand[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return commands;
  return commands.filter((command) => command.name.toLowerCase().startsWith(normalized));
}
