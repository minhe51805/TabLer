import { describe, expect, it } from "vitest";
import {
  buildComposerCommandContext,
  describeMissingCommandContext,
  findFileCommandName,
  isBackupCommand,
  isRollbackCommand,
  matchSlashCommands,
  mergeSlashCommands,
  parseSlashCommandLine,
  runsSlashCommandImmediately,
  slashCommandDraft,
  type AgentFileCommand,
  type ResolvedFileCommand,
  type AISlashCommand,
} from "@/components/AISlidePanel/ai-slash-commands";

const registry: AISlashCommand[] = [
  { name: "backup", description: "Back up the current database." },
  { name: "compact", description: "Compact the conversation." },
];

describe("composer slash commands", () => {
  it("shows the full registry for a bare slash and filters by prefix", () => {
    expect(matchSlashCommands("", registry)).toEqual(registry);
    expect(matchSlashCommands("b", registry).map((command) => command.name)).toEqual(["backup"]);
    expect(matchSlashCommands("CO", registry).map((command) => command.name)).toEqual(["compact"]);
    expect(matchSlashCommands("nope", registry)).toEqual([]);
  });

  it("detects the /backup command with or without a trailing note", () => {
    expect(isBackupCommand("/backup")).toBe(true);
    expect(isBackupCommand("  /Backup  ")).toBe(true);
    expect(isBackupCommand("/backup now, include everything")).toBe(true);
    expect(isBackupCommand("/backups")).toBe(false);
    expect(isBackupCommand("/compact")).toBe(false);
    expect(isBackupCommand("please /backup")).toBe(false);
  });

  it("detects the /rollback command (exact, no args)", () => {
    expect(isRollbackCommand("/rollback")).toBe(true);
    expect(isRollbackCommand("  /Rollback ")).toBe(true);
    expect(isRollbackCommand("/rollback now")).toBe(false);
    expect(isRollbackCommand("/backup")).toBe(false);
  });

  it("keeps registry names unique so menu selection is unambiguous", () => {
    const names = registry.map((command) => command.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('picking a command from the "/" menu', () => {
  it("only runs the command that carries its own confirmation", () => {
    // `/rollback` opens the checkpoint picker, and that picker *is* the
    // confirmation, so a second Enter would only add a step.
    expect(runsSlashCommandImmediately("rollback")).toBe(true);
    expect(runsSlashCommandImmediately("  Rollback ")).toBe(true);
    // Everything else waits for an ordinary Enter through the send path, which is
    // what expands file-backed runbooks and applies `/backup`/`/compact`.
    expect(runsSlashCommandImmediately("backup")).toBe(false);
    expect(runsSlashCommandImmediately("compact")).toBe(false);
    expect(runsSlashCommandImmediately("review-sql")).toBe(false);
    expect(runsSlashCommandImmediately("help")).toBe(false);
  });

  it("parks the command in the composer ready for arguments", () => {
    expect(slashCommandDraft("review-sql")).toBe("/review-sql ");
    expect(slashCommandDraft("  profile  ")).toBe("/profile ");
  });

  it("hands the send path a draft it recognises as that very command", () => {
    // The parked draft is only useful if Enter resolves it exactly like the typed
    // form: the native handlers, the file-backed lookup and the argument parser
    // must all agree, or the user would watch Enter do nothing.
    for (const name of ["backup", "rollback", "profile", "review-sql"]) {
      const draft = slashCommandDraft(name);
      const parsed = parseSlashCommandLine(draft);
      expect(parsed?.name).toBe(name);
      expect(parsed?.arguments).toBe("");
    }
    expect(isBackupCommand(slashCommandDraft("backup"))).toBe(true);
    expect(isRollbackCommand(slashCommandDraft("rollback"))).toBe(true);
  });

  it("leaves room for arguments, which is why picking never runs the command", () => {
    const commands: AgentFileCommand[] = [
      {
        name: "profile",
        description: "Profile a table.",
        argumentHint: "[table to profile]",
        argumentNames: ["table"],
        allowedTools: [],
        inject: [],
        origin: "builtin",
      },
    ];
    // `/profile orders` is only reachable because the menu inserts `/profile`
    // first; an immediate run would have thrown the table name away.
    expect(findFileCommandName(`${slashCommandDraft("profile")} orders`, commands)).toBe("profile");
  });
});

describe("file-backed command registry", () => {
  const fileCommand = (overrides: Partial<AgentFileCommand> = {}): AgentFileCommand => ({
    name: "profile",
    description: "Profile a table.",
    argumentHint: "[table to profile]",
    argumentNames: ["table"],
    allowedTools: [],
    inject: ["schema_summary"],
    origin: "builtin",
    ...overrides,
  });

  it("parses /name and /name args, and ignores plain prompts", () => {
    expect(parseSlashCommandLine("/profile orders")).toEqual({
      name: "profile",
      arguments: "orders",
    });
    // Lowercased, so a command the menu offered cannot fail once typed with a capital.
    expect(parseSlashCommandLine("  /Explain  select 1  ")).toEqual({
      name: "explain",
      arguments: "select 1",
    });
    expect(parseSlashCommandLine("/backup")).toEqual({ name: "backup", arguments: "" });
    expect(parseSlashCommandLine("select 1")).toBeNull();
    expect(parseSlashCommandLine("/")).toBeNull();
    expect(parseSlashCommandLine("")).toBeNull();
  });

  it("merges file commands under the native ones and never shadows them", () => {
    const native: AISlashCommand[] = [{ name: "backup", description: "Native backup." }];
    const merged = mergeSlashCommands(native, [
      // A file command trying to take over `/backup` must lose: the native one
      // is a real feature, not a prompt.
      fileCommand({ name: "backup", description: "Hijack." }),
      fileCommand({ name: "profile" }),
    ]);

    expect(merged.map((command) => command.name)).toEqual(["backup", "profile"]);
    expect(merged[0].description).toBe("Native backup.");
    // The argument hint rides along so the menu can show the affordance.
    expect(merged[1].description).toContain("[table to profile]");
  });

  it("hides a command the user disabled", () => {
    const merged = mergeSlashCommands(
      [],
      [fileCommand({ name: "profile" }), fileCommand({ name: "indexes" })],
      (name) => name !== "profile",
    );
    expect(merged.map((command) => command.name)).toEqual(["indexes"]);
  });

  it("resolves the file command a draft invokes, case-insensitively", () => {
    const commands = [fileCommand({ name: "profile" })];
    expect(findFileCommandName("/profile orders", commands)).toBe("profile");
    expect(findFileCommandName("/PROFILE", commands)).toBe("profile");
    expect(findFileCommandName("/profiler", commands)).toBeNull();
    expect(findFileCommandName("profile orders", commands)).toBeNull();
  });

  it("sends only the context values the app actually has", () => {
    const context = buildComposerCommandContext({
      currentDatabase: "sales",
      boundConnection: "  prod-eu  ",
      activeTabSql: "   ",
      selectedTable: null,
      schemaSummary: undefined,
      checkpointList: "",
    });

    // A blank value is omitted, not sent as "": the engine treats a missing key
    // as "the app could not supply this" and tells the agent to ask, whereas an
    // empty string reads like a genuine observation of nothing.
    expect(context).toEqual({ current_database: "sales", bound_connection: "prod-eu" });
  });

  it("explains missing context only when something is missing", () => {
    const resolved: ResolvedFileCommand = {
      command: fileCommand(),
      prompt: "Profile orders.",
      arguments: "orders",
      allowedTools: [],
      missingContext: ["active_tab_sql"],
    };
    expect(describeMissingCommandContext(resolved)).toContain("active_tab_sql");
    expect(describeMissingCommandContext({ ...resolved, missingContext: [] })).toBe("");
  });
});
