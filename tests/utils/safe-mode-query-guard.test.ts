import { beforeEach, describe, expect, it } from "vitest";
import { assertStatementsAllowed } from "@/utils/safe-mode-query-guard";
import { useSafeModeStore } from "@/stores/safeModeStore";

describe("restore safe-mode guard", () => {
  beforeEach(() => {
    localStorage.clear();
    useSafeModeStore.setState({
      settings: { globalLevel: 1, connectionOverrides: [], connectionEnvironments: {} },
    });
  });

  it("blocks schema restore statements for the default production Strict profile", async () => {
    useSafeModeStore.getState().setConnectionEnvironment("production", "production");

    await expect(
      assertStatementsAllowed(["CREATE TABLE audit_log (id INTEGER)"], "production"),
    ).rejects.toThrow("blocked statement");
  });
});
