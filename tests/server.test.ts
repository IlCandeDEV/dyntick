import { afterEach, test } from "bun:test";
import { deepEqual, equal, notEqual, ok } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "../server/app.ts";
import { createTimer, DEFAULT_PREFERENCES, pauseTimer, startTimer } from "../src/timer.ts";
import type { Snapshot } from "../src/protocol.ts";

const origin = "http://dyntick.test:8080";
const start = 1_800_000_000_000;
const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "dyntick-api-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  let now = start;
  const options = { databasePath: join(directory, "dyntick.sqlite"), now: () => now };
  let app = createApplication(options);
  cleanup.push(() => app.close());
  let nextId = 0;
  const request = (path: string, init?: RequestInit) => app.fetch(new Request(origin + path, init));
  const state = async () => await (await request("/api/state")).json() as Snapshot;
  const post = (path: string, body: unknown, headers?: Record<string, string>) => request(path, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Dyntick-Request": "1", Origin: origin, ...headers },
    body: JSON.stringify(body),
  });
  const action = async (value: unknown, revision?: number, requestId?: string) => {
    const current = revision ?? (await state()).revision;
    return await post("/api/action", { requestId: requestId ?? `test-request-${++nextId}`, revision: current, action: value });
  };
  const apply = async (value: unknown) => {
    const response = await action(value);
    equal(response.status, 200, await response.clone().text());
    return await response.json() as Snapshot;
  };
  return {
    directory, request, post, state, action, apply,
    setTime: (value: number) => { now = value; },
    reopen: () => { app.close(); app = createApplication(options); },
  };
}

test("a new SQLite instance starts with English defaults and a stable server identity", async () => {
  const f = fixture();
  const first = await f.state();
  equal(first.schemaVersion, 2);
  deepEqual(first.preferences, DEFAULT_PREFERENCES);
  equal(first.timer.status, "idle");
  equal(first.timer.remainingMs, 25 * 60_000);
  equal(first.initialized, false);
  equal(Object.keys(first.activity.entries).length, 0);
  ok(first.instanceId.length > 0);
  equal(first.serverNow, start);
  equal((await f.state()).revision, first.revision, "Read-only polling must not create revisions");
  f.reopen();
  equal((await f.state()).instanceId, first.instanceId);
});

test("preferences and a running timer survive closing and reopening the database", async () => {
  const f = fixture();
  await f.apply({ type: "preferences", patch: { language: "de", theme: "dark", focusMinutes: 40, soundEnabled: false } });
  const running = await f.apply({ type: "start" });
  equal(running.timer.endAt, start + 40 * 60_000);
  f.setTime(start + 120_000);
  f.reopen();
  const recovered = await f.state();
  equal(recovered.preferences.language, "de");
  equal(recovered.preferences.theme, "dark");
  equal(recovered.preferences.soundEnabled, false);
  equal(recovered.timer.status, "running");
  equal(recovered.timer.endAt, running.timer.endAt);
  equal(recovered.timer.focusSessionId, running.timer.focusSessionId);
});

test("pause, resume, reset and mode selection are shared server commands", async () => {
  const f = fixture();
  const running = await f.apply({ type: "start" });
  f.setTime(start + 72_345);
  const paused = await f.apply({ type: "pause" });
  equal(paused.timer.status, "paused");
  equal(paused.timer.remainingMs, 25 * 60_000 - 72_345);
  f.setTime(start + 86_400_000);
  f.reopen();
  equal((await f.state()).timer.remainingMs, paused.timer.remainingMs);
  const resumed = await f.apply({ type: "start" });
  equal(resumed.timer.endAt, start + 86_400_000 + paused.timer.remainingMs);
  equal(resumed.timer.focusSessionId, running.timer.focusSessionId);
  const reset = await f.apply({ type: "reset" });
  equal(reset.timer.status, "idle");
  equal(reset.timer.remainingMs, 25 * 60_000);
  const shortBreak = await f.apply({ type: "mode", mode: "shortBreak" });
  equal(shortBreak.timer.mode, "shortBreak");
  equal(shortBreak.timer.remainingMs, 5 * 60_000);
  equal(Object.keys(shortBreak.activity.entries).length, 0);
});

test("completion is recovered without an open browser and credited exactly once across restarts", async () => {
  const f = fixture();
  const running = await f.apply({ type: "start" });
  f.setTime(start + 7 * 86_400_000);
  f.reopen();
  const completed = await f.state();
  equal(completed.timer.status, "completed");
  equal(completed.timer.completedFocuses, 1);
  equal(completed.timer.completionId, 1);
  deepEqual(Object.values(completed.activity.entries), [{
    id: running.timer.focusSessionId, completedAt: running.timer.endAt, minutes: 25,
  }]);
  for (let index = 0; index < 8; index++) {
    f.reopen();
    const repeated = await f.state();
    equal(repeated.revision, completed.revision);
    equal(Object.keys(repeated.activity.entries).length, 1);
    equal(repeated.timer.completionId, 1);
  }
});

test("a long break follows the configured number of completed sessions and starts manually", async () => {
  const f = fixture();
  await f.apply({ type: "preferences", patch: { longBreakInterval: 2 } });
  let nextStart = start;
  for (let index = 0; index < 2; index++) {
    f.setTime(nextStart);
    const focus = await f.apply({ type: "start" });
    equal(focus.timer.mode, "focus");
    f.setTime(focus.timer.endAt!);
    const finished = await f.state();
    equal(finished.timer.status, "completed");
    equal(Object.keys(finished.activity.entries).length, index + 1);
    const pause = await f.apply({ type: "start" });
    equal(pause.timer.mode, index === 0 ? "shortBreak" : "longBreak");
    equal(pause.timer.durationMs, (index === 0 ? 5 : 15) * 60_000);
    f.setTime(pause.timer.endAt!);
    equal((await f.state()).timer.status, "completed");
    equal(Object.keys((await f.state()).activity.entries).length, index + 1, "Breaks never add study activity");
    nextStart = pause.timer.endAt! + 1;
  }
  f.setTime(nextStart);
  const nextCycle = await f.apply({ type: "start" });
  equal(nextCycle.timer.mode, "focus");
  equal(nextCycle.timer.completedFocuses, 0);
});

test("language, theme and future durations preserve running and paused sessions", async () => {
  const f = fixture();
  const running = await f.apply({ type: "start" });
  const localized = await f.apply({ type: "preferences", patch: { language: "es", theme: "dark", focusMinutes: 50 } });
  equal(localized.timer.endAt, running.timer.endAt);
  equal(localized.timer.durationMs, running.timer.durationMs);
  f.setTime(start + 60_000);
  const paused = await f.apply({ type: "pause" });
  const changed = await f.apply({ type: "preferences", patch: { language: "it", soundEnabled: false } });
  equal(changed.timer.remainingMs, paused.timer.remainingMs);
  equal(changed.timer.status, "paused");
  equal((await f.apply({ type: "reset" })).timer.durationMs, 50 * 60_000);
});

test("concurrent devices cannot overwrite a newer revision", async () => {
  const f = fixture();
  const old = await f.state();
  const outcomes = await Promise.all([
    f.action({ type: "start" }, old.revision, "device-a-start"),
    f.action({ type: "reset" }, old.revision, "device-b-reset"),
  ]);
  deepEqual(outcomes.map(response => response.status).sort(), [200, 409]);
  const rejected = await outcomes.find(response => response.status === 409)!.json() as { error: string; state: Snapshot };
  equal(rejected.error, "conflict");
  equal(rejected.state.revision, old.revision + 1);
  deepEqual(rejected.state.timer, (await f.state()).timer);
});

test("retried commands keep their original result and cannot repeat a completed phase", async () => {
  const f = fixture();
  const old = await f.state();
  const first = await f.action({ type: "start" }, old.revision, "retry-start");
  equal(first.status, 200);
  const running = await first.json() as Snapshot;
  const retry = await f.action({ type: "start" }, old.revision, "retry-start");
  equal(retry.status, 200);
  equal((await retry.json() as Snapshot).timer.endAt, running.timer.endAt);
  f.setTime(running.timer.endAt! + 86_400_000);
  const completed = await f.state();
  equal(completed.timer.status, "completed");
  const lateRetry = await f.action({ type: "start" }, old.revision, "retry-start");
  equal(lateRetry.status, 200);
  equal((await f.state()).timer.status, "completed");
  equal(Object.keys((await f.state()).activity.entries).length, 1);
  equal((await f.state()).revision, completed.revision);
});

test("reusing a command identity for another payload is rejected", async () => {
  const f = fixture();
  const original = await f.state();
  equal((await f.action({ type: "start" }, original.revision, "same-id")).status, 200);
  const mismatch = await f.action({ type: "reset" }, original.revision, "same-id");
  ok(mismatch.status >= 400 && mismatch.status < 500);
  equal((await f.state()).timer.status, "running");
});

test("the first legacy browser imports preferences, timer and history once", async () => {
  const f = fixture();
  const preferences = { ...DEFAULT_PREFERENCES, language: "it" as const, focusMinutes: 35 };
  const legacy = startTimer(createTimer(preferences), preferences, start - 3_000_000);
  const activity = { version: 1, entries: { old: { id: "old", completedAt: start - 86_400_000, minutes: 25 } } };
  const body = { requestId: "legacy-browser-a", preferences, timer: legacy, activity };
  const importedResponse = await f.post("/api/import", body);
  equal(importedResponse.status, 200);
  const imported = await importedResponse.json() as Snapshot;
  equal(imported.initialized, true);
  equal(imported.preferences.language, "it");
  equal(imported.timer.status, "completed");
  equal(Object.keys(imported.activity.entries).length, 2);
  f.reopen();
  equal((await f.post("/api/import", body)).status, 200);
  const recovered = await f.state();
  equal(Object.keys(recovered.activity.entries).length, 2);
  equal(recovered.timer.completionId, 1);
});

test("a later device merges its legacy history without replacing live server preferences or timer", async () => {
  const f = fixture();
  const live = await f.apply({ type: "preferences", patch: { language: "de", theme: "dark" } });
  equal(live.initialized, true);
  const running = await f.apply({ type: "start" });
  const legacyPreferences = { ...DEFAULT_PREFERENCES, language: "es" as const, focusMinutes: 50 };
  const body = {
    requestId: "later-device", preferences: legacyPreferences,
    timer: pauseTimer(startTimer(createTimer(legacyPreferences), legacyPreferences, start), start + 1000),
    activity: { version: 1, entries: { second: { id: "second", completedAt: start - 2000, minutes: 50 } } },
  };
  const response = await f.post("/api/import", body);
  equal(response.status, 200);
  const imported = await response.json() as Snapshot;
  equal(imported.preferences.language, "de");
  equal(imported.timer.endAt, running.timer.endAt);
  equal(imported.timer.focusSessionId, running.timer.focusSessionId);
  equal(Object.keys(imported.activity.entries).length, 1);
});

test("concurrent legacy histories merge by stable completion IDs, including duplicate imports", async () => {
  const f = fixture();
  const a = { id: "a", completedAt: start - 10_000, minutes: 25 };
  const b = { id: "b", completedAt: start - 5000, minutes: 40 };
  for (const [id, entries] of [["import-a", { a }], ["import-b", { a, b }], ["import-b-copy", { a, b }]] as const) {
    equal((await f.post("/api/import", { requestId: id, activity: { version: 1, entries } })).status, 200);
  }
  deepEqual((await f.state()).activity.entries, { a, b });
});

test("invalid preference patches and arbitrary timer replacement cannot corrupt server state", async () => {
  const f = fixture();
  const initial = await f.state();
  for (const action of [
    { type: "preferences", patch: { focusMinutes: 0 } },
    { type: "preferences", patch: { focusMinutes: 181 } },
    { type: "preferences", patch: { language: "fr" } },
    { type: "preferences", patch: { longBreakInterval: 7 } },
    { type: "preferences", patch: { soundEnabled: "yes" } },
    { type: "preferences", patch: { unknown: 1 } },
    { type: "mode", mode: "unknown" },
    { type: "replace", timer: { status: "completed" } },
  ]) {
    const response = await f.action(action);
    equal(response.status, 400, await response.clone().text());
  }
  const state = await f.state();
  deepEqual(state.preferences, initial.preferences);
  deepEqual(state.timer, initial.timer);
  equal(state.revision, initial.revision);
});

test("write endpoints require JSON, the application header and the same origin", async () => {
  const f = fixture();
  const body = JSON.stringify({ requestId: "unsafe", revision: (await f.state()).revision, action: { type: "start" } });
  const rejectedHeaders: Record<string, string>[] = [
    { "Content-Type": "application/json", Origin: origin },
    { "Content-Type": "application/json", "X-Dyntick-Request": "1", Origin: "https://unrelated.example" },
    { "Content-Type": "text/plain", "X-Dyntick-Request": "1", Origin: origin },
    { "Content-Type": "application/json", "X-Dyntick-Request": "1", Origin: origin, "Sec-Fetch-Site": "cross-site" },
  ];
  for (const headers of rejectedHeaders) {
    const response = await f.request("/api/action", { method: "POST", headers, body });
    ok(response.status >= 400 && response.status < 500);
    equal(response.headers.get("access-control-allow-origin"), null);
  }
  equal((await f.state()).timer.status, "idle");
});

test("malformed or excessive requests fail without altering SQLite", async () => {
  const f = fixture();
  const headers = { "Content-Type": "application/json", "X-Dyntick-Request": "1", Origin: origin };
  for (const body of ["not-json", "null", "[]", "{}", JSON.stringify({ requestId: "x".repeat(512), revision: 0, action: { type: "start" } })]) {
    const response = await f.request("/api/action", { method: "POST", headers, body });
    ok(response.status >= 400 && response.status < 500);
  }
  const oversized = await f.request("/api/import", { method: "POST", headers, body: "x".repeat(6 * 1024 * 1024) });
  equal(oversized.status, 413);
  equal((await f.state()).timer.status, "idle");
});

test("API responses are private and never expose the database as a static file", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dyntick-static-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const site = join(directory, "site");
  mkdirSync(site);
  writeFileSync(join(site, "index.html"), "<!doctype html><title>Dyntick</title>");
  writeFileSync(join(directory, "secret.txt"), "private-database-data");
  const app = createApplication({ databasePath: join(directory, "dyntick.sqlite"), staticDirectory: site, now: () => start });
  cleanup.push(() => app.close());
  const response = await app.fetch(new Request(origin + "/api/state"));
  equal(response.status, 200);
  ok(response.headers.get("cache-control")?.includes("no-store"));
  for (const path of ["/dyntick.sqlite", "/data/dyntick.sqlite", "/%2e%2e/secret.txt", "/%252e%252e/secret.txt", "/api/unknown"]) {
    const hidden = await app.fetch(new Request(origin + path));
    notEqual(hidden.status, 200, path);
    ok(!(await hidden.text()).includes("private-database-data"));
  }
  const health = await app.fetch(new Request(origin + "/healthz"));
  equal(health.status, 200);
});

test("a chunked upload cannot evade the body limit with a false Content-Length", async () => {
  const f = fixture();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let index = 0; index < 4; index++) controller.enqueue(new Uint8Array(768 * 1024));
    },
    cancel() { cancelled = true; },
  });
  const response = await f.request("/api/import", {
    method: "POST", body: stream,
    headers: { "Content-Type": "application/json", "X-Dyntick-Request": "1", Origin: origin, "Content-Length": "1" },
  });
  equal(response.status, 413);
  equal(cancelled, true, "The remaining upload should be cancelled as soon as its limit is exceeded");
  equal((await f.state()).initialized, false);
});

test("same-host HTTPS reverse proxies can save state while a foreign origin remains rejected", async () => {
  const f = fixture();
  const current = await f.state();
  const request = { requestId: "reverse-proxy", revision: current.revision, action: { type: "start" } };
  const rejected = await f.post("/api/action", request, { Origin: "https://other.example", "X-Forwarded-Proto": "https" });
  equal(rejected.status, 403);
  const accepted = await f.post("/api/action", request, { Origin: origin.replace("http:", "https:"), "X-Forwarded-Proto": "https" });
  equal(accepted.status, 200);
  equal((await accepted.json() as Snapshot).timer.status, "running");
});

test("API methods advertise allowed operations and never grant cross-origin preflight access", async () => {
  const f = fixture();
  for (const path of ["/api/action", "/api/import"]) {
    const get = await f.request(path);
    equal(get.status, 405);
    equal(get.headers.get("allow"), "POST");
    const preflight = await f.request(path, { method: "OPTIONS", headers: { Origin: "https://other.example", "Access-Control-Request-Method": "POST" } });
    equal(preflight.status, 405);
    equal(preflight.headers.get("access-control-allow-origin"), null);
  }
  const postState = await f.request("/api/state", { method: "POST" });
  equal(postState.status, 405);
  equal(postState.headers.get("allow"), "GET");
});

test("a later device recovers an expired legacy focus without replacing the server's live session", async () => {
  const f = fixture();
  await f.apply({ type: "preferences", patch: { language: "de", focusMinutes: 40 } });
  const live = await f.apply({ type: "start" });
  const legacyPreferences = { ...DEFAULT_PREFERENCES, language: "it" as const, focusMinutes: 25 };
  const legacy = startTimer(createTimer(legacyPreferences), legacyPreferences, start - 2_000_000);
  const body = { requestId: "expired-later-browser", preferences: legacyPreferences, timer: legacy, activity: { version: 1, entries: {} } };
  const importedResponse = await f.post("/api/import", body);
  equal(importedResponse.status, 200);
  const imported = await importedResponse.json() as Snapshot;
  equal(imported.preferences.language, "de");
  equal(imported.timer.endAt, live.timer.endAt);
  equal(imported.timer.focusSessionId, live.timer.focusSessionId);
  deepEqual(Object.values(imported.activity.entries), [{ id: legacy.focusSessionId, completedAt: legacy.endAt, minutes: 25 }]);
  f.reopen();
  equal((await f.post("/api/import", body)).status, 200);
  equal(Object.keys((await f.state()).activity.entries).length, 1);
  equal((await f.state()).timer.endAt, live.timer.endAt);
  equal((await f.state()).timer.completionId, 0);
});

test("a stale command at expiry returns a conflict after durably recording the completed session", async () => {
  const f = fixture();
  const running = await f.apply({ type: "start" });
  f.setTime(running.timer.endAt! + 1000);
  // Do not read first: the rejected command itself must settle and commit expiry.
  const response = await f.action({ type: "reset" }, running.revision, "stale-at-expiry");
  equal(response.status, 409);
  const conflict = await response.json() as { error: string; state: Snapshot };
  equal(conflict.error, "conflict");
  equal(conflict.state.timer.status, "completed");
  equal(Object.keys(conflict.state.activity.entries).length, 1);
  equal(conflict.state.revision, running.revision + 1);
  f.reopen();
  const persisted = await f.state();
  equal(persisted.timer.status, "completed");
  equal(persisted.revision, conflict.state.revision);
  equal(persisted.activity.entries[running.timer.focusSessionId!].completedAt, running.timer.endAt);
  equal(Object.keys(persisted.activity.entries).length, 1);
});

test("a pending action from another database instance cannot modify this installation", async () => {
  const f = fixture();
  const initial = await f.state();
  const response = await f.post("/api/action", {
    requestId: "old-instance-action", instanceId: "replaced-installation", revision: initial.revision,
    action: { type: "start" },
  });
  equal(response.status, 409);
  const conflict = await response.json() as { error: string; state: Snapshot };
  equal(conflict.error, "instance_changed");
  equal(conflict.state.instanceId, initial.instanceId);
  equal((await f.state()).revision, initial.revision);
  equal((await f.state()).timer.status, "idle");
});

test("an import retry from another database instance cannot replace preferences or contribute history", async () => {
  const f = fixture();
  const initial = await f.state();
  const response = await f.post("/api/import", {
    requestId: "old-instance-import", instanceId: "replaced-installation",
    preferences: { ...DEFAULT_PREFERENCES, language: "it" },
    activity: { version: 1, entries: { old: { id: "old", completedAt: start - 1000, minutes: 25 } } },
  });
  equal(response.status, 409);
  const conflict = await response.json() as { error: string; state: Snapshot };
  equal(conflict.error, "instance_changed");
  equal(conflict.state.instanceId, initial.instanceId);
  equal((await f.state()).initialized, false);
  equal((await f.state()).revision, initial.revision);
  equal(Object.keys((await f.state()).activity.entries).length, 0);
  equal((await f.state()).preferences.language, "en");
});
