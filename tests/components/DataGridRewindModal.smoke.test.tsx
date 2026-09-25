// Smoke: the Rewind modal lists checkpoints, restores one through the store
// wrapper, and shows an empty state; the Tools menu only offers Rewind when
// a handler is wired (or a connectionId enables the built-in modal).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { RewindCheckpointInfo } from "../../src/types";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("../../src/stores/pluginStore", () => ({
  usePluginStore: (selector: (state: unknown) => unknown) =>
    selector({ plugins: [], hasLoaded: true, loadPlugins: vi.fn() }),
}));

import { DataGridRewindModal } from "../../src/components/DataGrid/DataGridRewindModal";
import { DataGridToolbar } from "../../src/components/DataGrid/DataGridToolbar";

const noop = vi.fn();

const checkpoints: RewindCheckpointInfo[] = [
  {
    id: "cp-1",
    tableName: "public.users",
    database: "appdb",
    kind: "update",
    rowCount: 3,
    createdAtMs: Date.now() - 5 * 60_000,
  },
  {
    id: "cp-2",
    tableName: "public.orders",
    database: null,
    kind: "delete",
    rowCount: 12,
    createdAtMs: Date.now() - 60_000,
  },
];

function renderToolbar(overrides: Record<string, unknown> = {}) {
  return render(
    <DataGridToolbar
      tableName="public.users"
      selectedRowCount={0}
      isDeletingRows={false}
      handleDeleteSelectedRows={noop}
      handleInsertRow={noop}
      handleCopyAsInsert={noop}
      handleCopyAsUpdate={noop}
      handleCopyAsInsertParam={noop}
      handleCopyAsUpdateParam={noop}
      handleCopyAsDeleteParam={noop}
      isTableEditable
      structureStatus="ready"
      resolvedColumns={[
        { name: "id", data_type: "integer", is_nullable: false, is_primary_key: true },
      ]}
      dataRows={[[1]]}
      onReloadData={noop}
      {...overrides}
    />,
  );
}

describe("DataGridRewindModal", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "list_rewind_checkpoints") return checkpoints;
      if (command === "restore_rewind_checkpoint") return 3;
      if (command === "delete_rewind_checkpoint") return true;
      throw new Error(`Unexpected command: ${command}`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists checkpoints with table names, databases, and kind badges", async () => {
    render(<DataGridRewindModal connectionId="conn-1" onClose={noop} />);

    expect(await screen.findByText("public.users")).toBeInTheDocument();
    expect(screen.getByText("public.orders")).toBeInTheDocument();
    expect(screen.getByText("appdb")).toBeInTheDocument();
    expect(screen.getByText("UPDATE")).toBeInTheDocument();
    expect(screen.getByText("DELETE")).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith("list_rewind_checkpoints", {
      connectionId: "conn-1",
    });
  });

  it("restores a confirmed checkpoint and fires onRestored", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const onRestored = vi.fn();
    render(<DataGridRewindModal connectionId="conn-1" onClose={noop} onRestored={onRestored} />);

    await screen.findByText("public.users");
    fireEvent.click(screen.getAllByRole("button", { name: /^Restore/ })[0]);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("restore_rewind_checkpoint", {
        connectionId: "conn-1",
        checkpointId: "cp-1",
      });
      expect(onRestored).toHaveBeenCalledOnce();
    });
  });

  it("does not restore when the confirmation is declined", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<DataGridRewindModal connectionId="conn-1" onClose={noop} onRestored={noop} />);

    await screen.findByText("public.users");
    fireEvent.click(screen.getAllByRole("button", { name: /^Restore/ })[0]);

    await waitFor(() => expect(screen.getByText("public.users")).toBeInTheDocument());
    expect(invokeMock.mock.calls.some(([command]) => command === "restore_rewind_checkpoint")).toBe(
      false,
    );
  });

  it("shows the empty state when the engine returns no checkpoints", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "list_rewind_checkpoints") return [];
      throw new Error(`Unexpected command: ${command}`);
    });

    render(<DataGridRewindModal connectionId="conn-1" onClose={noop} />);

    expect(await screen.findByText(/No rewind checkpoints/)).toBeInTheDocument();
  });
});

describe("Tools menu Rewind entry", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "list_rewind_checkpoints") return checkpoints;
      throw new Error(`Unexpected command: ${command}`);
    });
  });

  it("hides the entry when neither onOpenRewind nor connectionId is given", () => {
    renderToolbar();
    fireEvent.click(screen.getByRole("button", { name: "Tools" }));
    expect(screen.queryByText("Rewind…")).not.toBeInTheDocument();
  });

  it("shows the entry and invokes onOpenRewind when provided", () => {
    const onOpenRewind = vi.fn();
    renderToolbar({ onOpenRewind });
    fireEvent.click(screen.getByRole("button", { name: "Tools" }));
    fireEvent.click(screen.getByText("Rewind…"));
    expect(onOpenRewind).toHaveBeenCalledOnce();
  });

  it("opens the built-in modal when only a connectionId is provided", async () => {
    renderToolbar({ connectionId: "conn-1" });
    fireEvent.click(screen.getByRole("button", { name: "Tools" }));
    fireEvent.click(screen.getByText("Rewind…"));

    expect(await screen.findByText("Rewind checkpoints")).toBeInTheDocument();
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("list_rewind_checkpoints", {
        connectionId: "conn-1",
      }),
    );
  });
});
