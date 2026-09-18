import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const invokeMutationMock = vi.fn();
vi.mock("@/utils/tauri-utils", () => ({
  invokeMutation: (...args: unknown[]) => invokeMutationMock(...args),
}));

import { AISkillsManagerModal } from "@/components/AISlidePanel/AISkillsManagerModal";
import { useSkillPrefsStore } from "@/stores/skillPrefsStore";
import { useSkillUsageStore } from "@/stores/skillUsageStore";

const alpha = {
  name: "alpha-skill",
  description: "Handles alpha work when the user asks for alpha.",
  source: "global",
  version: "1.0.0",
};

const beta = {
  name: "beta-skill",
  description: "Handles beta work when the user asks for beta.",
  source: "project",
  version: null,
};

function renderModal(overrides: { open?: boolean; language?: string; onClose?: () => void } = {}) {
  return render(
    <AISkillsManagerModal
      open={overrides.open ?? true}
      language={overrides.language ?? "en"}
      onClose={overrides.onClose ?? (() => {})}
    />,
  );
}

/**
 * Scoped helpers: the modal is master–detail, so the selected skill's name and
 * cost chips appear twice (roster row + detail pane) and an unscoped `getByText`
 * would trip over the duplicate.
 */
function pane(selector: string): HTMLElement {
  const element = document.querySelector(selector) as HTMLElement | null;
  if (!element) throw new Error(`expected ${selector} to be rendered`);
  return element;
}

/**
 * The skills manager is the only surface that shows what each enabled skill
 * costs on every run, so the guards here are about the numbers staying honest
 * and the two write paths (enable toggle, scaffolder) reaching the right
 * invoke with the right arguments.
 */
describe("AISkillsManagerModal", () => {
  beforeEach(() => {
    invokeMutationMock.mockReset();
    invokeMutationMock.mockResolvedValue([]);
    useSkillPrefsStore.setState({ disabled: {} });
    useSkillUsageStore.setState({ usage: {} });
  });

  it("lists the discovered catalog and reports enabled/unused/context cost", async () => {
    invokeMutationMock.mockResolvedValue([alpha, beta]);
    useSkillUsageStore.setState({
      usage: { "beta-skill": { runs: 3, lastUsedAt: 1719000000000, lastConnectionId: null } },
    });

    renderModal();

    // Both names come from the backend, not from any local seed list.
    const roster = await waitFor(() => pane(".ai-skills-manager-list"));
    expect(within(roster).getByText("alpha-skill")).toBeInTheDocument();
    expect(within(roster).getByText("beta-skill")).toBeInTheDocument();
    expect(invokeMutationMock).toHaveBeenCalledWith("list_ai_skills", {});

    // 2/2 enabled; only alpha has zero runs, and `unused` means enabled+runs 0.
    const stats = pane(".ai-skills-manager-stats");
    expect(within(stats).getByText("2/2")).toBeInTheDocument();
    expect(within(stats).getByText("1")).toBeInTheDocument();

    // Cost is the sum over ENABLED skills: name + description + 40 framing chars.
    const expected = [alpha, beta].reduce(
      (sum, entry) => sum + entry.name.length + entry.description.length + 40,
      0,
    );
    expect(within(stats).getByText(`~${expected.toLocaleString("en-US")}`)).toBeInTheDocument();

    // Master–detail: unused sorts first, so alpha's record fills the right pane
    // and its description is not repeated in the roster.
    const detail = pane(".ai-skills-manager-detail-pane");
    expect(within(detail).getByText(alpha.description)).toBeInTheDocument();
    expect(within(roster).queryByText(alpha.description)).not.toBeInTheDocument();
  });

  it("marks an enabled-but-never-run skill as unused and counts no cost once disabled", async () => {
    invokeMutationMock.mockResolvedValue([alpha]);
    const user = userEvent.setup();

    renderModal();
    const toggle = await screen.findByRole("switch", { name: "Enable skill alpha-skill" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    const detail = pane(".ai-skills-manager-detail-pane");
    expect(within(detail).getByText("unused")).toBeInTheDocument();

    await user.click(toggle);

    expect(useSkillPrefsStore.getState().disabled["alpha-skill"]).toBe(true);
    expect(toggle).toHaveAttribute("aria-checked", "false");
    // A disabled skill is not injected, so its catalog cost must disappear.
    expect(within(detail).queryByText("unused")).not.toBeInTheDocument();
    expect(within(detail).getByText("no context cost")).toBeInTheDocument();
  });

  it("swaps the detail pane to whichever roster row is picked", async () => {
    invokeMutationMock.mockResolvedValue([alpha, beta]);
    const user = userEvent.setup();

    renderModal();
    const roster = await waitFor(() => pane(".ai-skills-manager-list"));
    // Only the selected skill renders a switch, so the pane — not the roster —
    // is the single place a skill can be toggled.
    expect(screen.getAllByRole("switch")).toHaveLength(1);
    expect(screen.getByRole("switch")).toHaveAccessibleName("Enable skill alpha-skill");

    await user.click(within(roster).getByRole("button", { name: "beta-skill" }));

    const detail = pane(".ai-skills-manager-detail-pane");
    expect(within(detail).getByText(beta.description)).toBeInTheDocument();
    expect(screen.getByRole("switch")).toHaveAccessibleName("Enable skill beta-skill");
    expect(within(roster).getByRole("button", { name: "beta-skill" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("filters rows by name, description, or source and reports an empty result", async () => {
    invokeMutationMock.mockResolvedValue([alpha, beta]);
    const user = userEvent.setup();

    renderModal();
    await screen.findAllByText("alpha-skill");
    const search = screen.getByRole("searchbox", { name: "Search skills" });

    await user.type(search, "project");
    const roster = pane(".ai-skills-manager-list");
    expect(within(roster).getByText("beta-skill")).toBeInTheDocument();
    expect(within(roster).queryByText("alpha-skill")).not.toBeInTheDocument();

    await user.clear(search);
    await user.type(search, "nothing-matches-this");
    expect(screen.getByText('No skill matches "nothing-matches-this".')).toBeInTheDocument();
  });
});
