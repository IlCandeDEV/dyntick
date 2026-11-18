import { Database } from "bun:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { emptyActivity, mergeActivity, recordCompletion, type StudyActivity } from "../src/activity.ts";
import type { Action, Snapshot } from "../src/protocol.ts";
import { parsePreferences, parseTimer } from "../src/storage.ts";
import {
  createTimer, DEFAULT_PREFERENCES, pauseTimer, resetTimer, selectMode,
  settleTimer, startTimer, updateDurations, type Preferences, type TimerState,
} from "../src/timer.ts";

interface StateRow {
  instance_id: string;
  revision: number;
  initialized: number;
  preferences: string;
  timer: string;
}
interface CompletionRow { id: string; completed_at: number; minutes: number }
interface RequestRow { fingerprint: string }

export class StateConflict extends Error {
  constructor(public state: Snapshot, public code = "conflict") { super(code); }
}

/** SQLite is authoritative: state transitions and their completion records commit together. */
export class StudyDatabase {
  private db: Database;

  constructor(path: string, private now: () => number = Date.now) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true, strict: true });
    if (path !== ":memory:") chmodSync(path, 0o600);
    try {
      this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
      const version = this.db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
      if (version > 1) throw new Error("This database needs a newer version of Dyntick.");
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS study_state (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            instance_id TEXT NOT NULL,
            revision INTEGER NOT NULL DEFAULT 0,
            initialized INTEGER NOT NULL DEFAULT 0,
            preferences TEXT NOT NULL,
            timer TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS completions (
            id TEXT PRIMARY KEY,
            completed_at INTEGER NOT NULL,
            minutes INTEGER NOT NULL CHECK (minutes BETWEEN 1 AND 180)
          );
          CREATE TABLE IF NOT EXISTS requests (
            id TEXT PRIMARY KEY,
            fingerprint TEXT NOT NULL
          );
          PRAGMA user_version = 1;
        `);
        this.db.query("INSERT OR IGNORE INTO study_state (id, instance_id, preferences, timer) VALUES (1, ?, ?, ?)")
          .run(crypto.randomUUID(), JSON.stringify(DEFAULT_PREFERENCES), JSON.stringify(createTimer(DEFAULT_PREFERENCES)));
      }).immediate();
    } catch (error) { this.db.close(); throw error; }
  }

  close() { this.db.close(); }
  health() { this.db.query("SELECT 1 FROM study_state WHERE id = 1").get(); }

  private row(): StateRow {
    return this.db.query<StateRow, []>("SELECT instance_id, revision, initialized, preferences, timer FROM study_state WHERE id = 1").get()!;
  }

  private activity(): StudyActivity {
    const rows = this.db.query<CompletionRow, []>("SELECT id, completed_at, minutes FROM completions ORDER BY completed_at, id").all();
    return { version: 1, entries: Object.fromEntries(rows.map((row) => [row.id, {
      id: row.id, completedAt: row.completed_at, minutes: row.minutes,
    }])) };
  }

  private credit(timer: TimerState) {
    const completion = timer.lastFocusCompletion;
    if (completion) this.db.query("INSERT OR IGNORE INTO completions (id, completed_at, minutes) VALUES (?, ?, ?)")
      .run(completion.id, completion.completedAt, completion.minutes);
  }

  private save(row: StateRow, timer: TimerState, preferences: Preferences, initialized = row.initialized) {
    this.credit(timer);
    this.db.query("UPDATE study_state SET revision = revision + 1, initialized = ?, preferences = ?, timer = ? WHERE id = 1")
      .run(initialized, JSON.stringify(preferences), JSON.stringify(timer));
  }

  private settle(timestamp: number) {
    const row = this.row();
    const timer = JSON.parse(row.timer) as TimerState;
    const settled = settleTimer(timer, timestamp);
    if (settled !== timer) this.save(row, settled, JSON.parse(row.preferences) as Preferences);
  }

  private snapshot(timestamp: number): Snapshot {
    const row = this.row();
    return { schemaVersion: 2, instanceId: row.instance_id, revision: row.revision,
      initialized: row.initialized === 1, serverNow: timestamp,
      preferences: JSON.parse(row.preferences), timer: JSON.parse(row.timer), activity: this.activity() };
  }

  read(): Snapshot {
    return this.db.transaction(() => {
      const timestamp = this.now();
      this.settle(timestamp);
      return this.snapshot(timestamp);
    }).immediate();
  }

  private duplicate(requestId: string, fingerprint: string): boolean {
    const previous = this.db.query<RequestRow, [string]>("SELECT fingerprint FROM requests WHERE id = ?").get(requestId);
    if (previous && previous.fingerprint !== fingerprint) {
      throw new StateConflict(this.snapshot(this.now()), "request_reused");
    }
    return Boolean(previous);
  }

  private remember(requestId: string, fingerprint: string) {
    this.db.query("INSERT INTO requests (id, fingerprint) VALUES (?, ?)").run(requestId, fingerprint);
  }

  action(requestId: string, revision: number, action: Action): Snapshot {
    const fingerprint = new Bun.CryptoHasher("sha256").update(JSON.stringify({ revision, action })).digest("hex");
    // A conflict is returned after settling, so expiry is durable even for a stale command.
    const result: { state?: Snapshot; conflict?: Snapshot } = this.db.transaction(() => {
      const timestamp = this.now();
      this.settle(timestamp);
      if (this.duplicate(requestId, fingerprint)) return { state: this.snapshot(timestamp) };
      const row = this.row();
      if (row.revision !== revision) return { conflict: this.snapshot(timestamp) };
      let timer = JSON.parse(row.timer) as TimerState;
      let preferences = JSON.parse(row.preferences) as Preferences;
      switch (action.type) {
        case "start": timer = startTimer(timer, preferences, timestamp); break;
        case "pause": timer = pauseTimer(timer, timestamp); break;
        case "reset": timer = resetTimer(timer, preferences); break;
        case "mode": timer = selectMode(timer, action.mode, preferences); break;
        case "preferences":
          preferences = { ...preferences, ...action.patch };
          timer = updateDurations(timer, preferences);
          break;
      }
      this.save(row, timer, preferences, 1);
      this.remember(requestId, fingerprint);
      return { state: this.snapshot(timestamp) };
    }).immediate();
    if (result.conflict) throw new StateConflict(result.conflict);
    return result.state!;
  }

  importLegacy(requestId: string, payload: { preferences?: unknown; timer?: unknown; activity?: StudyActivity }): Snapshot {
    const fingerprint = "import:" + new Bun.CryptoHasher("sha256").update(JSON.stringify(payload)).digest("hex");
    return this.db.transaction(() => {
      const timestamp = this.now();
      this.settle(timestamp);
      if (this.duplicate(requestId, fingerprint)) return this.snapshot(timestamp);
      const row = this.row();
      let preferences = JSON.parse(row.preferences) as Preferences;
      let timer = JSON.parse(row.timer) as TimerState;
      const legacyPreferences = payload.preferences ? parsePreferences(JSON.stringify(payload.preferences)) : preferences;
      const legacyTimer = payload.timer ? parseTimer(JSON.stringify(payload.timer), legacyPreferences, timestamp) : null;
      if (!row.initialized) {
        preferences = legacyPreferences;
        timer = legacyTimer ?? createTimer(preferences);
      }
      let incoming = mergeActivity(emptyActivity(), payload.activity ?? emptyActivity());
      // A later device may have closed before its expired focus reached local history.
      // Import that earned completion without replacing the live shared timer.
      if (legacyTimer?.lastFocusCompletion) incoming = recordCompletion(incoming, legacyTimer.lastFocusCompletion);
      // Match legacy browser union rules without allowing a duplicate to increase credit.
      for (const completion of Object.values(incoming.entries)) {
        this.db.query(`INSERT INTO completions (id, completed_at, minutes) VALUES (?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET completed_at = excluded.completed_at, minutes = excluded.minutes
          WHERE excluded.completed_at < completions.completed_at OR
            (excluded.completed_at = completions.completed_at AND excluded.minutes < completions.minutes)`)
          .run(completion.id, completion.completedAt, completion.minutes);
      }
      this.save(row, timer, preferences, 1);
      this.remember(requestId, fingerprint);
      return this.snapshot(timestamp);
    }).immediate();
  }
}
