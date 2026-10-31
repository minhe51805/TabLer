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

  it("lists the built-in pack and serves the new one with its version", async function () {
    this.timeout(120_000);
    // The backend catalog is the roster's source of truth — derive the expected
    // name set from it instead of pinning a count that breaks on pack growth.
    // Premise: this e2e links no workspace folder, so the manager's catalog
    // (it resolves workspaceDir itself) equals the global catalog here.
    const backend = await invoke("list_ai_skills", {});
    const expectedNames = backend.skills.map((s) => s.name).sort();

    const skillsBtn = await $('[data-testid="agent-skills-toggle"]');
    await skillsBtn.waitForDisplayed({ timeout: 10_000 });
    await skillsBtn.click();

    const modal = await $(".ai-skills-manager-modal");
    await modal.waitForDisplayed({ timeout: 10_000 });

    // No load-error banner: a broken SKILL.md would surface here first.
    const loadErrors = await $$(".ai-skills-manager-error");
    if (loadErrors.length > 0) {
      throw new Error(`skills manager shows load errors: ${await loadErrors[0].getText()}`);
    }

    // The UI roster must mirror the backend catalog exactly — a leak, a
    // missing entry, or a blocked skill all fail this set equality.
    const rows = await $$(".ai-skills-manager-row");
    const rowNames = [];
    for (const row of rows) rowNames.push(await row.$(".ai-settings-sidebar-item-name").getText());
    if (JSON.stringify(rowNames.sort()) !== JSON.stringify(expectedNames)) {
      throw new Error(
        `roster ${JSON.stringify(rowNames)} != backend ${JSON.stringify(expectedNames)}`,
      );
    }
    if (!rowNames.includes("duckdb-dialect-mastery")) {
      throw new Error(`duckdb-dialect-mastery missing from roster: ${rowNames.join(", ")}`);
    }

    // Search narrows to the new skill; its record's version must equal the
    // backend catalog's version for the same entry — derived, so a version
    // bump cannot redden the journey.
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
    const duckBackend = backend.skills.find((s) => s.name === "duckdb-dialect-mastery");
    const version = await $(".ai-skills-manager-row-version").getText();
    if (version !== `v${duckBackend.version}`) {
      throw new Error(
        `detail shows ${version}, backend catalog says v${duckBackend.version} — the manager and the catalog disagree`,
      );
    }

    // One of the edited skills reports its catalog version too.
    await search.setValue("query-performance");
    await browser.pause(400);
    const perfRow = (await $$(".ai-skills-manager-row"))[0];
    if (!perfRow) throw new Error("query-performance-tuning not found via search");
    await perfRow.click();
    const perfVersion = await $(".ai-skills-manager-row-version").getText();
    const perfBackend = backend.skills.find((s) => s.name === "query-performance-tuning");
    if (perfVersion !== `v${perfBackend.version}`) {
      throw new Error(
        `detail shows ${perfVersion}, backend catalog says v${perfBackend.version} — the manager and the catalog disagree`,
      );
    }

    await search.clearValue();
    await $('[data-testid="ai-skills-modal-close"]').click();
    await $(".ai-skills-manager-modal").waitForDisplayed({ timeout: 5_000, reverse: true });
  });
});
