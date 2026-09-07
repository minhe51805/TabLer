import { beforeEach, describe, expect, it } from "vitest";
import { useSkillUsageStore } from "@/stores/skillUsageStore";

describe("skillUsageStore", () => {
  beforeEach(() => {
    useSkillUsageStore.setState({ usage: {} });
  });

  it("counts runs per skill and keeps the last connection", () => {
    const { recordSkillRun } = useSkillUsageStore.getState();
    recordSkillRun("db-audit", "conn-1");
    recordSkillRun("db-audit", "conn-2");
    const entry = useSkillUsageStore.getState().usage["db-audit"];
    expect(entry.runs).toBe(2);
    expect(entry.lastConnectionId).toBe("conn-2");
    expect(entry.lastUsedAt).toBeGreaterThan(0);
  });

  it("ignores blank skill names", () => {
    const { recordSkillRun } = useSkillUsageStore.getState();
    recordSkillRun("   ");
    expect(useSkillUsageStore.getState().usage).toEqual({});
  });

  it("clearSkillUsage resets everything", () => {
    const { recordSkillRun, clearSkillUsage } = useSkillUsageStore.getState();
    recordSkillRun("db-audit", "conn-1");
    clearSkillUsage();
    expect(useSkillUsageStore.getState().usage).toEqual({});
  });
});
