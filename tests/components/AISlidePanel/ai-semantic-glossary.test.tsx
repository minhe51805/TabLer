import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * The glossary modal is the only user-visible surface for agent-learned
 * terms — if it cannot list or delete entries, a bad remember_term write
 * silently steers every future run.
 */

const getEntriesMock = vi.fn();
const deleteEntryMock = vi.fn();
vi.mock("@/utils/semantic-glossary", () => ({
  getSemanticGlossary: vi.fn(),
  saveSemanticGlossaryEntry: vi.fn(),
  deleteSemanticGlossaryEntry: (...args: unknown[]) => deleteEntryMock(...args),
  invalidateSemanticGlossary: vi.fn(),
}));

const invokeMutationMock = vi.fn();
vi.mock("@/utils/tauri-utils", () => ({
  invokeMutation: (...args: unknown[]) => invokeMutationMock(...args),
}));

import { AISemanticGlossaryModal } from "@/components/AISlidePanel/AISemanticGlossaryModal";

const entry = {
  id: "e-1",
  connectionId: "conn-1",
  database: "shop",
  term: "revenue",
  definition: "sum(amount) where status='paid'",
  kind: "metric" as const,
  source: "agent" as const,
  createdAt: "2026-09-20T10:00:00Z",
  updatedAt: "2026-09-20T10:00:00Z",
};

function renderModal() {
  return render(
    <AISemanticGlossaryModal
      open
      language="en"
      connectionId="conn-1"
      database="shop"
      onClose={vi.fn()}
    />,
  );
}

describe("AISemanticGlossaryModal", () => {
  beforeEach(() => {
    getEntriesMock.mockReset();
    deleteEntryMock.mockReset();
    invokeMutationMock.mockReset();
  });

  it("lists the scope's entries with term, kind and agent badge", async () => {
    invokeMutationMock.mockResolvedValue([entry]);
    renderModal();

    await waitFor(() =>
      expect(invokeMutationMock).toHaveBeenCalledWith("get_semantic_entries", {
        connectionId: "conn-1",
        database: "shop",
      }),
    );
    expect(await screen.findByText("revenue")).toBeInTheDocument();
    expect(screen.getByText("sum(amount) where status='paid'")).toBeInTheDocument();
    expect(screen.getByText("Kind: metric")).toBeInTheDocument();
    expect(screen.getByText("agent")).toBeInTheDocument();
  });

  it("deletes an entry only after the confirm dialog approves", async () => {
    const user = userEvent.setup();
    invokeMutationMock.mockResolvedValue([entry]);
    deleteEntryMock.mockResolvedValue(undefined);
    renderModal();

    await user.click(await screen.findByRole("button", { name: "Delete" }));
    // The dialog must be the gate — nothing is deleted on row click alone.
    expect(deleteEntryMock).not.toHaveBeenCalled();
    // ConfirmDialog portals to document.body with no role — the confirm
    // button is identifiable by its class within the dialog actions.
    const confirm = await waitFor(() => {
      const btn = document.querySelector<HTMLButtonElement>(
        ".confirm-dialog .confirm-dialog-btn-confirm",
      );
      expect(btn).not.toBeNull();
      return btn!;
    });
    await user.click(confirm);
    await waitFor(() => expect(deleteEntryMock).toHaveBeenCalledWith("e-1"));
    await waitFor(() => expect(screen.queryByText("revenue")).toBeNull());
  });

  it("renders the empty state without a connection scope", async () => {
    render(
      <AISemanticGlossaryModal
        open
        language="en"
        connectionId={null}
        database={null}
        onClose={vi.fn()}
      />,
    );
    expect(await screen.findByText(/No glossary entries yet/)).toBeInTheDocument();
    expect(invokeMutationMock).not.toHaveBeenCalled();
  });
});
