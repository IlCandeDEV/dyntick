import { test } from "bun:test";
import { deepEqual, equal } from "node:assert/strict";
import {
  parsePreferences, parseTimer, PREFERENCES_KEY, readStorage, type StorageLike,
  TIMER_KEY, writeStorage,
} from "../src/storage.ts";
import { createTimer, DEFAULT_PREFERENCES, LANGUAGES, pauseTimer, remainingAt, startTimer } from "../src/timer.ts";

const preferences = { ...DEFAULT_PREFERENCES };
const now = 1_800_000_000_000;

function memoryStorage(): StorageLike {
  const data = new Map<string, string>();
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); } };
}

test("valid preferences round-trip through browser storage", () => {
  const storage = memoryStorage();
  const custom = { ...preferences, focusMinutes: 45, theme: "dark" as const, soundEnabled: false, creditSystem: "ECTS" as const, dateFormat: "mdy" as const };
  equal(writeStorage(storage, PREFERENCES_KEY, custom), true);
  deepEqual(parsePreferences(readStorage(storage, PREFERENCES_KEY)), custom);
});

test("invalid or missing preferences recover safely with field-level defaults", () => {
  for (const raw of [null, "not json", "null", "[]", "17"]) deepEqual(parsePreferences(raw), preferences);
  const result = parsePreferences(JSON.stringify({
    focusMinutes: 0, shortBreakMinutes: 8, longBreakMinutes: 181,
    longBreakInterval: 1.5, soundEnabled: "yes", theme: "unrecognized", creditSystem: "unrecognized", dateFormat: "unrecognized",
  }));
  deepEqual(result, { ...preferences, shortBreakMinutes: 8 });
});

test("cycles allow up to six sessions and migrate larger saved values without losing other preferences", () => {
  const custom = { ...preferences, focusMinutes: 45, language: "it" as const, theme: "dark" as const, soundEnabled: false };
  for (const count of [1, 4, 6, 7, 12]) {
    deepEqual(parsePreferences(JSON.stringify({ ...custom, longBreakInterval: count })), {
      ...custom, longBreakInterval: Math.min(count, 6),
    });
  }
});

test("a running timer survives refresh using its original absolute deadline", () => {
  const running = startTimer(createTimer(preferences), preferences, now);
  const recovered = parseTimer(JSON.stringify(running), preferences, now + 120_000);
  equal(recovered.endAt, running.endAt);
  equal(remainingAt(recovered, now + 120_000), 23 * 60_000);
  equal(recovered.status, "running");
});

test("refresh after expiry credits exactly one phase and repeated refreshes do not add more", () => {
  const running = startTimer(createTimer(preferences), preferences, now);
  const recovered = parseTimer(JSON.stringify(running), preferences, now + 86_400_000);
  equal(recovered.status, "completed");
  equal(recovered.completedFocuses, 1);
  deepEqual(parseTimer(JSON.stringify(recovered), preferences, now + 2 * 86_400_000), recovered);
});

test("paused timers stay paused after reload regardless of elapsed wall-clock time", () => {
  const paused = pauseTimer(startTimer(createTimer(preferences), preferences, now), now + 30_000);
  const recovered = parseTimer(JSON.stringify(paused), preferences, now + 86_400_000);
  deepEqual(recovered, paused);
});

test("invalid stored timer shapes cannot start an unexpected session", () => {
  const valid = createTimer(preferences);
  const changes = [
    { version: 99 }, { mode: "unknown" }, { status: "unknown" }, { durationMs: 0 },
    { durationMs: 181 * 60_000 }, { remainingMs: -1 }, { remainingMs: 2_000_000 },
    { completedFocuses: -1 }, { completionId: 0.5 }, { endAt: now },
    { status: "completed", remainingMs: 100 }, { status: "paused", remainingMs: 0 },
    { status: "running", endAt: null },
    { status: "running", endAt: now + 999_999_999 },
  ];
  for (const change of changes) {
    deepEqual(parseTimer(JSON.stringify({ ...valid, ...change }), preferences, now), valid);
  }
  for (const raw of [null, "broken", "{}", "null", "[]"]) {
    deepEqual(parseTimer(raw, preferences, now), valid);
  }
});

test("legacy per-tab session data can be read without altering shared preferences", () => {
  const tabA = memoryStorage();
  const tabB = memoryStorage();
  const local = memoryStorage();
  writeStorage(local, PREFERENCES_KEY, preferences);
  writeStorage(tabA, TIMER_KEY, startTimer(createTimer(preferences), preferences, now));
  writeStorage(tabB, TIMER_KEY, createTimer(preferences, "longBreak"));
  equal(parseTimer(readStorage(tabA, TIMER_KEY), preferences, now).mode, "focus");
  equal(parseTimer(readStorage(tabB, TIMER_KEY), preferences, now).mode, "longBreak");
  deepEqual(parsePreferences(readStorage(local, PREFERENCES_KEY)), preferences);
});

test("blocked storage and exhausted quotas do not throw", () => {
  const blocked: StorageLike = {
    getItem() { throw new Error("Storage disabled"); },
    setItem() { throw new Error("Quota exceeded"); },
  };
  equal(readStorage(blocked, TIMER_KEY), null);
  equal(writeStorage(blocked, TIMER_KEY, createTimer(preferences)), false);
  equal(readStorage(null, PREFERENCES_KEY), null);
  equal(writeStorage(null, PREFERENCES_KEY, preferences), false);
});

test("English is the default for new, legacy, or invalid language preferences", () => {
  equal(parsePreferences(null).language, "en");
  equal(parsePreferences(JSON.stringify({ focusMinutes: 45, theme: "dark" })).language, "en");
  equal(parsePreferences(JSON.stringify({ language: "fr" })).language, "en");
  const legacy = parsePreferences(JSON.stringify({ focusMinutes: 45, soundEnabled: false }));
  equal(legacy.focusMinutes, 45);
  equal(legacy.soundEnabled, false);
});

for (const language of LANGUAGES) test(`${language} persists while preserving the running and paused timer`, () => {
  const storage = memoryStorage();
  const running = startTimer(createTimer(preferences), preferences, now);
  const localized = { ...preferences, language };
  writeStorage(storage, PREFERENCES_KEY, localized);
  writeStorage(storage, TIMER_KEY, running);
  const recoveredPreferences = parsePreferences(readStorage(storage, PREFERENCES_KEY));
  const recoveredTimer = parseTimer(readStorage(storage, TIMER_KEY), recoveredPreferences, now + 5000);
  equal(recoveredPreferences.language, language);
  equal(recoveredTimer.endAt, running.endAt);
  equal(remainingAt(recoveredTimer, now + 5000), 25 * 60_000 - 5000);
  const paused = pauseTimer(recoveredTimer, now + 5000);
  const pausedReload = parseTimer(JSON.stringify(paused), recoveredPreferences, now + 90_000);
  equal(pausedReload.remainingMs, paused.remainingMs);
  equal(pausedReload.status, "paused");
});
