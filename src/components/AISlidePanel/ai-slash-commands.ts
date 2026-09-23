/**
 * Composer slash commands. Typing "/" at the start of the AI composer opens a
 * filterable command menu (like the reference "COMMANDS" popover); a typed
 * command plus Enter also works without the menu. Picking a command from the
 * menu inserts it into the composer instead of running it, so the user gets a
 * second look and can add arguments — the exception is `/rollback`, which is
 * its own confirmation (see `runsSlashCommandImmediately`).
 */

export interface AISlashCommand {
  /** Command name without the leading slash. */
  name: string;
  /** Localized one-line description shown in the menu. */
  description: string;
  /**
   * Small label rendered after the name (e.g. the localized "custom" badge on
   * user-authored command files). Absent on native and built-in commands.
   */
  badge?: string;
}

/** A stored DB checkpoint row (matches the Rust DatabaseCheckpoint payload). */
export interface AIDatabaseCheckpoint {
  fileName: string;
  label: string;
  createdAt: number;
  engine: string;
  database: string | null;
  tableCount: number;
  rowCount: number;
  sizeBytes: number;
}

/** "/backup [note]" — note becomes the checkpoint label (ignored by the run). */
export function isBackupCommand(text: string) {
  const trimmed = text.trim().toLowerCase();
  return trimmed === "/backup" || trimmed.startsWith("/backup ");
}

/** "/rollback" — opens the checkpoint picker to restore a previous /backup. */
export function isRollbackCommand(text: string) {
  return text.trim().toLowerCase() === "/rollback";
}

/**
 * Commands that carry their own confirmation step and therefore run the moment
 * the menu hands them over instead of landing in the composer for a second
 * Enter: `/rollback` opens the checkpoint picker, which *is* the confirmation.
 *
 * Nothing else belongs here — a command that runs work directly must never
 * bypass the composer, or the user loses the chance to add arguments.
 */
const SELF_CONFIRMING_SLASH_COMMANDS = new Set(["rollback"]);

/**
 * Whether picking `name` from the menu runs it right away.
 *
 * Every other command is parked in the composer, so `/review-sql` shows up as
 * `/review-sql` and the user runs it with an ordinary Enter through the normal
 * send path (which is what expands file-backed commands and applies the
 * native `/backup`, `/compact`, `/rollback` handling).
 */
export function runsSlashCommandImmediately(name: string): boolean {
  return SELF_CONFIRMING_SLASH_COMMANDS.has(name.trim().toLowerCase());
}

/**
 * The composer text a picked command leaves behind, e.g. `/review-sql `.
 *
 * The trailing space is deliberate: the caret lands after it, so the next
 * keystroke starts the argument (`/profile orders`) instead of gluing onto the
 * command name. `handleGenerate` trims before parsing, so the space never
 * reaches the resolver.
 */
export function slashCommandDraft(name: string): string {
  return `/${name.trim()} `;
}

/** Filters the registry by the text typed after the leading "/". */
export function matchSlashCommands(query: string, commands: AISlashCommand[]): AISlashCommand[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return commands;
  return commands.filter((command) => command.name.toLowerCase().startsWith(normalized));
}

// ---------------------------------------------------------------------------
// Editor-assist commands (/explain, /optimize, /fix)
// ---------------------------------------------------------------------------

/**
 * Native commands that act on the SQL sitting in the active editor tab.
 *
 * They park in the composer like every other command (`/explain` stays
 * `/explain` until Enter), but on send they are expanded into a contextual
 * prompt — the editor SQL, the last recorded query error, or an EXPLAIN plan
 * — by `resolveEditorAssistPrompt` in `use-ai-slide-panel.ts`. The composer
 * keeps showing the short command while the model receives the full context.
 */
export type EditorAssistCommand = "explain" | "optimize" | "fix";

const EDITOR_ASSIST_COMMANDS: Record<EditorAssistCommand, true> = {
  explain: true,
  optimize: true,
  fix: true,
};

/**
 * Parse `/explain`, `/optimize`, or `/fix` (with optional trailing hint text),
 * or return `null` for anything else. The name is lowercased by
 * `parseSlashCommandLine`, so `/FIX` still resolves.
 */
export function parseEditorAssistCommand(
  text: string,
): { command: EditorAssistCommand; arguments: string } | null {
  const parsed = parseSlashCommandLine(text);
  if (!parsed) return null;
  if (!EDITOR_ASSIST_COMMANDS[parsed.name as EditorAssistCommand]) return null;
  return { command: parsed.name as EditorAssistCommand, arguments: parsed.arguments };
}

// ---------------------------------------------------------------------------
// File-backed commands (the runbook registry in `agent_commands.rs`)
// ---------------------------------------------------------------------------

/** One registry entry as the Rust engine serialises it. */
export interface AgentFileCommand {
  name: string;
  description: string;
  argumentHint: string | null;
  argumentNames: string[];
  /**
   * Tools this command narrows the run to (empty = no narrowing). Narrowing
   * only — it can take tools away, never grant one policy would refuse.
   */
  allowedTools: string[];
  inject: string[];
  origin: "builtin" | "global" | "workspace";
}

/** The composer's view of `/name arguments`, after Rust expanded it. */
export interface ResolvedFileCommand {
  command: AgentFileCommand;
  /** The body with `$ARGUMENTS` substituted and observed facts prepended. */
  prompt: string;
  arguments: string;
  /** Tools this command narrows the run to (empty = no narrowing). */
  allowedTools: string[];
  /**
   * Context keys the command asked for that the app could not supply. Surfacing
   * them lets the composer say "there is no active SQL" instead of the agent
   * quietly inventing one.
   */
  missingContext: string[];
}

/**
 * Split `/name rest` into its parts, or `null` when the text is a plain prompt.
 *
 * Mirrors `agent_commands::parse_command_line`, including the lowercase name: a
 * command the menu offered must not fail once typed with a capital letter.
 */
export function parseSlashCommandLine(text: string): { name: string; arguments: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const rest = trimmed.slice(1);
  const match = /^(\S+)\s*([\s\S]*)$/.exec(rest);
  if (!match) return null;
  const name = match[1].toLowerCase();
  if (!name) return null;
  return { name, arguments: match[2].trim() };
}

/**
 * The name of a file-backed command this draft invokes, or `null`.
 *
 * Native commands (`/backup`, `/rollback`, `/compact`) are handled before this
 * is consulted, so a file command can never shadow one of them.
 */
export function findFileCommandName(
  text: string,
  commands: readonly AgentFileCommand[],
): string | null {
  const parsed = parseSlashCommandLine(text);
  if (!parsed) return null;
  const found = commands.find((command) => command.name.toLowerCase() === parsed.name);
  return found ? found.name : null;
}

/**
 * Merge the native commands with the discovered file commands.
 *
 * Native wins on a name collision because those three are implemented in the
 * app itself; a file command with the same name would silently replace a
 * working feature with a prompt. `isEnabled` applies the user's per-command
 * opt-out so disabling a command hides it everywhere. `customBadge` is the
 * localized label stamped on user-authored files (origins `global` and
 * `workspace`); the untouched built-in pack stays unbadged.
 */
export function mergeSlashCommands(
  native: readonly AISlashCommand[],
  fileCommands: readonly AgentFileCommand[],
  isEnabled?: (name: string) => boolean,
  customBadge?: string,
): AISlashCommand[] {
  const merged: AISlashCommand[] = [...native];
  const taken = new Set(native.map((command) => command.name.toLowerCase()));

  for (const command of fileCommands) {
    const key = command.name.toLowerCase();
    if (taken.has(key)) continue;
    if (isEnabled && !isEnabled(command.name)) continue;
    taken.add(key);
    merged.push({
      name: command.name,
      description: command.argumentHint
        ? `${command.description} ${command.argumentHint}`.trim()
        : command.description,
      badge: command.origin === "builtin" ? undefined : customBadge,
    });
  }

  return merged;
}

/** Values the app can supply to a command's `inject:` list. */
export interface ComposerCommandContext {
  currentDatabase?: string | null;
  boundConnection?: string | null;
  activeTabSql?: string | null;
  selectedTable?: string | null;
  schemaSummary?: string | null;
  checkpointList?: string | null;
}

/**
 * Build the `inject:` payload sent to Rust.
 *
 * Empty values are omitted rather than sent as empty strings: the engine treats
 * a missing key as "the app could not supply this" and tells the agent to ask,
 * whereas an empty string reads like a real observation of nothing.
 */
export function buildComposerCommandContext(
  values: ComposerCommandContext,
): Record<string, string> {
  const entries: Array<[string, string | null | undefined]> = [
    ["current_database", values.currentDatabase],
    ["bound_connection", values.boundConnection],
    ["active_tab_sql", values.activeTabSql],
    ["selected_table", values.selectedTable],
    ["schema_summary", values.schemaSummary],
    ["checkpoint_list", values.checkpointList],
  ];

  const context: Record<string, string> = {};
  for (const [key, value] of entries) {
    const trimmed = value?.trim();
    if (trimmed) context[key] = trimmed;
  }
  return context;
}

/**
 * The note shown when the app could not supply context a command asked for, so
 * the user knows the agent will ask instead of quietly guessing.
 */
export function describeMissingCommandContextItems(missingContext: readonly string[]): string {
  if (missingContext.length === 0) return "";
  return `The command asked for ${missingContext.join(
    ", ",
  )}, which the app could not supply — the agent will ask for it.`;
}

export function describeMissingCommandContext(resolved: ResolvedFileCommand): string {
  return describeMissingCommandContextItems(resolved.missingContext);
}
