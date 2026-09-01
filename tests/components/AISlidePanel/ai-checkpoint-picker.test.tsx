import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const invokeMutationMock = vi.fn();
vi.mock("@/utils/tauri-utils", () => ({
  invokeMutation: (...args: unknown[]) => invokeMutationMock(...args),
}));

import { AICheckpointPickerModal } from "@/components/AISlidePanel/AICheckpointPickerModal";
import { requestAICheckpointPick } from "@/components/AISlidePanel/ai-checkpoint-picker";
import { getAIWorkspaceCopy } from "@/components/AISlidePanel/ai-workspace-copy";

const copy = getAIWorkspaceCopy("en").composer;

const checkpoint = {
  fileName: "1719000000000-before_schema_change.sql",
  label: "before schema change",
  createdAt: 1719000000000,
  engine: "postgresql",
  database: "appdb",
  tableCount: 12,
  rowCount: 3456,
  sizeBytes: 4096,
};

/**
 * Regression guard for the rollback confirm flow: the preview invoke MUST
 * carry dbType (a required Rust command argument) — a missing arg fails at
 * the serialization boundary, previewError is set, and the Restore button
 * stays disabled forever (the "main button never enables" bug class).
 */
describe("AICheckpointPickerModal", () => {
  beforeEach(() => {
    invokeMutationMock.mockReset();
  });

  it("passes connectionId + dbType into the preview invoke and enables Restore", async () => {
    const user = userEvent.setup();
    invokeMutationMock.mockResolvedValue({
      statementCount: 3,
      schemaChangeCount: 1,
      dataChangeCount: 2,
      destructiveStatementCount: 0,
      transactional: true,
      warning: null,
    });

    render(<AICheckpointPickerModal copy={copy} />);
    const pickPromise = requestAICheckpointPick([checkpoint], "en", "conn-1", "postgres");

    // List view: picking a checkpoint triggers the preview invoke.
    await user.click(await screen.findByRole("button", { name: /before schema change/ }));

    expect(
      await screen.findByText(/Runs 3 statements \(1 schema, 2 data, 0 destructive\)/),
    ).toBeInTheDocument();
    expect(invokeMutationMock).toHaveBeenCalledWith(
      "preview_database_checkpoint_restore",
      expect.objectContaining({
        connectionId: "conn-1",
        fileName: checkpoint.fileName,
        dbType: "postgres",
      }),
    );

    const restoreButton = screen.getByRole("button", { name: "Restore" });
    expect(restoreButton).not.toBeDisabled();
    await user.click(restoreButton);
    await expect(pickPromise).resolves.toBe(checkpoint.fileName);
  });

  it("resolves null from the Cancel button without invoking any command", async () => {
    const user = userEvent.setup();
    render(<AICheckpointPickerModal copy={copy} />);
    const pickPromise = requestAICheckpointPick([checkpoint], "en", "conn-1", "postgres");

    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await expect(pickPromise).resolves.toBeNull();
    expect(invokeMutationMock).not.toHaveBeenCalled();
  });
});
