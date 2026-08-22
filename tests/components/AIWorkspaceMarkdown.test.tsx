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
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(sql));
  });

  it("leaves non-sql code blocks unhighlighted", () => {
    render(<AIWorkspaceMarkdown text={"```text\nplain notes```"} />);

    expect(document.querySelector(".tok-kw")).toBeNull();
    expect(screen.getByText(/plain notes/)).toBeInTheDocument();
  });
});
