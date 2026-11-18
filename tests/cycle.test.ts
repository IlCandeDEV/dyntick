import { test } from "bun:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { cyclePhases, cycleLayout } from "../src/cycle.ts";
import { createTimer, DEFAULT_PREFERENCES, startTimer, settleTimer, type Preferences } from "../src/timer.ts";

test("configured cycles contain one focus and one following break per session", () => {
  for (const count of [1, 4, 6]) {
    const preferences: Preferences = { ...DEFAULT_PREFERENCES, longBreakInterval: count };
    const phases = cyclePhases(preferences, createTimer(preferences));
    equal(phases.length, count * 2);
    equal(phases.filter(p => p.mode === "focus").length, count);
    equal(phases.filter(p => p.mode === "shortBreak").length, count - 1);
    equal(phases.filter(p => p.mode === "longBreak").length, 1);
    equal(phases.at(-1)!.mode, "longBreak");
    deepEqual(phases.filter(p => p.mode === "focus").map(p => p.session), Array.from({ length: count }, (_, i) => i + 1));
  }
});

test("cycle follows focus, break, long break and restart without changing timer state", () => {
  const p = { ...DEFAULT_PREFERENCES, longBreakInterval: 2 };
  let timer = createTimer(p);
  const current = () => cyclePhases(p, timer).find(phase => phase.current)!.id;
  equal(current(), "focus-1");
  timer = settleTimer(startTimer(timer, p, 0), 25 * 60_000);
  equal(current(), "focus-1");
  ok(cyclePhases(p, timer)[0].done);
  timer = startTimer(timer, p, 2_000_000);
  equal(current(), "shortBreak-1");
  timer = settleTimer(timer, 3_000_000);
  timer = startTimer(timer, p, 4_000_000);
  equal(current(), "focus-2");
  timer = settleTimer(timer, 6_000_000);
  timer = startTimer(timer, p, 7_000_000);
  equal(current(), "longBreak-2");
  timer = settleTimer(timer, 8_000_000);
  timer = startTimer(timer, p, 9_000_000);
  equal(current(), "focus-1");
  equal(timer.completedFocuses, 0);
});

test("manual breaks never imply that planned focus sessions were completed", () => {
  for (const mode of ["shortBreak", "longBreak"] as const) {
    const phases = cyclePhases(DEFAULT_PREFERENCES, createTimer(DEFAULT_PREFERENCES, mode));
    ok(phases.every(phase => !phase.current && !phase.done));
  }
});

test("cycle keeps a running phase's original duration while showing new future durations", () => {
  const timer = startTimer(createTimer(DEFAULT_PREFERENCES), DEFAULT_PREFERENCES, 1000);
  const snapshot = structuredClone(timer);
  const phases = cyclePhases({ ...DEFAULT_PREFERENCES, focusMinutes: 40, shortBreakMinutes: 8 }, timer);
  equal(phases[0].minutes, 25);
  equal(phases[1].minutes, 8);
  equal(phases[2].minutes, 40);
  deepEqual(timer, snapshot);
});

test("responsive cycles show every target without overflow or overlapping hitboxes", () => {
  for (const width of [180, 220, 252, 280, 320, 390, 560]) {
    for (let sessions = 1; sessions <= 6; sessions++) {
      const layout = cycleLayout(width, sessions);
      equal(layout.width, width);
      equal(layout.points.length, sessions * 2);
      equal(layout.arrows.length, layout.points.length);
      const targets = layout.points.map((point, index) => ({
        left: point.x - (index === layout.points.length - 1 ? 26 : 22),
        right: point.x + (index === layout.points.length - 1 ? 26 : 22),
        top: point.y - 22, bottom: point.y + 22,
      }));
      for (let index = 0; index < targets.length; index++) {
        const a = targets[index];
        const p = layout.points[index];
        const oval = ((p.x - width / 2) / layout.rx) ** 2 + ((p.y - layout.height / 2) / layout.ry) ** 2;
        ok(Math.abs(oval - 1) < .001, "Every phase stays on the oval track");
        const detailWidth = Math.min(110, width - 112);
        ok(a.right + 2 <= width / 2 - detailWidth / 2 || a.left - 2 >= width / 2 + detailWidth / 2 || a.bottom + 2 <= layout.height / 2 - 40 || a.top - 2 >= layout.height / 2 + 40,
          "Cycle targets leave the center details unobstructed");
        ok(a.left >= 0 && a.right <= width && a.top >= 0 && a.bottom <= layout.height,
          `Cycle ${sessions} at ${width}px clips target ${index}`);
        for (const b of targets.slice(index + 1)) {
          ok(a.right + 2 <= b.left || b.right + 2 <= a.left || a.bottom + 2 <= b.top || b.bottom + 2 <= a.top,
            `Cycle ${sessions} at ${width}px has overlapping click areas`);
        }
      }
    }
  }
});
