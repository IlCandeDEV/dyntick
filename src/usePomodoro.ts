import { useCallback, useEffect, useRef, useState } from "react";
import { TimerAudio } from "./audio.ts";
import { ACTIVITY_KEY, emptyActivity, parseActivity } from "./activity.ts";
import {
  browserStorage,
  parsePreferences,
  parseTimer,
  PREFERENCES_KEY,
  readStorage,
  TIMER_KEY,
} from "./storage.ts";
import { createTimer, DEFAULT_PREFERENCES, type Mode, type Preferences } from "./timer.ts";
import { DEFAULT_SESSION_MONTHS, type Exam, type PlanningAction, type SessionMonths } from "./planning.ts";
import { newClientId, type Action, type Snapshot } from "./protocol.ts";

type Connection = "loading" | "online" | "offline";
type PendingRequest = { path: string; body: Record<string, unknown> };

const NO_EXAMS: readonly Exam[] = [];

async function request(path: string, body?: Record<string, unknown>) {
  return fetch(path, {
    method: body ? "POST" : "GET",
    cache: "no-store",
    credentials: "same-origin",
    headers: body ? { "Content-Type": "application/json", "X-Dyntick-Request": "1" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
}

/** The server owns every durable value. Browser storage is read only for v1 migration. */
export function usePomodoro() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const snapshotRef = useRef<Snapshot | null>(null);
  const [connection, setConnection] = useState<Connection>("loading");
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [ready, setReady] = useState(false);
  const readyRef = useRef(false);
  const pending = useRef<PendingRequest | null>(null);
  const mutationInFlight = useRef(false);
  const refreshInFlight = useRef(false);
  const mounted = useRef(true);
  const clockOffset = useRef(0);
  const [now, setNow] = useState(Date.now);
  const audio = useRef<TimerAudio | null>(null);
  const notifiedCompletion = useRef<number | null>(null);
  const defaults = useRef({ ...DEFAULT_PREFERENCES });
  const initialTimer = useRef(createTimer(defaults.current));
  const initialActivity = useRef(emptyActivity());

  const audioInstance = useCallback(() => audio.current ??= new TimerAudio(), []);
  const getNow = useCallback(() => Date.now() + clockOffset.current, []);

  const accept = useCallback((incoming: Snapshot) => {
    if (!mounted.current) return;
    const current = snapshotRef.current;
    if (current?.instanceId === incoming.instanceId && current.revision > incoming.revision) return;
    if (current && current.instanceId !== incoming.instanceId) {
      readyRef.current = false;
      setReady(false);
    }
    clockOffset.current = incoming.serverNow - Date.now();
    setNow(incoming.serverNow);
    if (notifiedCompletion.current === null || current?.instanceId !== incoming.instanceId) {
      notifiedCompletion.current = incoming.timer.completionId;
    } else if (incoming.timer.completionId > notifiedCompletion.current) {
      notifiedCompletion.current = incoming.timer.completionId;
      if (incoming.preferences.soundEnabled) audio.current?.chime();
    }
    snapshotRef.current = incoming;
    setSnapshot(incoming);
  }, []);

  const sendPending = useCallback(async (): Promise<boolean> => {
    const operation = pending.current;
    if (!operation || mutationInFlight.current) return false;
    mutationInFlight.current = true;
    if (mounted.current) setBusy(true);
    try {
      const response = await request(operation.path, operation.body);
      if (response.status === 409) {
        const result = await response.json() as { state: Snapshot };
        accept(result.state);
        pending.current = null;
        if (mounted.current) { setConflict(true); setConnection("online"); }
        return false;
      }
      if (!response.ok) throw new Error(`Persistence request failed (${response.status})`);
      const result = await response.json() as Snapshot;
      accept(result);
      pending.current = null;
      if (mounted.current) { setConflict(false); setConnection("online"); }
      return true;
    } catch {
      // Keep the same request ID: a disconnected response may already have committed.
      // Replaying it after reconnect cannot start, pause or import the session twice.
      if (mounted.current) setConnection("offline");
      return false;
    } finally {
      mutationInFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [accept]);

  const refresh = useCallback(async () => {
    if (refreshInFlight.current || mutationInFlight.current) return;
    refreshInFlight.current = true;
    try {
      if (pending.current) {
        if (!await sendPending()) return;
      }
      const response = await request("/api/state");
      if (!response.ok) throw new Error(`State request failed (${response.status})`);
      const current = await response.json() as Snapshot;
      // A GET that began before a command must not clear a later saving/offline state.
      // The pending request is reconciled by its own idempotent response or replay.
      if (pending.current || mutationInFlight.current) return;
      const previous = snapshotRef.current;
      if (previous && previous.instanceId !== current.instanceId) {
        readyRef.current = false;
        if (mounted.current) { setReady(false); setConflict(false); }
      }
      accept(current);
      const storage = browserStorage("localStorage");
      const migrationKey = `dyntick.migrated.v2.${current.instanceId}`;
      // Preserve the old keys as a backup. Only confirmed imports get a marker.
      if (!readyRef.current && readStorage(storage, migrationKey) !== "done") {
        const preferencesRaw = readStorage(storage, PREFERENCES_KEY);
        const timerRaw = readStorage(browserStorage("sessionStorage"), TIMER_KEY);
        const activityRaw = readStorage(storage, ACTIVITY_KEY);
        // Opening a new device must not revise an already initialized shared timer.
        const hasLegacyData = preferencesRaw !== null || timerRaw !== null || activityRaw !== null;
        if (!current.initialized || hasLegacyData) {
          const preferences = preferencesRaw ? parsePreferences(preferencesRaw) : current.preferences;
          pending.current = {
            path: "/api/import",
            body: {
              requestId: newClientId(),
              instanceId: current.instanceId,
              ...(preferencesRaw ? { preferences } : {}),
              ...(timerRaw ? { timer: parseTimer(timerRaw, preferences, current.serverNow) } : {}),
              ...(activityRaw ? { activity: parseActivity(activityRaw) } : {}),
            },
          };
          if (!await sendPending()) return;
        }
        try { storage?.setItem(migrationKey, "done"); } catch { /* Reimport is idempotent. */ }
      }
      if (mounted.current) {
        readyRef.current = true;
        setReady(true);
        setConnection("online");
      }
    } catch {
      if (mounted.current) setConnection("offline");
    } finally {
      refreshInFlight.current = false;
    }
  }, [accept, sendPending]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const interval = globalThis.setInterval(() => { void refresh(); }, 1000);
    const resume = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", resume);
    globalThis.addEventListener("focus", resume);
    globalThis.addEventListener("pageshow", resume);
    return () => {
      mounted.current = false;
      globalThis.clearInterval(interval);
      document.removeEventListener("visibilitychange", resume);
      globalThis.removeEventListener("focus", resume);
      globalThis.removeEventListener("pageshow", resume);
    };
  }, [refresh]);

  useEffect(() => {
    const interval = globalThis.setInterval(() => setNow(getNow()), 250);
    return () => globalThis.clearInterval(interval);
  }, [getNow]);

  useEffect(() => () => {
    audio.current?.dispose();
    audio.current = null;
  }, []);

  const perform = useCallback(async (action: Action): Promise<boolean> => {
    // Compare against the state shown to the user, never a newer unrendered poll.
    const current = snapshot;
    if (!readyRef.current || !current || mutationInFlight.current || pending.current || connection !== "online") return false;
    pending.current = {
      path: "/api/action",
      body: { requestId: newClientId(), instanceId: current.instanceId, revision: current.revision, action },
    };
    setConflict(false);
    return sendPending();
  }, [connection, sendPending, snapshot]);

  const preferences = snapshot?.preferences ?? defaults.current;
  const timer = snapshot?.timer ?? initialTimer.current;

  const savePreferences = useCallback(async (next: Preferences, sessionMonths?: Readonly<SessionMonths>) => {
    const current = snapshotRef.current;
    if (!current) return false;
    const patch = Object.fromEntries(Object.entries(next).filter(([key, value]) =>
      value !== preferences[key as keyof Preferences]
    )) as Partial<Preferences>;
    if (Object.keys(patch).length === 0 && !sessionMonths) return true;
    if (next.soundEnabled) void audioInstance().unlock();
    return perform({ type: "preferences", patch, sessionMonths });
  }, [audioInstance, perform, preferences]);

  const primaryAction = useCallback(async () => {
    if (preferences.soundEnabled) void audioInstance().unlock();
    return perform({ type: timer.status === "running" ? "pause" : "start" });
  }, [audioInstance, perform, preferences.soundEnabled, timer.status]);

  const reset = useCallback(() => perform({ type: "reset" }), [perform]);
  const changeMode = useCallback((mode: Mode) => perform({ type: "mode", mode }), [perform]);
  const changePlanning = useCallback((action: PlanningAction) => perform(action), [perform]);
  const previewSound = useCallback(async () => {
    const instance = audioInstance();
    const available = await instance.unlock();
    if (available) instance.chime();
    return available;
  }, [audioInstance]);

  return {
    preferences, timer, now, getNow,
    revision: snapshot?.revision ?? -1,
    instanceId: snapshot?.instanceId,
    activity: snapshot?.activity ?? initialActivity.current,
    exams: snapshot?.exams ?? NO_EXAMS,
    sessionMonths: snapshot?.sessionMonths ?? DEFAULT_SESSION_MONTHS,
    connection, busy, conflict, ready,
    controlsDisabled: !ready || connection !== "online" || busy || pending.current !== null,
    retry: refresh,
    activityPersisted: connection === "online" && !busy,
    storageAvailable: connection === "online" && !busy,
    savePreferences, primaryAction, reset, changeMode, changePlanning, previewSound,
  };
}
