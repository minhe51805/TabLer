import { describe, expect, it } from "vitest";

import { resolveDesktopWindowProfile } from "@/hooks/useDesktopWindow";

describe("resolveDesktopWindowProfile", () => {
  it("uses the workspace profile for a connected session", () => {
    expect(
      resolveDesktopWindowProfile({
        isConnected: true,
        isConnecting: false,
        isConnectionFormOpen: false,
        suspendProfileSync: false,
      }),
    ).toBe("workspace");
  });

  it("selects form or launcher for disconnected sessions", () => {
    const base = {
      isConnected: false,
      isConnecting: false,
      suspendProfileSync: false,
    };
    expect(resolveDesktopWindowProfile({ ...base, isConnectionFormOpen: true })).toBe("form");
    expect(resolveDesktopWindowProfile({ ...base, isConnectionFormOpen: false })).toBe(
      "launcher",
    );
  });

  it("does not change profiles while connection state is transitional", () => {
    expect(
      resolveDesktopWindowProfile({
        isConnected: false,
        isConnecting: true,
        isConnectionFormOpen: false,
        suspendProfileSync: false,
      }),
    ).toBeNull();
    expect(
      resolveDesktopWindowProfile({
        isConnected: false,
        isConnecting: false,
        isConnectionFormOpen: false,
        suspendProfileSync: true,
      }),
    ).toBeNull();
  });
});
