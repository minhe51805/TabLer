import { beforeEach, describe, expect, it } from "vitest";
import {
  approveDataRead,
  dataReadScopeKey,
  isDataReadApproved,
  revokeDataRead,
} from "../../src/components/AISlidePanel/ai-data-read-approvals";

describe("ai-data-read-approvals", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("remembers an approval per connection + database", () => {
    expect(isDataReadApproved("conn-1", "shop")).toBe(false);

    approveDataRead("conn-1", "shop");

    expect(isDataReadApproved("conn-1", "shop")).toBe(true);
  });

  it("approval survives an app restart because storage has no cache", () => {
    approveDataRead("conn-1", "shop");
    // Every call re-reads localStorage, so a fresh mount (new session)
    // still sees the approval — the prompt must not re-appear.
    expect(isDataReadApproved("conn-1", "shop")).toBe(true);
  });

  it("switching to a different database re-arms the prompt", () => {
    approveDataRead("conn-1", "shop");

    expect(isDataReadApproved("conn-1", "analytics")).toBe(false);
    expect(isDataReadApproved("conn-2", "shop")).toBe(false);
  });

  it("revoking only clears the current database", () => {
    approveDataRead("conn-1", "shop");
    approveDataRead("conn-1", "analytics");

    revokeDataRead("conn-1", "shop");

    expect(isDataReadApproved("conn-1", "shop")).toBe(false);
    expect(isDataReadApproved("conn-1", "analytics")).toBe(true);
  });

  it("treats a missing database as its own scope", () => {
    approveDataRead("conn-1", null);

    expect(isDataReadApproved("conn-1", "shop")).toBe(false);
    expect(dataReadScopeKey("conn-1", null)).toBe("conn-1:no-database");
  });

  it("never throws on corrupt stored data", () => {
    window.localStorage.setItem("tabler.ai.dataReadApprovals.v1", "{not json");

    expect(isDataReadApproved("conn-1", "shop")).toBe(false);

    approveDataRead("conn-1", "shop");
    expect(isDataReadApproved("conn-1", "shop")).toBe(true);
  });
});
