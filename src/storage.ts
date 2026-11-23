import { isCreditSystem, isDateFormat } from "./planning.ts";
import {
  createTimer,
  DEFAULT_PREFERENCES,
  isLanguage,
  MAX_CYCLE_SESSIONS,
  MODES,
  settleTimer,
  type CompletedBreak,
  type FocusCompletion,
  type Preferences,
  type TimerState,
} from "./timer.ts";

export const PREFERENCES_KEY = "dyntick.preferences.v1";
export const TIMER_KEY = "dyntick.timer.v1";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function integer(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) &&
    value >= minimum && value <= maximum;
}

export function parsePreferences(raw: string | null): Preferences {
  const defaults = { ...DEFAULT_PREFERENCES };
  try {
    const value: unknown = raw ? JSON.parse(raw) : null;
    if (!record(value)) return defaults;
    for (const key of ["focusMinutes", "shortBreakMinutes", "longBreakMinutes"] as const) {
      if (integer(value[key], 1, 180)) defaults[key] = value[key];
    }
    // Older saved cycles may exceed the current limit; keep their other preferences.
    if (integer(value.longBreakInterval, 1, Number.MAX_SAFE_INTEGER)) {
      defaults.longBreakInterval = Math.min(value.longBreakInterval, MAX_CYCLE_SESSIONS);
    }
    if (typeof value.soundEnabled === "boolean") defaults.soundEnabled = value.soundEnabled;
    if (value.theme === "system" || value.theme === "light" || value.theme === "dark") {
      defaults.theme = value.theme;
    }
    if (isLanguage(value.language)) defaults.language = value.language;
    if (isCreditSystem(value.creditSystem)) defaults.creditSystem = value.creditSystem;
    if (isDateFormat(value.dateFormat)) defaults.dateFormat = value.dateFormat;
  } catch { /* A damaged or older preference file must not prevent opening the app. */ }
  return defaults;
}

export function parseTimer(raw: string | null, preferences: Preferences, now: number): TimerState {
  const fallback = () => createTimer(preferences);
  try {
    const value: unknown = raw ? JSON.parse(raw) : null;
    if (!record(value) || value.version !== 1 || !MODES.includes(value.mode as TimerState["mode"]) ||
      !["idle", "running", "paused", "completed"].includes(String(value.status)) ||
      !integer(value.durationMs, 60_000, 180 * 60_000) ||
      typeof value.remainingMs !== "number" || !Number.isFinite(value.remainingMs) ||
      value.remainingMs < 0 || value.remainingMs > value.durationMs ||
      !integer(value.completedFocuses, 0, 1_000_000) ||
      !integer(value.completionId, 0, Number.MAX_SAFE_INTEGER)) return fallback();

    if (value.status === "running") {
      if (typeof value.endAt !== "number" || !Number.isFinite(value.endAt) ||
        value.endAt < 0 || value.endAt > now + value.durationMs) return fallback();
    } else if (value.endAt !== null) return fallback();
    if (value.status === "completed" && value.remainingMs !== 0) return fallback();
    if (value.status !== "completed" && value.remainingMs === 0) return fallback();
    const completionValue = value.lastFocusCompletion;
    const lastFocusCompletion = record(completionValue) &&
        typeof completionValue.id === "string" && completionValue.id.length > 0 &&
        completionValue.id.length <= 128 &&
        integer(completionValue.completedAt, 0, 8_640_000_000_000_000) &&
        integer(completionValue.minutes, 1, 180)
      ? completionValue as unknown as FocusCompletion
      : null;
    const focusSessionId = typeof value.focusSessionId === "string" &&
        value.focusSessionId.length > 0 && value.focusSessionId.length <= 128
      ? value.focusSessionId
      : null;
    const maxBreakPosition = Math.min(value.completedFocuses, MAX_CYCLE_SESSIONS);
    const completedBreaks = Array.isArray(value.completedBreaks) ? value.completedBreaks.flatMap<CompletedBreak>((entry: unknown) => {
      if (!record(entry) || (entry.mode !== "shortBreak" && entry.mode !== "longBreak") ||
        !integer(entry.afterFocus, 1, maxBreakPosition)) return [];
      return [{ mode: entry.mode, afterFocus: entry.afterFocus }];
    }).slice(0, MAX_CYCLE_SESSIONS * 2) : undefined;
    return settleTimer({
      version: 1,
      mode: value.mode as TimerState["mode"],
      status: value.status as TimerState["status"],
      durationMs: value.durationMs,
      remainingMs: value.remainingMs,
      endAt: value.endAt as number | null,
      completedFocuses: value.completedFocuses,
      ...(completedBreaks && { completedBreaks }),
      completionId: value.completionId,
      focusSessionId,
      lastFocusCompletion,
    }, now);
  } catch {
    return fallback();
  }
}

export function readStorage(storage: StorageLike | null, key: string): string | null {
  try { return storage?.getItem(key) ?? null; } catch { return null; }
}

export function writeStorage(storage: StorageLike | null, key: string, value: unknown): boolean {
  try {
    if (!storage) return false;
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch { return false; }
}

export function browserStorage(kind: "localStorage" | "sessionStorage"): StorageLike | null {
  try { return globalThis[kind] ?? null; } catch { return null; }
}
