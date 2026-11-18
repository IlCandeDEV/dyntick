import { test } from "bun:test";
import { deepEqual, equal, notEqual, strictEqual } from "node:assert/strict";
import {
  ACTIVITY_KEY, activityDays, emptyActivity, mergeActivity, parseActivity,
  persistActivity, recordCompletion, sameActivity, serializeActivity,
} from "../src/activity.ts";
import { parseTimer, type StorageLike } from "../src/storage.ts";
import {
  createTimer, DEFAULT_PREFERENCES, type FocusCompletion, pauseTimer,
  resetTimer, selectMode, settleTimer, startTimer, updateDurations,
} from "../src/timer.ts";

const preferences = { ...DEFAULT_PREFERENCES };
const start = new Date(2026, 10, 12, 23, 30).getTime();
const completion = (id: string, completedAt = start, minutes = 25): FocusCompletion =>
  ({ id, completedAt, minutes });

test("activity parsing recovers damaged data and validates each completion independently", () => {
  for (const raw of [null, "broken", "null", "[]", "{}", '{"version":2,"entries":{}}']) {
    deepEqual(parseActivity(raw), emptyActivity());
  }
  const parsed = parseActivity(JSON.stringify({ version: 1, entries: {
    valid: { ...completion("valid"), ignored: "not persisted" },
    mismatched: completion("another-id"),
    negative: completion("negative", -1),
    invalidDate: completion("invalidDate", 8_640_000_000_000_001),
    fractional: completion("fractional", start + 0.5),
    tooShort: completion("tooShort", start, 0),
    tooLong: completion("tooLong", start, 181),
    invalidMinutes: completion("invalidMinutes", start, 2.5),
  } }));
  deepEqual(parsed.entries, { valid: completion("valid") });
});

test("untrusted object-property IDs remain ordinary entries and cannot mutate prototypes", () => {
  const raw = '{"version":1,"entries":{"__proto__":{"id":"__proto__","completedAt":0,"minutes":1},"constructor":{"id":"constructor","completedAt":0,"minutes":1}}}';
  const parsed = parseActivity(raw);
  const merged = mergeActivity(emptyActivity(), parsed);
  equal(Object.keys(merged.entries).length, 2);
  equal(Object.getPrototypeOf(merged.entries), Object.prototype);
  equal(Object.hasOwn(merged.entries, "__proto__"), true);
  equal(activityDays(merged)["1970-01-01"]?.sessions ??
    Object.values(activityDays(merged))[0].sessions, 2);
});

test("concurrent sessions finishing together merge by ID rather than timestamp", () => {
  const first = recordCompletion(emptyActivity(), completion("tab-a"));
  const second = recordCompletion(emptyActivity(), completion("tab-b"));
  const union = mergeActivity(first, second);
  equal(Object.keys(union.entries).length, 2);
  strictEqual(mergeActivity(union, first), union);
  strictEqual(recordCompletion(union, completion("tab-a")), union);
  equal(sameActivity(union, mergeActivity(second, first)), true);
  equal(serializeActivity(union), serializeActivity(mergeActivity(second, first)));
});

test("conflicting duplicate IDs converge to the same value without storage ping-pong", () => {
  const first = recordCompletion(emptyActivity(), completion("same", start, 25));
  const second = recordCompletion(emptyActivity(), completion("same", start + 1000, 30));
  const a = mergeActivity(first, second);
  const b = mergeActivity(second, first);
  equal(serializeActivity(a), serializeActivity(b));
  strictEqual(mergeActivity(a, b), a);
  equal(a.entries.same.completedAt, start);
});

test("a persisted session ID makes updater replays and background recovery idempotent", () => {
  const running = startTimer(createTimer(preferences), preferences, start);
  equal(typeof running.focusSessionId, "string");
  const first = settleTimer(running, running.endAt!);
  const recovered = settleTimer(running, start + 7 * 86_400_000);
  equal(first.lastFocusCompletion!.id, running.focusSessionId);
  deepEqual(first.lastFocusCompletion, recovered.lastFocusCompletion);
  equal(recovered.lastFocusCompletion!.completedAt, running.endAt);
  let activity = recordCompletion(emptyActivity(), first.lastFocusCompletion!);
  activity = recordCompletion(activity, recovered.lastFocusCompletion!);
  equal(Object.keys(activity.entries).length, 1);
  const days = activityDays(activity);
  deepEqual(days["2026-11-12"], { sessions: 1, minutes: 25 });
  equal(days["2026-11-19"], undefined);
});

test("pause and resume preserve focus identity and credit only the configured study duration", () => {
  const running = startTimer(createTimer(preferences), preferences, start);
  const paused = pauseTimer(running, start + 10_000);
  const resumed = startTimer(paused, preferences, start + 86_400_000);
  equal(resumed.focusSessionId, running.focusSessionId);
  const updated = updateDurations(resumed, { ...preferences, focusMinutes: 60 });
  const finished = settleTimer(updated, updated.endAt!);
  equal(finished.lastFocusCompletion!.minutes, 25);
  equal(finished.lastFocusCompletion!.completedAt, resumed.endAt);
});

test("cancelling and breaks earn no activity; repeating a completed focus creates a new session", () => {
  const running = startTimer(createTimer(preferences), preferences, start);
  const cancelled = resetTimer(running, preferences);
  equal(cancelled.lastFocusCompletion, null);
  equal(cancelled.focusSessionId, null);
  equal(selectMode(cancelled, "shortBreak", preferences).lastFocusCompletion, null);
  const finished = settleTimer(running, running.endAt!);
  const breakRunning = startTimer(finished, preferences, running.endAt! + 1);
  const breakFinished = settleTimer(breakRunning, breakRunning.endAt!);
  strictEqual(breakFinished.lastFocusCompletion, finished.lastFocusCompletion);
  let activity = recordCompletion(emptyActivity(), finished.lastFocusCompletion!);
  activity = recordCompletion(activity, breakFinished.lastFocusCompletion!);
  equal(Object.keys(activity.entries).length, 1);
  const repeated = startTimer(resetTimer(finished, preferences), preferences, start + 3_000_000);
  notEqual(repeated.focusSessionId, running.focusSessionId);
  const repeatedFinished = settleTimer(repeated, repeated.endAt!);
  activity = recordCompletion(activity, repeatedFinished.lastFocusCompletion!);
  equal(Object.keys(activity.entries).length, 2);
});

test("legacy expired timers recover a stable completion, and completed timers survive refresh", () => {
  const running = startTimer(createTimer(preferences), preferences, start);
  const legacy = JSON.parse(JSON.stringify(running));
  delete legacy.focusSessionId;
  delete legacy.lastFocusCompletion;
  const first = parseTimer(JSON.stringify(legacy), preferences, start + 86_400_000);
  const second = parseTimer(JSON.stringify(legacy), preferences, start + 2 * 86_400_000);
  deepEqual(first.lastFocusCompletion, second.lastFocusCompletion);
  equal(first.lastFocusCompletion!.completedAt, running.endAt);
  const reloaded = parseTimer(JSON.stringify(first), preferences, start + 3 * 86_400_000);
  deepEqual(reloaded.lastFocusCompletion, first.lastFocusCompletion);
  let activity = recordCompletion(emptyActivity(), first.lastFocusCompletion!);
  activity = recordCompletion(activity, second.lastFocusCompletion!);
  activity = recordCompletion(activity, reloaded.lastFocusCompletion!);
  equal(Object.keys(activity.entries).length, 1);
});

test("read-before-write plus event payloads recover overwritten concurrent storage writes", () => {
  const a = recordCompletion(emptyActivity(), completion("tab-a"));
  const b = recordCompletion(emptyActivity(), completion("tab-b"));
  let raw = serializeActivity(b); // B overwrote A before A's storage event was handled.
  let writes = 0;
  const storage: StorageLike = {
    getItem(key) { equal(key, ACTIVITY_KEY); return raw; },
    setItem(key, value) { equal(key, ACTIVITY_KEY); raw = value; writes++; },
  };
  const reconciled = persistActivity(mergeActivity(b, a), storage);
  equal(reconciled.persisted, true);
  equal(Object.keys(parseActivity(raw).entries).length, 2);
  equal(writes, 1);
  for (let index = 0; index < 10; index++) {
    const again = persistActivity(mergeActivity(reconciled.activity, parseActivity(raw)), storage);
    strictEqual(again.activity, reconciled.activity);
    equal(again.persisted, true);
  }
  equal(writes, 1);
});

test("unavailable activity storage preserves in-memory completions and can retry later", () => {
  const activity = recordCompletion(emptyActivity(), completion("retry"));
  for (const storage of [null, {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("quota exceeded"); },
  }]) {
    const result = persistActivity(activity, storage);
    strictEqual(result.activity, activity);
    equal(result.persisted, false);
  }
  let raw: string | null = null;
  const stored = persistActivity(activity, {
    getItem: () => raw,
    setItem: (_key, value) => { raw = value; },
  });
  equal(stored.persisted, true);
  equal(Object.keys(parseActivity(raw).entries).length, 1);
});
