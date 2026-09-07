import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/utils/tauri-utils", () => ({
  invokeWithTimeout: vi.fn(),
}));
vi.mock("@/utils/app-toast", () => ({
  emitAppToast: vi.fn(),
}));

import { invokeWithTimeout } from "@/utils/tauri-utils";
import { emitAppToast } from "@/utils/app-toast";
import { captureAgentEditedRunCheckpoint } from "@/components/SQLEditor/agent-edit-safety";

const mockedInvoke = vi.mocked(invokeWithTimeout);
const mockedToast = vi.mocked(emitAppToast);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("captureAgentEditedRunCheckpoint", () => {
  it("captures the rollback point before an agent-edited run", async () => {
    mockedInvoke.mockResolvedValue({ fileName: "1234-before-agent-edited-run.sql" });
    const result = await captureAgentEditedRunCheckpoint({
      connectionId: "conn-1",
      database: "appdb",
      dbType: "mssql",
    });
    expect(result?.fileName).toBe("1234-before-agent-edited-run.sql");
    expect(mockedInvoke).toHaveBeenCalledWith(
      "create_database_checkpoint",
      {
        connectionId: "conn-1",
        database: "appdb",
        dbType: "mssql",
        label: "before-agent-edited-run",
      },
      60_000,
      "Safety checkpoint",
    );
    expect(mockedToast).not.toHaveBeenCalled();
  });

  it("toasts loudly and returns null on failure without throwing", async () => {
    mockedInvoke.mockRejectedValue("disk full");
    const result = await captureAgentEditedRunCheckpoint({
      connectionId: "conn-1",
      database: null,
      dbType: "mssql",
    });
    expect(result).toBeNull();
    expect(mockedToast).toHaveBeenCalledWith(expect.objectContaining({ tone: "error" }));
  });
});
