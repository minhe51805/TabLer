import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { GenerateTestRowsDialog } from "@/components/GenerateTestRows/GenerateTestRowsDialog";
import { useChangeTrackingStore } from "@/stores/change-tracking-store";
import type { ColumnDetail } from "@/types";

vi.mock("@/utils/app-toast", () => ({
  emitAppToast: vi.fn(),
}));

const COLUMNS: ColumnDetail[] = [
  {
    name: "id",
    data_type: "int",
    is_nullable: false,
    is_primary_key: true,
    extra: "auto_increment",
  },
  {
    name: "email",
    data_type: "varchar",
    column_type: "varchar(255)",
    is_nullable: false,
    is_primary_key: false,
  },
  { name: "age", data_type: "int", is_nullable: true, is_primary_key: false },
];

describe("GenerateTestRowsDialog", () => {
  beforeEach(() => {
    useChangeTrackingStore.setState({
      stagedChanges: [],
      history: [],
      future: [],
      isPreviewOpen: false,
      selectedChangeId: null,
      _columnNameMap: {},
      _dbTypeMap: {},
    });
  });

  it("stages N generated rows and opens the review modal on generate", () => {
    render(
      <GenerateTestRowsDialog
        tableName="users"
        database="app"
        columns={COLUMNS}
        onClose={() => {}}
      />,
    );

    const countInput = screen.getByLabelText("Rows to generate");
    fireEvent.change(countInput, { target: { value: "7" } });
    fireEvent.click(screen.getByText("Generate & stage"));

    const state = useChangeTrackingStore.getState();
    expect(state.stagedChanges).toHaveLength(7);
    expect(state.isPreviewOpen).toBe(true);
    for (const change of state.stagedChanges) {
      expect(change.type).toBe("insert");
      expect(change.tableName).toBe("users");
      // Auto-increment PK is skipped; email/age are present.
      expect(change.sqlPreview).toMatch(/^INSERT INTO users \(email, age\) VALUES \(/);
    }
  });

  it("disables generate for out-of-range counts", () => {
    render(<GenerateTestRowsDialog tableName="users" columns={COLUMNS} onClose={() => {}} />);
    const countInput = screen.getByLabelText("Rows to generate");
    fireEvent.change(countInput, { target: { value: "0" } });
    expect(screen.getByText("Generate & stage")).toBeDisabled();
    fireEvent.change(countInput, { target: { value: "2000" } });
    expect(screen.getByText("Generate & stage")).toBeDisabled();
  });

  it("shows the no-columns message when every column is auto-generated", () => {
    render(
      <GenerateTestRowsDialog
        tableName="users"
        columns={[
          {
            name: "id",
            data_type: "int",
            is_nullable: false,
            is_primary_key: true,
            extra: "auto_increment",
          },
        ]}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText(/No seedable columns/)).toBeInTheDocument();
  });
});
