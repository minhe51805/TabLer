import { act, renderHook } from "@testing-library/react";
import { useRef, useState } from "react";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { useDataGridTableExport } from "@/components/DataGrid/hooks/useDataGridTableExport";
import type { TableFilterPlan } from "@/components/DataGrid/hooks/useDataGrid";
import type { requestAppConfirmation, requestAppExportEncryption } from "@/stores/confirmStore";

const confirmMocks = vi.hoisted(() => ({
  requestAppConfirmation: vi.fn<typeof requestAppConfirmation>(),
  requestAppExportEncryption: vi.fn<typeof requestAppExportEncryption>(),
}));

vi.mock("@/stores/confirmStore", () => confirmMocks);

type TableExportParams = Parameters<typeof useDataGridTableExport>[0];
type ExportTableDataFn = TableExportParams["exportTableData"];
type CancelTableExportFn = TableExportParams["cancelTableExport"];

const NO_FILTER: TableFilterPlan = { serverFilter: "", clientSideOnly: false };

interface HarnessOptions {
  filterPlan?: TableFilterPlan;
  masksActive?: boolean;
  sortColumn?: string | null;
  exportTableData?: Mock<ExportTableDataFn>;
  cancelTableExport?: Mock<CancelTableExportFn>;
}

function makeHarness(options: HarnessOptions = {}) {
  const spies = {
    setError: vi.fn(),
    exportTableData: options.exportTableData ?? vi.fn<ExportTableDataFn>(async () => ({})),
    cancelTableExport: options.cancelTableExport ?? vi.fn<CancelTableExportFn>(async () => ({})),
  };
  const hook = renderHook(() => {
    const [isExportingFull, setIsExportingFull] = useState(false);
    const [exportedRowCount, setExportedRowCount] = useState(-1);
    const operationIdRef = useRef<string | null>(null);
    const api = useDataGridTableExport({
      tableName: "users",
      database: "app",
      connectionId: "conn-1",
      sortColumn: options.sortColumn ?? null,
      sortDir: "DESC",
      filterPlan: options.filterPlan ?? NO_FILTER,
      isExportingFull,
      setIsExportingFull,
      setExportedRowCount,
      setError: spies.setError,
      exportTableData: spies.exportTableData,
      cancelTableExport: spies.cancelTableExport,
      tableExportOperationIdRef: operationIdRef,
      masksActive: options.masksActive,
    });
    return { api, isExportingFull, exportedRowCount, operationIdRef };
  });
  return { hook, spies };
}

async function runExport(hook: ReturnType<typeof makeHarness>["hook"], format = "csv") {
  await act(async () => {
    await hook.result.current.api.handleFullTableExport(format as never);
  });
}

beforeEach(() => {
  confirmMocks.requestAppConfirmation.mockReset().mockResolvedValue(true);
  confirmMocks.requestAppExportEncryption
    .mockReset()
    .mockResolvedValue({ confirmed: true, password: null });
});

describe("refusal gates", () => {
  it("refuses a client-side-only filter before any prompt or backend call", async () => {
    const { hook, spies } = makeHarness({
      filterPlan: { serverFilter: "", clientSideOnly: true },
    });
    await runExport(hook);
    expect(spies.setError).toHaveBeenCalledWith(expect.stringContaining("filter"));
    expect(confirmMocks.requestAppExportEncryption).not.toHaveBeenCalled();
    expect(spies.exportTableData).not.toHaveBeenCalled();
  });

  it("refuses while column masks are active — streaming export can't mask", async () => {
    const { hook, spies } = makeHarness({ masksActive: true });
    await runExport(hook);
    expect(spies.setError).toHaveBeenCalled();
    expect(confirmMocks.requestAppExportEncryption).not.toHaveBeenCalled();
    expect(spies.exportTableData).not.toHaveBeenCalled();
  });

  it("aborts silently when the encryption prompt is cancelled", async () => {
    confirmMocks.requestAppExportEncryption.mockResolvedValue({
      confirmed: false,
      password: null,
    });
    const { hook, spies } = makeHarness();
    await runExport(hook);
    expect(spies.exportTableData).not.toHaveBeenCalled();
    expect(spies.setError).not.toHaveBeenCalled();
    expect(hook.result.current.isExportingFull).toBe(false);
  });
});

describe("happy path", () => {
  it("exports with table/database/format and resets state afterwards", async () => {
    const { hook, spies } = makeHarness();
    await runExport(hook, "json");
    expect(spies.exportTableData).toHaveBeenCalledTimes(1);
    const [connId, request, operationId] = spies.exportTableData.mock.calls[0] as [
      string,
      Record<string, unknown>,
      string,
    ];
    expect(connId).toBe("conn-1");
    expect(request).toMatchObject({
      table: "users",
      database: "app",
      format: "json",
      overwrite: false,
    });
    expect(request.orderBy).toBeUndefined();
    expect(request.filter).toBeUndefined();
    expect(operationId).toMatch(/^export-/);
    expect(hook.result.current.isExportingFull).toBe(false);
    expect(hook.result.current.exportedRowCount).toBe(0);
    expect(hook.result.current.operationIdRef.current).toBeNull();
  });

  it("forwards sort + server filter and the encryption password", async () => {
    confirmMocks.requestAppExportEncryption.mockResolvedValue({
      confirmed: true,
      password: "s3cret",
    });
    const { hook, spies } = makeHarness({
      sortColumn: "name",
      filterPlan: { serverFilter: "name LIKE '%a%'", clientSideOnly: false },
    });
    await runExport(hook);
    const request = spies.exportTableData.mock.calls[0][1] as Record<string, unknown>;
    expect(request).toMatchObject({
      orderBy: "name",
      orderDir: "DESC",
      filter: "name LIKE '%a%'",
      encryptPassword: "s3cret",
    });
  });
});

describe("FILE_EXISTS retry", () => {
  it("confirms overwrite, then retries once with overwrite: true", async () => {
    const exportTableData = vi
      .fn<ExportTableDataFn>()
      .mockRejectedValueOnce(new Error("TABLER_EXPORT_FILE_EXISTS: /tmp/out.csv already exists"))
      .mockResolvedValueOnce({});
    const { hook, spies } = makeHarness({ exportTableData });
    await runExport(hook);

    expect(confirmMocks.requestAppConfirmation).toHaveBeenCalledTimes(1);
    expect(spies.exportTableData).toHaveBeenCalledTimes(2);
    expect(spies.exportTableData.mock.calls[1][1]).toMatchObject({ overwrite: true });
    expect(spies.setError).not.toHaveBeenCalled();
  });

  it("does not retry when the user declines the overwrite prompt", async () => {
    const exportTableData = vi
      .fn<ExportTableDataFn>()
      .mockRejectedValue(new Error("TABLER_EXPORT_FILE_EXISTS: exists"));
    confirmMocks.requestAppConfirmation.mockResolvedValue(false);
    const { hook, spies } = makeHarness({ exportTableData });
    await runExport(hook);
    expect(spies.exportTableData).toHaveBeenCalledTimes(1);
    expect(spies.setError).not.toHaveBeenCalled();
  });
});

describe("error handling", () => {
  it("surfaces a generic backend failure", async () => {
    const exportTableData = vi.fn<ExportTableDataFn>().mockRejectedValue(new Error("disk full"));
    const { hook, spies } = makeHarness({ exportTableData });
    await runExport(hook);
    expect(spies.setError).toHaveBeenCalledWith(expect.stringContaining("disk full"));
    expect(hook.result.current.isExportingFull).toBe(false);
  });

  it("swallows cancel errors — aborting an export is not a failure", async () => {
    const exportTableData = vi
      .fn<ExportTableDataFn>()
      .mockRejectedValue(new Error("Export cancelled by user"));
    const { hook, spies } = makeHarness({ exportTableData });
    await runExport(hook);
    expect(spies.setError).not.toHaveBeenCalled();
    expect(hook.result.current.isExportingFull).toBe(false);
  });
});

describe("handleCancelFullTableExport", () => {
  it("cancels the in-flight operation id", async () => {
    const { hook, spies } = makeHarness();
    act(() => {
      hook.result.current.operationIdRef.current = "export-abc";
    });
    await act(async () => {
      await hook.result.current.api.handleCancelFullTableExport();
    });
    expect(spies.cancelTableExport).toHaveBeenCalledWith("export-abc");
  });

  it("is a no-op without an active export", async () => {
    const { hook, spies } = makeHarness();
    await act(async () => {
      await hook.result.current.api.handleCancelFullTableExport();
    });
    expect(spies.cancelTableExport).not.toHaveBeenCalled();
  });
});
