import { browser, $, $$ } from "@wdio/globals";
import { connectionConfig, connectionId, invoke, waitForApp } from "../helpers.mjs";

// T9 — "the skills manager shows the aggregated pack" user journey:
// a user opens the AI panel, opens Agent Skills, finds the new DuckDB skill,
// sees the bumped versions, and closes the manager. Mirrors the T4/T5/T7
// journey shape in e2e/specs/user-testing-fixes.e2e.mjs.
describe("user testing T9 — skills manager shows the aggregated pack", () => {
  before(async function () {
    this.timeout(120_000);
    await waitForApp();
    await browser.setWindowSize(1280, 900);
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
    await openConnection.waitForDisplayed({ timeout: 60_000 });
    await openConnection.click();
    await $('[data-testid="database-current"]').waitForDisplayed({ timeout: 60_000 });
    const trigger = await $('[data-tour="ai-trigger"]');
    await trigger.waitForDisplayed({ timeout: 10_000 });
    await trigger.click();
    await $(".ai-workspace-composer-textarea").waitForDisplayed({ timeout: 10_000 });
  });

  it("lists 11 built-in skills and serves the new one with its version", async function () {
    this.timeout(120_000);
    // The toolbar button's title is localized ("Agent Skills" / "Quản lý Agent
    // Skills") — match on the stable substring, not the full string.
    const skillsBtn = await $('button.toolbar-btn.icon-only[title*="Agent Skills"]');
    await skillsBtn.waitForDisplayed({ timeout: 10_000 });
    await skillsBtn.click();

    const modal = await $(".ai-skills-manager-modal");
    await modal.waitForDisplayed({ timeout: 10_000 });

    // No load-error banner: a broken SKILL.md would surface here first.
    const loadErrors = await $$(".ai-skills-manager-error");
    if (loadErrors.length > 0) {
      throw new Error(`skills manager shows load errors: ${await loadErrors[0].getText()}`);
    }

    // The full aggregated roster is there, including the new skill.
    const rows = await $$(".ai-skills-manager-row");
    if (rows.length !== 11) {
      throw new Error(`roster shows ${rows.length} skills, expected 11`);
    }
    const rowNames = [];
    for (const row of rows) rowNames.push(await row.$(".ai-settings-sidebar-item-name").getText());
    if (!rowNames.includes("duckdb-dialect-mastery")) {
      throw new Error(`duckdb-dialect-mastery missing from roster: ${rowNames.join(", ")}`);
    }

    // Search narrows to the new skill and its record shows the version.
    const search = await $(".ai-skills-manager-search input");
    await search.setValue("duckdb");
    await browser.pause(400);
    const filtered = await $$(".ai-skills-manager-row");
    if (filtered.length !== 1) {
      throw new Error(`search 'duckdb' matched ${filtered.length} rows, expected 1`);
    }
    await filtered[0].click();
    const detailName = await $(".ai-skills-manager-detail-name").getText();
    if (detailName !== "duckdb-dialect-mastery") {
      throw new Error(`detail shows ${detailName}, expected duckdb-dialect-mastery`);
    }
    const version = await $(".ai-skills-manager-row-version").getText();
    if (version !== "v1.0.1") {
      throw new Error(`detail shows ${version}, expected v1.0.1`);
    }

    // One of the edited skills reports its bump too.
    await search.setValue("query-performance");
    await browser.pause(400);
    const perfRow = (await $$(".ai-skills-manager-row"))[0];
    if (!perfRow) throw new Error("query-performance-tuning not found via search");
    await perfRow.click();
    const perfVersion = await $(".ai-skills-manager-row-version").getText();
    if (perfVersion !== "v1.1.0") {
      throw new Error(`perf skill shows ${perfVersion}, expected v1.1.0`);
    }

    await search.clearValue();
    // The close button's aria-label is localized too ("Close" / "Đóng").
    let close = await $('.ai-skills-manager-modal button[aria-label="Close"]');
    if (!(await close.isExisting())) {
      close = await $('.ai-skills-manager-modal button[aria-label="Đóng"]');
    }
    await close.click();
    await $(".ai-skills-manager-modal").waitForDisplayed({ timeout: 5_000, reverse: true });
  });
});
