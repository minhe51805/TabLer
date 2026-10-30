import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  INSECURE_TLS_DISMISSAL_KEY,
  InsecureTlsWarning,
} from "@/components/ConnectionForm/InsecureTlsWarning";

const warning = {
  insecure: true as const,
  reason: "TLS is disabled for this connection.",
};

describe("InsecureTlsWarning", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it("persists dismissal so the warning is shown only once", () => {
    const first = render(<InsecureTlsWarning warning={warning} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Insecure TLS configuration");

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(window.localStorage.getItem(INSECURE_TLS_DISMISSAL_KEY)).toBe("1");

    first.unmount();
    render(<InsecureTlsWarning warning={warning} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
