import { test } from "bun:test";
import { deepEqual, equal, strictEqual } from "node:assert/strict";
import {
  createTimer, DEFAULT_PREFERENCES, durationFor, formatTime, nextMode, pauseTimer,
  remainingAt, resetTimer, selectMode, sessionNumber, settleTimer, startTimer, updateDurations,
} from "../src/timer.ts";

const preferences = { ...DEFAULT_PREFERENCES };
const start = 1_800_000_000_000;

test("an idle timer starts with the configured duration and one fixed deadline", () => {
  const timer = startTimer(createTimer(preferences), preferences, start);
  equal(timer.status, "running");
  equal(timer.endAt, start + 25 * 60_000);
  equal(remainingAt(timer, start + 1000), 25 * 60_000 - 1000);
  strictEqual(startTimer(timer, preferences, start + 2000), timer);
});

test("pause freezes the exact remainder and resume excludes all paused time", () => {
  const running = startTimer(createTimer(preferences), preferences, start);
  const paused = pauseTimer(running, start + 72_345);
  equal(paused.remainingMs, 25 * 60_000 - 72_345);
  equal(paused.endAt, null);
  equal(remainingAt(paused, start + 86_400_000), paused.remainingMs);
  const resumed = startTimer(paused, preferences, start + 86_400_000);
  equal(resumed.endAt, start + 86_400_000 + paused.remainingMs);
});

test("reset stops a running phase and restores its full configured duration", () => {
  const running = startTimer(createTimer(preferences), preferences, start);
  deepEqual(resetTimer(running, preferences), createTimer(preferences));
});

test("a suspended tab finishes only the actual phase, even days later", () => {
  const running = startTimer(createTimer(preferences), preferences, start);
  const finished = settleTimer(running, start + 7 * 86_400_000);
  equal(finished.status, "completed");
  equal(finished.remainingMs, 0);
  equal(finished.endAt, null);
  equal(finished.completedFocuses, 1);
  equal(finished.completionId, 1);
  strictEqual(settleTimer(finished, start + 8 * 86_400_000), finished);
});

test("repeated checks at the deadline never credit the same session twice", () => {
  const running = startTimer(createTimer(preferences), preferences, start);
  const deadline = running.endAt!;
  strictEqual(settleTimer(running, deadline - 1), running);
  let timer = settleTimer(running, deadline);
  for (let index = 0; index < 100; index++) timer = settleTimer(timer, deadline + index);
  equal(timer.completedFocuses, 1);
  equal(timer.completionId, 1);
});

test("a late pause completes the phase, rather than creating a zero-duration pause", () => {
  const running = startTimer(createTimer(preferences), preferences, start);
  const pausedLate = pauseTimer(running, running.endAt! + 1000);
  equal(pausedLate.status, "completed");
  equal(pausedLate.completedFocuses, 1);
});

test("a late start on a running timer finishes it without starting a second phase", () => {
  const running = startTimer(createTimer(preferences), preferences, start);
  const result = startTimer(running, preferences, running.endAt! + 1000);
  equal(result.mode, "focus");
  equal(result.status, "completed");
});

test("the next phase only starts on an explicit action", () => {
  const running = startTimer(createTimer(preferences), preferences, start);
  const finished = settleTimer(running, running.endAt!);
  equal(nextMode(finished, preferences), "shortBreak");
  const next = startTimer(finished, preferences, start + 2_000_000);
  equal(next.mode, "shortBreak");
  equal(next.status, "running");
  equal(next.endAt, start + 2_000_000 + 5 * 60_000);
});

test("four completed focuses lead to a long break, then a fresh cycle", () => {
  let timer = createTimer(preferences);
  let now = start;
  for (let index = 0; index < 4; index++) {
    equal(sessionNumber(timer, preferences), index + 1);
    timer = startTimer(timer, preferences, now);
    now = timer.endAt!;
    timer = settleTimer(timer, now);
    equal(sessionNumber(timer, preferences), index + 1);
    equal(timer.completedFocuses, index + 1);
    timer = startTimer(timer, preferences, ++now);
    equal(timer.mode, index === 3 ? "longBreak" : "shortBreak");
    now = timer.endAt!;
    timer = settleTimer(timer, now);
    equal(timer.completedFocuses, index + 1);
    timer = startTimer(timer, preferences, ++now);
    equal(timer.mode, "focus");
    if (index < 3) timer = pauseTimer(timer, now);
  }
  equal(timer.completedFocuses, 0);
  equal(sessionNumber(timer, preferences), 1);
});

test("a custom long-break interval of one works from the first session", () => {
  const custom = { ...preferences, longBreakInterval: 1, longBreakMinutes: 20 };
  const running = startTimer(createTimer(custom), custom, start);
  const finished = settleTimer(running, running.endAt!);
  equal(nextMode(finished, custom), "longBreak");
  equal(startTimer(finished, custom, start + 2_000_000).durationMs, 20 * 60_000);
});

test("switching modes never credits a focus and is blocked while running", () => {
  const idle = createTimer(preferences);
  const pause = selectMode(idle, "shortBreak", preferences);
  equal(pause.completedFocuses, 0);
  equal(pause.durationMs, 5 * 60_000);
  const running = startTimer(idle, preferences, start);
  strictEqual(selectMode(running, "longBreak", preferences), running);
});

test("resetting a completed focus repeats that same session without double credit", () => {
  const running = startTimer(createTimer(preferences), preferences, start);
  const finished = settleTimer(running, running.endAt!);
  const reset = resetTimer(finished, preferences);
  equal(reset.completedFocuses, 0);
  equal(reset.completionId, finished.completionId);
  equal(sessionNumber(reset, preferences), 1);
});

test("changing preferences preserves an active or paused phase and applies on reset", () => {
  const changed = { ...preferences, focusMinutes: 40 };
  const running = startTimer(createTimer(preferences), preferences, start);
  strictEqual(updateDurations(running, changed), running);
  const paused = pauseTimer(running, start + 10_000);
  strictEqual(updateDurations(paused, changed), paused);
  equal(resetTimer(paused, changed).remainingMs, 40 * 60_000);
  equal(updateDurations(createTimer(preferences), changed).durationMs, 40 * 60_000);
});

test("a future phase uses the newly configured durations", () => {
  const changed = { ...preferences, shortBreakMinutes: 8 };
  const running = startTimer(createTimer(preferences), preferences, start);
  const finished = settleTimer(running, running.endAt!);
  equal(startTimer(finished, changed, running.endAt! + 1000).remainingMs, 8 * 60_000);
  equal(durationFor("longBreak", changed), 15 * 60_000);
});

test("shortening the cycle preserves the running deadline and offers a long break next", () => {
  const fourth = startTimer(createTimer(preferences, "focus", 3), preferences, start);
  const changed = { ...preferences, longBreakInterval: 2 };
  const updated = updateDurations(fourth, changed);
  equal(updated.endAt, fourth.endAt);
  equal(updated.remainingMs, fourth.remainingMs);
  equal(sessionNumber(updated, changed), 2);
  const finished = settleTimer(updated, updated.endAt!);
  equal(nextMode(finished, changed), "longBreak");
});

test("display rounds upwards, never goes negative, and supports durations over an hour", () => {
  equal(formatTime(25 * 60_000), "25:00");
  equal(formatTime(59_001), "01:00");
  equal(formatTime(1), "00:01");
  equal(formatTime(0), "00:00");
  equal(formatTime(-100), "00:00");
  equal(formatTime(180 * 60_000), "180:00");
});
