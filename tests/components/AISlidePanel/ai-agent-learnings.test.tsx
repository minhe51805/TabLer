import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const invokeMutationMock = vi.fn();
vi.mock("@/utils/tauri-utils", () => ({
  invokeMutation: (...args: unknown[]) => invokeMutationMock(...args),
}));

import { AIAgentLearnings } from "@/components/AISlidePanel/AIAgentLearnings";
import { getAIWorkspaceCopy } from "@/components/AISlidePanel/ai-workspace-copy";
import type { LearningProposal } from "@/components/AISlidePanel/ai-agent-learning";
import { useAgentLearningStore } from "@/stores/agent-learning-store";

const copy = getAIWorkspaceCopy("en");
const SCOPE = "conn-a::shop";
const OTHER_SCOPE = "conn-b::shop";
const TARGET = { connectionId: "conn-a", database: "shop" };

const proposal: LearningProposal = {
  id: "memory:high-null-column:users:email",
  kind: "memory",
  title: "Remember that users.email behaves this way",
  rationale: "The run proved it by reading 500 row(s).",
  evidenceSql: "SELECT COUNT(*) AS __total FROM users",
  memory: {
    name: "users-email-high-null-column",
    description: "users.email is never populated",
    body: "## Verified finding\n\n99.8% NULL.",
  },
};

describe("AIAgentLearnings", () => {
  beforeEach(() => {
    invokeMutationMock.mockReset();
    useAgentLearningStore.setState({ proposals: [] });
  });

  const record = (target = SCOPE) =>
    useAgentLearningStore.getState().recordRunLearnings([proposal], target, TARGET);

  it("renders nothing until a run has something to offer", () => {
    render(<AIAgentLearnings copy={copy} scope={SCOPE} />);
    expect(screen.queryByTestId("ai-learnings-strip")).toBeNull();
  });

  it("shows the offer with the evidence it is based on", () => {
    record();
    render(<AIAgentLearnings copy={copy} scope={SCOPE} />);
    expect(screen.getByText(proposal.title)).toBeInTheDocument();
    expect(screen.getByText(proposal.rationale)).toBeInTheDocument();
    expect(screen.getByTitle(proposal.evidenceSql ?? "")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: copy.learnings.saveMemory })).toBeInTheDocument();
  });

  it("hides offers raised on another database", () => {
    record(OTHER_SCOPE);
    render(<AIAgentLearnings copy={copy} scope={SCOPE} />);
    expect(screen.queryByTestId("ai-learnings-strip")).toBeNull();
  });

  it("writes nothing until the user approves, then announces the path", async () => {
    const toasts: unknown[] = [];
    const onToast = (event: Event) => toasts.push((event as CustomEvent).detail);
    window.addEventListener("app-toast", onToast);
    invokeMutationMock.mockResolvedValue("/data/memory/users-email.md");
    record();
    render(<AIAgentLearnings copy={copy} scope={SCOPE} />);

    expect(invokeMutationMock).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: copy.learnings.saveMemory }));

    await waitFor(() => expect(invokeMutationMock).toHaveBeenCalledTimes(1));
    expect(invokeMutationMock).toHaveBeenCalledWith("save_agent_memory", {
      name: "users-email-high-null-column",
      body: proposal.kind === "memory" ? proposal.memory.body : "",
      description: "users.email is never populated",
      connectionId: "conn-a",
      database: "shop",
      // Agent-proposed learning writes are still agent-authored.
      origin: "agent",
    });
    // The offer is spent, so the card retires; the toast carries the evidence
    // that something was actually written.
    await waitFor(() => expect(screen.queryByTestId("ai-learnings-strip")).toBeNull());
    expect(toasts).toEqual([
      { title: copy.learnings.saved, description: "/data/memory/users-email.md", tone: "success" },
    ]);
    window.removeEventListener("app-toast", onToast);
  });

  it("keeps the card and says so when the write fails", async () => {
    invokeMutationMock.mockRejectedValue(new Error("readonly filesystem"));
    record();
    render(<AIAgentLearnings copy={copy} scope={SCOPE} />);

    await userEvent.click(screen.getByRole("button", { name: copy.learnings.saveMemory }));

    await waitFor(() => expect(screen.getByText(copy.learnings.failed)).toBeInTheDocument());
    // Still on screen: a failed write must stay the user's problem to resolve.
    expect(screen.getByText(proposal.title)).toBeInTheDocument();
  });

  it("dismisses an offer the user does not want", async () => {
    record();
    render(<AIAgentLearnings copy={copy} scope={SCOPE} />);
    await userEvent.click(screen.getByRole("button", { name: copy.learnings.dismiss }));
    expect(screen.queryByTestId("ai-learnings-strip")).toBeNull();
    expect(invokeMutationMock).not.toHaveBeenCalled();
  });
});
