import { afterEach, test } from "bun:test";
import { Database } from "bun:sqlite";
import { deepEqual, equal, notEqual, ok } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication, type ApplicationOptions } from "../server/app.ts";
import { createTimer, DEFAULT_PREFERENCES, pauseTimer, startTimer } from "../src/timer.ts";
import type { Snapshot } from "../src/protocol.ts";
import { academicYearAt, DEFAULT_SESSION_MONTHS, formatExamDate, MAX_EXAM_CREDITS, MAX_EXAM_NAME_LENGTH, parseExamDate } from "../src/planning.ts";

const origin = "http://dyntick.test:8080";
const start = 1_800_000_000_000;
const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

function fixture(fetchRelease?: ApplicationOptions["fetchRelease"]) {
  const directory = mkdtempSync(join(tmpdir(), "dyntick-api-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  let now = start;
  const options = { databasePath: join(directory, "dyntick.sqlite"), now: () => now, fetchRelease };
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

test("the latest release is shared across readers and refreshed after the cache expires", async () => {
  let calls = 0;
  let tag: string | null = "v2.0.1";
  const f = fixture((url, init) => {
    equal(url, "https://api.github.com/repos/IlCandeDEV/dyntick/releases/latest");
    equal(new Headers(init.headers).get("authorization"), null);
    ok(init.signal);
    calls++;
    return Promise.resolve(tag ? Response.json({ tag_name: tag }) : new Response(null, { status: 503 }));
  });
  const path = "/api/latest-release";
  const read = async () => (await f.request(path)).json();
  equal((await f.request(path, { method: "POST" })).status, 405);
  await f.state();
  equal(calls, 0, "Reading timer state must leave the release check idle");
  deepEqual(await Promise.all([read(), read()]), [{ version: "2.0.1" }, { version: "2.0.1" }]);
  equal(calls, 1);
  const hour = 60 * 60_000;
  f.setTime(start + hour - 1);
  deepEqual(await read(), { version: "2.0.1" });
  equal(calls, 1);
  f.setTime(start + hour);
  tag = null;
  deepEqual(await read(), { version: "2.0.1" });
  deepEqual(await read(), { version: "2.0.1" });
  equal(calls, 2, "An upstream failure must not make every request retry");
  f.setTime(start + hour + 5 * 60_000);
  tag = "2.0.2";
  deepEqual(await read(), { version: "2.0.2" });
  equal(calls, 3);
});

test("the release check records no version when the upstream tag is invalid", async () => {
  const f = fixture(() => Promise.resolve(Response.json({ tag_name: "2.0.1-rc.1" })));
  deepEqual(await (await f.request("/api/latest-release")).json(), { version: null });
  equal((await f.state()).revision, 0);
});

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
  const breaks = [];
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
    breaks.push({ mode: pause.timer.mode, afterFocus: index + 1 });
    f.reopen();
    const completed = await f.state();
    equal(completed.timer.status, "completed");
    deepEqual(completed.timer.completedBreaks, breaks);
    equal(Object.keys(completed.activity.entries).length, index + 1, "Breaks never add study activity");
    nextStart = pause.timer.endAt! + 1;
  }
  f.setTime(nextStart);
  const nextCycle = await f.apply({ type: "start" });
  equal(nextCycle.timer.mode, "focus");
  equal(nextCycle.timer.completedFocuses, 0);
  deepEqual(nextCycle.timer.completedBreaks, []);
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

test("an existing database adds exam planning and preserves its running timer", async () => {
  const f = fixture();
  const running = await f.apply({ type: "start" });
  const legacy = new Database(join(f.directory, "dyntick.sqlite"));
  legacy.exec("DROP TABLE exams; DROP TABLE session_months; PRAGMA user_version = 1;");
  legacy.close();
  f.reopen();
  const upgraded = await f.state();
  deepEqual(upgraded.exams, []);
  deepEqual(upgraded.sessionMonths, DEFAULT_SESSION_MONTHS);
  deepEqual(upgraded.timer, running.timer);

  const exam = { id: "systems", name: "Operating Systems", academicYear: 2026, session: null };
  const create = { type: "exam.create", exam: { ...exam, name: "  Operating Systems  " } };
  const created = await f.action(create, upgraded.revision, "add-systems");
  equal(created.status, 200);
  const added = await created.json() as Snapshot;
  deepEqual(added.exams, [{ ...exam, credits: 0, examDate: null }]);
  const duplicate = await f.action(create, upgraded.revision, "add-systems");
  equal(duplicate.status, 200);
  equal((await duplicate.json() as Snapshot).revision, added.revision);

  const winter = await f.apply({ type: "exam.update", id: exam.id, patch: { session: "winter" } });
  deepEqual(winter.exams, [{ ...exam, session: "winter", credits: 0, examDate: null }]);
  const stale = await f.action({ type: "exam.update", id: exam.id, patch: { session: "resit" } }, added.revision);
  equal(stale.status, 409);
  const renamed = await f.apply({ type: "exam.update", id: exam.id, patch: { name: "Computer Systems" } });
  equal(renamed.exams[0].session, "winter");
  f.reopen();
  deepEqual((await f.state()).exams, renamed.exams);
  const unscheduled = await f.apply({ type: "exam.update", id: exam.id, patch: { session: null } });
  equal(unscheduled.exams[0].session, null);
  const deleted = await f.apply({ type: "exam.delete", id: exam.id });
  deepEqual(deleted.exams, []);
  deepEqual(deleted.timer, running.timer);
  equal((await f.action({ type: "exam.update", id: exam.id, patch: { session: "summer" } })).status, 409);
});

test("existing exams get zero credits without losing their planning or request history", async () => {
  const f = fixture();
  const exam = { id: "existing", name: "Calculus", academicYear: 2026, session: "winter" };
  const create = { type: "exam.create", exam };
  const revision = (await f.state()).revision;
  const saved = await f.action(create, revision, "existing-exam");
  equal(saved.status, 200);
  const legacy = new Database(join(f.directory, "dyntick.sqlite"));
  legacy.exec("ALTER TABLE exams DROP COLUMN credits; ALTER TABLE exams DROP COLUMN exam_date; PRAGMA user_version = 1;");
  const legacyFingerprint = new Bun.CryptoHasher("sha256").update(JSON.stringify({ revision, action: create })).digest("hex");
  legacy.query("UPDATE requests SET fingerprint = ? WHERE id = ?").run(legacyFingerprint, "existing-exam");
  legacy.close();
  f.reopen();
  deepEqual((await f.state()).exams, [{ ...exam, credits: 0, examDate: null }]);
  equal((await f.action(create, revision, "existing-exam")).status, 200);

  await f.apply({ type: "exam.update", id: exam.id, patch: { credits: MAX_EXAM_CREDITS } });
  await f.apply({ type: "exam.update", id: exam.id, patch: { session: "summer" } });
  f.reopen();
  deepEqual((await f.state()).exams, [{ ...exam, session: "summer", credits: MAX_EXAM_CREDITS, examDate: null }]);
  const reset = await f.apply({ type: "exam.update", id: exam.id, patch: { credits: 0 } });
  equal(reset.exams[0].credits, 0);
});

test("a version 2 plan keeps its exams and timer when the credit range is widened", async () => {
  const f = fixture();
  const exam = { id: "previous-credit-limit", name: "Calculus", academicYear: 2026, session: "winter", credits: 12 };
  await f.apply({ type: "exam.create", exam });
  const running = await f.apply({ type: "start" });
  const database = new Database(join(f.directory, "dyntick.sqlite"));
  database.exec(`
    CREATE TABLE legacy_exams (
      id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL,
      academic_year INTEGER NOT NULL CHECK (academic_year BETWEEN 1000 AND 9998),
      session TEXT CHECK (session IN ('winter', 'summer', 'resit')),
      credits INTEGER NOT NULL DEFAULT 0 CHECK (credits BETWEEN 0 AND 12)
    );
    INSERT INTO legacy_exams SELECT id, name, academic_year, session, credits FROM exams;
    DROP TABLE exams;
    ALTER TABLE legacy_exams RENAME TO exams;
    UPDATE study_state SET preferences = json_remove(preferences, '$.creditSystem');
    PRAGMA user_version = 2;
  `);
  database.close();

  f.reopen();
  const migrated = await f.state();
  deepEqual(migrated.exams, [{ ...exam, examDate: null }]);
  deepEqual(migrated.preferences, running.preferences);
  deepEqual(migrated.timer, running.timer);
  equal(migrated.revision, running.revision);
  equal((await f.action({ type: "preferences", patch: { creditSystem: "unknown" } })).status, 400);
  const ects = await f.apply({ type: "preferences", patch: { creditSystem: "ECTS" } });
  equal(ects.preferences.creditSystem, "ECTS");
  const cats = await f.apply({ type: "preferences", patch: { creditSystem: "CATS" } });
  equal(cats.preferences.creditSystem, "CATS");
  deepEqual(cats.exams, migrated.exams);
  deepEqual(cats.timer, running.timer);

  await f.apply({ type: "exam.update", id: exam.id, patch: { credits: MAX_EXAM_CREDITS } });
  f.reopen();
  const saved = await f.state();
  equal(saved.preferences.creditSystem, "CATS");
  deepEqual(saved.exams, [{ ...exam, credits: MAX_EXAM_CREDITS, examDate: null }]);
});

test("exam dates are optional calendar dates and survive migration, changes of session and restarts", async () => {
  const f = fixture();
  const exam = { id: "dated-exam", name: "Calculus", academicYear: 2027, session: "winter", credits: 9 };
  const create = { type: "exam.create", exam };
  const revision = (await f.state()).revision;
  equal((await f.action(create, revision, "before-exam-dates")).status, 200);
  const database = new Database(join(f.directory, "dyntick.sqlite"));
  database.exec("ALTER TABLE exams DROP COLUMN exam_date; PRAGMA user_version = 3;");
  database.close();
  f.reopen();
  deepEqual((await f.state()).exams, [{ ...exam, examDate: null }]);
  equal((await f.action(create, revision, "before-exam-dates")).status, 200);

  for (const examDate of ["2026-02-29", "2028-04-31", "2028-2-29", "0000-02-29", "2028-02-29T00:00:00Z", 20280229]) {
    equal((await f.action({ type: "exam.create", exam: { ...exam, examDate } })).status, 400);
    equal((await f.action({ type: "exam.update", id: exam.id, patch: { examDate } })).status, 400);
  }
  const examDate = "2028-02-29";
  const added = await f.apply({ type: "exam.create", exam: { ...exam, id: "second-exam", examDate } });
  equal(added.exams[1].examDate, examDate);
  await f.apply({ type: "exam.update", id: exam.id, patch: { examDate } });
  await f.apply({ type: "exam.update", id: exam.id, patch: { session: "resit" } });
  f.reopen();
  deepEqual((await f.state()).exams[0], { ...exam, session: "resit", examDate });
  const cleared = await f.apply({ type: "exam.update", id: exam.id, patch: { examDate: null } });
  deepEqual(cleared.exams[0], { ...exam, session: "resit", examDate: null });
});

test("both numeric date formats map to the same calendar date and validate the entered day and month", () => {
  equal(formatExamDate("2028-02-09", "dmy"), "09/02/2028");
  equal(formatExamDate("2028-02-09", "mdy"), "02/09/2028");
  equal(parseExamDate(" 9/2/2028 ", "dmy"), "2028-02-09");
  equal(parseExamDate("02/09/2028", "mdy"), "2028-02-09");
  equal(parseExamDate("02/09/2028", "dmy"), "2028-09-02");
  equal(parseExamDate("29/02/2028", "dmy"), "2028-02-29");
  equal(parseExamDate("29/02/2028", "mdy"), null);
  equal(parseExamDate("02/29/2027", "mdy"), null);
  equal(parseExamDate("31/04/2028", "dmy"), null);
});

test("an existing installation defaults to European dates and can save American format without changing its exams", async () => {
  const f = fixture();
  const exam = { id: "date-format", name: "Calculus", academicYear: 2027, session: "winter", credits: 6, examDate: "2028-02-09" };
  await f.apply({ type: "exam.create", exam });
  const running = await f.apply({ type: "start" });
  const database = new Database(join(f.directory, "dyntick.sqlite"));
  database.exec("UPDATE study_state SET preferences = json_remove(preferences, '$.dateFormat'); PRAGMA user_version = 4;");
  database.close();
  f.reopen();
  const migrated = await f.state();
  deepEqual(migrated.preferences, running.preferences);
  equal(migrated.preferences.dateFormat, "dmy");
  equal((await f.action({ type: "preferences", patch: { dateFormat: "ymd" } })).status, 400);
  await f.apply({ type: "preferences", patch: { dateFormat: "mdy" } });
  f.reopen();
  const saved = await f.state();
  equal(saved.preferences.dateFormat, "mdy");
  deepEqual(saved.exams, [exam]);
  deepEqual(saved.timer, running.timer);
});

test("exam planning validates names, sessions, academic years and credits before saving", async () => {
  const f = fixture();
  const exam = { id: "invalid", name: "Calculus", academicYear: 2026, session: "summer" };
  for (const invalid of [
    { ...exam, session: "spring" }, { ...exam, name: "   " },
    { ...exam, name: "a".repeat(MAX_EXAM_NAME_LENGTH + 1) }, { ...exam, academicYear: 2026.5 },
  ]) {
    equal((await f.action({ type: "exam.create", exam: invalid })).status, 400);
  }
  deepEqual((await f.state()).exams, []);

  for (const credits of [-1, MAX_EXAM_CREDITS + 1, 3.5, "9", null]) {
    equal((await f.action({ type: "exam.create", exam: { ...exam, credits } })).status, 400);
  }
  const atLimit = { ...exam, name: "W".repeat(MAX_EXAM_NAME_LENGTH), credits: MAX_EXAM_CREDITS };
  deepEqual((await f.apply({ type: "exam.create", exam: atLimit })).exams, [{ ...atLimit, examDate: null }]);
  equal((await f.action({ type: "exam.update", id: exam.id, patch: { name: `${atLimit.name}W` } })).status, 400);
  equal((await f.action({ type: "exam.update", id: exam.id, patch: { credits: MAX_EXAM_CREDITS + 1 } })).status, 400);

  const legacyName = "W".repeat(120);
  const db = new Database(join(f.directory, "dyntick.sqlite"));
  db.query("UPDATE exams SET name = ? WHERE id = ?").run(legacyName, exam.id);
  db.close();
  const moved = await f.apply({ type: "exam.update", id: exam.id, patch: { session: "winter" } });
  deepEqual(moved.exams, [{ ...exam, name: legacyName, session: "winter", credits: MAX_EXAM_CREDITS, examDate: null }]);
  equal(academicYearAt(new Date(2027, 8, 30)), 2026);
  equal(academicYearAt(new Date(2027, 9, 1)), 2027);
});

test("session months are validated and saved independently of exams and the timer", async () => {
  const f = fixture();
  const initial = await f.apply({ type: "start" });
  const update = { type: "session.months", session: "winter", months: [2, 12, 1] };
  for (const months of [[], [0], [13], [1, 1], ["1"]]) {
    equal((await f.action({ ...update, months })).status, 400);
  }
  equal((await f.action({ ...update, session: null })).status, 400);
  const result = await f.action(update, initial.revision, "winter-months");
  equal(result.status, 200);
  const updated = await result.json() as Snapshot;
  deepEqual(updated.sessionMonths, { ...DEFAULT_SESSION_MONTHS, winter: [12, 1, 2] });
  deepEqual(updated.timer, initial.timer);
  deepEqual(updated.exams, initial.exams);
  const retry = await f.action({ ...update, months: [1, 2, 12] }, initial.revision, "winter-months");
  equal(retry.status, 200);
  equal((await retry.json() as Snapshot).revision, updated.revision);
  equal((await f.action({ ...update, months: [3] }, initial.revision)).status, 409);
  f.reopen();
  deepEqual((await f.state()).sessionMonths, updated.sessionMonths);
});

test("restoring preferences commits every exam period together", async () => {
  const f = fixture();
  await f.apply({ type: "preferences", patch: { focusMinutes: 45 } });
  const exam = { id: "restore-periods-exam", name: "Systems", academicYear: 2026, session: "winter", credits: 9, examDate: "2027-01-15" };
  await f.apply({ type: "exam.create", exam });
  await f.apply({ type: "session.months", session: "winter", months: [12] });
  await f.apply({ type: "session.months", session: "summer", months: [8] });
  await f.apply({ type: "session.months", session: "resit", months: [10] });
  const before = await f.apply({ type: "start" });
  const restore = {
    type: "preferences", patch: { focusMinutes: DEFAULT_PREFERENCES.focusMinutes }, sessionMonths: DEFAULT_SESSION_MONTHS,
  };
  const invalid = { ...restore, sessionMonths: { ...DEFAULT_SESSION_MONTHS, resit: [13] } };
  equal((await f.action(invalid, before.revision)).status, 400);
  deepEqual(await f.state(), before);

  const result = await f.action(restore, before.revision, "restore-months");
  equal(result.status, 200);
  const saved = await result.json() as Snapshot;
  deepEqual(saved.sessionMonths, DEFAULT_SESSION_MONTHS);
  equal(saved.preferences.focusMinutes, DEFAULT_PREFERENCES.focusMinutes);
  deepEqual(saved.exams, [exam]);
  deepEqual(saved.timer, before.timer);
  equal(saved.revision, before.revision + 1);
  const retry = await f.action(restore, before.revision, "restore-months");
  equal(retry.status, 200);
  equal((await retry.json() as Snapshot).revision, saved.revision);
  f.reopen();
  deepEqual((await f.state()).sessionMonths, DEFAULT_SESSION_MONTHS);
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
