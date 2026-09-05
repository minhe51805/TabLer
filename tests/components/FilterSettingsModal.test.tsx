import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { FilterSettingsModal } from "../../src/components/Sidebar/Sidebar";

const baseProps = {
  tableOperator: "contains" as const,
  setTableOperator: () => {},
  conditions: [{ id: "c1", column: "", operator: "contains" as const, value: "" }],
  setConditions: () => {},
  conditionLogic: "AND" as const,
  setConditionLogic: () => {},
  onClear: () => {},
  onClose: () => {},
};

afterEach(cleanup);

describe("FilterSettingsModal operator selects", () => {
  it("renders per-row operator select with grouped options and applies changes", () => {
    const ops: string[] = [];
    render(
      <FilterSettingsModal
        {...baseProps}
        setConditions={(cs) => ops.push(cs[0].operator)}
      />,
    );
    const selects = document.body.querySelectorAll<HTMLSelectElement>(
      ".filter-conditions-grid select.filter-operator-select",
    );
    expect(selects.length).toBeGreaterThan(0);
    const gridSelect = selects[0];
    // Grouped options render (SSMS-like categories).
    expect(gridSelect.querySelectorAll("optgroup").length).toBeGreaterThan(0);
    expect(gridSelect.textContent).toContain("Equals");
    // Changing the select updates the condition operator.
    fireEvent.change(gridSelect, { target: { value: "starts_with" } });
    expect(ops[0]).toBe("starts_with");
  });

  it("renders the conditions grid as the only section controls", () => {
    render(<FilterSettingsModal {...baseProps} />);
    // The standalone OPERATOR section was removed; only the conditions-grid
    // operator selects remain inside the modal body.
    expect(document.body.querySelector(".filter-operator-row")).toBeNull();
    const gridSelects = document.body.querySelectorAll<HTMLSelectElement>(
      ".filter-conditions-grid select.filter-operator-select",
    );
    expect(gridSelects.length).toBeGreaterThan(0);
    expect(screen.getAllByText("Equals").length).toBeGreaterThan(0);
  });
});


