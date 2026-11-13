import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MarkdownCard } from "@/components/MetricsBoard/components/MarkdownCard";

afterEach(cleanup);

describe("MarkdownCard link scheme allowlist (security review 2026-11-01)", () => {
  it("renders http/https links as anchors", () => {
    render(<MarkdownCard content="see [docs](https://example.com/docs)" />);
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("https://example.com/docs");
  });

  it("downgrades javascript: targets to plain text", () => {
    render(<MarkdownCard content="click [here](javascript:alert(1))" />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(document.body.innerHTML).not.toContain('href="javascript');
  });

  it("downgrades data: and relative-scheme targets to plain text", () => {
    render(<MarkdownCard content="[a](data:text/html,hi) and [b](vbscript:x)" />);
    expect(screen.queryByRole("link")).toBeNull();
  });
});
