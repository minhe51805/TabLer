// Verifies launcher grouping + card context menu (Move to group) rendering.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ConnectionListView } from "./ConnectionListView";
import { STARTUP_COPY } from "./startup-copy";
import type { ConnectionConfig, ConnectionGroup } from "./types";

vi.mock("../../i18n", () => ({
  useI18n: () => ({ t: (key: string) => key, language: "en" }),
}));

const conn = (id: string, groupId?: string): ConnectionConfig =>
  ({
    id,
    name: `Conn ${id}`,
    db_type: "postgresql",
    host: "localhost",
    use_ssl: false,
    groupId,
  }) as ConnectionConfig;

const groups: ConnectionGroup[] = [{ id: "g1", name: "Prod", color: "#e74c3c" }];

function renderList(connections: ConnectionConfig[], overrides = {}) {
  const props = {
    search: "",
    onSearchChange: vi.fn(),
    layoutMode: "stacked" as const,
    onLayoutModeChange: vi.fn(),
    isConnecting: false,
    filteredConnections: connections,
    selectedConnectionId: null,
    activeConnectionId: null,
    connectedIds: new Set<string>(),
    groups,
    tags: [],
    collapsedGroupIds: new Set<string>(),
    onSelectConnection: vi.fn(),
    onConnect: vi.fn(),
    onDeleteConnection: vi.fn(),
    onRenameConnection: vi.fn(),
    onHover: vi.fn(),
    onLeaveHover: vi.fn(),
    onNewConnection: vi.fn(),
    onOpenDatabaseFile: vi.fn(),
    showEmptyStateCtas: false,
    sampleCopy: STARTUP_COPY.en.sampleCard,
    isCreatingSample: false,
    onCreateSample: vi.fn(),
    onImportConnections: vi.fn(),
    importCtaCopy: STARTUP_COPY.en.importCta,
    onToggleGroup: vi.fn(),
    onRenameGroup: vi.fn(),
    onChangeGroupColor: vi.fn(),
    onDeleteGroup: vi.fn(),
    onAssignToGroup: vi.fn(),
    onCreateAndAssignGroup: vi.fn(),
    groupsCopy: STARTUP_COPY.en.groups,
    listRef: { current: null },
    pingResults: new Map(),
    isPingingAll: false,
    onPingAll: vi.fn(),
    pingAllCopy: STARTUP_COPY.en.pingAll,
    ...overrides,
  };
  return render(<ConnectionListView {...props} />);
}

describe("ConnectionListView grouping", () => {
  beforeEach(() => window.localStorage.clear());

  it("renders grouped connections under a header, ungrouped last", () => {
    renderList([conn("a", "g1"), conn("b")]);
    expect(screen.getByText("Prod")).toBeInTheDocument();
    const titles = screen.getAllByText(/Conn /);
    expect(titles[0].textContent).toBe("Conn a");
    expect(titles[1].textContent).toBe("Conn b");
  });

  it("collapsed group hides its connections", () => {
    renderList([conn("a", "g1"), conn("b")], {
      collapsedGroupIds: new Set(["g1"]),
    });
    expect(screen.queryByText("Conn a")).not.toBeInTheDocument();
    expect(screen.getByText("Conn b")).toBeInTheDocument();
  });

  it("right-click opens context menu and assigns to group", () => {
    const onAssignToGroup = vi.fn();
    renderList([conn("b")], { onAssignToGroup });
    fireEvent.contextMenu(screen.getByText("Conn b").closest(".startup-connection-row")!);
    expect(screen.getByText("Move to group")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Prod"));
    expect(onAssignToGroup).toHaveBeenCalledWith("b", "g1");
  });

  it("New group… shows inline input and creates+assigns", () => {
    const onCreateAndAssignGroup = vi.fn();
    renderList([conn("b")], { onCreateAndAssignGroup });
    fireEvent.contextMenu(screen.getByText("Conn b").closest(".startup-connection-row")!);
    fireEvent.click(screen.getByText("New group…"));
    const input = screen.getByPlaceholderText("Group name");
    fireEvent.change(input, { target: { value: "Staging" } });
    fireEvent.click(screen.getByText("Create"));
    expect(onCreateAndAssignGroup).toHaveBeenCalledWith("b", "Staging");
  });

  it("renders connection color as accent bar and avatar tint", () => {
    const colored = { ...conn("c"), color: "#ff0000" };
    const { container } = renderList([colored]);
    const accent = container.querySelector(".startup-connection-accent") as HTMLElement;
    expect(accent.style.backgroundColor).toBe("rgb(255, 0, 0)");
    const avatar = container.querySelector(".startup-connection-avatar") as HTMLElement;
    expect(avatar.style.backgroundColor).toBe("rgb(255, 0, 0)");
  });
});

describe("ConnectionListView empty-state CTAs", () => {
  it("shows create, sample, and import actions when the launcher is empty", () => {
    const onNewConnection = vi.fn();
    const onCreateSample = vi.fn();
    const onImportConnections = vi.fn();
    const { container } = renderList([], {
      showEmptyStateCtas: true,
      onNewConnection,
      onCreateSample,
      onImportConnections,
    });

    const empty = container.querySelector(".startup-manager-empty")!;
    const buttons = empty.querySelectorAll("button");
    expect(buttons).toHaveLength(3);

    fireEvent.click(buttons[0]);
    expect(onNewConnection).toHaveBeenCalledTimes(1);

    fireEvent.click(buttons[1]);
    expect(onCreateSample).toHaveBeenCalledTimes(1);

    fireEvent.click(buttons[2]);
    expect(onImportConnections).toHaveBeenCalledTimes(1);
  });

  it("hides the CTAs when the list is only filtered to zero", () => {
    const { container } = renderList([], { showEmptyStateCtas: false });
    const empty = container.querySelector(".startup-manager-empty")!;
    expect(empty.querySelectorAll("button")).toHaveLength(0);
  });
});
