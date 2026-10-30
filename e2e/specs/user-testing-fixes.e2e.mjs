import { browser, $, $$ } from "@wdio/globals";
import { connectionConfig, connectionId, invoke, waitForApp } from "../helpers.mjs";

describe("TableR user testing fixes — T4/T5/T7 regression", () => {
  it("verifies the three genuine UX failures are fixed", async function () {
    this.timeout(300_000);
    await waitForApp();
    await browser.setWindowSize(1280, 900);
    await invoke("connect_database", { config: connectionConfig() });
    await invoke("disconnect_database", { connectionId });
    await invoke("connect_saved_connection", { connectionId });
    const saved = await invoke("get_saved_connections");
    if (!Array.isArray(saved) || saved.length === 0) throw new Error("Bootstrap failed");
    const skip = await $("button.onboarding-skip");
    if (await skip.isDisplayed()) {
      await skip.click();
      await $(".onboarding-tour").waitForDisplayed({ timeout: 5_000, reverse: true });
    }
    await browser.execute(() => window.location.reload());
    await waitForApp();
    await browser.setWindowSize(1280, 900);
    if (await skip.isDisplayed()) {
      await skip.click();
      await $(".onboarding-tour").waitForDisplayed({ timeout: 5_000, reverse: true });
    }
    const openConnection = await $(
      `[data-testid="connection-${connectionId}"] .startup-connection-open`,
    );
    await browser.waitUntil(
      async () =>
        (await $('[data-testid="database-current"]').isDisplayed()) ||
        (await openConnection.isDisplayed()),
      { timeout: 30_000, interval: 200 },
    );
    if (!(await $('[data-testid="database-current"]').isDisplayed())) {
      await openConnection.click();
    }
    await $('[data-testid="database-current"]').waitForDisplayed({ timeout: 30_000 });

    // ── T4 fix: Query Schedules is reachable via keyboard shortcut ────────────
    await browser.keys(["Control", "Shift", "Q"]);
    await $(".fav-panel").waitForDisplayed({ timeout: 10_000 });
    const scheduleTitle = await $(".fav-panel").getText();
    if (!scheduleTitle.toLowerCase().includes("schedule")) {
      throw new Error(`Expected schedule panel, got: ${scheduleTitle.slice(0, 80)}`);
    }
    await $(".fav-close").click();
    await browser.pause(500);

    // ── T4 fix: Query Schedules is reachable via command palette ──────────────
    await browser.keys(["Control", "Shift", "P"]);
    const palette = await $(".command-palette");
    await palette.waitForDisplayed({ timeout: 10_000 });
    const input = await $(".command-palette-input");
    await input.click();
    await browser.keys("schedules");
    await browser.pause(500);
    const items = await $$(".command-palette-item");
    if (items.length === 0) throw new Error("Command palette found no 'schedules' command");
    const itemText = await items[0].getText();
    if (!itemText.toLowerCase().includes("schedule")) {
      throw new Error(`Expected schedules command, got: ${itemText.slice(0, 80)}`);
    }
    await items[0].click();
    await $(".fav-panel").waitForDisplayed({ timeout: 10_000 });
    await $(".fav-close").click();
    await browser.pause(500);

    // ── T7 fix: Structure button is visible without hover ─────────────────────
    const folder = await $(
      '//button[contains(concat(" ", normalize-space(@class), " "), " explorer-folder-row ")][contains(., "Tables")]',
    );
    if ((await folder.getAttribute("aria-expanded")) !== "true") await folder.click();
    const row = await $('[data-testid="table-public-smoke_items"]');
    await row.waitForDisplayed({ timeout: 10_000 });
    const rowParent = await row.$("..");
    const structureBtn = await rowParent.$(".explorer-structure-btn");
    const opacity = await browser.execute((el) => getComputedStyle(el).opacity, structureBtn);
    if (parseFloat(opacity) < 1) {
      throw new Error(`Structure button opacity is ${opacity}, expected 1 (always visible)`);
    }
    await structureBtn.click();
    await $(".explorer-context-menu").waitForDisplayed({ timeout: 8_000 });
    const openStructure = await $('//button[contains(normalize-space(.), "Open structure")]');
    await openStructure.waitForDisplayed({ timeout: 8_000 });
    await openStructure.click();
    await $(".structure-shell").waitForDisplayed({ timeout: 20_000 });

    // ── T5 fix: Export Connections has X close button and Escape handler ─────
    await $('button[aria-label="Open app menu"]').click();
    await browser.pause(400);
    const exportItem = await $('//button[contains(normalize-space(.), "Export Connections")]');
    await exportItem.waitForDisplayed({ timeout: 8_000 });
    await exportItem.click();
    await $(".cex-modal").waitForDisplayed({ timeout: 10_000 });
    // Verify X close button exists and is visible
    const closeBtn = await $(".cex-close-btn");
    if (!(await closeBtn.isDisplayed())) {
      throw new Error("Export Connections X close button is missing");
    }
    // Close via X button
    await closeBtn.click();
    await browser.pause(500);
    const stillOpen = await $(".cex-modal")
      .isDisplayed()
      .catch(() => false);
    if (stillOpen) throw new Error("X close button did not close Export Connections");
    // Reopen and close via Escape
    await $('button[aria-label="Open app menu"]').click();
    await browser.pause(300);
    const exportItem2 = await $('//button[contains(normalize-space(.), "Export Connections")]');
    await exportItem2.waitForDisplayed({ timeout: 8_000 });
    await exportItem2.click();
    await $(".cex-modal").waitForDisplayed({ timeout: 10_000 });
    await browser.keys(["Escape"]);
    await browser.pause(500);
    const stillOpen2 = await $(".cex-modal")
      .isDisplayed()
      .catch(() => false);
    if (stillOpen2) throw new Error("Escape did not close Export Connections");
  });
});
