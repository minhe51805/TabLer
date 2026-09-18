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

// A workspace skill lives in the user's own repository, so it is read-only in
// the manager — the app only ever writes the global skills root.
const beta = {
  name: "beta-skill",
  description: "Handles beta work when the user asks for beta.",
  source: "workspace",
  version: null,
};

/** What `read_ai_skill` returns for a stored, editable skill. */
const alphaContent = {
  name: "alpha-skill",
  description: alpha.description,
  source: "global",
  body: "# alpha-skill\n\nDo the alpha thing.",
  version: "1.0.0",
  license: null,
  model: null,
  effort: null,
  allowedTools: ["run_readonly_sql"],
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

    await user.type(search, "workspace");
    const roster = pane(".ai-skills-manager-list");
    expect(within(roster).getByText("beta-skill")).toBeInTheDocument();
    expect(within(roster).queryByText("alpha-skill")).not.toBeInTheDocument();

    await user.clear(search);
    await user.type(search, "nothing-matches-this");
    expect(screen.getByText('No skill matches "nothing-matches-this".')).toBeInTheDocument();
  });

  it("creates a skill from the editor form instead of a bare name field", async () => {
    invokeMutationMock.mockImplementation((command: string) => {
      if (command === "list_ai_skills") return Promise.resolve([]);
      if (command === "create_ai_skill") return Promise.resolve("/data/skills/db-audit");
      return Promise.resolve(null);
    });
    const user = userEvent.setup({ delay: null });

    renderModal();
    await user.click(await screen.findByRole("button", { name: "New skill" }));

    // The editor replaces the roster, so the two states cannot be confused.
    expect(screen.queryByRole("searchbox", { name: "Search skills" })).not.toBeInTheDocument();

    // The button stays disabled until the name is valid — validation mirrors
    // `validate_skill_name` in ai_skills.rs.
    const submit = screen.getByRole("button", { name: "Create skill" });
    expect(submit).toBeDisabled();
    const nameField = screen.getByLabelText("Skill name");
    await user.type(nameField, "db audit");
    expect(screen.getByRole("alert")).toHaveTextContent("letters, digits");
    await user.clear(nameField);
    await user.type(nameField, "db-audit");
    expect(submit).toBeEnabled();

    // Long fields are pasted: the per-keystroke path is indistinguishable here
    // and slow enough to time the suite out.
    await user.click(screen.getByLabelText("Description"));
    await user.paste("Use this when auditing a schema.");
    await user.click(screen.getByLabelText("SKILL.md body"));
    await user.paste("# db-audit\n\nRun EXPLAIN.");
    await user.click(submit);

    await waitFor(() =>
      expect(invokeMutationMock).toHaveBeenCalledWith("create_ai_skill", {
        name: "db-audit",
        description: "Use this when auditing a schema.",
        body: "# db-audit\n\nRun EXPLAIN.",
      }),
    );
    // The catalog is re-read from disk rather than patched from local state.
    await waitFor(() =>
      expect(
        invokeMutationMock.mock.calls.filter(([command]) => command === "list_ai_skills"),
      ).toHaveLength(2),
    );
    expect(screen.getByRole("searchbox", { name: "Search skills" })).toBeInTheDocument();
  });

  it("loads a stored skill into the editor and saves the whole record", async () => {
    invokeMutationMock.mockImplementation((command: string) => {
      if (command === "list_ai_skills") return Promise.resolve([alpha]);
      if (command === "read_ai_skill") return Promise.resolve(alphaContent);
      if (command === "update_ai_skill") return Promise.resolve("/data/skills/alpha-skill");
      return Promise.resolve(null);
    });
    const user = userEvent.setup({ delay: null });

    renderModal();
    const roster = await waitFor(() => pane(".ai-skills-manager-list"));
    await user.click(within(roster).getByRole("button", { name: "alpha-skill" }));
    await user.click(screen.getByRole("button", { name: "Edit" }));

    expect(invokeMutationMock).toHaveBeenCalledWith("read_ai_skill", { name: "alpha-skill" });
    const body = await screen.findByLabelText("SKILL.md body");
    expect(body).toHaveValue(alphaContent.body);
    // The name is the directory, so it is shown but locked; the tool list is
    // round-tripped as comma-separated text.
    expect(screen.getByLabelText("Skill name")).toHaveAttribute("readonly");
    expect(screen.getByLabelText("Allowed tools")).toHaveValue("run_readonly_sql");

    await user.clear(body);
    await user.click(body);
    await user.paste("# alpha-skill\n\nDo the beta thing.");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(invokeMutationMock).toHaveBeenCalledWith("update_ai_skill", {
        name: "alpha-skill",
        description: alpha.description,
        body: "# alpha-skill\n\nDo the beta thing.",
        version: "1.0.0",
        allowedTools: ["run_readonly_sql"],
        license: null,
        model: null,
        effort: null,
      }),
    );
  });

  it("keeps Edit disabled for a workspace skill the app must not rewrite", async () => {
    invokeMutationMock.mockResolvedValue([beta]);

    renderModal();
    const detail = await waitFor(() => pane(".ai-skills-manager-detail-pane"));
    await waitFor(() => expect(within(detail).getByText(beta.description)).toBeInTheDocument());

    expect(within(detail).getByRole("button", { name: "Edit" })).toBeDisabled();
  });
});
