import { describe, expect, it } from "vitest";
import {
  isBackupCommand,
  isRollbackCommand,
  matchSlashCommands,
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
