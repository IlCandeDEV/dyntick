// Runs on a GitHub runner against its production container.
import { deepEqual, equal, ok } from "node:assert/strict";
import { chromium, type Page } from "playwright";

const base = Deno.env.get("DYNTICK_TEST_URL") ?? "http://127.0.0.1:18080";
const output = ".ci-output/screenshots";
await Deno.mkdir(output, { recursive: true });
const browser = await chromium.launch();
const errors: string[] = [];

const languageLabels: Record<string, string> = { en: "English", it: "Italiano", de: "Deutsch", es: "Español" };

async function chooseLanguage(page: Page, language: string) {
  await page.getByTestId("language-selector").click();
  await page.getByRole("option", { name: languageLabels[language], exact: true }).click();
  await page.waitForFunction((value) => document.documentElement.lang === value, language);
}

async function showStudyPage(page: Page, target: "pomodoro" | "activity" | "settings") {
  await page.locator(`#tab-${target}`).click();
  await page.waitForFunction((id) =>
    document.getElementById(`tab-${id}`)?.getAttribute("aria-selected") === "true", target);
  await page.locator(".page-track").evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished.catch(() => {})));
  });
}

async function waitForActivity(page: Page, count: number) {
  await page.waitForFunction((expected) => {
    const raw = localStorage.getItem("dyntick.activity.v1");
    return raw !== null && Object.keys(JSON.parse(raw).entries).length === expected;
  }, count);
}

async function dayKey(page: Page, timestamp: number) {
  return await page.evaluate((value) => {
    const date = new Date(value);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }, timestamp);
}

async function waitForDaySessions(page: Page, key: string, count: string) {
  await page.waitForFunction(({ day, sessions }) =>
    document.querySelector(`[data-day="${day}"]`)?.getAttribute("data-count") === sessions,
    { day: key, sessions: count });
}

async function verifyResponsiveCycle() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, locale: "en-US" });
  context.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
  try {
    const page = await context.newPage();
    await page.goto(base);
    for (let sessions = 1; sessions <= 6; sessions++) {
      await showStudyPage(page, "settings");
      await page.locator('input[name="longBreakInterval"]').fill(String(sessions));
      await page.getByRole("button", { name: "Save preferences", exact: true }).click();
      await showStudyPage(page, "pomodoro");
      for (const width of [320, 390, 768, 1024, 1440]) {
        await page.setViewportSize({ width, height: 1050 });
        await page.waitForFunction(() => {
          const map = document.querySelector(".cycle-map-canvas")!;
          const svg = map.querySelector("svg")!;
          return Math.abs(map.clientWidth - svg.viewBox.baseVal.width) <= 1;
        });
        const geometry = await page.getByTestId("cycle-map").evaluate((map) => {
          const canvas = map.querySelector<HTMLElement>(".cycle-map-canvas")!;
          const bounds = canvas.getBoundingClientRect();
          const targets = [...map.querySelectorAll(".cycle-node")].map((button) => {
            const r = button.getBoundingClientRect();
            return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
          });
          return {
            documentFits: document.documentElement.scrollWidth <= innerWidth,
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

    const language = page.getByTestId("language-selector");
    const trigger = await page.locator(".language-trigger").boundingBox();
    const button = await language.boundingBox();
    ok(trigger && button && Math.abs(button.x - trigger.x) <= 2 && Math.abs(button.y - trigger.y) <= 2 && Math.abs(button.width - trigger.width) <= 2 && Math.abs(button.height - trigger.height) <= 2,
      "The language button must cover the complete visible control");
    await page.mouse.click(trigger.x + 12, trigger.y + trigger.height / 2);
    await page.getByRole("listbox").waitFor();
    equal(await language.evaluate((element) => getComputedStyle(element).boxShadow), "none");
    await page.screenshot({ path: `${output}/controls-language-hover.png`, fullPage: true, animations: "disabled" });
    await language.press("Escape");
    await page.mouse.click(trigger.x + trigger.width - 12, trigger.y + trigger.height / 2);
    await page.getByRole("listbox").waitFor();
    await language.press("Escape");

    await page.locator('.cycle-node[data-mode="longBreak"]').click();
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
    await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
    await page.locator(".cycle-panel").screenshot({ path: `${output}/cycle-dark-contrast.png`, animations: "disabled" });
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
    await page.emulateMedia({ reducedMotion: "reduce" });
    await node.hover();
    equal(await node.locator(".cycle-node-face").evaluate((element) => getComputedStyle(element).transform), "none");
    await showStudyPage(page, "activity");
    equal(await page.locator("#panel-activity").evaluate((element) => getComputedStyle(element).filter), "none");
    await showStudyPage(page, "pomodoro");
    console.log("Responsive cycle checks passed: 30 viewport/session combinations, full visibility, non-overlapping 44px targets, stable hover hitboxes, complete language trigger and reduced motion.");
  } finally {
    await context.close();
  }
}

try {
  // English must remain the default even when the browser itself is Italian.
  const context = await browser.newContext({ viewport: { width: 1440, height: 1024 }, colorScheme: "light", locale: "it-IT" });
  context.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
  context.on("request", (request) => {
    if (request.url().startsWith("http") && new URL(request.url()).origin !== new URL(base).origin) {
      errors.push(`Unexpected external resource: ${request.url()}`);
    }
  });
  const page = await context.newPage();
  await page.goto(base);
  await page.getByRole("heading", { name: "Welcome to Dyntick." }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  equal(await page.locator("html").getAttribute("lang"), "en");
  equal(await page.getByTestId("language-selector").getAttribute("data-language"), "en");
  equal(await page.getByTestId("countdown").textContent(), "25:00");
  // Focusing an incoming page must not add scroll offsets to its slide transform.
  await page.locator("#tab-activity").click();
  await page.locator(".year-picker select").focus();
  await showStudyPage(page, "activity");
  ok(await page.locator(".page-viewport").evaluate((element) => element.scrollLeft === 0));
  ok(await page.locator("#panel-activity").evaluate((element) =>
    Math.abs(element.getBoundingClientRect().left - element.closest(".page-viewport")!.getBoundingClientRect().left) < 1),
    "The active page stays aligned after incoming content receives focus");
  await page.getByRole("heading", { name: "Study activity", exact: true }).waitFor();
  await page.getByTestId("activity-calendar").waitFor();
  equal((await page.getByTestId("today-sessions").textContent())?.trim(), "0");
  await showStudyPage(page, "pomodoro");
  await page.screenshot({ path: `${output}/desktop-light.png`, fullPage: true, animations: "disabled" });

  await verifyResponsiveCycle();

  await page.getByRole("button", { name: "Start focusing", exact: true }).click();
  await page.getByRole("button", { name: "Pause timer", exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid="countdown"]')?.textContent !== "25:00");
  const initialDeadline = await page.evaluate(() => JSON.parse(sessionStorage.getItem("dyntick.timer.v1")!).endAt);
  // Page changes must preserve both the active deadline and an unsaved settings draft.
  await showStudyPage(page, "settings");
  await page.locator('input[name="focusMinutes"]').fill("29");
  await showStudyPage(page, "activity");
  await page.locator("#main-content").focus();
  await page.keyboard.press("r");
  equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem("dyntick.timer.v1")!).endAt), initialDeadline,
    "Timer shortcuts must not reset a session from another study page");
  await showStudyPage(page, "settings");
  equal(await page.locator('input[name="focusMinutes"]').inputValue(), "29", "Unsaved settings survive page changes");
  await showStudyPage(page, "pomodoro");
  equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem("dyntick.timer.v1")!).endAt), initialDeadline);
  await page.getByRole("tab", { name: "Pomodoro", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  equal(await page.getByRole("tab", { name: "Activity", exact: true }).getAttribute("aria-selected"), "true");
  await page.keyboard.press("ArrowLeft");
  equal(await page.getByRole("tab", { name: "Pomodoro", exact: true }).getAttribute("aria-selected"), "true");
  // Page shortcuts also work outside the tab bar, without consuming native field keys.
  await page.locator("#main-content").focus();
  await page.keyboard.press("ArrowRight");
  equal(await page.locator("#tab-activity").getAttribute("aria-selected"), "true");
  await page.keyboard.press("l");
  equal(await page.locator("#tab-settings").getAttribute("aria-selected"), "true");
  await showStudyPage(page, "settings");
  await page.getByTestId("keyboard-tips").getByText("Previous page", { exact: true }).waitFor();
  await page.locator('input[name="focusMinutes"]').focus();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("h");
  await page.keyboard.press("l");
  equal(await page.locator("#tab-settings").getAttribute("aria-selected"), "true", "Editing numbers must not navigate");
  await page.locator('select[name="theme"]').focus();
  await page.keyboard.press("h");
  equal(await page.locator("#tab-settings").getAttribute("aria-selected"), "true", "Native menus keep their keyboard behavior");
  await page.locator("#main-content").focus();
  await page.keyboard.press("ArrowLeft");
  equal(await page.locator("#tab-activity").getAttribute("aria-selected"), "true");
  await page.keyboard.press("h");
  equal(await page.locator("#tab-pomodoro").getAttribute("aria-selected"), "true");
  await page.keyboard.press("h");
  equal(await page.locator("#tab-pomodoro").getAttribute("aria-selected"), "true", "Navigation stops at the first page");
  equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem("dyntick.timer.v1")!).endAt), initialDeadline);
  await page.emulateMedia({ reducedMotion: "reduce" });
  equal(await page.locator(".timer-colon").evaluate((element) => getComputedStyle(element).animationName), "none");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  equal(await page.getByRole("link", { name: "GitHub", exact: true }).getAttribute("href"), "https://github.com/IlCandeDEV/dyntick");

  await chooseLanguage(page, "it");
  await page.getByRole("heading", { name: "Benvenuto su Dyntick." }).waitFor();
  equal(await page.locator("html").getAttribute("lang"), "it");
  equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem("dyntick.timer.v1")!).endAt), initialDeadline);
  await page.getByRole("button", { name: "Metti in pausa", exact: true }).click();
  await page.getByRole("button", { name: "Riprendi", exact: true }).waitFor();
  const pausedTime = await page.getByTestId("countdown").textContent();
  await page.reload();
  await page.getByRole("button", { name: "Riprendi", exact: true }).waitFor();
  equal(await page.getByTestId("countdown").textContent(), pausedTime);
  equal(await page.locator("html").getAttribute("lang"), "it");
  await page.screenshot({ path: `${output}/desktop-italian.png`, fullPage: true, animations: "disabled" });

  await showStudyPage(page, "settings");
  await page.getByTestId("settings-page").waitFor();
  await page.locator('input[name="focusMinutes"]').fill("30");
  await page.locator('select[name="theme"]').selectOption("dark");
  await page.getByRole("switch", { name: "Suono a fine intervallo", exact: true }).uncheck();
  await page.getByRole("button", { name: "Salva preferenze", exact: true }).click();
  await showStudyPage(page, "pomodoro");
  equal(await page.locator("html").getAttribute("lang"), "it");
  equal(await page.getByTestId("countdown").textContent(), pausedTime);
  await chooseLanguage(page, "en");
  await page.getByRole("heading", { name: "Welcome to Dyntick." }).waitFor();
  await page.getByRole("button", { name: "Reset timer", exact: true }).click();
  equal(await page.getByTestId("countdown").textContent(), "30:00");
  await page.reload();
  await page.getByRole("button", { name: "Start focusing", exact: true }).waitFor();
  equal(await page.locator("html").getAttribute("lang"), "en");
  equal(await page.getByTestId("countdown").textContent(), "30:00");
  equal(await page.locator("html").getAttribute("data-theme"), "dark");
  await page.screenshot({ path: `${output}/desktop-dark.png`, fullPage: true, animations: "disabled" });
  await showStudyPage(page, "settings");
  await page.getByTestId("settings-page").waitFor();
  await page.screenshot({ path: `${output}/settings.png`, fullPage: true, animations: "disabled" });
  await showStudyPage(page, "pomodoro");

  await page.getByRole("button", { name: "Switch to light theme", exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${output}/mobile-light.png`, fullPage: true, animations: "disabled" });
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Mobile layout must not scroll horizontally");
  await page.setViewportSize({ width: 320, height: 740 });
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "The language selector must fit narrow screens");
  await page.setViewportSize({ width: 390, height: 844 });
  await chooseLanguage(page, "it");
  await page.getByRole("heading", { name: "Benvenuto su Dyntick." }).waitFor();
  await page.screenshot({ path: `${output}/mobile-italian.png`, fullPage: true, animations: "disabled" });
  await chooseLanguage(page, "en");
  await page.getByRole("heading", { name: "Welcome to Dyntick." }).waitFor();
  await page.getByRole("button", { name: "Switch to dark theme", exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  await page.screenshot({ path: `${output}/mobile-dark.png`, fullPage: true, animations: "disabled" });

  // Recover one expired fourth session: do not auto-run any unattended breaks.
  const recoveredDeadline = await page.evaluate(() => {
    const endAt = Date.now() - 5 * 60_000;
    sessionStorage.setItem("dyntick.timer.v1", JSON.stringify({
      version: 1, mode: "focus", status: "running", durationMs: 60_000,
      remainingMs: 60_000, endAt,
      completedFocuses: 3, completionId: 10,
    }));
    return endAt;
  });
  await page.reload();
  await page.getByRole("button", { name: "Start long break", exact: true }).waitFor();
  equal(await page.getByTestId("countdown").textContent(), "00:00");
  await waitForActivity(page, 1);
  const recoveredDay = await dayKey(page, recoveredDeadline);
  await waitForDaySessions(page, recoveredDay, "1");
  equal(await page.locator(`[data-day="${recoveredDay}"]`).getAttribute("data-count"), "1");
  const firstCompletion = await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem("dyntick.activity.v1")!).entries)[0]) as { completedAt: number; minutes: number };
  equal(firstCompletion.completedAt, recoveredDeadline, "Recovery credits the original deadline, not the refresh time");
  equal(firstCompletion.minutes, 1);
  await page.reload();
  await page.getByRole("button", { name: "Start long break", exact: true }).waitFor();
  await waitForActivity(page, 1);
  equal(await page.locator(`[data-day="${recoveredDay}"]`).getAttribute("data-count"), "1", "Refresh must not duplicate a completion");
  await page.getByRole("button", { name: "Start long break", exact: true }).click();
  await page.getByRole("button", { name: "Pause timer", exact: true }).waitFor();
  equal(await page.getByRole("button", { name: "Long break", exact: true }).getAttribute("aria-pressed"), "true");

  const otherTab = await context.newPage();
  await otherTab.goto(base);
  await otherTab.getByRole("button", { name: "Start focusing", exact: true }).waitFor();
  equal(await otherTab.getByTestId("countdown").textContent(), "30:00");
  const breakDeadline = await page.evaluate(() => JSON.parse(sessionStorage.getItem("dyntick.timer.v1")!).endAt);
  await chooseLanguage(otherTab, "it");
  await page.getByRole("button", { name: "Metti in pausa", exact: true }).waitFor();
  equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem("dyntick.timer.v1")!).endAt), breakDeadline);
  equal(await otherTab.getByTestId("countdown").textContent(), "30:00");
  await chooseLanguage(otherTab, "en");
  await page.getByRole("button", { name: "Pause timer", exact: true }).waitFor();

  // A second tab finishes its own focus interval while the first remains on its break.
  // The near deadline exercises live expiry as well as storage-event synchronization.
  const secondDeadline = await otherTab.evaluate(() => {
    const endAt = Date.now() + 5000;
    sessionStorage.setItem("dyntick.timer.v1", JSON.stringify({
      version: 1, mode: "focus", status: "running", durationMs: 60_000,
      remainingMs: 60_000, endAt, completedFocuses: 0, completionId: 0,
      focusSessionId: "browser-second-tab-focus", lastFocusCompletion: null,
    }));
    return endAt;
  });
  await otherTab.reload();
  await otherTab.getByRole("button", { name: "Pause timer", exact: true }).waitFor();
  await otherTab.getByRole("button", { name: "Start short break", exact: true }).waitFor();
  await waitForActivity(otherTab, 2);
  const secondDay = await dayKey(otherTab, secondDeadline);
  const expectedOnSecondDay = recoveredDay === secondDay ? "2" : "1";
  await waitForDaySessions(page, secondDay, expectedOnSecondDay);
  await waitForDaySessions(otherTab, secondDay, expectedOnSecondDay);
  equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem("dyntick.timer.v1")!).endAt), breakDeadline, "Sharing history must preserve each tab's active timer");
  equal(await otherTab.locator(`[data-day="${secondDay}"]`).getAttribute("data-count"), expectedOnSecondDay);
  await otherTab.reload();
  await otherTab.getByRole("button", { name: "Start short break", exact: true }).waitFor();
  await waitForActivity(otherTab, 2);
  await otherTab.close();

  // Recovering an expired break must never add study activity.
  await page.evaluate(() => {
    const state = JSON.parse(sessionStorage.getItem("dyntick.timer.v1")!);
    sessionStorage.setItem("dyntick.timer.v1", JSON.stringify({ ...state, endAt: Date.now() - 1000 }));
  });
  await page.reload();
  await page.getByRole("button", { name: "Back to focus", exact: true }).waitFor();
  await waitForActivity(page, 2);
  await page.reload();
  await page.getByRole("button", { name: "Back to focus", exact: true }).waitFor();
  await waitForActivity(page, 2);

  // Populate history in this isolated browser test only, so dense calendars, old years,
  // day selection and both themes have inspectable screenshots without product demo data.
  const fixture = await page.evaluate(() => {
    const activity = JSON.parse(localStorage.getItem("dyntick.activity.v1")!);
    const now = new Date();
    for (let offset = 1; offset <= 180; offset++) {
      if (offset % 7 === 0 || offset % 4 === 1) continue;
      const completedAt = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset, 12).getTime();
      const count = 1 + offset % 4;
      for (let index = 0; index < count; index++) {
        const id = `browser-calendar-fixture-${offset}-${index}`;
        activity.entries[id] = { id, completedAt: completedAt + index * 30 * 60_000, minutes: 25 };
      }
    }
    const previousYear = now.getFullYear() - 1;
    // January of the previous year cannot overlap the rolling 180-day fixtures.
    const olderDate = `${previousYear}-01-15`;
    for (let index = 0; index < 2; index++) {
      const id = `browser-previous-year-${index}`;
      activity.entries[id] = { id, completedAt: new Date(previousYear, 0, 15, 12, index * 30).getTime(), minutes: 25 };
    }
    localStorage.setItem("dyntick.activity.v1", JSON.stringify(activity));
    return { currentYear: now.getFullYear(), previousYear, olderDate, entryCount: Object.keys(activity.entries).length };
  });
  await page.reload();
  await showStudyPage(page, "activity");
  await page.getByRole("heading", { name: "Study activity", exact: true }).waitFor();
  await waitForActivity(page, fixture.entryCount);
  await page.setViewportSize({ width: 1440, height: 1024 });
  await page.getByRole("button", { name: "Switch to light theme", exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
  await page.getByLabel("Activity year", { exact: true }).selectOption(String(fixture.previousYear));
  const olderDay = page.locator(`[data-day="${fixture.olderDate}"]`);
  equal(await olderDay.getAttribute("data-count"), "2");
  await olderDay.click();
  equal(await olderDay.getAttribute("aria-pressed"), "true");
  ok((await page.getByTestId("activity-day-details").textContent())?.includes("50"), "Selecting a day shows its focus minutes");
  await olderDay.focus();
  await page.keyboard.press("ArrowDown");
  equal(await page.locator(`[data-day="${fixture.previousYear}-01-16"]`).getAttribute("aria-pressed"), "true", "Calendar days support keyboard navigation");
  await page.keyboard.press("ArrowUp");
  equal(await olderDay.getAttribute("aria-pressed"), "true");
  await page.keyboard.press("ArrowRight");
  equal(await page.locator(`#tab-activity`).getAttribute("aria-selected"), "true", "Calendar arrows must not change pages");
  equal(await page.locator(`[data-day="${fixture.previousYear}-01-22"]`).getAttribute("aria-pressed"), "true");
  await page.keyboard.press("ArrowLeft");
  equal(await olderDay.getAttribute("aria-pressed"), "true");
  await page.screenshot({ path: `${output}/history-previous-year.png`, fullPage: true, animations: "disabled" });
  await page.getByLabel("Activity year", { exact: true }).selectOption(String(fixture.currentYear));
  await page.screenshot({ path: `${output}/history-desktop-light.png`, fullPage: true, animations: "disabled" });
  await page.getByRole("button", { name: "Switch to dark theme", exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  await page.screenshot({ path: `${output}/history-desktop-dark.png`, fullPage: true, animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${output}/history-mobile-dark.png`, fullPage: true, animations: "disabled" });
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "The activity calendar must scroll within its own container on mobile");
  await page.setViewportSize({ width: 320, height: 740 });
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Activity controls and details must fit a 320px viewport");
  await chooseLanguage(page, "it");
  await page.getByRole("heading", { name: "Attività di studio", exact: true }).waitFor();
  await page.getByLabel("Anno attività", { exact: true }).selectOption(String(fixture.previousYear));
  await page.locator(`[data-day="${fixture.olderDate}"]`).click();
  ok((await page.getByTestId("activity-day-details").textContent())?.includes("50"));
  await waitForActivity(page, fixture.entryCount);
  await page.screenshot({ path: `${output}/history-mobile-italian.png`, fullPage: true, animations: "disabled" });

  // Keep rollover checks isolated from study records and settings used above. Only
  // Date.now is replaced; real browser timers and Playwright timeouts keep running.
  const rolloverContext = await browser.newContext({
    viewport: { width: 1440, height: 1024 }, locale: "en-GB", timezoneId: "Europe/Rome",
  });
  rolloverContext.on("page", (current) => current.on("pageerror", (error) => errors.push(error.message)));
  rolloverContext.on("request", (request) => {
    if (request.url().startsWith("http") && new URL(request.url()).origin !== new URL(base).origin) {
      errors.push(`Unexpected external resource: ${request.url()}`);
    }
  });
  try {
    const rolloverPage = await rolloverContext.newPage();
    await rolloverPage.goto(base);
    await showStudyPage(rolloverPage, "activity");
    await rolloverPage.getByRole("heading", { name: "Study activity", exact: true }).waitFor();
    const times = await rolloverPage.evaluate(() => ({
      december2027: new Date(2027, 11, 31, 23, 59, 30).getTime(),
      january2028: new Date(2028, 0, 1, 0, 0, 31).getTime(),
      december2028: new Date(2028, 11, 31, 23, 59, 30).getTime(),
      january2029: new Date(2029, 0, 1, 0, 0, 31).getTime(),
    }));
    const setClock = async (timestamp: number) => {
      await rolloverPage.evaluate((now) => {
        Date.now = () => now;
        globalThis.dispatchEvent(new Event("focus"));
      }, timestamp);
    };
    const waitForSelection = async (year: string, day: string) => {
      await rolloverPage.waitForFunction(({ selectedYear, selectedDay }) =>
        document.querySelector<HTMLSelectElement>('select[aria-label="Activity year"]')?.value === selectedYear &&
        document.querySelector(`[data-day="${selectedDay}"]`)?.getAttribute("aria-pressed") === "true",
        { selectedYear: year, selectedDay: day });
    };
    await setClock(times.december2027);
    await waitForSelection("2027", "2027-12-31");
    await setClock(times.january2028);
    await waitForSelection("2028", "2028-01-01");
    equal(await rolloverPage.locator('[data-day="2028-01-01"]').getAttribute("data-today"), "true", "Following today must advance both the calendar and selected year at New Year");

    await setClock(times.december2028);
    await waitForSelection("2028", "2028-12-31");
    await rolloverPage.locator('[data-day="2028-12-15"]').click();
    await waitForSelection("2028", "2028-12-15");
    await setClock(times.january2029);
    await rolloverPage.waitForFunction(() =>
      document.querySelector('select[aria-label="Activity year"] option[value="2029"]') !== null);
    await waitForSelection("2028", "2028-12-15");
    const availableYears = await rolloverPage.getByLabel("Activity year", { exact: true }).locator("option").evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
    ok(availableYears.includes("2028") && availableYears.includes("2029"), "A manually selected historical year must remain available alongside the new current year");
    await rolloverPage.getByLabel("Activity year", { exact: true }).selectOption("2029");
    await waitForSelection("2029", "2029-01-01");
  } finally {
    await rolloverContext.close();
  }
  // Exercise the new locales on a fresh browser whose own language is German.
  // Locale changes must preserve active deadlines, paused sessions and study history.
  const languagesContext = await browser.newContext({
    viewport: { width: 1440, height: 1024 }, locale: "de-DE", timezoneId: "Europe/Rome", colorScheme: "light",
  });
  languagesContext.on("page", (current) => current.on("pageerror", (error) => errors.push(error.message)));
  languagesContext.on("request", (request) => {
    if (request.url().startsWith("http") && new URL(request.url()).origin !== new URL(base).origin) {
      errors.push(`Unexpected external resource: ${request.url()}`);
    }
  });
  try {
    const localized = await languagesContext.newPage();
    await localized.goto(base);
    await localized.getByRole("heading", { name: "Welcome to Dyntick.", exact: true }).waitFor();
    equal(await localized.locator("html").getAttribute("lang"), "en");
    await localized.getByTestId("language-selector").click();
    deepEqual((await localized.getByRole("option").allTextContents()).map(text => text.trim()), ["English", "Italiano", "Deutsch", "Español"]);
    await localized.keyboard.press("Escape");
    await localized.evaluate(() => {
      const id = "browser-localization-history";
      localStorage.setItem("dyntick.activity.v1", JSON.stringify({ version: 1, entries: {
        [id]: { id, completedAt: Date.now(), minutes: 25 },
      } }));
    });
    await localized.reload();
    await waitForActivity(localized, 1);
    const history = await localized.evaluate(() => localStorage.getItem("dyntick.activity.v1"));
    await localized.getByRole("button", { name: "Start focusing", exact: true }).click();
    await localized.getByRole("button", { name: "Pause timer", exact: true }).waitFor();
    const cases = [
      { code: "de", heading: "Willkommen bei Dyntick.", activity: "Lernaktivität", pause: "Timer pausieren", resume: "Fortsetzen", settings: "Einstellungen öffnen", settingsTitle: "Dein Pomodoro", save: "Einstellungen speichern", sound: "Ton am Ende jedes Intervalls", dark: "Zum dunklen Design wechseln", light: "Zum hellen Design wechseln", mode: "Lernen", year: "Aktivitätsjahr", summary: "1 Lerneinheit abgeschlossen" },
      { code: "es", heading: "Te damos la bienvenida a Dyntick.", activity: "Actividad de estudio", pause: "Pausar el temporizador", resume: "Continuar", settings: "Abrir ajustes", settingsTitle: "Tu Pomodoro", save: "Guardar preferencias", sound: "Sonido al terminar cada intervalo", dark: "Cambiar al tema oscuro", light: "Cambiar al tema claro", mode: "Estudio", year: "Año de actividad", summary: "1 sesión completada" },
    ];
    for (const item of cases) {
      const deadline = await localized.evaluate(() => JSON.parse(sessionStorage.getItem("dyntick.timer.v1")!).endAt);
      await chooseLanguage(localized, item.code);
      await localized.getByRole("heading", { name: item.heading, exact: true }).waitFor();
      equal(await localized.locator("html").getAttribute("lang"), item.code);
      equal(await localized.getByTestId("language-selector").getAttribute("data-language"), item.code);
      await showStudyPage(localized, "activity");
      await localized.getByRole("heading", { name: item.activity, exact: true }).waitFor();
      await localized.getByText(item.summary, { exact: true }).waitFor();
      await localized.getByLabel(item.year, { exact: true }).waitFor();
      await showStudyPage(localized, "pomodoro");
      ok((await localized.title()).includes(`${item.mode} · Dyntick`));
      equal(await localized.evaluate(() => JSON.parse(sessionStorage.getItem("dyntick.timer.v1")!).endAt), deadline);
      equal(await localized.evaluate(() => localStorage.getItem("dyntick.activity.v1")), history);
      await showStudyPage(localized, "settings");
      await localized.getByTestId("settings-page").waitFor();
      await localized.getByRole("switch", { name: item.sound, exact: true }).waitFor();
      await localized.screenshot({ path: `${output}/${item.code}-settings.png`, fullPage: true, animations: "disabled" });
      await localized.getByRole("button", { name: item.save, exact: true }).click();
      await showStudyPage(localized, "pomodoro");
      await localized.reload();
      await localized.getByRole("button", { name: item.pause, exact: true }).waitFor();
      equal(await localized.locator("html").getAttribute("lang"), item.code);
      equal(await localized.evaluate(() => JSON.parse(sessionStorage.getItem("dyntick.timer.v1")!).endAt), deadline);
      await localized.getByRole("button", { name: item.pause, exact: true }).click();
      await localized.getByRole("button", { name: item.resume, exact: true }).waitFor();
      const paused = await localized.evaluate(() => JSON.parse(sessionStorage.getItem("dyntick.timer.v1")!).remainingMs);
      await localized.reload();
      await localized.getByRole("button", { name: item.resume, exact: true }).waitFor();
      equal(await localized.evaluate(() => JSON.parse(sessionStorage.getItem("dyntick.timer.v1")!).remainingMs), paused);
      equal(await localized.evaluate(() => localStorage.getItem("dyntick.activity.v1")), history);
      await localized.screenshot({ path: `${output}/${item.code}-desktop-light.png`, fullPage: true, animations: "disabled" });
      if (item.code === "de") {
        equal(await localized.locator(".brand-mark").evaluate((element) => getComputedStyle(element).backgroundColor), "rgba(0, 0, 0, 0)");
        await localized.locator(".brand").screenshot({ path: `${output}/brand-light.png` });
      }
      await localized.setViewportSize({ width: 390, height: 844 });
      await localized.getByRole("button", { name: item.dark, exact: true }).click();
      await localized.waitForFunction(() => document.documentElement.dataset.theme === "dark");
      await localized.screenshot({ path: `${output}/${item.code}-mobile-dark.png`, fullPage: true, animations: "disabled" });
      if (item.code === "de") await localized.locator(".brand").screenshot({ path: `${output}/brand-dark.png` });
      await localized.setViewportSize({ width: 320, height: 740 });
      ok(await localized.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${item.code} must fit at 320px`);
      const brand = await localized.locator(".brand").boundingBox();
      const language = await localized.getByTestId("language-selector").boundingBox();
      ok(brand && language && Math.abs(brand.y + brand.height / 2 - language.y - language.height / 2) < 3, "Brand and language controls should stay on one mobile row");
      await showStudyPage(localized, "settings");
      await localized.getByTestId("settings-page").waitFor();
      ok(await localized.getByTestId("settings-page").evaluate((element) => element.scrollWidth <= element.clientWidth), `${item.code} settings must fit at 320px`);
      await localized.screenshot({ path: `${output}/${item.code}-settings-mobile.png`, fullPage: true, animations: "disabled" });
      const mobileSave = localized.getByRole("button", { name: item.save, exact: true });
      await mobileSave.scrollIntoViewIfNeeded();
      await localized.getByTestId("settings-page").screenshot({ path: `${output}/${item.code}-settings-mobile-footer.png`, animations: "disabled" });
      await mobileSave.click();
      await showStudyPage(localized, "pomodoro");
      equal(await localized.getByTestId("language-selector").getAttribute("data-language"), item.code);
      equal(await localized.evaluate(() => JSON.parse(sessionStorage.getItem("dyntick.timer.v1")!).remainingMs), paused);
      await localized.getByRole("button", { name: item.light, exact: true }).click();
      await localized.waitForFunction(() => document.documentElement.dataset.theme === "light");
      await localized.setViewportSize({ width: 1440, height: 1024 });
      await localized.getByRole("button", { name: item.resume, exact: true }).click();
      await localized.getByRole("button", { name: item.pause, exact: true }).waitFor();
    }
    // A tab shares the chosen locale while retaining its independent timer.
    const second = await languagesContext.newPage();
    await second.goto(base);
    await second.getByRole("button", { name: "Empezar a estudiar", exact: true }).waitFor();
    equal(await second.locator("html").getAttribute("lang"), "es");
    equal(await second.getByTestId("countdown").textContent(), "25:00");
    const deadline = await localized.evaluate(() => JSON.parse(sessionStorage.getItem("dyntick.timer.v1")!).endAt);
    await chooseLanguage(second, "de");
    await localized.getByRole("button", { name: "Timer pausieren", exact: true }).waitFor();
    equal(await localized.evaluate(() => JSON.parse(sessionStorage.getItem("dyntick.timer.v1")!).endAt), deadline);
    equal(await second.getByTestId("countdown").textContent(), "25:00");
  } finally {
    await languagesContext.close();
  }
  deepEqual(errors, [], "No runtime errors or external requests are allowed");
  console.log("Browser checks passed: sliding study pages, active timer and settings draft preservation, keyboard tab navigation, public repository footer, English default, EN/IT/DE/ES switching, settings, desktop/mobile, themes, timer refresh/expiry/tab isolation, focus history recovery/deduplication, cross-tab synchronization, breaks excluded, year/day selection, New Year rollover, German/Spanish persistence and mobile settings, freestanding logo and populated activity screenshots.");
} finally {
  await browser.close();
}
