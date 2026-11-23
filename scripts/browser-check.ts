// Runs only on a GitHub runner against the real production container and SQLite volume.
import { deepEqual, equal, ok } from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, type BrowserContext, type Locator, type Page } from "playwright";
import { DEFAULT_SESSION_MONTHS, MAX_EXAM_NAME_LENGTH } from "../src/planning.ts";
import type { Snapshot } from "../src/protocol.ts";
import type { StudyPage } from "../src/StudyPages.tsx";
import { DEFAULT_PREFERENCES } from "../src/timer.ts";

const base = process.env.DYNTICK_TEST_URL ?? "http://127.0.0.1:18080";
const output = ".ci-output/screenshots";
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
const errors: string[] = [];
const languageLabels: Record<string, string> = { en: "English", it: "Italiano", de: "Deutsch", es: "Español" };

function observe(context: BrowserContext) {
  context.on("page", page => page.on("pageerror", error => errors.push(error.message)));
  context.on("request", request => {
    if (request.url().startsWith("http") && new URL(request.url()).origin !== new URL(base).origin) {
      errors.push(`Unexpected external resource: ${request.url()}`);
    }
  });
}

async function snapshot(): Promise<Snapshot> {
  const response = await fetch(`${base}/api/state`);
  equal(response.status, 200);
  return await response.json() as Snapshot;
}

async function post(path: string, body: unknown): Promise<Snapshot> {
  const response = await fetch(`${base}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Dyntick-Request": "1", Origin: new URL(base).origin },
    body: JSON.stringify(body),
  });
  equal(response.status, 200, await response.clone().text());
  return await response.json() as Snapshot;
}

async function action(value: unknown) {
  return await post("/api/action", { requestId: crypto.randomUUID(), revision: (await snapshot()).revision, action: value });
}

async function ready(page: Page) {
  await page.locator('.app-shell[data-state-ready="true"]').waitFor();
  // A second device receives changes on its next poll. A previously saved view can
  // still be one revision behind; wait for the rendered server revision before a
  // controlled test action instead of accidentally exercising a stale command.
  const { instanceId, revision } = await snapshot();
  await page.waitForFunction(({ instanceId, revision }) => {
    const shell = document.querySelector<HTMLElement>(".app-shell");
    return shell?.dataset.instance === instanceId && Number(shell.dataset.revision) >= revision;
  }, { instanceId, revision });
  await page.locator('[data-testid="sync-status"][data-sync-state="saved"]').waitFor();
}

async function chooseLanguage(page: Page, language: string) {
  await ready(page);
  await chooseMenuOption(page, page.getByTestId("language-selector"), languageLabels[language]);
  await page.waitForFunction(value => document.documentElement.lang === value, language);
  await ready(page);
}

async function chooseMenuOption(page: Page, trigger: Locator, label: string) {
  const touch = await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
  if (touch) await trigger.tap();
  else await trigger.click();
  const menu = page.getByRole("listbox");
  const option = menu.getByRole("option", { name: label, exact: true });
  if (touch) await option.tap();
  else await option.click();
  await menu.waitFor({ state: "hidden" });
}

async function chooseOption(page: Page, label: string, option: string, scope: Page | Locator = page) {
  await chooseMenuOption(page, scope.getByRole("combobox", { name: label, exact: true }), option);
}

async function showStudyPage(page: Page, target: StudyPage) {
  await page.locator(`#tab-${target}`).click();
  await page.waitForFunction(id => document.getElementById(`tab-${id}`)?.getAttribute("aria-selected") === "true", target);
}

async function waitForLanguage(page: Page, language: string) {
  await page.waitForFunction(value => document.documentElement.lang === value, language);
  await ready(page);
}

function countdownSeconds(text: string | null) {
  const [minutes, seconds] = (text ?? "0:0").split(":").map(Number);
  return minutes * 60 + seconds;
}

async function verifyFooterVersion(page: Page) {
  const versions = page.locator(".site-footer-versions");
  const label = await versions.locator(".site-footer-current").textContent();
  const buildVersion = process.env.DYNTICK_VERSION;
  ok(buildVersion ? label === `v${buildVersion}` : /^v\d+\.\d+\.\d+$/.test(label ?? ""), "The footer shows the build version");
  ok(await versions.evaluate((element) => {
    const version = element.getBoundingClientRect();
    const footer = element.closest("footer")!.getBoundingClientRect();
    return version.width > 0 && Math.abs(version.left + version.width / 2 - (footer.left + footer.width / 2)) <= 1;
  }), "The version labels are centered in the footer");
}

async function verifyMobileStudyPages(page: Page) {
  ok(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), "The phone context uses touch input");
  const welcome = page.getByRole("heading", { name: "Welcome to Dyntick.", exact: true });
  const subtitle = page.getByText("A simple yet functional space to study.", { exact: true });
  await page.evaluate(() => document.fonts.ready);
  equal(await subtitle.evaluate((element) => getComputedStyle(element).fontStyle), "normal");
  ok(await page.evaluate(() => [...document.fonts].some((font) =>
    font.family.replaceAll('"', "") === "IBM Plex Sans Variable" && font.style === "normal" && font.status === "loaded")),
    "The subtitle uses the loaded IBM Plex Sans face");

  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: width === 320 ? 568 : 844 });
    await verifyFooterVersion(page);
    ok(await page.locator(".page-heading").evaluate((heading) => {
      const bounds = (selector: string) => heading.querySelector(selector)!.getBoundingClientRect();
      const centerY = (rect: DOMRect) => rect.top + rect.height / 2;
      const title = bounds("h1");
      const date = bounds(".heading-date");
      const subtitle = bounds(".welcome-subtitle");
      const sync = bounds(".sync-status");
      return date.width > 0 && sync.width > 0 && date.left >= title.right && sync.left >= subtitle.right
        && Math.abs(centerY(title) - centerY(date)) <= 1 && Math.abs(centerY(subtitle) - centerY(sync)) <= 1;
    }), `The date and sync status align with the welcome lines at ${width}px`);
    const position = () => welcome.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return { x: bounds.left, y: bounds.top + window.scrollY };
    });
    const first = await position();
    for (const pageName of ["activity", "planning", "settings", "pomodoro"] as const) {
      await showStudyPage(page, pageName);
      deepEqual(await position(), first, `The welcome heading stays in place on ${pageName} at ${width}px`);
      ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
        `${pageName} has no horizontal page scroll at ${width}px`);
      ok(await page.locator(".main-nav").evaluate((nav) => [...nav.querySelectorAll("button")].every((button) =>
        button.getBoundingClientRect().height >= 44 && button.scrollWidth <= button.clientWidth)),
        `All navigation tabs are touch-sized and fit at ${width}px`);
      const panel = page.locator(`#panel-${pageName}`);
      ok(await panel.isVisible(), "The selected tab panel is visible");
      equal(await page.getByRole("tabpanel").count(), 1, "Only the selected panel is exposed");
    }
  }
}

async function verifyActivityCalendar(page: Page, expectedRows: number) {
  const calendar = page.getByTestId("activity-calendar");
  const widthFits = await calendar.evaluate((element) => element.scrollWidth <= element.clientWidth);
  ok(widthFits, "The entire heatmap fits without horizontal scrolling");
  equal(await calendar.locator(".calendar-month").count(), 12);
  const weekdays = calendar.locator(".weekday-labels:visible");
  equal(await weekdays.count(), expectedRows, "Each row starts with a visible weekday axis");
  deepEqual(await weekdays.first().locator("span").allTextContents(), ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
}

async function verifyResponsiveCycle() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, locale: "en-US" });
  context.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
  try {
    const page = await context.newPage();
    await page.goto(base);
    await ready(page);
    await page.locator('.cycle-panel .study-card-note svg[data-icon="info"]').waitFor();
    equal(await page.getByText("Select a step to see its duration.", { exact: true }).count(), 0);
    const todayNote = page.locator(".today-panel .study-card-note");
    await todayNote.locator('svg[data-icon="info"]').waitFor();
    for (let sessions = 1; sessions <= 6; sessions++) {
      await showStudyPage(page, "settings");
      await page.locator('input[name="longBreakInterval"]').fill(String(sessions));
      await page.getByRole("button", { name: "Save preferences", exact: true }).click();
      await ready(page);
      await showStudyPage(page, "pomodoro");
      const unit = sessions === 1 ? "session" : "sessions";
      await todayNote.getByText(`One full cycle consists of ${sessions} ${unit}.`, { exact: true }).waitFor();
      for (const width of [320, 390, 768, 1024, 1440]) {
        await page.setViewportSize({ width, height: 1050 });
        await page.waitForFunction(() => {
          const map = document.querySelector(".cycle-map-canvas")!;
          const svg = map.querySelector("svg")!;
          return Math.abs(map.clientWidth - svg.viewBox.baseVal.width) <= 1;
        });
        if (sessions === 1) {
          ok(await page.locator(".timer-colon").evaluate((colon) => {
            const before = colon.previousElementSibling!.getBoundingClientRect();
            const after = colon.nextElementSibling!.getBoundingClientRect();
            const text = document.createRange();
            text.selectNodeContents(colon);
            const glyph = text.getBoundingClientRect();
            return Math.abs((glyph.left + glyph.right) / 2 - (before.right + after.left) / 2) <= 1;
          }), `The clock separator is centered between the digit slots at ${width}px`);
        }
        const geometry = await page.getByTestId("cycle-map").evaluate((map) => {
          const canvas = map.querySelector<HTMLElement>(".cycle-map-canvas")!;
          const bounds = canvas.getBoundingClientRect();
          const targets = [...map.querySelectorAll(".cycle-node")].map((button) => {
            const r = button.getBoundingClientRect();
            return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
          });
          return {
            documentFits: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
            canvasFits: canvas.scrollWidth <= canvas.clientWidth && canvas.scrollHeight <= canvas.clientHeight,
            allVisible: targets.every((r) => r.left >= bounds.left - .5 && r.right <= bounds.right + .5 && r.top >= bounds.top - .5 && r.bottom <= bounds.bottom + .5),
            targets,
          };
        });
        ok(geometry.documentFits && geometry.canvasFits && geometry.allVisible, `The complete ${sessions}-session cycle must fit at ${width}px`);
        equal(geometry.targets.length, sessions * 2);
        for (let index = 0; index < geometry.targets.length; index++) {
          const a = geometry.targets[index];
          ok(a.width >= 44 && a.height >= 44, "Cycle targets must keep their touch size");
          for (const b of geometry.targets.slice(index + 1)) {
            ok(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top, "Cycle hitboxes must not overlap");
          }
        }
        if (sessions === 6 && (width === 320 || width === 1440)) {
          await page.locator(".toast.is-visible").waitFor({ state: "hidden" });
          await page.locator(".cycle-panel").screenshot({ path: `${output}/cycle-${width}-6-sessions.png`, animations: "disabled" });
        }
      }
    }
    const node = page.locator('.cycle-node[data-mode="shortBreak"]').first();
    const nodeBefore = await node.boundingBox();
    await node.hover();
    deepEqual(await node.boundingBox(), nodeBefore, "Hover must not move the cycle hitbox");
    equal(await node.evaluate((element) => getComputedStyle(element).boxShadow), "none", "The transparent hitbox must not acquire a rectangular shadow");
    equal(await node.evaluate((element) => getComputedStyle(element).backgroundColor), "rgba(0, 0, 0, 0)");
    await page.locator(".cycle-panel").screenshot({ path: `${output}/cycle-hover.png`, animations: "disabled" });
    const reset = page.locator(".reset-action");
    const resetBefore = await reset.boundingBox();
    await reset.hover();
    deepEqual(await reset.boundingBox(), resetBefore, "Action buttons keep a stable hitbox on hover");

    const verifyThemeControlColors = async () => {
      await page.mouse.move(0, 0);
      await page.waitForFunction(() => {
        const theme = document.querySelector(".topbar-actions .icon-button")!;
        const language = document.querySelector(".language-picker .select-trigger")!;
        return getComputedStyle(theme).backgroundColor === getComputedStyle(language).backgroundColor
          && getComputedStyle(theme).borderTopColor === getComputedStyle(language).borderTopColor
          && getComputedStyle(theme.querySelector(".ui-icon")!).color === getComputedStyle(language.querySelector(".ui-icon")!).color;
      });
    };
    await verifyThemeControlColors();
    const language = page.getByTestId("language-selector");
    const trigger = await page.locator(".language-picker .select-trigger").boundingBox();
    const button = await language.boundingBox();
    ok(trigger && button && Math.abs(button.x - trigger.x) <= 2 && Math.abs(button.y - trigger.y) <= 2 && Math.abs(button.width - trigger.width) <= 2 && Math.abs(button.height - trigger.height) <= 2,
      "The language button must cover the complete visible control");
    const themeButton = await page.locator(".topbar-actions .icon-button").boundingBox();
    ok(themeButton && Math.abs(themeButton.height - trigger.height) <= 1, "The theme and language buttons have the same height");
    await page.mouse.click(trigger.x + 12, trigger.y + trigger.height / 2);
    await page.getByRole("listbox").waitFor();
    equal(await language.evaluate((element) => getComputedStyle(element).boxShadow), "none");
    await page.screenshot({ path: `${output}/controls-language-hover.png`, fullPage: true, animations: "disabled" });
    await language.press("Escape");
    await page.mouse.click(trigger.x + trigger.width - 12, trigger.y + trigger.height / 2);
    await page.getByRole("listbox").waitFor();
    await language.press("Escape");

    const longBreak = page.locator('.cycle-node[data-mode="longBreak"]');
    await longBreak.locator('svg[data-icon="cup"]').waitFor();
    await longBreak.click();
    equal(await page.getByTestId("countdown").getAttribute("aria-label"), "25:00");
    await page.getByTestId("cycle-detail").getByText("Long break", { exact: true }).waitFor();
    for (const tab of await page.locator(".main-nav button").all()) {
      const before = await tab.boundingBox();
      await tab.hover();
      await tab.evaluate(async (element) => {
        await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})));
      });
      deepEqual(await tab.boundingBox(), before, "Top navigation hitboxes stay fixed during icon hover");
      const iconFits = await tab.evaluate(element => {
        const bounds = element.getBoundingClientRect();
        const svg = element.querySelector<SVGSVGElement>("svg")!;
        const ink = element.querySelector<SVGGElement>(".icon-motion")!.getBoundingClientRect();
        const box = svg.getBoundingClientRect();
        return ink.left - 1 >= bounds.left && ink.right + 1 <= bounds.right && ink.top - 1 >= bounds.top && ink.bottom + 1 <= bounds.bottom
          && (getComputedStyle(svg).overflow === "visible" || (ink.left >= box.left && ink.right <= box.right && ink.top >= box.top && ink.bottom <= box.bottom));
      });
      ok(iconFits, "Navigation icons must remain fully visible during hover");
    }
    await page.locator(".topbar").screenshot({ path: `${output}/navigation-hover.png`, animations: "disabled" });
    await page.getByRole("button", { name: "Switch to dark theme", exact: true }).click();
    await ready(page);
    await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
    await verifyThemeControlColors();
    await page.locator(".cycle-panel").screenshot({ path: `${output}/cycle-dark-contrast.png`, animations: "disabled" });
    ok(await page.locator(".cycle-panel").evaluate((cycle) => {
      const cycleStyle = getComputedStyle(cycle);
      const todayStyle = getComputedStyle(document.querySelector(".today-panel")!);
      return ["background-color", "border-color", "border-radius", "box-shadow", "padding"].every((property) =>
        cycleStyle.getPropertyValue(property) === todayStyle.getPropertyValue(property));
    }), "Current cycle and Today use the same card styling");
    const cycleContrast = await page.locator(".cycle-panel").evaluate(element => {
      const luminance = (color: string) => {
        const values = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(value => color.startsWith("color(") ? value : value / 255);
        const linear = values.map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
        return linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
      };
      const card = luminance(getComputedStyle(element).backgroundColor);
      const canvas = luminance(getComputedStyle(document.body).backgroundColor);
      return (Math.max(card, canvas) + .05) / (Math.min(card, canvas) + .05);
    });
    ok(cycleContrast >= 1.3, "The dark cycle card must be visibly separated from the page canvas");
    console.log(`Dark cycle card contrast against canvas: ${cycleContrast.toFixed(2)}:1; navigation icon bounds passed.`);
    await page.getByRole("button", { name: "Switch to light theme", exact: true }).click();
    await ready(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await node.hover();
    equal(await node.locator(".cycle-node-face").evaluate((element) => getComputedStyle(element).transform), "none");
    await showStudyPage(page, "activity");
    equal(await page.locator("#panel-activity").evaluate((element) => getComputedStyle(element).filter), "none");
    equal(await page.locator("#panel-activity").evaluate((element) => getComputedStyle(element).animationName), "none");
    await showStudyPage(page, "pomodoro");
    console.log("Responsive cycle checks passed: 30 viewport/session combinations, full visibility, non-overlapping 44px targets, stable hover hitboxes, complete language trigger and reduced motion.");
  } finally {
    await context.close();
  }
}

try {
  const initial = await snapshot();
  equal(initial.initialized, false, "Browser migration checks require a fresh production SQLite volume");
  equal(initial.preferences.language, "en", "The initial language must never be inferred from a browser locale");

  // Test data belongs only to this isolated CI installation. Seed the old storage format
  // to exercise the actual 1.x -> 2.0 migration, including completion during an absence.
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 1024 }, colorScheme: "light", locale: "it-IT", timezoneId: "Europe/Rome" });
  observe(desktop);
  await desktop.route("**/api/latest-release", (route) => route.fulfill({ json: { version: "2.8.0" } }));
  await desktop.addInitScript((origin) => {
    if (location.origin !== origin) return;
    if (localStorage.getItem("browser-legacy-seeded")) return;
    const now = Date.now();
    localStorage.setItem("browser-legacy-seeded", "true");
    localStorage.setItem("dyntick.preferences.v1", JSON.stringify({
      focusMinutes: 25, shortBreakMinutes: 5, longBreakMinutes: 15, longBreakInterval: 4,
      language: "en", theme: "light", soundEnabled: false,
    }));
    localStorage.setItem("dyntick.activity.v1", JSON.stringify({ version: 1, entries: {
      "browser-old-focus": { id: "browser-old-focus", completedAt: now - 86_400_000, minutes: 25 },
    } }));
    sessionStorage.setItem("dyntick.timer.v1", JSON.stringify({
      version: 1, mode: "focus", status: "running", durationMs: 60_000, remainingMs: 60_000,
      endAt: now - 1000, completedFocuses: 3, completionId: 3,
      focusSessionId: "browser-expired-focus", lastFocusCompletion: null,
    }));
  }, new URL(base).origin);
  const page = await desktop.newPage();
  await page.goto(base);
  await ready(page);
  await page.getByRole("heading", { name: "Welcome to Dyntick.", exact: true }).waitFor();
  await page.getByRole("button", { name: "Start long break", exact: true }).waitFor();
  equal(await page.getByTestId("countdown").textContent(), "00:00");
  const imported = await snapshot();
  equal(imported.initialized, true);
  equal(Object.keys(imported.activity.entries).length, 2);
  equal(imported.activity.entries["browser-expired-focus"].minutes, 1);
  equal(imported.timer.completedFocuses, 4);
  const backup = await page.evaluate(() => ({ preferences: localStorage.getItem("dyntick.preferences.v1"), activity: localStorage.getItem("dyntick.activity.v1"), timer: sessionStorage.getItem("dyntick.timer.v1") }));
  await page.reload();
  await ready(page);
  equal(Object.keys((await snapshot()).activity.entries).length, 2, "Reload must not duplicate migrated sessions");
  equal((await snapshot()).timer.completionId, imported.timer.completionId);
  equal(await page.evaluate(instanceId => localStorage.getItem(`dyntick.migrated.v2.${instanceId}`), imported.instanceId), "done");

  await action({ type: "reset" });
  await action({ type: "preferences", patch: { longBreakInterval: 4, theme: "light", language: "en" } });
  await page.getByRole("button", { name: "Start focusing", exact: true }).waitFor();
  await ready(page);
  await page.evaluate(() => document.fonts.ready);
  equal(await page.getByTestId("countdown").textContent(), "25:00");
  equal(await page.getByRole("link", { name: "GitHub", exact: true }).getAttribute("href"), "https://github.com/IlCandeDEV/dyntick");
  await page.locator(".site-footer-versions").getByText("v2.8.0", { exact: true }).waitFor();
  await verifyFooterVersion(page);
  await verifyResponsiveCycle();
  await action({ type: "preferences", patch: { longBreakInterval: 4, focusMinutes: 25, shortBreakMinutes: 5, longBreakMinutes: 15, theme: "light" } });
  await page.reload();
  await ready(page);
  await showStudyPage(page, "pomodoro");
  await page.screenshot({ path: `${output}/desktop-light.png`, fullPage: true, animations: "disabled" });
  await page.getByRole("button", { name: "Switch to dark theme", exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  await ready(page);
  await page.screenshot({ path: `${output}/desktop-dark.png`, fullPage: true, animations: "disabled" });
  equal(await page.locator(".brand-mark").evaluate(element => getComputedStyle(element).backgroundColor), "rgba(0, 0, 0, 0)");
  await page.locator(".brand").screenshot({ path: `${output}/brand-dark.png`, animations: "disabled" });
  await page.getByRole("button", { name: "Switch to light theme", exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
  await ready(page);
  await page.locator(".brand").screenshot({ path: `${output}/brand-light.png`, animations: "disabled" });

  const startClock = page.getByRole("button", { name: "Start focusing", exact: true });
  const pauseClock = page.getByRole("button", { name: "Pause timer", exact: true });
  await action({ type: "preferences", patch: { focusMinutes: 1 } });
  await ready(page);
  equal(await page.getByTestId("countdown").textContent(), "01:00");
  await startClock.click();
  await pauseClock.waitFor();
  const motion = await page.locator(".timer-dial").evaluate(async (dial) => {
    const marker = dial.querySelector<SVGGElement>(".dial-marker")!;
    const ring = dial.querySelector<SVGCircleElement>(".dial-progress")!;
    const readAngle = () => marker.transform.baseVal.getItem(0).angle;
    const nextFrame = () => new Promise<number>(resolve => requestAnimationFrame(resolve));
    const start = await nextFrame();
    const initial = readAngle();
    let previous = initial;
    let furthestFromRing = 0;
    let fastestDeviation = 0;
    let backward = 0;
    let timestamp = start;
    while (timestamp - start < 1300) {
      timestamp = await nextFrame();
      const angle = readAngle();
      const ringAngle = 360 * (1 - Number(ring.getAttribute("stroke-dashoffset")) / Number(ring.getAttribute("stroke-dasharray")));
      furthestFromRing = Math.max(furthestFromRing, Math.abs(angle - ringAngle));
      fastestDeviation = Math.max(fastestDeviation, Math.abs(angle - initial + (timestamp - start) * .006));
      backward = Math.max(backward, angle - previous);
      previous = angle;
    }
    return { moved: initial - previous, furthestFromRing, fastestDeviation, backward };
  });
  ok(motion.moved > 7 && motion.fastestDeviation < 1.2 && motion.backward < .01, "The one-minute marker moves continuously through a server refresh");
  ok(motion.furthestFromRing < .01, "The marker stays at the same angle as the ring endpoint");
  await pauseClock.click();
  await page.getByRole("button", { name: "Resume", exact: true }).waitFor();
  await ready(page);
  const pausedMarker = await page.locator(".dial-marker").getAttribute("transform");
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  equal(await page.locator(".dial-marker").getAttribute("transform"), pausedMarker, "Pausing freezes the running marker");
  await action({ type: "reset" });
  await action({ type: "preferences", patch: { focusMinutes: 25 } });
  await ready(page);
  await startClock.click();
  await pauseClock.waitFor();
  await ready(page);
  equal(await page.locator('.timer-face[data-running="true"] .timer-colon').evaluate(element => getComputedStyle(element).animationName), "none", "The running clock uses a fixed separator");
  await pauseClock.focus();
  await page.keyboard.press("r");
  await startClock.waitFor();
  await ready(page);
  equal((await snapshot()).timer.status, "idle", "R resets the running Clock while its button has focus");
  equal(await page.getByTestId("countdown").textContent(), "25:00");
  await startClock.click();
  await pauseClock.waitFor();
  await ready(page);
  const initialDeadline = (await snapshot()).timer.endAt;
  ok(initialDeadline);
  await showStudyPage(page, "settings");
  const shortcuts = page.getByTestId("keyboard-tips");
  await shortcuts.getByText("Start / pause the Clock", { exact: true }).waitFor();
  await shortcuts.getByText("Reset the Clock", { exact: true }).waitFor();
  ok(await page.getByTestId("settings-page").evaluate((settings) => {
    const card = settings.querySelector(".settings-surface");
    const form = card?.querySelector("form");
    return card?.nextElementSibling === settings.querySelector(".keyboard-tips") &&
      form?.lastElementChild?.classList.contains("settings-footer") === true;
  }), "Settings end with the preference actions and the shortcuts sit outside the settings card");
  deepEqual(await page.locator(".settings-category > h3").allTextContents(), ["General", "Pomodoro", "Activity", "Planning"]);
  await page.getByRole("region", { name: "General", exact: true }).getByRole("combobox", { name: "Appearance" }).waitFor();
  await page.getByRole("region", { name: "Pomodoro", exact: true }).locator('input[name="focusMinutes"]').waitFor();
  await page.getByRole("region", { name: "Planning", exact: true }).getByRole("combobox", { name: "Credit system" }).waitFor();
  await chooseOption(page, "Appearance", "Dark");
  equal((await snapshot()).preferences.theme, "light", "The appearance dropdown saves with the rest of Settings");
  await page.locator('input[name="focusMinutes"]').fill("29");
  await showStudyPage(page, "activity");
  const historyNote = page.getByText("History is saved locally and shared across your devices.", { exact: true });
  await historyNote.locator('svg[data-icon="info"]').waitFor();
  await page.locator("#main-content").focus();
  await page.keyboard.press("r");
  equal((await snapshot()).timer.endAt, initialDeadline, "Timer shortcuts must not reset from another study page");
  await showStudyPage(page, "settings");
  equal(await page.locator('input[name="focusMinutes"]').inputValue(), "29", "Unsaved settings survive page changes");
  equal(await page.getByRole("combobox", { name: "Appearance", exact: true }).textContent(), "Dark", "The selected theme survives page changes before saving");
  await page.locator('input[name="focusMinutes"]').focus();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("h");
  equal(await page.locator("#tab-settings").getAttribute("aria-selected"), "true", "Editing a field must not navigate");
  await showStudyPage(page, "pomodoro");
  await page.getByRole("tab", { name: "Pomodoro", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  equal(await page.locator("#tab-activity").getAttribute("aria-selected"), "true");
  equal(await page.locator("#panel-activity").getAttribute("data-enter"), "forward");
  equal(await page.locator("#panel-activity").evaluate((element) => getComputedStyle(element).animationName), "page-panel-enter");
  await page.keyboard.press("ArrowLeft");
  equal(await page.locator("#tab-pomodoro").getAttribute("aria-selected"), "true");
  equal(await page.locator("#panel-pomodoro").getAttribute("data-enter"), "backward");
  equal(await page.locator("#panel-pomodoro").evaluate((element) => getComputedStyle(element).animationName), "page-panel-enter");
  await page.reload();
  await ready(page);
  equal((await snapshot()).timer.endAt, initialDeadline, "Refresh must use the server's original deadline");

  // Another browser context represents a phone. Its local clock is deliberately
  // six hours ahead; the server clock must keep both countdowns aligned.
  const secondDevice = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true,
    locale: "de-DE", timezoneId: "Europe/Rome", colorScheme: "light" });
  observe(secondDevice);
  await secondDevice.addInitScript(() => {
    const realNow = Date.now.bind(Date);
    Date.now = () => realNow() + 6 * 60 * 60_000;
  });
  const second = await secondDevice.newPage();
  await second.route("**/api/latest-release", (route) => route.fulfill({ json: { version: null } }));
  await second.goto(base);
  await ready(second);
  await second.getByRole("button", { name: "Pause timer", exact: true }).waitFor();
  await verifyMobileStudyPages(second);
  equal(await second.locator(".site-footer-latest").textContent(), "—", "An unavailable release keeps the installed build visible");
  equal(await second.locator("html").getAttribute("lang"), "en", "A new device uses server language, never browser language");
  ok(Math.abs(countdownSeconds(await page.getByTestId("countdown").textContent()) - countdownSeconds(await second.getByTestId("countdown").textContent())) <= 2,
    "The same session stays aligned across devices despite client clock skew");
  await second.getByRole("button", { name: "Pause timer", exact: true }).click();
  await second.getByRole("button", { name: "Resume", exact: true }).waitFor();
  await page.getByRole("button", { name: "Resume", exact: true }).waitFor();
  let paused = (await snapshot()).timer.remainingMs;
  await page.reload();
  await ready(page);
  equal((await snapshot()).timer.remainingMs, paused);
  equal(await page.getByTestId("countdown").textContent(), await second.getByTestId("countdown").textContent());

  const locales = [
    { code: "it", heading: "Benvenuto su Dyntick.", activity: "Attività di studio", pause: "Metti in pausa", resume: "Riprendi", save: "Salva preferenze", sound: "Suono a fine intervallo", dark: "Passa al tema scuro", light: "Passa al tema chiaro", year: "Anno attività" },
    { code: "de", heading: "Willkommen bei Dyntick.", activity: "Lernaktivität", pause: "Timer pausieren", resume: "Fortsetzen", save: "Einstellungen speichern", sound: "Ton am Ende jedes Intervalls", dark: "Zum dunklen Design wechseln", light: "Zum hellen Design wechseln", year: "Aktivitätsjahr" },
    { code: "es", heading: "Te damos la bienvenida a Dyntick.", activity: "Actividad de estudio", pause: "Pausar el temporizador", resume: "Continuar", save: "Guardar preferencias", sound: "Sonido al terminar cada intervalo", dark: "Cambiar al tema oscuro", light: "Cambiar al tema claro", year: "Año de actividad" },
  ];
  for (const locale of locales) {
    await chooseLanguage(second, locale.code);
    await waitForLanguage(page, locale.code);
    await page.getByRole("heading", { name: locale.heading, exact: true }).waitFor();
    equal((await snapshot()).timer.remainingMs, paused, "Language changes preserve paused time");
    await page.getByRole("button", { name: locale.resume, exact: true }).click();
    await page.getByRole("button", { name: locale.pause, exact: true }).waitFor();
    await ready(page);
    const deadline = (await snapshot()).timer.endAt;
    await chooseLanguage(second, "en");
    await page.getByRole("button", { name: "Pause timer", exact: true }).waitFor();
    equal((await snapshot()).timer.endAt, deadline, "Language changes preserve an active deadline");
    await chooseLanguage(second, locale.code);
    await waitForLanguage(page, locale.code);
    await showStudyPage(page, "settings");
    await page.getByRole("switch", { name: locale.sound, exact: true }).waitFor();
    await page.locator('input[name="focusMinutes"]').fill("30");
    await page.getByRole("button", { name: locale.save, exact: true }).click();
    await ready(page);
    equal((await snapshot()).preferences.focusMinutes, 30);
    equal((await snapshot()).timer.endAt, deadline, "Saving future durations preserves the current timer");
    await showStudyPage(page, "pomodoro");
    await ready(second);
    await second.getByRole("button", { name: locale.pause, exact: true }).click();
    await page.getByRole("button", { name: locale.resume, exact: true }).waitFor();
    const samePaused = (await snapshot()).timer.remainingMs;
    await page.reload();
    await ready(page);
    equal((await snapshot()).timer.remainingMs, samePaused);
    await page.screenshot({ path: `${output}/${locale.code}-desktop-light.png`, fullPage: true, animations: "disabled" });
    await page.setViewportSize({ width: 320, height: 740 });
    await page.getByRole("button", { name: locale.dark, exact: true }).click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
    await second.waitForFunction(() => document.documentElement.dataset.theme === "dark");
    await ready(page);
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${locale.code} fits at 320px`);
    await page.screenshot({ path: `${output}/${locale.code}-mobile-dark.png`, fullPage: true, animations: "disabled" });
    await showStudyPage(page, "settings");
    ok(await page.getByTestId("settings-page").evaluate(element => element.scrollWidth <= element.clientWidth), `${locale.code} settings fit at 320px`);
    const save = page.getByRole("button", { name: locale.save, exact: true });
    await save.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${output}/${locale.code}-settings-mobile.png`, fullPage: true, animations: "disabled" });
    await save.click();
    await ready(page);
    await showStudyPage(page, "pomodoro");
    equal((await snapshot()).timer.remainingMs, samePaused);
    await page.getByRole("button", { name: locale.light, exact: true }).click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
    await ready(page);
    await page.setViewportSize({ width: 1440, height: 1024 });
    paused = samePaused;
  }
  await chooseLanguage(second, "en");
  await waitForLanguage(page, "en");

  // The old browser values remain a backup and no longer change as the shared state changes.
  deepEqual(await page.evaluate(() => ({ preferences: localStorage.getItem("dyntick.preferences.v1"), activity: localStorage.getItem("dyntick.activity.v1"), timer: sessionStorage.getItem("dyntick.timer.v1") })), backup);
  equal(await second.evaluate(() => localStorage.getItem("dyntick.activity.v1")), null);
  equal(await second.evaluate(() => sessionStorage.getItem("dyntick.timer.v1")), null);

  // A later device contributes its old history but cannot replace the current timer/settings.
  const beforeLaterImport = await snapshot();
  const laterDevice = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  observe(laterDevice);
  await laterDevice.addInitScript((origin) => {
    if (location.origin !== origin) return;
    localStorage.setItem("dyntick.preferences.v1", JSON.stringify({ language: "it", focusMinutes: 50, theme: "dark" }));
    localStorage.setItem("dyntick.activity.v1", JSON.stringify({ version: 1, entries: {
      "browser-later-device": { id: "browser-later-device", completedAt: Date.now() - 300_000, minutes: 50 },
    } }));
  }, new URL(base).origin);
  const later = await laterDevice.newPage();
  await later.goto(base);
  await ready(later);
  const afterLaterImport = await snapshot();
  deepEqual(afterLaterImport.preferences, beforeLaterImport.preferences);
  deepEqual(afterLaterImport.timer, beforeLaterImport.timer);
  equal(Object.keys(afterLaterImport.activity.entries).length, 3);
  await later.reload();
  await ready(later);
  equal(Object.keys((await snapshot()).activity.entries).length, 3);
  await laterDevice.close();

  // Dense calendar fixtures are imported through the normal migration endpoint;
  // they never ship in product data and never overwrite the server's current session.
  const entries: Record<string, { id: string; completedAt: number; minutes: number }> = {};
  const today = new Date();
  for (let index = 0; index < 8; index++) {
    const id = `browser-cycle-focus-${index}`;
    entries[id] = { id, completedAt: today.getTime(), minutes: 1 };
  }
  for (let offset = 1; offset <= 180; offset++) {
    if (offset % 7 === 0 || offset % 4 === 1) continue;
    const completedAt = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset, 12).getTime();
    for (let index = 0; index < 1 + offset % 4; index++) {
      const id = `browser-calendar-${offset}-${index}`;
      entries[id] = { id, completedAt: completedAt + index * 30 * 60_000, minutes: 25 };
    }
  }
  const previousYear = today.getFullYear() - 1;
  const olderDate = `${previousYear}-01-15`;
  const fullHistoryDate = `${previousYear}-01-18`;
  for (let index = 0; index < 2; index++) {
    const id = `browser-previous-year-${index}`;
    entries[id] = { id, completedAt: new Date(previousYear, 0, 15, 12, index * 30).getTime(), minutes: index === 0 ? 5 : 45 };
    const recordId = `browser-record-${index}`;
    entries[recordId] = { id: recordId, completedAt: new Date(previousYear, 0, 20, 12, index * 30).getTime(), minutes: 180 };
  }
  for (let index = 0; index < 12; index++) {
    const id = `browser-history-day-${index}`;
    entries[id] = { id, completedAt: new Date(previousYear, 0, 18, 8, index * 20).getTime(), minutes: 20 };
  }
  const populated = await post("/api/import", { requestId: crypto.randomUUID(), activity: { version: 1, entries } });
  equal(populated.preferences.longBreakInterval, 4);
  await showStudyPage(page, "pomodoro");
  await page.getByTestId("today-cycle-count").filter({ hasText: /^2$/ }).waitFor();
  await showStudyPage(page, "activity");
  equal(await page.locator('.activity-year .select-trigger svg[data-icon="calendar"]').count(), 1);
  await page.getByRole("heading", { name: "Study activity", exact: true }).waitFor();
  equal(await page.getByText("Small sessions. Steady progress.", { exact: true }).count(), 0);
  await verifyActivityCalendar(page, 2);
  const timeTracking = page.getByRole("region", { name: "Time tracking", exact: true });
  equal(await timeTracking.locator(".time-tracking-selection").count(), 0);
  const expectedTracking = await page.evaluate((activity) => {
    const date = new Date();
    const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    const minutes = Object.values(activity.entries).reduce((total, entry) =>
      new Date(entry.completedAt).toDateString() === date.toDateString() ? total + entry.minutes : total, 0);
    return { month, day: date.getDate(), minutes };
  }, populated.activity);
  equal(await timeTracking.getAttribute("data-month"), expectedTracking.month);
  const trackedDays = timeTracking.locator("[data-tracking-day]");
  const todayTracking = timeTracking.locator(`[data-tracking-day="${expectedTracking.day}"][data-minutes="${expectedTracking.minutes}"]`);
  await todayTracking.waitFor();
  const verifyTrackingColors = async () => {
    ok(await todayTracking.locator(".time-tracking-bar").evaluate((bar) => {
      const primaryButton = document.querySelector(".timer-actions .primary-action")!;
      const legend = bar.closest(".time-tracking-card")!.querySelector(".time-tracking-key-bars")!;
      const fill = getComputedStyle(primaryButton).backgroundColor;
      return getComputedStyle(bar).backgroundColor === fill && getComputedStyle(legend).backgroundColor === fill;
    }), "The histogram bars and legend use the primary button fill");
  };
  await verifyTrackingColors();
  equal(await trackedDays.count(), expectedTracking.day, "Future days may appear on the axis but never have tracked totals");
  await timeTracking.getByText("7-day average", { exact: false }).waitFor();
  await timeTracking.getByText("All-time daily high", { exact: false }).filter({ hasText: "360 min" }).waitFor();
  await timeTracking.locator(".time-tracking-record").waitFor({ state: "attached" });
  if (expectedTracking.day > 1) {
    await trackedDays.last().focus();
    await page.keyboard.press("ArrowLeft");
    equal(await trackedDays.nth(expectedTracking.day - 2).getAttribute("aria-pressed"), "true");
    equal(await page.locator("#tab-activity").getAttribute("aria-selected"), "true");
    await page.keyboard.press("ArrowRight");
  }
  const nextActivityYear = String(Number(expectedTracking.month.slice(0, 4)) + 1);
  const activityCalendar = page.getByTestId("activity-calendar");
  await chooseOption(page, "Activity year", nextActivityYear);
  equal(await activityCalendar.locator(".calendar-month").count(), 12);
  equal(await activityCalendar.locator("button.activity-cell").count(), 0, "The next year only shows future days");
  equal(await timeTracking.getAttribute("data-month"), `${nextActivityYear}-01`);
  await chooseOption(page, "Tracking month", "February", timeTracking);
  equal(await timeTracking.getAttribute("data-month"), `${nextActivityYear}-02`);
  equal(await trackedDays.count(), 0);
  await chooseOption(page, "Activity year", String(previousYear));
  equal(await timeTracking.getAttribute("data-month"), `${previousYear}-01`);
  equal(await trackedDays.count(), 31);
  await timeTracking.locator('[data-tracking-day="15"][data-minutes="50"]').waitFor();
  await chooseOption(page, "Tracking month", "February", timeTracking);
  equal(await timeTracking.getAttribute("data-month"), `${previousYear}-02`);
  equal(await trackedDays.count(), new Date(previousYear, 2, 0).getDate());
  const calendarMonths = page.getByTestId("activity-calendar").locator(".calendar-month");
  equal(await calendarMonths.count(), 12);
  equal(await calendarMonths.nth(0).locator(`[data-day="${previousYear}-01-31"]`).count(), 1);
  equal(await calendarMonths.nth(1).locator(`[data-day="${previousYear}-02-01"]`).count(), 1);
  await calendarMonths.nth(0).locator(`[data-day="${previousYear}-01-31"]`).focus();
  await page.keyboard.press("ArrowDown");
  equal(await calendarMonths.nth(1).locator(`[data-day="${previousYear}-02-01"]`).getAttribute("aria-pressed"), "true");
  const olderDay = page.locator(`[data-day="${olderDate}"]`);
  await page.waitForFunction(key => document.querySelector(`[data-day="${key}"]`)?.getAttribute("data-count") === "2", olderDate);
  await olderDay.click();
  ok(await olderDay.evaluate((cell) => {
    const style = getComputedStyle(cell);
    const filled = cell.getBoundingClientRect();
    const empty = cell.closest(".calendar-month")!.querySelector('[data-level="0"]')!.getBoundingClientRect();
    return filled.width >= 15 && filled.width === empty.width && filled.height === empty.height &&
      style.backgroundClip === "border-box" && Number.parseFloat(style.outlineOffset) <= -Number.parseFloat(style.outlineWidth);
  }), "Filled and empty cells share the same footprint, including the selection outline");
  const dayDetails = page.getByTestId("activity-day-details");
  await dayDetails.locator(".day-summary p").filter({ hasText: /2 sessions.*50 min/ }).waitFor();
  ok(await dayDetails.evaluate((details) => {
    const history = details.querySelector(".day-records")!.getBoundingClientRect();
    const summary = details.querySelector(".day-summary")!.getBoundingClientRect();
    return history.right < summary.left;
  }), "The session history sits to the left of the selected day summary");
  const daySessions = dayDetails.getByRole("list").getByRole("listitem");
  equal(await daySessions.count(), 2);
  ok(await daySessions.evaluateAll((rows) => rows.every((row) => {
    const dot = row.querySelector(".day-record-dot")!.getBoundingClientRect();
    const labelElement = row.querySelector(".day-record-label")!;
    const label = labelElement.getBoundingClientRect();
    const text = document.createRange();
    text.selectNodeContents(labelElement);
    const divider = row.querySelector(".day-record-divider")!.getBoundingClientRect();
    const duration = row.querySelector("strong")!.getBoundingClientRect();
    return row.children.length === 4 && text.getClientRects().length === 1 && dot.width === 6 && dot.height === 6
      && dot.right < label.left && label.right < divider.left && divider.right < duration.left
      && divider.width === 16 && divider.height === 1;
  })), "A dot, an unbroken label, a divider and the duration form each row");
  for (const index of [0, 1]) {
    const entry = entries[`browser-previous-year-${index}`];
    const row = daySessions.nth(index);
    await row.getByText("Focus session", { exact: true }).waitFor();
    await row.getByText(`${entry.minutes} min`, { exact: true }).waitFor();
  }
  await olderDay.focus();
  await page.keyboard.press("ArrowDown");
  equal(await page.locator(`[data-day="${previousYear}-01-16"]`).getAttribute("aria-pressed"), "true");
  await dayDetails.getByText("No focus sessions completed on this day.", { exact: true }).waitFor();
  equal(await daySessions.count(), 0);
  await page.keyboard.press("ArrowUp");
  equal(await olderDay.getAttribute("aria-pressed"), "true");
  await page.keyboard.press("ArrowRight");
  equal(await page.locator("#tab-activity").getAttribute("aria-selected"), "true", "Calendar arrows must not change pages");
  equal(await page.locator(`[data-day="${previousYear}-01-22"]`).getAttribute("aria-pressed"), "true");
  await page.keyboard.press("ArrowLeft");
  await page.screenshot({ path: `${output}/history-previous-year.png`, fullPage: true, animations: "disabled" });
  await chooseOption(page, "Activity year", String(today.getFullYear()));
  equal(await timeTracking.getAttribute("data-month"), expectedTracking.month);
  await page.screenshot({ path: `${output}/history-desktop-light.png`, fullPage: true, animations: "disabled" });
  await page.getByRole("button", { name: "Switch to dark theme", exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  await ready(page);
  await verifyTrackingColors();
  const futureCells = page.getByTestId("activity-calendar").locator(".activity-cell.future");
  if (await futureCells.count()) {
    ok(await futureCells.first().evaluate((cell) => {
      const futureStyle = getComputedStyle(cell);
      const emptyStyle = getComputedStyle(cell.closest(".activity-panel")!.querySelector('.activity-legend [data-level="0"]')!);
      return futureStyle.opacity === "1" && futureStyle.borderTopColor === emptyStyle.borderTopColor &&
        futureStyle.backgroundColor === emptyStyle.backgroundColor;
    }), "Future days match the fill and border for past days without activity");
  }
  await page.screenshot({ path: `${output}/history-desktop-dark.png`, fullPage: true, animations: "disabled" });
  await showStudyPage(second, "activity");
  await second.getByRole("heading", { name: "Study activity", exact: true }).waitFor();
  await chooseOption(second, "Activity year", String(previousYear));
  await second.waitForFunction(key => document.querySelector(`[data-day="${key}"]`)?.getAttribute("data-count") === "2", olderDate);
  await second.locator(`[data-day="${olderDate}"]`).click();
  const mobileDayDetails = second.getByTestId("activity-day-details");
  await mobileDayDetails.locator(".day-summary p").filter({ hasText: /2 sessions.*50 min/ }).waitFor();
  await second.setViewportSize({ width: 320, height: 740 });
  await verifyActivityCalendar(second, 6);
  ok(await mobileDayDetails.evaluate((details) => {
    const history = details.querySelector(".day-records")!.getBoundingClientRect();
    const summary = details.querySelector(".day-summary")!.getBoundingClientRect();
    return summary.bottom < history.top;
  }), "The selected day summary stacks above the session list on mobile");
  await second.locator(`[data-day="${fullHistoryDate}"]`).tap();
  const fullHistory = mobileDayDetails.getByRole("list");
  equal(await fullHistory.getByRole("listitem").count(), 12);
  ok(await fullHistory.evaluate((list) => {
    const bounds = list.getBoundingClientRect();
    const last = list.lastElementChild!.getBoundingClientRect();
    const text = document.createRange();
    const oneLineLabels = Array.from(list.querySelectorAll(".day-record-label")).every((label) => {
      text.selectNodeContents(label);
      return text.getClientRects().length === 1;
    });
    return oneLineLabels && list.scrollWidth <= list.clientWidth && list.scrollHeight <= list.clientHeight && last.bottom <= bounds.bottom + 1;
  }), "All session rows and their timing fit without a scrollbar at 320px");
  await chooseOption(second, "Activity year", String(today.getFullYear()));
  equal(Object.keys((await snapshot()).activity.entries).length, Object.keys(populated.activity.entries).length);
  ok(await second.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
  const mobileTracking = second.getByRole("region", { name: "Time tracking", exact: true });
  await mobileTracking.locator(`[data-tracking-day="${expectedTracking.day}"]`).tap();
  equal(await mobileTracking.locator(`[data-tracking-day="${expectedTracking.day}"]`).getAttribute("aria-pressed"), "true");
  await second.screenshot({ path: `${output}/history-mobile-dark.png`, fullPage: true, animations: "disabled" });

  // Move an exam with a desktop drag, then assign it on the narrow second device.
  await showStudyPage(page, "planning");
  await page.getByRole("heading", { name: "Exam Session", exact: true }).waitFor();
  equal(await page.locator('.planning-year .select-trigger svg[data-icon="calendar"]').count(), 1);
  equal(await page.getByRole("region", { name: "Unscheduled", exact: true }).locator('svg[data-icon="calendar-pending"]').count(), 1);
  ok(await page.locator(".planning-header").evaluate((header) => {
    const intro = header.querySelector(".planning-intro")!.getBoundingClientRect();
    const controls = header.querySelector(".planning-controls")!.getBoundingClientRect();
    return intro.right <= controls.left && Math.abs((intro.top + intro.bottom) - (controls.top + controls.bottom)) <= 2;
  }), "The Planning copy and controls share one centered row on desktop");
  await ready(page);
  const yearPicker = page.getByRole("combobox", { name: "Academic year", exact: true });
  const currentAcademicYear = (await yearPicker.textContent())?.trim() ?? "";
  const planningYear = Number(currentAcademicYear.split("–")[0]);
  ok(planningYear > 2000);
  const examName = "Operating Systems, Concurrent Programming and Cloud Distributed Systems Security";
  equal(examName.length, MAX_EXAM_NAME_LENGTH);
  await page.getByRole("button", { name: "Add exam", exact: true }).click();
  const editor = page.getByRole("dialog");
  const nameField = editor.getByLabel("Exam name");
  equal(await nameField.getAttribute("maxlength"), String(MAX_EXAM_NAME_LENGTH));
  await nameField.fill(examName);
  const creditsField = editor.getByRole("spinbutton", { name: "Credits (CFU)", exact: true });
  const addExam = editor.getByRole("button", { name: "Add exam", exact: true });
  await creditsField.fill("101");
  ok(await addExam.isDisabled(), "Values above 100 cannot be saved");
  await creditsField.fill("9");
  const examDate = `${planningYear + 1}-02-12`;
  const europeanDate = `12/02/${planningYear + 1}`;
  const americanDate = `02/12/${planningYear + 1}`;
  const dateOnTile = `time[datetime="${examDate}"]`;
  const examDateField = editor.getByLabel("Exam date", { exact: true });
  equal(await examDateField.getAttribute("placeholder"), "dd/mm/yyyy");
  await examDateField.fill(`31/02/${planningYear + 1}`);
  ok(await addExam.isDisabled(), "Invalid calendar dates cannot be saved");
  await examDateField.fill(`11/02/${planningYear + 1}`);
  const openCalendar = editor.getByRole("button", { name: "Open calendar", exact: true });
  await openCalendar.click();
  const examCalendar = page.getByRole("dialog", { name: "Exam date", exact: true });
  ok(await examCalendar.evaluate((popup) => {
    const style = getComputedStyle(popup);
    const editorStyle = getComputedStyle(document.querySelector('.exam-editor[aria-labelledby="exam-editor-title"]')!);
    return ["background-color", "border-top-color", "border-radius", "color", "font-family"].every((property) =>
      style.getPropertyValue(property) === editorStyle.getPropertyValue(property));
  }), "The exam calendar shares the editor theme");
  const selectedDate = examCalendar.getByRole("button", { pressed: true });
  await selectedDate.press("ArrowRight");
  const nextDate = examCalendar.getByRole("button", { name: new RegExp(`12 February ${planningYear + 1}$`) });
  equal(await nextDate.evaluate((button) => button === document.activeElement), true);
  await page.keyboard.press("Enter");
  await examCalendar.waitFor({ state: "hidden" });
  equal(await examDateField.inputValue(), europeanDate);
  await openCalendar.click();
  await examCalendar.waitFor();
  await page.keyboard.press("Escape");
  await examCalendar.waitFor({ state: "hidden" });
  equal(await openCalendar.evaluate((button) => button === document.activeElement), true, "Closing the calendar restores focus to its trigger");
  await addExam.click();
  await editor.waitFor({ state: "hidden" });
  const unassigned = page.getByRole("region", { name: "Unscheduled", exact: true });
  const winter = page.getByRole("region", { name: "Winter session", exact: true });
  await unassigned.getByRole("button", { name: examName })
    .dragTo(winter.getByText("No exams planned", { exact: true }));
  const winterTile = winter.getByRole("button", { name: examName });
  await winterTile.getByText("9 CFU", { exact: true }).waitFor();
  const winterDate = winterTile.locator(dateOnTile);
  await winterDate.filter({ hasText: europeanDate }).waitFor();
  const winterTotals = winter.getByTestId("exam-zone-totals");
  await winterTotals.getByText("1 exam", { exact: true }).waitFor();
  await winterTotals.getByText("9 CFU", { exact: true }).waitFor();
  equal(await unassigned.getByRole("button").count(), 0);
  await action({ type: "exam.create", exam: { id: "browser-extra-exam", name: "Algorithms", academicYear: planningYear, session: "winter", credits: 3 } });
  await winterTotals.getByText("2 exams", { exact: true }).waitFor();
  await winterTotals.getByText("12 CFU", { exact: true }).waitFor();
  const winterMonthsLabel = "Edit months for Winter session";
  equal(await winter.getByRole("button", { name: winterMonthsLabel, exact: true }).count(), 0);
  await showStudyPage(page, "settings");
  const examPeriods = page.getByRole("region", { name: "Exam periods", exact: true });
  await examPeriods.getByRole("button", { name: winterMonthsLabel, exact: true }).click();
  const monthsEditor = page.getByRole("dialog", { name: "Winter session", exact: true });
  await monthsEditor.getByRole("checkbox", { name: "December", exact: true }).check();
  await monthsEditor.getByRole("button", { name: "Save months", exact: true }).click();
  await monthsEditor.waitFor({ state: "hidden" });
  await examPeriods.getByText("Dec–Feb", { exact: true }).waitFor();
  await chooseOption(page, "Credit system", "CATS");
  await chooseOption(page, "Date format", "American (mm/dd/yyyy)");
  await page.getByRole("button", { name: "Save preferences", exact: true }).click();
  await ready(page);
  await showStudyPage(page, "planning");
  await winter.getByText("Dec–Feb", { exact: true }).waitFor();
  await winterTotals.getByText("12 CATS", { exact: true }).waitFor();
  await winterDate.filter({ hasText: americanDate }).waitFor();
  await page.mouse.move(0, 0);
  ok(await winterTile.evaluate(async (tile) => {
    await Promise.all(tile.getAnimations().map((animation) => animation.finished.catch(() => {})));
    const tileStyle = getComputedStyle(tile);
    const cycleStyle = getComputedStyle(document.querySelector(".cycle-panel")!);
    return ["background-color", "background-image", "border-top-color", "box-shadow", "color"].every((property) =>
      tileStyle.getPropertyValue(property) === cycleStyle.getPropertyValue(property));
  }), "The exam card and Current cycle share the secondary card theme");
  await page.screenshot({ path: `${output}/planning-desktop-dark.png`, fullPage: true, animations: "disabled" });

  await chooseOption(page, "Academic year", `${planningYear + 1}–${planningYear + 2}`);
  equal(await winter.getByRole("button", { name: examName }).count(), 0);
  await winterTotals.getByText("0 CATS", { exact: true }).waitFor();
  await chooseOption(page, "Academic year", currentAcademicYear);
  await showStudyPage(second, "settings");
  const mobileExamPeriods = second.getByRole("region", { name: "Exam periods", exact: true });
  await mobileExamPeriods.getByText("Dec–Feb", { exact: true }).waitFor();
  await mobileExamPeriods.getByRole("button", { name: winterMonthsLabel, exact: true }).tap();
  const mobileMonths = second.getByRole("dialog", { name: "Winter session", exact: true });
  equal(await mobileMonths.getByRole("checkbox", { name: "December", exact: true }).isChecked(), true);
  await mobileMonths.getByRole("button", { name: "Cancel", exact: true }).tap();
  await showStudyPage(second, "planning");
  await chooseOption(second, "Academic year", currentAcademicYear);
  const mobileWinter = second.getByRole("region", { name: "Winter session", exact: true });
  await mobileWinter.getByText("Dec–Feb", { exact: true }).waitFor();
  const sharedTile = mobileWinter.getByRole("button", { name: examName });
  await sharedTile.locator(dateOnTile).filter({ hasText: americanDate }).waitFor();
  ok(await sharedTile.evaluate((tile) => tile.scrollWidth <= tile.clientWidth && tile.scrollHeight <= tile.clientHeight),
    "An exam tile with a long name fits on a narrow phone");
  await sharedTile.tap();
  const mobileEditor = second.getByRole("dialog", { name: "Edit exam", exact: true });
  const mobileDateField = mobileEditor.getByLabel("Exam date", { exact: true });
  equal(await mobileDateField.inputValue(), americanDate);
  await mobileEditor.getByRole("button", { name: "Open calendar", exact: true }).tap();
  const mobileCalendar = second.getByRole("dialog", { name: "Exam date", exact: true });
  const yearField = mobileCalendar.getByRole("spinbutton", { name: "Year", exact: true });
  await yearField.fill(String(planningYear + 2));
  await chooseOption(second, "Month", "March", mobileCalendar);
  await mobileCalendar.getByRole("button", { name: new RegExp(`12 March ${planningYear + 2}$`) }).tap();
  await mobileCalendar.waitFor({ state: "hidden" });
  equal(await mobileDateField.inputValue(), `03/12/${planningYear + 2}`);
  await mobileDateField.fill(americanDate);
  await chooseOption(second, "Session", "Resit session", mobileEditor);
  await mobileEditor.getByRole("spinbutton", { name: "Credits (CATS)", exact: true }).fill("100");
  await mobileEditor.getByRole("button", { name: "Save exam", exact: true }).tap();
  await mobileEditor.waitFor({ state: "hidden" });
  ok(await second.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "Planning fits at 320px");
  await second.screenshot({ path: `${output}/planning-mobile-dark.png`, fullPage: true, animations: "disabled" });
  const resit = page.getByRole("region", { name: "Resit session", exact: true });
  const resitTotals = resit.getByTestId("exam-zone-totals");
  const resitTile = resit.getByRole("button", { name: examName });
  await resitTile.getByText("100 CATS", { exact: true }).waitFor();
  await winterTotals.getByText("3 CATS", { exact: true }).waitFor();
  await page.reload();
  await ready(page);
  equal(new URL(page.url()).hash, "#planning");
  await resitTotals.getByText("100 CATS", { exact: true }).waitFor();
  await resitTile.locator(dateOnTile).waitFor();
  await resitTile.click();
  await editor.getByRole("button", { name: "Clear date", exact: true }).click();
  await editor.getByRole("button", { name: "Save exam", exact: true }).click();
  await editor.waitFor({ state: "hidden" });
  equal(await resitTile.locator("time").count(), 0);
  await resitTile.click();
  await editor.getByRole("button", { name: "Remove exam", exact: true }).click();
  await editor.getByRole("button", { name: "Remove exam", exact: true }).click();
  await editor.waitFor({ state: "hidden" });
  await resitTotals.getByText("0 exams", { exact: true }).waitFor();
  await resitTotals.getByText("0 CATS", { exact: true }).waitFor();
  await action({ type: "exam.delete", id: "browser-extra-exam" });
  equal((await snapshot()).exams.length, 0);

  // A disconnected device must never claim a server write succeeded or keep editing
  // a separate local timer. Reconnection receives changes made by the other PC.
  await showStudyPage(page, "pomodoro");
  await showStudyPage(second, "pomodoro");
  const syncBadge = page.getByTestId("sync-status").locator(".sync-badge");
  equal(await syncBadge.textContent(), "Synced");
  equal(await syncBadge.locator("svg").getAttribute("data-icon"), "check");
  await page.route("**/api/**", route => route.abort("connectionfailed"));
  await page.locator('[data-testid="sync-status"][data-sync-state="offline"]').waitFor();
  equal(await syncBadge.textContent(), "Unsynced");
  equal(await syncBadge.locator("svg").getAttribute("data-icon"), "close");
  equal(await page.locator(".primary-action").isDisabled(), true);
  equal(await page.locator(".reset-action").isDisabled(), true);
  await ready(second);
  await second.getByRole("button", { name: "Switch to light theme", exact: true }).click();
  await second.waitForFunction(() => document.documentElement.dataset.theme === "light");
  await ready(second);
  await page.screenshot({ path: `${output}/connection-offline.png`, fullPage: true, animations: "disabled" });
  await page.unroute("**/api/**");
  await page.getByRole("button", { name: "Retry connection", exact: true }).click();
  await ready(page);
  await page.waitForFunction(() => document.documentElement.dataset.theme === "light");

  // Drop one response *after* SQLite accepted a command. The retry must reuse its
  // request identity, so recovery cannot start an extra phase or pause the session.
  await action({ type: "reset" });
  await page.getByRole("button", { name: "Start focusing", exact: true }).waitFor();
  await ready(page);
  const beforeLostResponse = await snapshot();
  let releaseOldPoll = () => {};
  let markPollHeld = () => {};
  let markPollDelivered = () => {};
  let releaseRetry = () => {};
  const oldPollGate = new Promise<void>(resolve => { releaseOldPoll = resolve; });
  const pollHeld = new Promise<void>(resolve => { markPollHeld = resolve; });
  const pollDelivered = new Promise<void>(resolve => { markPollDelivered = resolve; });
  const retryGate = new Promise<void>(resolve => { releaseRetry = resolve; });
  let holdOnePoll = true;
  await page.route("**/api/state", async route => {
    if (!holdOnePoll) { await route.continue(); return; }
    holdOnePoll = false;
    const oldResponse = await route.fetch();
    markPollHeld();
    await oldPollGate;
    await route.fulfill({ response: oldResponse });
    markPollDelivered();
  });
  let pollTimeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([pollHeld, new Promise<never>((_, reject) => {
      pollTimeout = setTimeout(() => reject(new Error("The browser did not issue its scheduled state poll")), 15_000);
    })]);
  } finally { clearTimeout(pollTimeout); }
  let dropped = false;
  await page.route("**/api/action", async route => {
    if (dropped) { await retryGate; await route.continue(); return; }
    dropped = true;
    const accepted = await route.fetch();
    equal(accepted.status(), 200);
    await route.abort("connectionfailed");
  });
  await page.getByRole("button", { name: "Start focusing", exact: true }).click();
  await page.locator('[data-testid="sync-status"][data-sync-state="offline"]').waitFor();
  releaseOldPoll();
  await pollDelivered;
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const unresolved = await page.getByTestId("sync-status").getAttribute("data-sync-state");
  ok(unresolved === "offline" || unresolved === "saving", "An old GET response cannot claim an unresolved command was saved");
  equal(await page.locator(".primary-action").isDisabled(), true, "A command awaiting confirmation must keep further edits disabled");
  releaseRetry();
  await page.getByRole("button", { name: "Pause timer", exact: true }).waitFor();
  await ready(page);
  await page.unroute("**/api/state");
  const afterLostResponse = await snapshot();
  equal(afterLostResponse.timer.status, "running");
  equal(afterLostResponse.revision, beforeLostResponse.revision + 1, "A lost response must not apply a command twice");
  equal(Object.keys(afterLostResponse.activity.entries).length, Object.keys(populated.activity.entries).length);
  await page.unroute("**/api/action");
  await second.getByRole("button", { name: "Pause timer", exact: true }).waitFor();
  await second.getByRole("button", { name: "Pause timer", exact: true }).click();
  await page.getByRole("button", { name: "Resume", exact: true }).waitFor();
  // Exercise saving when only the exam periods and date format differ from the defaults.
  await action({ type: "preferences", patch: { ...DEFAULT_PREFERENCES, dateFormat: "mdy" } });
  await showStudyPage(page, "settings");
  await ready(page);
  const beforeRestore = await snapshot();
  await examPeriods.getByText("Dec–Feb", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Restore defaults", exact: true }).click();
  await examPeriods.getByText("Jan–Feb", { exact: true }).waitFor();
  await page.getByRole("combobox", { name: "Date format", exact: true }).filter({ hasText: "European (dd/mm/yyyy)" }).waitFor();
  deepEqual((await snapshot()).sessionMonths, beforeRestore.sessionMonths, "Restore updates only the Settings draft until saved");
  await page.getByRole("button", { name: "Save preferences", exact: true }).click();
  await page.getByText("Preferences saved.", { exact: true }).waitFor();
  await ready(page);
  const afterRestore = await snapshot();
  deepEqual(afterRestore.sessionMonths, DEFAULT_SESSION_MONTHS);
  equal(afterRestore.preferences.dateFormat, "dmy");
  deepEqual(afterRestore.timer, beforeRestore.timer, "Saving defaults preserves the paused timer");
  await showStudyPage(second, "planning");
  await mobileWinter.getByText("Jan–Feb", { exact: true }).waitFor();
  await secondDevice.close();
  await desktop.close();
  deepEqual(errors, [], "No runtime errors or external resource requests are allowed");
  console.log("Browser checks passed: real SQLite migration and deduplication, two independent devices, shared active/paused timer, server clock skew correction, saved EN/IT/DE/ES preferences, themes, responsive cycles and settings, keyboard navigation, preserved legacy backups, merged history, calendar keyboard access, offline/reconnect and idempotent lost-response recovery. Main-page light and dark screenshots captured from this build.");
} finally {
  await browser.close();
}
