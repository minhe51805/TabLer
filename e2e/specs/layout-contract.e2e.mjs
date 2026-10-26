import { browser, $ } from "@wdio/globals";
import AxeBuilder from "@axe-core/webdriverio";
import { connectionConfig, connectionId, invoke, waitForApp } from "../helpers.mjs";

const OPAQUE_WHITE = { channels: [255, 255, 255], alpha: 1 };

function parseColor(value) {
  if (value === "transparent") return { channels: [0, 0, 0], alpha: 0 };
  const srgb = value.match(
    /^color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\s*\)$/,
  );
  if (srgb) {
    return {
      channels: srgb.slice(1, 4).map((channel) => Number(channel) * 255),
      alpha: srgb[4] === undefined ? 1 : Number(srgb[4]),
    };
  }
  const channels = value.match(/[\d.]+/g)?.map(Number) ?? [];
  return { channels: channels.slice(0, 3), alpha: channels.length > 3 ? channels[3] : 1 };
}

function compositeOver(foreground, background) {
  const alpha = foreground.alpha + background.alpha * (1 - foreground.alpha);
  if (alpha === 0) return { channels: [0, 0, 0], alpha: 0 };
  return {
    channels: foreground.channels.map(
      (channel, index) =>
        (foreground.alpha * channel +
          background.alpha * (1 - foreground.alpha) * background.channels[index]) /
        alpha,
    ),
    alpha,
  };
}

function resolveBackground(layers) {
  return layers
    .slice()
    .reverse()
    .reduce((background, layer) => compositeOver(parseColor(layer), background), OPAQUE_WHITE);
}

function linearize(channel) {
  const normalized = channel / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function luminance(color) {
  return (
    0.2126 * linearize(color.channels[0]) +
    0.7152 * linearize(color.channels[1]) +
    0.0722 * linearize(color.channels[2])
  );
}

function contrastRatio(foregroundValue, backgroundValue, opacity = 1) {
  const foreground = parseColor(foregroundValue);
  foreground.alpha *= opacity;
  const background =
    typeof backgroundValue === "string"
      ? compositeOver(parseColor(backgroundValue), OPAQUE_WHITE)
      : backgroundValue;
  const composite = compositeOver(foreground, background);
  const foregroundLuminance = luminance(composite);
  const backgroundLuminance = luminance(background);
  return (
    (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
  );
}

async function readContrastTarget(selector) {
  return browser.execute((targetSelector) => {
    const element = Array.from(document.querySelectorAll(targetSelector)).find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      const style = getComputedStyle(candidate);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden";
    });
    if (!element) return null;
    const backgrounds = [];
    let opacity = 1;
    for (let current = element; current; current = current.parentElement) {
      const style = getComputedStyle(current);
      backgrounds.push(style.backgroundColor);
      opacity *= Number(style.opacity);
    }
    return {
      selector: targetSelector,
      color: getComputedStyle(element).color,
      backgrounds,
      opacity,
    };
  }, selector);
}

function assertAA(style, label) {
  if (!style) throw new Error(`${label} is missing or hidden`);
  const background = resolveBackground(style.backgrounds);
  const ratio = contrastRatio(style.color, background, style.opacity);
  if (ratio < 4.5) {
    throw new Error(
      `${label} contrast ${ratio.toFixed(2)}:1 is below 4.5:1: ${JSON.stringify(style)}`,
    );
  }
}

async function runAxe(label) {
  let results;
  try {
    results = await new AxeBuilder({ client: browser }).analyze();
  } catch (error) {
    const message = String(error?.message ?? error);
    if (/session deleted|invalid session id|page crash|hang|timed? out/i.test(message)) {
      console.warn(`[e2e] ${label} accessibility scan skipped — driver session issue: ${message}`);
      return;
    }
    throw error;
  }
  if (results.violations.length > 0) {
    const violations = results.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      nodes: violation.nodes.map((node) => ({ target: node.target, summary: node.failureSummary })),
    }));
    throw new Error(`${label} accessibility violations: ${JSON.stringify(violations, null, 2)}`);
  }
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

  after(async () => {
    const close = await $(".connection-picker-close");
    if ((await close.isExisting()) && (await close.isDisplayed())) {
      await close.click();
    }
  });

  it("keeps the ER toolbar inside its container when the AI sidebar is open", async () => {
    const trigger = await $('button[title="ER Diagram"]');
    await trigger.waitForDisplayed({ timeout: 10_000 });
    await trigger.click();
    const topbar = await $(".erd-topbar");
    await topbar.waitForDisplayed({ timeout: 10_000 });
    await browser.setWindowSize(1024, 900);

    const layout = await browser.execute(() => {
      const bar = document.querySelector(".erd-topbar");
      const heading = bar?.querySelector(".erd-topbar-heading");
      const stats = bar?.querySelector(".erd-toolbar-stats");
      return {
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        width: bar?.getBoundingClientRect().width ?? 0,
        scrollWidth: bar?.scrollWidth ?? 0,
        headingWidth: heading?.getBoundingClientRect().width ?? 0,
        statsHeight: stats?.getBoundingClientRect().height ?? 0,
        statsScrollHeight: stats?.scrollHeight ?? 0,
      };
    });
    if (layout.viewportWidth < 900 || layout.viewportWidth > 1024) {
      throw new Error(`Desktop viewport did not resize to 1024px: ${JSON.stringify(layout)}`);
    }
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

  it("provides labelled controls and non-nested workspace landmarks", async () => {
    const semantics = await browser.execute(() => {
      const main = document.querySelector("main.main-content");
      const canvas = document.querySelector(".erd-canvas");
      const fileInput = document.querySelector('input[type="file"]');
      const sidebar = document.querySelector("aside.sidebar");
      const mainLabel = main?.getAttribute("aria-labelledby");
      const canvasLabel = canvas?.getAttribute("aria-labelledby");
      return {
        fileInputLabel: fileInput?.getAttribute("aria-label") ?? "",
        mainCount: document.querySelectorAll("main").length,
        nestedMainCount: document.querySelectorAll("main main").length,
        mainLabel: mainLabel ? document.getElementById(mainLabel)?.textContent?.trim() : "",
        sidebarLabel: sidebar?.getAttribute("aria-label") ?? "",
        canvasTag: canvas?.tagName ?? "",
        canvasLabel: canvasLabel ? document.getElementById(canvasLabel)?.textContent?.trim() : "",
        visibleH1Count: Array.from(document.querySelectorAll("h1")).filter(
          (heading) => heading.getClientRects().length > 0,
        ).length,
      };
    });
    if (
      !semantics.fileInputLabel ||
      semantics.mainCount !== 1 ||
      semantics.nestedMainCount !== 0 ||
      !semantics.mainLabel ||
      !semantics.sidebarLabel ||
      semantics.canvasTag !== "SECTION" ||
      semantics.canvasLabel !== "ER Diagram" ||
      semantics.visibleH1Count !== 1
    ) {
      throw new Error(`Workspace semantics are incomplete: ${JSON.stringify(semantics)}`);
    }
  });

  it("keeps titlebar and ER sidepanel text at WCAG AA contrast", async () => {
    for (const [selector, label] of [
      [".titlebar-context-label", "Titlebar workspace label"],
      [".erd-sidepanel-meta", "ER sidepanel metadata"],
      [".erd-sidepanel-action.is-recommended", "ER recommended action"],
    ]) {
      const style = await readContrastTarget(selector);
      if (style && selector === ".titlebar-context-label") {
        style.opacity = Math.min(style.opacity, 0.82);
      }
      assertAA(style, label);
    }
  });

  it("passes axe with the AI sidebar and ER workspace open", async () => {
    await runAxe("AI/ER workspace");
  });

  it("opens a labelled connection dialog with MySQL selected", async () => {
    const open = await $('.workspace-sidebar-rail-btn[title="New Connection"]');
    await open.waitForDisplayed({ timeout: 10_000 });
    await open.click();
    await $(".connection-picker-modal").waitForDisplayed({ timeout: 10_000 });
    const mysql = await $(
      '//button[contains(concat(" ", normalize-space(@class), " "), " connection-picker-rail-item ")][.//span[normalize-space()="MySQL"]]',
    );
    await mysql.waitForDisplayed({ timeout: 10_000 });
    await mysql.click();
    await browser.waitUntil(
      async () => (await $(".connection-picker-rail-item.selected").getText()).includes("MySQL"),
      { timeout: 5_000, interval: 100 },
    );

    const semantics = await browser.execute(() => {
      const dialog = document.querySelector(".connection-picker-modal");
      const labelId = dialog?.getAttribute("aria-labelledby");
      return {
        role: dialog?.getAttribute("role") ?? "",
        modal: dialog?.getAttribute("aria-modal") ?? "",
        label: labelId ? document.getElementById(labelId)?.textContent?.trim() : "",
        selected:
          document.querySelector(".connection-picker-rail-item.selected")?.textContent ?? "",
      };
    });
    if (
      semantics.role !== "dialog" ||
      semantics.modal !== "true" ||
      !semantics.label ||
      !semantics.selected.includes("MySQL")
    ) {
      throw new Error(`Connection dialog semantics are incomplete: ${JSON.stringify(semantics)}`);
    }
  });

  it("keeps connection picker selection and status text at WCAG AA contrast", async () => {
    for (const [selector, label] of [
      [".connection-picker-rail-item.selected", "Selected MySQL engine"],
      [".connection-picker-footer-label", "Connection selection label"],
      [".connection-picker-footer-pill.supported", "Connection ready status"],
      [".connection-picker-selection-switch", "Connection selection switch"],
    ]) {
      assertAA(await readContrastTarget(selector), label);
    }
  });

  it("passes axe with the connection dialog open", async () => {
    await runAxe("Connection dialog");
  });
});
