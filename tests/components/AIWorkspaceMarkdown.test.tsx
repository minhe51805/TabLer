import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AIWorkspaceMarkdown } from "@/components/AISlidePanel/AIWorkspaceMarkdown";

describe("AIWorkspaceMarkdown", () => {
  const writeText = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    writeText.mockClear();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
  });

  it("renders --- lines as separators instead of literal text", () => {
    const { container } = render(
      <AIWorkspaceMarkdown text={"Execution details\n---\nReturned 10 rows."} />,
    );

    expect(container.querySelector(".ai-workspace-markdown-hr")).toBeInTheDocument();
    expect(screen.queryByText("---")).not.toBeInTheDocument();
    expect(screen.getByText(/Returned 10 rows\./)).toBeInTheDocument();
  });

  it("renders sql code blocks with a language label and a working copy button", async () => {
    const sql = "SELECT id, name\nFROM public.users\nWHERE id = 42;";
    render(<AIWorkspaceMarkdown text={`\`\`\`sql\n${sql}\n\`\`\``} />);

    expect(screen.getByText("sql")).toBeInTheDocument();
    expect(document.querySelector(".ai-workspace-markdown-code .tok-kw")).toHaveTextContent(
      "SELECT",
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining("FROM")));
    // Copy returns the pretty-printed SQL the user actually sees.
    const copied = writeText.mock.calls[0][0] as string;
    expect(copied.replace(/\s+/g, " ").trim()).toBe(sql.replace(/\s+/g, " ").trim());
  });

  it("pretty-prints an unfenced single-line SQL paragraph without a semicolon", () => {
    const sql =
      "SELECT u.id, u.email FROM public.users u JOIN public.roles r ON r.id = u.role_id WHERE u.email = 'a@b.c' ORDER BY u.id";
    render(<AIWorkspaceMarkdown text={sql} />);

    // Detected as SQL and rendered as a formatted code frame, not prose.
    expect(screen.getByText("sql")).toBeInTheDocument();
    const code = document.querySelector(".ai-workspace-markdown-code");
    expect(code).not.toBeNull();
    expect(code?.textContent).toContain("\n");
  });
  it("leaves non-sql code blocks unhighlighted", () => {
    render(<AIWorkspaceMarkdown text={"```text\nplain notes```"} />);

    expect(document.querySelector(".tok-kw")).toBeNull();
    expect(screen.getByText(/plain notes/)).toBeInTheDocument();
  });
});
