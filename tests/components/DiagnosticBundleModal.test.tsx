import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { DiagnosticBundleModal } from "@/components/DiagnosticBundleModal";

const mockedInvoke = vi.mocked(invoke);

describe("DiagnosticBundleModal", () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
  });

  it("requires a reviewed preview before exporting the diagnostic bundle", async () => {
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "preview_diagnostic_bundle") {
        return {
          reviewId: "review-once",
          expiresAt: "2026-07-18T10:10:00Z",
          categories: ["App version and operating system", "Redacted application logs"],
          logEntries: 12,
          estimatedBytes: 2_048,
          excluded: [
            "Saved connections and credentials",
            "AI keys and conversation data",
            "Query results and database rows",
          ],
        };
      }
      if (command === "export_diagnostic_bundle") {
        return "C:\\Temp\\tabler-diagnostics.json";
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const onClose = vi.fn();

    render(<DiagnosticBundleModal onClose={onClose} />);

    const exportButton = screen.getByRole("button", { name: "Choose location and export" });
    expect(exportButton).toBeDisabled();
    expect(await screen.findByText("Redacted application logs")).toBeInTheDocument();
    expect(screen.getByText("Saved connections and credentials")).toBeInTheDocument();
    expect(screen.getByText("Query results and database rows")).toBeInTheDocument();
    expect(screen.getByText("12 log entries, approximately 2 KB.")).toBeInTheDocument();
    expect(exportButton).toBeEnabled();

    fireEvent.click(exportButton);

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith("export_diagnostic_bundle", {
        reviewId: "review-once",
      });
      expect(onClose).toHaveBeenCalledOnce();
    });
  });

  it("keeps export disabled when preview generation fails", async () => {
    mockedInvoke.mockRejectedValueOnce(new Error("Logs are unavailable"));

    render(<DiagnosticBundleModal onClose={vi.fn()} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Logs are unavailable");
    expect(screen.getByRole("button", { name: "Choose location and export" })).toBeDisabled();
    expect(mockedInvoke).toHaveBeenCalledWith("preview_diagnostic_bundle");
  });
});
