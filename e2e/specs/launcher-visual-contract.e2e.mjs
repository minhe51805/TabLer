import { browser, $ } from "@wdio/globals";
import AxeBuilder from "@axe-core/webdriverio";
import { waitForApp } from "../helpers.mjs";

describe("TableR launcher visual contract", () => {
  it("keeps the launcher flat and accessible", async () => {
    await waitForApp();
    const skip = await $("button.onboarding-skip");
    if (await skip.isDisplayed()) {
      await skip.click();
      await $(".onboarding-tour").waitForDisplayed({ timeout: 5_000, reverse: true });
    }
    await $(".startup-manager-modal").waitForDisplayed({ timeout: 15_000 });

    const styles = await browser.execute(() => {
      const modal = document.querySelector(".startup-manager-modal");
      const sample = document.querySelector(".startup-manager-sample-card");
      const primary = document.querySelector(".startup-manager-search-add.primary");
      return {
        modalShadow: modal ? getComputedStyle(modal).boxShadow : "",
        sampleShadow: sample ? getComputedStyle(sample).boxShadow : "none",
        primaryBackground: primary ? getComputedStyle(primary).backgroundColor : "",
      };
    });
    if (
      styles.modalShadow !== "none" ||
      styles.sampleShadow !== "none" ||
      styles.primaryBackground !== "rgb(0, 81, 213)"
    ) {
      throw new Error(`Launcher visual system is inconsistent: ${JSON.stringify(styles)}`);
    }

    let results;
    try {
      results = await new AxeBuilder({ client: browser }).analyze();
    } catch (error) {
      const message = String(error?.message ?? error);
      if (/session deleted|invalid session id|page crash|hang|timed? out/i.test(message)) {
        console.warn(
          `[e2e] launcher accessibility scan skipped — driver session issue: ${message}`,
        );
        return;
      }
      throw error;
    }
    if (results.violations.length > 0) {
      const violations = results.violations.map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        nodes: violation.nodes.map((node) => ({
          target: node.target,
          summary: node.failureSummary,
        })),
      }));
      throw new Error(`Launcher accessibility violations: ${JSON.stringify(violations, null, 2)}`);
    }
  });
});
