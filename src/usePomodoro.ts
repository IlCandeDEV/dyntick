import { useCallback, useEffect, useRef, useState } from "react";
import { TimerAudio } from "./audio.ts";
import {
  ACTIVITY_KEY,
  mergeActivity,
  parseActivity,
  persistActivity,
  recordCompletion,
  type StudyActivity,
} from "./activity.ts";
import {
  browserStorage,
  parsePreferences,
  parseTimer,
  PREFERENCES_KEY,
  readStorage,
  TIMER_KEY,
  writeStorage,
} from "./storage.ts";
import {
  type Mode,
  pauseTimer,
  type Preferences,
  resetTimer,
  selectMode,
  settleTimer,
  startTimer,
  updateDurations,
} from "./timer.ts";

export function usePomodoro() {
  const [preferences, setPreferences] = useState(() =>
    parsePreferences(readStorage(browserStorage("localStorage"), PREFERENCES_KEY))
  );
  const [timer, setTimer] = useState(() =>
    parseTimer(
      readStorage(browserStorage("sessionStorage"), TIMER_KEY),
      preferences,
      Date.now(),
    )
  );
  const [now, setNow] = useState(Date.now);
  const [activity, setActivity] = useState(() =>
    parseActivity(readStorage(browserStorage("localStorage"), ACTIVITY_KEY))
  );
  const activityRef = useRef(activity);
  const [activityPersisted, setActivityPersisted] = useState(true);
  const [preferencesPersisted, setPreferencesPersisted] = useState(true);
  const [sessionPersisted, setSessionPersisted] = useState(true);
  const audio = useRef<TimerAudio | null>(null);
  const notifiedCompletion = useRef(timer.completionId);

  const audioInstance = useCallback(() => audio.current ??= new TimerAudio(), []);

  const syncActivity = useCallback((incoming?: StudyActivity) => {
    const current = incoming ? mergeActivity(activityRef.current, incoming) : activityRef.current;
    const result = persistActivity(current, browserStorage("localStorage"));
    activityRef.current = result.activity;
    setActivity(result.activity);
    setActivityPersisted(result.persisted);
  }, []);

  useEffect(() => {
    // Keep this completion in timer/session storage until history is durable, including
    // refresh recovery and immediate reset/mode changes after the timer has expired.
    syncActivity(timer.lastFocusCompletion
      ? recordCompletion(activityRef.current, timer.lastFocusCompletion)
      : undefined);
  }, [timer.lastFocusCompletion, syncActivity]);

  useEffect(() => {
    const saved = writeStorage(browserStorage("localStorage"), PREFERENCES_KEY, preferences);
    setPreferencesPersisted(saved);
  }, [preferences]);

  useEffect(() => {
    setSessionPersisted(writeStorage(browserStorage("sessionStorage"), TIMER_KEY, timer));
  }, [timer]);

  useEffect(() => {
    const refresh = () => {
      const timestamp = Date.now();
      setNow(timestamp);
      setTimer((state) => settleTimer(state, timestamp));
    };
    refresh();
    // The idle clock also rolls the activity calendar over at local midnight.
    const interval = globalThis.setInterval(refresh, timer.status === "running" ? 250 : 60_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        refresh();
        syncActivity();
      }
    };
    const onResume = () => { refresh(); syncActivity(); };
    document.addEventListener("visibilitychange", onVisible);
    globalThis.addEventListener("pageshow", onResume);
    globalThis.addEventListener("focus", onResume);
    return () => {
      globalThis.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      globalThis.removeEventListener("pageshow", onResume);
      globalThis.removeEventListener("focus", onResume);
    };
  }, [timer.status, timer.endAt, syncActivity]);

  useEffect(() => {
    if (timer.completionId <= notifiedCompletion.current) return;
    notifiedCompletion.current = timer.completionId;
    if (preferences.soundEnabled) audio.current?.chime();
  }, [timer.completionId, preferences.soundEnabled]);

  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.storageArea !== browserStorage("localStorage")) return;
      if (event.key === ACTIVITY_KEY) {
        // The event can contain a concurrent write that has already been overwritten.
        // Merge its payload as well as the latest stored map before persisting a union.
        syncActivity(parseActivity(event.newValue));
        return;
      }
      if (event.key !== PREFERENCES_KEY) return;
      const next = parsePreferences(event.newValue);
      setPreferences(next);
      setTimer((state) => updateDurations(state, next));
    };
    globalThis.addEventListener("storage", sync);
    return () => globalThis.removeEventListener("storage", sync);
  }, [syncActivity]);

  useEffect(() => () => {
    audio.current?.dispose();
    audio.current = null;
  }, []);

  const savePreferences = useCallback((next: Preferences) => {
    setPreferences(next);
    setTimer((state) => updateDurations(state, next));
    if (next.soundEnabled) void audioInstance().unlock();
  }, [audioInstance]);

  const primaryAction = useCallback(() => {
    const timestamp = Date.now();
    setNow(timestamp);
    if (preferences.soundEnabled) void audioInstance().unlock();
    setTimer((state) => state.status === "running"
      ? pauseTimer(state, timestamp)
      : startTimer(state, preferences, timestamp)
    );
  }, [preferences, audioInstance]);

  const reset = useCallback(() => {
    const timestamp = Date.now();
    setNow(timestamp);
    setTimer((state) => resetTimer(settleTimer(state, timestamp), preferences));
  }, [preferences]);

  const changeMode = useCallback((mode: Mode) => {
    const timestamp = Date.now();
    setNow(timestamp);
    setTimer((state) => selectMode(settleTimer(state, timestamp), mode, preferences));
  }, [preferences]);

  const previewSound = useCallback(async () => {
    const instance = audioInstance();
    const available = await instance.unlock();
    if (available) instance.chime();
    return available;
  }, [audioInstance]);

  return {
    preferences,
    timer,
    now,
    activity,
    activityPersisted,
    storageAvailable: preferencesPersisted && sessionPersisted && activityPersisted,
    savePreferences,
    primaryAction,
    reset,
    changeMode,
    previewSound,
  };
}
