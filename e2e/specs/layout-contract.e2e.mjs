import { browser, $ } from "@wdio/globals";
import { connectionConfig, connectionId, invoke, waitForApp } from "../helpers.mjs";

function parseColor(value) {
  const channels = value.match(/[\d.]+/g)?.map(Number) ?? [];
  return { channels: channels.slice(0, 3), alpha: channels.length > 3 ? channels[3] : 1 };
}

function linearize(channel) {
  const normalized = channel / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function contrastRatio(foregroundValue, backgroundValue) {
  const foreground = parseColor(foregroundValue);
  const background = parseColor(backgroundValue);
  const composite = foreground.channels.map(
    (channel, index) =>
      foreground.alpha * channel + (1 - foreground.alpha) * background.channels[index],
  );
  const foregroundLuminance =
    0.2126 * linearize(composite[0]) +
    0.7152 * linearize(composite[1]) +
    0.0722 * linearize(composite[2]);
  const backgroundLuminance =
    0.2126 * linearize(background.channels[0]) +
    0.7152 * linearize(background.channels[1]) +
    0.0722 * linearize(background.channels[2]);
  return (
    (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
  );
}

describe("TableR UI layout contract", () => {
  before(async () => {
    await waitForApp();
    await invoke("connect_database", { config: connectionConfig() });
    await invoke("disconnect_database", { connectionId });
    await invoke("connect_saved_connection", { connectionId });
    const skip = await $("button.onboarding-skip");
    if (await skip.isDisplayed()) {
      await skip.click();
      await $(".onboarding-tour").waitForDisplayed({ timeout: 5_000, reverse: true });
    }
    const openConnection = await $(
      `[data-testid="connection-${connectionId}"] .startup-connection-open`,
    );
    await openConnection.waitForDisplayed({ timeout: 30_000 });
    await openConnection.click();
    await $('[data-testid="database-current"]').waitForDisplayed({ timeout: 30_000 });
    const trigger = await $('[data-tour="ai-trigger"]');
    await trigger.waitForDisplayed({ timeout: 10_000 });
    await trigger.click();
    await $(".ai-workspace-composer-textarea").waitForDisplayed({ timeout: 10_000 });
  });

  it("keeps the ER toolbar inside its container when the AI sidebar is open", async () => {
    const trigger = await $('button[title="ER Diagram"]');
    await trigger.waitForDisplayed({ timeout: 10_000 });
    await trigger.click();
    const topbar = await $(".erd-topbar");
    await topbar.waitForDisplayed({ timeout: 10_000 });

    const layout = await browser.execute(() => {
      const bar = document.querySelector(".erd-topbar");
      const heading = bar?.querySelector(".erd-topbar-heading");
      const stats = bar?.querySelector(".erd-toolbar-stats");
      return {
        width: bar?.getBoundingClientRect().width ?? 0,
        scrollWidth: bar?.scrollWidth ?? 0,
        headingWidth: heading?.getBoundingClientRect().width ?? 0,
        statsHeight: stats?.getBoundingClientRect().height ?? 0,
        statsScrollHeight: stats?.scrollHeight ?? 0,
      };
    });
    if (layout.headingWidth <= 0) {
      throw new Error(`ER heading collapsed: ${JSON.stringify(layout)}`);
    }
    if (layout.scrollWidth > layout.width + 1) {
      throw new Error(`ER toolbar overflows horizontally: ${JSON.stringify(layout)}`);
    }
    if (layout.statsScrollHeight > layout.statsHeight + 1) {
      throw new Error(`ER stats are clipped vertically: ${JSON.stringify(layout)}`);
    }
  });

  it("keeps the AI prompt placeholder at WCAG AA contrast", async () => {
    const style = await browser.execute(() => {
      const textarea = document.querySelector(".ai-workspace-composer-textarea");
      if (!textarea) return null;
      return {
        color: getComputedStyle(textarea, "::placeholder").color,
        backgroundColor: getComputedStyle(textarea.closest(".ai-workspace-compose-box") ?? textarea)
          .backgroundColor,
      };
    });
    if (!style) throw new Error("AI composer is missing");
    const ratio = contrastRatio(style.color, style.backgroundColor);
    if (ratio < 4.5) {
      throw new Error(
        `AI placeholder contrast ${ratio.toFixed(2)}:1 is below 4.5:1: ${JSON.stringify(style)}`,
      );
    }
  });
});
