import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeWithTimeoutMock = vi.fn();
vi.mock("@/utils/tauri-utils", () => ({
  invokeWithTimeout: (...args: unknown[]) => invokeWithTimeoutMock(...args),
  invokeMutation: vi.fn(),
}));

import { assertQueryAllowed } from "@/utils/safe-mode-query-guard";
import { useSafeModeStore } from "@/stores/safeModeStore";
import { useConnectionStore } from "@/stores/connectionStore";

const WRITE_DECISION = {
  statements: [{ sql: "UPDATE dbo.SinhViens SET HoTen = N'Ninh'", kind: "write", readOnly: false }],
  readOnly: false,
  hasSchemaMutation: false,
};

/** Approves/denies the pending Safe Mode confirmation request. */
function respondToSafeModePrompt(approved: boolean) {
  window.dispatchEvent(
    new CustomEvent("safe-mode-confirm-response", { detail: { approved } }),
  );
}

describe("assertQueryAllowed safe-mode confirmation override", () => {
  beforeEach(() => {
    invokeWithTimeoutMock.mockReset();
    invokeWithTimeoutMock.mockResolvedValue(WRITE_DECISION);
    useSafeModeStore.setState({
      settings: { globalLevel: 1, connectionOverrides: [], connectionEnvironments: {} },
    });
    useConnectionStore.setState({
      connections: [{ id: "conn-1", name: "Test", db_type: "mssql" }] as never,
      activeConnectionId: "conn-1",
    });
  });

  it("levels 1-3 offer the confirmation dialog instead of a hard block when the run is user-initiated (approved run passes)", async () => {
    const promise = assertQueryAllowed("UPDATE dbo.SinhViens SET HoTen = N'Ninh'", "conn-1", {
      userInitiated: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    respondToSafeModePrompt(true);
    const decision = await promise;
    expect(decision.statements).toHaveLength(1);
    expect(decision.userConfirmed).toBe(true);
  });

  it("a denied confirmation cancels the run", async () => {
    const promise = assertQueryAllowed("UPDATE dbo.SinhViens SET HoTen = N'Ninh'", "conn-1", {
      userInitiated: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    respondToSafeModePrompt(false);
    await expect(promise).rejects.toThrow("Query cancelled by Safe Mode confirmation.");
  });

  it("autonomous paths (no userInitiated) keep the hard block at levels 1-3", async () => {
    // Agent tools and programmatic sandbox calls must never pop a dialog or
    // write through the guard tier.
    await expect(
      assertQueryAllowed("UPDATE dbo.SinhViens SET HoTen = N'Ninh'", "conn-1"),
    ).rejects.toThrow("[Safe Mode level 1] This statement is blocked");
  });

  it("levels 4-5 keep the hard block for always-blocked statements (no confirmation offer)", async () => {
    useSafeModeStore.setState({
      settings: { globalLevel: 5, connectionOverrides: [], connectionEnvironments: {} },
    });
    // At level 4-5 a plain UPDATE goes through confirmation; only the
    // always-blocked family (DROP/TRUNCATE/CREATE TABLE) hard-fails.
    invokeWithTimeoutMock.mockResolvedValue({
      statements: [
        { sql: "DROP TABLE dbo.SinhViens", kind: "schema", readOnly: false },
      ],
      readOnly: false,
      hasSchemaMutation: true,
    });
    await expect(
      assertQueryAllowed("DROP TABLE dbo.SinhViens", "conn-1", { userInitiated: true }),
    ).rejects.toThrow("[Safe Mode level 5] This statement is blocked");
  });

  it("preApproved runs pass Safe Mode levels 1-3 without another dialog", async () => {
    // The human already granted approval (AI review dialog or the standing
    // "full autonomy" permission): no confirmation event is expected.
    const decision = await assertQueryAllowed("UPDATE dbo.SinhViens SET HoTen = N'Ninh'", "conn-1", {
      preApproved: true,
    });
    expect(decision.statements).toHaveLength(1);
    expect(decision.userConfirmed).toBe(true);
  });

  it("preApproved does not skip confirmations at levels 4-5 (strict/production)", async () => {
    useSafeModeStore.setState({
      settings: { globalLevel: 5, connectionOverrides: [], connectionEnvironments: {} },
    });
    invokeWithTimeoutMock.mockResolvedValue({
      statements: [
        { sql: "UPDATE dbo.SinhViens SET HoTen = N'Ninh'", kind: "write", readOnly: false },
      ],
      readOnly: false,
      hasSchemaMutation: false,
    });
    const promise = assertQueryAllowed("UPDATE dbo.SinhViens SET HoTen = N'Ninh'", "conn-1", {
      preApproved: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    respondToSafeModePrompt(true);
    const decision = await promise;
    expect(decision.statements).toHaveLength(1);
  });
});
