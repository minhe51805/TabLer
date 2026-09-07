import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

import { WorkspaceSyncModal } from "@/components/WorkspaceSyncModal";

describe("WorkspaceSyncModal", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("loads revision state for the selected workspace id", () => {
    localStorage.setItem(
      "tabler.workspace-sync.revision.v1.workspace-a",
      "abcdef1234567890",
    );

    render(
      <WorkspaceSyncModal
        connectionName="Local database"
        defaultWorkspaceId="workspace-a"
        buildBundle={() => null}
        applyBundle={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("Current abcdef123456")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Workspace ID"), {
      target: { value: "workspace-b" },
    });

    expect(screen.getByText("Not synced")).toBeInTheDocument();
  });
});
