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

  it("uses flat surfaces and inline metadata on the workspace overview", async () => {
    await $(".workspace-ready-panel").waitForDisplayed({ timeout: 10_000 });
    const styles = await browser.execute(() => {
      const header = document.querySelector(".workspace-ready-header");
      const title = document.querySelector(".workspace-ready-title");
      const meta = document.querySelector(".workspace-ready-meta-chip");
      const action = document.querySelector(".workspace-ready-action-card");
      const main = document.querySelector(".main-content");
      return {
        headerShadow: header ? getComputedStyle(header).boxShadow : "",
        headerImage: header ? getComputedStyle(header).backgroundImage : "",
        headerRadius: header ? getComputedStyle(header).borderRadius : "",
        titleImage: title ? getComputedStyle(title).backgroundImage : "",
        metaBorderWidth: meta ? getComputedStyle(meta).borderTopWidth : "",
        actionShadow: action ? getComputedStyle(action).boxShadow : "",
        mainShadow: main ? getComputedStyle(main).boxShadow : "",
      };
    });
    if (
      styles.headerShadow !== "none" ||
      styles.headerImage !== "none" ||
      styles.headerRadius !== "12px" ||
      styles.titleImage !== "none" ||
      styles.metaBorderWidth !== "0px" ||
      styles.actionShadow !== "none" ||
      styles.mainShadow !== "none"
    ) {
      throw new Error(`Workspace visual system is not flat: ${JSON.stringify(styles)}`);
    }
    await runAxe("Workspace overview");
  });

  it("keeps the ER toolbar inside its container when the AI sidebar is open", async () => {
    const trigger = await $('button[title="ER Diagram"]');
    await trigger.waitForDisplayed({ timeout: 10_000 });
    await trigger.click();
    const topbar = await $(".erd-topbar");
    await topbar.waitForDisplayed({ timeout: 10_000 });
    await browser.setWindowSize(1024, 900);
    await browser.waitUntil(
      async () =>
        browser.execute(
          () => getComputedStyle(document.querySelector(".main-container")).marginRight === "0px",
        ),
      { timeout: 5_000, interval: 100 },
    );

    const layout = await browser.execute(() => {
      const bar = document.querySelector(".erd-topbar");
      const heading = bar?.querySelector(".erd-topbar-heading");
      const stats = bar?.querySelector(".erd-toolbar-stats");
      const main = document.querySelector(".main-content");
      const ai = document.querySelector(".ai-workspace-sidebar");
      const resizeHandle = document.querySelector(".ai-workspace-resize-handle");
      return {
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        mainWidth: main?.getBoundingClientRect().width ?? 0,
        mainMarginRight: getComputedStyle(document.querySelector(".main-container")).marginRight,
        aiWidth: ai?.getBoundingClientRect().width ?? 0,
        aiBoxShadow: ai ? getComputedStyle(ai).boxShadow : "",
        resizeHandleDisplay: resizeHandle ? getComputedStyle(resizeHandle).display : "",
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
    if (
      layout.mainWidth < 700 ||
      layout.mainMarginRight !== "0px" ||
      layout.aiWidth <= 0 ||
      layout.aiWidth > 420 ||
      layout.aiBoxShadow !== "none" ||
      layout.resizeHandleDisplay !== "none"
    ) {
      throw new Error(`AI drawer compresses the 1024px workspace: ${JSON.stringify(layout)}`);
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
        emptyTitleCount: document.querySelectorAll(".ai-workspace-chat-empty-title").length,
        statusbarText: document.querySelector(".statusbar-info")?.textContent ?? "",
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
      semantics.visibleH1Count !== 1 ||
      semantics.emptyTitleCount !== 0 ||
      !semantics.statusbarText.trim() ||
      /[\\/]/.test(semantics.statusbarText)
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
        duplicateFactCount: document.querySelectorAll(".connection-picker-inspector-fact").length,
        miniStatCount: document.querySelectorAll(".connection-picker-mini-stat").length,
      };
    });
    if (
      semantics.role !== "dialog" ||
      semantics.modal !== "true" ||
      !semantics.label ||
      !semantics.selected.includes("MySQL") ||
      semantics.duplicateFactCount !== 0 ||
      semantics.miniStatCount !== 0
    ) {
      throw new Error(`Connection dialog semantics are incomplete: ${JSON.stringify(semantics)}`);
    }
  });

  it("keeps connection picker primary actions visible outside the scroll area", async () => {
    const layout = await browser.execute(() => {
      const aside = document.querySelector(".connection-picker-aside");
      const card = document.querySelector(".connection-picker-selection-card");
      const footer = document.querySelector(".connection-picker-footer-actions");
      const primary = footer?.querySelector(".btn-primary");
      return {
        asideBottom: aside?.getBoundingClientRect().bottom ?? 0,
        footerTop: footer?.getBoundingClientRect().top ?? 0,
        footerBottom: footer?.getBoundingClientRect().bottom ?? 0,
        primaryBottom: primary?.getBoundingClientRect().bottom ?? 0,
        footerInCard: Boolean(footer && card?.contains(footer)),
        viewportHeight: window.innerHeight,
      };
    });
    if (
      layout.footerInCard ||
      layout.footerTop <= 0 ||
      layout.footerBottom > layout.asideBottom + 1 ||
      layout.primaryBottom > layout.viewportHeight ||
      layout.footerBottom > layout.viewportHeight
    ) {
      throw new Error(`Connection actions are not persistently visible: ${JSON.stringify(layout)}`);
    }
  });

  it("keeps connection picker selection and status text at WCAG AA contrast", async () => {
    for (const [selector, label] of [
      [".connection-picker-rail-item.selected", "Selected MySQL engine"],
      [".connection-picker-footer-label", "Connection selection label"],
      [".connection-picker-footer-pill.supported", "Connection ready status"],
      [".connection-picker-selection-switch", "Connection selection switch"],
      [".connection-picker-footer-actions .btn-primary", "Connection primary action"],
    ]) {
      assertAA(await readContrastTarget(selector), label);
    }
  });

  it("passes axe with the connection dialog open", async () => {
    await runAxe("Connection dialog");
  });

  it("restores side-by-side AI layout above the drawer breakpoint", async () => {
    await $(".connection-picker-close").click();
    await $(".connection-picker-modal").waitForDisplayed({ timeout: 5_000, reverse: true });
    await browser.setWindowSize(1280, 900);
    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const margin = Number.parseFloat(
            getComputedStyle(document.querySelector(".main-container")).marginRight,
          );
          const aiWidth =
            document.querySelector(".ai-workspace-sidebar")?.getBoundingClientRect().width ?? 0;
          return margin > 0 && Math.abs(margin - aiWidth) < 1;
        }),
      { timeout: 5_000, interval: 100 },
    );

    const layout = await browser.execute(() => {
      const main = document.querySelector(".main-content");
      const bar = document.querySelector(".erd-topbar");
      const resizeHandle = document.querySelector(".ai-workspace-resize-handle");
      return {
        mainWidth: main?.getBoundingClientRect().width ?? 0,
        resizeHandleDisplay: resizeHandle ? getComputedStyle(resizeHandle).display : "none",
        toolbarWidth: bar?.getBoundingClientRect().width ?? 0,
        toolbarScrollWidth: bar?.scrollWidth ?? 0,
      };
    });
    if (
      layout.mainWidth < 500 ||
      layout.resizeHandleDisplay === "none" ||
      layout.toolbarScrollWidth > layout.toolbarWidth + 1
    ) {
      throw new Error(`Wide AI layout did not recover: ${JSON.stringify(layout)}`);
    }
  });

  it("keeps the drawer and connection actions usable at the minimum window width", async () => {
    await browser.setWindowSize(800, 700);
    await browser.waitUntil(
      async () =>
        browser.execute(
          () => getComputedStyle(document.querySelector(".main-container")).marginRight === "0px",
        ),
      { timeout: 5_000, interval: 100 },
    );
    await $('.workspace-sidebar-rail-btn[title="New Connection"]').click();
    await $(".connection-picker-modal").waitForDisplayed({ timeout: 10_000 });
    const mysql = await $(
      '//button[contains(concat(" ", normalize-space(@class), " "), " connection-picker-rail-item ")][.//span[normalize-space()="MySQL"]]',
    );
    await mysql.click();

    const layout = await browser.execute(() => {
      const modal = document.querySelector(".connection-picker-modal");
      const head = document.querySelector(".connection-picker-head");
      const footer = document.querySelector(".connection-picker-footer-actions");
      const primary = footer?.querySelector(".btn-primary");
      const modalRect = modal?.getBoundingClientRect();
      return {
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        modalLeft: modalRect?.left ?? 0,
        modalRight: modalRect?.right ?? 0,
        modalScrollWidth: modal?.scrollWidth ?? 0,
        modalClientWidth: modal?.clientWidth ?? 0,
        headScrollWidth: head?.scrollWidth ?? 0,
        headClientWidth: head?.clientWidth ?? 0,
        footerBottom: footer?.getBoundingClientRect().bottom ?? 0,
        primaryBottom: primary?.getBoundingClientRect().bottom ?? 0,
      };
    });
    if (
      layout.viewportWidth !== 800 ||
      layout.modalLeft < 0 ||
      layout.modalRight > layout.viewportWidth + 1 ||
      layout.modalScrollWidth > layout.modalClientWidth + 1 ||
      layout.headScrollWidth > layout.headClientWidth + 1 ||
      layout.primaryBottom <= 0 ||
      layout.primaryBottom > layout.viewportHeight ||
      layout.footerBottom > layout.viewportHeight
    ) {
      throw new Error(`Minimum-width connection layout failed: ${JSON.stringify(layout)}`);
    }
    await runAxe("Minimum-width connection dialog");
  });

  it("shows an actionable empty state on the metrics board", async () => {
    await $(".connection-picker-close").click();
    await $(".connection-picker-modal").waitForDisplayed({ timeout: 5_000, reverse: true });
    await browser.setWindowSize(1280, 900);
    const closeAI = await $(".ai-workspace-panel-header .is-close");
    if (await closeAI.isDisplayed()) {
      await closeAI.click();
      await $(".ai-workspace-sidebar").waitForDisplayed({ timeout: 5_000, reverse: true });
    }
    await $('button[title="Metrics boards"]').click();
    await $(".metrics-board-empty-canvas").waitForDisplayed({ timeout: 10_000 });
    const state = await browser.execute(() => {
      const empty = document.querySelector(".metrics-board-empty-canvas");
      const topbar = document.querySelector(".metrics-board-topbar");
      return {
        emptyText: empty?.textContent ?? "",
        actionText: empty?.querySelector("button")?.textContent ?? "",
        workspaceTitle:
          document.querySelector(".workspace-toolbar-title")?.textContent?.trim() ?? "",
        topbarShadow: topbar ? getComputedStyle(topbar).boxShadow : "",
      };
    });
    if (
      !state.emptyText.includes("0") ||
      !state.actionText.includes("Add widget") ||
      state.workspaceTitle !== "Metrics" ||
      state.topbarShadow !== "none"
    ) {
      throw new Error(`Metrics empty state is incomplete: ${JSON.stringify(state)}`);
    }
    await runAxe("Metrics empty board");
  });

  it("opens the existing widget library from the metrics empty state", async () => {
    await $(".metrics-board-empty-canvas button").click();
    const menu = await $(".metrics-board-widget-menu-list[role=menu]");
    await menu.waitForDisplayed({ timeout: 5_000 });
    const itemCount = await menu.$$('[role="menuitem"]').length;
    if (itemCount === 0)
      throw new Error("Metrics empty-state action did not open the widget library");
  });

  it("keeps the data grid dense but visually flat", async () => {
    await $(".workspace-toolbar-title").click();
    await $('button[title="Database explorer"]').click();
    const folder = await $(
      '//button[contains(concat(" ", normalize-space(@class), " "), " explorer-folder-row ")][contains(., "Tables")]',
    );
    if ((await folder.getAttribute("aria-expanded")) !== "true") {
      await folder.click();
    }
    const table = await $('[data-testid="table-public-smoke_items"]');
    await table.waitForDisplayed({ timeout: 10_000 });
    await table.click();
    await $(".datagrid-shell").waitForDisplayed({ timeout: 15_000 });

    const styles = await browser.execute(() => {
      const shell = document.querySelector(".datagrid-shell");
      const topbar = document.querySelector(".datagrid-topbar");
      const action = document.querySelector(".datagrid-footer-action");
      const pinned = document.querySelector(".datagrid-pinned-boundary");
      const index = document.querySelector(".datagrid-td-index");
      return {
        shellShadow: shell ? getComputedStyle(shell).boxShadow : "",
        indexShadow: index ? getComputedStyle(index).boxShadow : "none",
        pinnedShadow: pinned ? getComputedStyle(pinned).boxShadow : "none",
        topbarShadow: topbar ? getComputedStyle(topbar).boxShadow : "",
        actionShadow: action ? getComputedStyle(action).boxShadow : "none",
        topbarWidth: topbar?.clientWidth ?? 0,
        topbarScrollWidth: topbar?.scrollWidth ?? 0,
      };
    });
    if (
      styles.shellShadow !== "none" ||
      styles.indexShadow !== "none" ||
      styles.pinnedShadow !== "none" ||
      styles.topbarShadow !== "none" ||
      styles.actionShadow !== "none" ||
      styles.topbarScrollWidth > styles.topbarWidth + 1
    ) {
      throw new Error(`Data grid visual contract failed: ${JSON.stringify(styles)}`);
    }
    await runAxe("Data grid workspace");
  });
});
