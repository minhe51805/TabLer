import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { notifyQueryDone, QUERY_NOTIFY_SLOW_MS } from "@/utils/query-notify";
// eslint's env lacks DOM lib types — declare them locally for the stand-in.
type NotifyPermission = "granted" | "denied" | "default";
type NotifyOptions = { body?: string };

// jsdom has no Notification API — install a controllable stand-in.
class FakeNotification {
  static instances: FakeNotification[] = [];
  static permission: NotifyPermission = "granted";
  static requestPermissionMock = vi.fn<() => Promise<NotifyPermission>>();

  title: string;
  body?: string;

  constructor(title: string, options?: NotifyOptions) {
    this.title = title;
    this.body = options?.body;
    FakeNotification.instances.push(this);
  }

  static requestPermission(): Promise<NotifyPermission> {
    return FakeNotification.requestPermissionMock();
  }
}

const win = window as unknown as { Notification: unknown };

beforeEach(() => {
  FakeNotification.instances = [];
  FakeNotification.permission = "granted";
  FakeNotification.requestPermissionMock.mockReset().mockResolvedValue("granted");
  win.Notification = FakeNotification;
});

afterEach(() => {
  delete win.Notification;
});

describe("notifyQueryDone gating", () => {
  it("stays silent for fast runs on a focused window", async () => {
    await notifyQueryDone({ durationMs: 500, rowCount: 10 });

    expect(FakeNotification.instances).toEqual([]);
    expect(FakeNotification.requestPermissionMock).not.toHaveBeenCalled();
  });

  it("notifies for slow runs even while the window is focused", async () => {
    await notifyQueryDone({ durationMs: QUERY_NOTIFY_SLOW_MS + 1, rowCount: 7 });

    expect(FakeNotification.instances).toHaveLength(1);
    expect(FakeNotification.instances[0].title).toBeTruthy();
    expect(FakeNotification.instances[0].body).toContain("7");
  });

  it("notifies for fast runs when the document is hidden", async () => {
    const hiddenSpy = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    try {
      await notifyQueryDone({ durationMs: 100, rowCount: 1 });
    } finally {
      hiddenSpy.mockRestore();
    }

    expect(FakeNotification.instances).toHaveLength(1);
  });

  it("uses the failure copy when the run errored", async () => {
    await notifyQueryDone({
      durationMs: QUERY_NOTIFY_SLOW_MS + 1,
      error: new Error("syntax error near WHERE"),
    });

    expect(FakeNotification.instances).toHaveLength(1);
    expect(FakeNotification.instances[0].body).toContain("syntax error near WHERE");
  });
});

describe("notifyQueryDone permission handling", () => {
  it("never constructs a notification when permission is denied", async () => {
    FakeNotification.permission = "denied";

    await notifyQueryDone({ durationMs: QUERY_NOTIFY_SLOW_MS + 1 });

    expect(FakeNotification.instances).toEqual([]);
    expect(FakeNotification.requestPermissionMock).not.toHaveBeenCalled();
  });
  // NOTE ordering: `permissionRequest` is a module-level cache — the first
  // default-permission test wins it for the whole file. The refusal case must
  // run before any granted one.
  it("a refused prompt is remembered too — no repeat prompts", async () => {
    FakeNotification.permission = "default";
    FakeNotification.requestPermissionMock.mockRejectedValue(new Error("user refused"));

    await notifyQueryDone({ durationMs: QUERY_NOTIFY_SLOW_MS + 1 });
    await notifyQueryDone({ durationMs: QUERY_NOTIFY_SLOW_MS + 1 });

    expect(FakeNotification.requestPermissionMock).toHaveBeenCalledTimes(1);
    expect(FakeNotification.instances).toEqual([]);
  });

  it("reuses the session's cached permission answer across queries", async () => {
    // The module already cached the refused request above: even with a fresh
    // "default" permission and a granted-leaning mock, no second prompt fires.
    // This is the dedupe contract — one prompt per session, whatever the answer.
    FakeNotification.permission = "default";

    await notifyQueryDone({ durationMs: QUERY_NOTIFY_SLOW_MS + 1 });

    expect(FakeNotification.requestPermissionMock).not.toHaveBeenCalled();
    expect(FakeNotification.instances).toEqual([]);
  });

  it("swallows a throwing Notification constructor", async () => {
    win.Notification = class {
      constructor() {
        throw new Error("webview blocked");
      }
      static permission = "granted";
    };

    await expect(
      notifyQueryDone({ durationMs: QUERY_NOTIFY_SLOW_MS + 1 }),
    ).resolves.toBeUndefined();
  });
});
