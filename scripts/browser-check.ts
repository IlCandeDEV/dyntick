// Runs only on a GitHub runner against the real production container and SQLite volume.
import { deepEqual, equal, ok } from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, type BrowserContext, type Page } from "playwright";
import type { Snapshot } from "../src/protocol.ts";

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
  await page.locator('[data-testid="sync-status"][data-sync-state="saved"]').waitFor();
}

async function chooseLanguage(page: Page, language: string) {
  await ready(page);
  await page.getByTestId("language-selector").click();
  await page.getByRole("option", { name: languageLabels[language], exact: true }).click();
  await page.waitForFunction(value => document.documentElement.lang === value, language);
  await ready(page);
}

async function showStudyPage(page: Page, target: "pomodoro" | "activity" | "settings") {
  await page.locator(`#tab-${target}`).click();
  await page.waitForFunction(id => document.getElementById(`tab-${id}`)?.getAttribute("aria-selected") === "true", target);
  await page.locator(".page-track").evaluate(async element => {
    await Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {})));
  });
}

async function waitForLanguage(page: Page, language: string) {
  await page.waitForFunction(value => document.documentElement.lang === value, language);
  await ready(page);
}

function countdownSeconds(text: string | null) {
  const [minutes, seconds] = (text ?? "0:0").split(":").map(Number);
  return minutes * 60 + seconds;
}

async function verifyResponsiveCycle() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, locale: "en-US" });
  context.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
  try {
    const page = await context.newPage();
    await page.goto(base);
    await ready(page);
    for (let sessions = 1; sessions <= 6; sessions++) {
      await showStudyPage(page, "settings");
      await page.locator('input[name="longBreakInterval"]').fill(String(sessions));
      await page.getByRole("button", { name: "Save preferences", exact: true }).click();
      await ready(page);
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
    await ready(page);
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
    await ready(page);
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
  const initial = await snapshot();
  equal(initial.initialized, false, "Browser migration checks require a fresh production SQLite volume");
  equal(initial.preferences.language, "en", "The initial language must never be inferred from a browser locale");

  // Test data belongs only to this isolated CI installation. Seed the old storage format
  // to exercise the actual 1.x -> 2.0 migration, including completion during an absence.
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 1024 }, colorScheme: "light", locale: "it-IT", timezoneId: "Europe/Rome" });
  observe(desktop);
  await desktop.addInitScript(() => {
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
  });
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

  await page.getByRole("button", { name: "Start focusing", exact: true }).click();
  await page.getByRole("button", { name: "Pause timer", exact: true }).waitFor();
  await ready(page);
  const initialDeadline = (await snapshot()).timer.endAt;
  ok(initialDeadline);
  await showStudyPage(page, "settings");
  await page.locator('input[name="focusMinutes"]').fill("29");
  await showStudyPage(page, "activity");
  await page.locator("#main-content").focus();
  await page.keyboard.press("r");
  equal((await snapshot()).timer.endAt, initialDeadline, "Timer shortcuts must not reset from another study page");
  await showStudyPage(page, "settings");
  equal(await page.locator('input[name="focusMinutes"]').inputValue(), "29", "Unsaved settings survive page changes");
  await page.locator('input[name="focusMinutes"]').focus();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("h");
  equal(await page.locator("#tab-settings").getAttribute("aria-selected"), "true", "Editing a field must not navigate");
  await showStudyPage(page, "pomodoro");
  await page.getByRole("tab", { name: "Pomodoro", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  equal(await page.locator("#tab-activity").getAttribute("aria-selected"), "true");
  await page.keyboard.press("ArrowLeft");
  equal(await page.locator("#tab-pomodoro").getAttribute("aria-selected"), "true");
  await page.reload();
  await ready(page);
  equal((await snapshot()).timer.endAt, initialDeadline, "Refresh must use the server's original deadline");

  // Another browser context represents a second PC. Its local clock is deliberately
  // six hours ahead; the server clock must keep both countdowns aligned.
  const secondDevice = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "de-DE", timezoneId: "Europe/Rome", colorScheme: "light" });
  observe(secondDevice);
  await secondDevice.addInitScript(() => {
    const realNow = Date.now.bind(Date);
    Date.now = () => realNow() + 6 * 60 * 60_000;
  });
  const second = await secondDevice.newPage();
  await second.goto(base);
  await ready(second);
  await second.getByRole("button", { name: "Pause timer", exact: true }).waitFor();
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
  await laterDevice.addInitScript(() => {
    localStorage.setItem("dyntick.preferences.v1", JSON.stringify({ language: "it", focusMinutes: 50, theme: "dark" }));
    localStorage.setItem("dyntick.activity.v1", JSON.stringify({ version: 1, entries: {
      "browser-later-device": { id: "browser-later-device", completedAt: Date.now() - 300_000, minutes: 50 },
    } }));
  });
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
  for (let index = 0; index < 2; index++) {
    const id = `browser-previous-year-${index}`;
    entries[id] = { id, completedAt: new Date(previousYear, 0, 15, 12, index * 30).getTime(), minutes: 25 };
  }
  const populated = await post("/api/import", { requestId: crypto.randomUUID(), activity: { version: 1, entries } });
  await showStudyPage(page, "activity");
  await page.getByRole("heading", { name: "Study activity", exact: true }).waitFor();
  await page.getByLabel("Activity year", { exact: true }).selectOption(String(previousYear));
  const olderDay = page.locator(`[data-day="${olderDate}"]`);
  await page.waitForFunction(key => document.querySelector(`[data-day="${key}"]`)?.getAttribute("data-count") === "2", olderDate);
  await olderDay.click();
  ok((await page.getByTestId("activity-day-details").textContent())?.includes("50"));
  await olderDay.focus();
  await page.keyboard.press("ArrowDown");
  equal(await page.locator(`[data-day="${previousYear}-01-16"]`).getAttribute("aria-pressed"), "true");
  await page.keyboard.press("ArrowUp");
  equal(await olderDay.getAttribute("aria-pressed"), "true");
  await page.keyboard.press("ArrowRight");
  equal(await page.locator("#tab-activity").getAttribute("aria-selected"), "true", "Calendar arrows must not change pages");
  equal(await page.locator(`[data-day="${previousYear}-01-22"]`).getAttribute("aria-pressed"), "true");
  await page.keyboard.press("ArrowLeft");
  await page.screenshot({ path: `${output}/history-previous-year.png`, fullPage: true, animations: "disabled" });
  await page.getByLabel("Activity year", { exact: true }).selectOption(String(today.getFullYear()));
  await page.screenshot({ path: `${output}/history-desktop-light.png`, fullPage: true, animations: "disabled" });
  await page.getByRole("button", { name: "Switch to dark theme", exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  await ready(page);
  await page.screenshot({ path: `${output}/history-desktop-dark.png`, fullPage: true, animations: "disabled" });
  await showStudyPage(second, "activity");
  await second.getByRole("heading", { name: "Study activity", exact: true }).waitFor();
  await second.getByLabel("Activity year", { exact: true }).selectOption(String(previousYear));
  await second.waitForFunction(key => document.querySelector(`[data-day="${key}"]`)?.getAttribute("data-count") === "2", olderDate);
  await second.locator(`[data-day="${olderDate}"]`).click();
  ok((await second.getByTestId("activity-day-details").textContent())?.includes("50"), "Imported history appears on the other independent device");
  await second.getByLabel("Activity year", { exact: true }).selectOption(String(today.getFullYear()));
  equal(Object.keys((await snapshot()).activity.entries).length, Object.keys(populated.activity.entries).length);
  await second.setViewportSize({ width: 320, height: 740 });
  ok(await second.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await second.screenshot({ path: `${output}/history-mobile-dark.png`, fullPage: true, animations: "disabled" });

  // A disconnected device must never claim a server write succeeded or keep editing
  // a separate local timer. Reconnection receives changes made by the other PC.
  await showStudyPage(page, "pomodoro");
  await showStudyPage(second, "pomodoro");
  await page.route("**/api/**", route => route.abort("connectionfailed"));
  await page.locator('[data-testid="sync-status"][data-sync-state="offline"]').waitFor();
  equal(await page.locator(".primary-action").isDisabled(), true);
  equal(await page.locator(".reset-action").isDisabled(), true);
  await second.getByRole("button", { name: "Switch to light theme", exact: true }).click();
  await second.waitForFunction(() => document.documentElement.dataset.theme === "light");
  await ready(second);
  await page.screenshot({ path: `${output}/connection-offline.png`, fullPage: true, animations: "disabled" });
  await page.unroute("**/api/**");
  await page.getByTestId("sync-status").getByRole("button").click();
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
  await page.emulateMedia({ reducedMotion: "reduce" });
  equal(await page.locator(".timer-colon").evaluate(element => getComputedStyle(element).animationName), "none");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await secondDevice.close();
  await desktop.close();
  deepEqual(errors, [], "No runtime errors or external resource requests are allowed");
  console.log("Browser checks passed: real SQLite migration and deduplication, two independent devices, shared active/paused timer, server clock skew correction, saved EN/IT/DE/ES preferences, themes, responsive cycles and settings, keyboard navigation, preserved legacy backups, merged history, calendar keyboard access, offline/reconnect and idempotent lost-response recovery. Main-page light and dark screenshots captured from this build.");
} finally {
  await browser.close();
}
