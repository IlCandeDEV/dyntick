import type { CreditSystem, DateFormat } from "./planning.ts";

export type Mode = "focus" | "shortBreak" | "longBreak";
export type TimerStatus = "idle" | "running" | "paused" | "completed";
export type ThemeMode = "system" | "light" | "dark";
export const LANGUAGES = ["en", "it", "de", "es"] as const;
export const MAX_CYCLE_SESSIONS = 6;
export type Language = typeof LANGUAGES[number];

export function isLanguage(value: unknown): value is Language {
  return LANGUAGES.some((language) => language === value);
}

export interface FocusCompletion {
  id: string;
  completedAt: number;
  minutes: number;
}

export interface CompletedBreak {
  mode: Exclude<Mode, "focus">;
  afterFocus: number;
}

export interface Preferences {
  focusMinutes: number;
  shortBreakMinutes: number;
  longBreakMinutes: number;
  longBreakInterval: number;
  soundEnabled: boolean;
  theme: ThemeMode;
  language: Language;
  creditSystem: CreditSystem;
  dateFormat: DateFormat;
}

export interface TimerState {
  version: 1;
  mode: Mode;
  status: TimerStatus;
  durationMs: number;
  remainingMs: number;
  endAt: number | null;
  completedFocuses: number;
  completedBreaks?: readonly CompletedBreak[];
  completionId: number;
  focusSessionId: string | null;
  lastFocusCompletion: FocusCompletion | null;
}

export const DEFAULT_PREFERENCES: Readonly<Preferences> = Object.freeze({
  focusMinutes: 25,
  shortBreakMinutes: 5,
  longBreakMinutes: 15,
  longBreakInterval: 4,
  soundEnabled: true,
  theme: "system",
  language: "en",
  creditSystem: "CFU",
  dateFormat: "dmy",
});

export const MODES: readonly Mode[] = ["focus", "shortBreak", "longBreak"];

export function durationFor(mode: Mode, preferences: Preferences): number {
  const minutes = mode === "focus"
    ? preferences.focusMinutes
    : mode === "shortBreak"
    ? preferences.shortBreakMinutes
    : preferences.longBreakMinutes;
  return minutes * 60_000;
}

export function createTimer(
  preferences: Preferences,
  mode: Mode = "focus",
  completedFocuses = 0,
  completionId = 0,
  lastFocusCompletion: FocusCompletion | null = null,
  completedBreaks: readonly CompletedBreak[] = [],
): TimerState {
  const durationMs = durationFor(mode, preferences);
  return {
    version: 1,
    mode,
    status: "idle",
    durationMs,
    remainingMs: durationMs,
    endAt: null,
    completedFocuses,
    completedBreaks,
    completionId,
    focusSessionId: null,
    lastFocusCompletion,
  };
}

export function remainingAt(state: TimerState, now: number): number {
  return state.status === "running" && state.endAt !== null
    ? Math.max(0, Math.min(state.durationMs, state.endAt - now))
    : state.remainingMs;
}

function recordBreak(state: TimerState): readonly CompletedBreak[] {
  const completed = state.completedBreaks ?? [];
  const { mode, completedFocuses: afterFocus } = state;
  if (mode === "focus" || afterFocus < 1 || afterFocus > MAX_CYCLE_SESSIONS ||
    completed.some((entry) => entry.mode === mode && entry.afterFocus === afterFocus)) return completed;
  return [...completed, { mode, afterFocus }];
}

function breakProgress(state: TimerState): readonly CompletedBreak[] {
  // Older timers can still tell us whether the currently displayed break finished.
  return state.completedBreaks ?? (state.status === "completed" ? recordBreak(state) : []);
}

/** Finish the current phase once. Never credit or start unattended future phases. */
export function settleTimer(state: TimerState, now: number): TimerState {
  if (state.status !== "running" || state.endAt === null || now < state.endAt) return state;
  const lastFocusCompletion = state.mode === "focus"
    ? {
      // The persisted run ID makes recovery and React updater replays idempotent.
      // Older running sessions have a deterministic migration ID instead.
      id: state.focusSessionId ?? `legacy-${state.endAt.toString(36)}-${state.durationMs.toString(36)}-${state.completionId.toString(36)}`,
      completedAt: state.endAt,
      minutes: Math.round(state.durationMs / 60_000),
    }
    : state.lastFocusCompletion;
  return {
    ...state,
    status: "completed",
    remainingMs: 0,
    endAt: null,
    completedFocuses: state.completedFocuses + (state.mode === "focus" ? 1 : 0),
    completedBreaks: recordBreak(state),
    completionId: state.completionId + 1,
    lastFocusCompletion,
  };
}

function createCompletionId(): string {
  try {
    if (typeof globalThis.crypto?.randomUUID === "function") {
      return globalThis.crypto.randomUUID();
    }
  } catch { /* Fall back to a local, non-security identifier in restricted contexts. */ }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function nextMode(state: TimerState, preferences: Preferences): Mode {
  if (state.mode !== "focus") return "focus";
  return state.completedFocuses >= preferences.longBreakInterval
    ? "longBreak"
    : "shortBreak";
}

export function startTimer(
  current: TimerState,
  preferences: Preferences,
  now: number,
): TimerState {
  // A delayed click on a running timer may finish it, but must not also start a break.
  if (current.status === "running") return settleTimer(current, now);
  let state = current;
  if (state.status === "completed") {
    const mode = nextMode(state, preferences);
    const newCycle = mode === "focus" && state.completedFocuses >= preferences.longBreakInterval;
    state = createTimer(preferences, mode, newCycle ? 0 : state.completedFocuses, state.completionId,
      state.lastFocusCompletion, newCycle ? [] : breakProgress(state));
  }
  return {
    ...state,
    status: "running",
    endAt: now + state.remainingMs,
    focusSessionId: state.mode === "focus" ? state.focusSessionId ?? createCompletionId() : null,
  };
}

export function pauseTimer(current: TimerState, now: number): TimerState {
  const state = settleTimer(current, now);
  if (state.status !== "running") return state;
  return { ...state, status: "paused", remainingMs: remainingAt(state, now), endAt: null };
}

export function resetTimer(state: TimerState, preferences: Preferences): TimerState {
  // Resetting a finished focus phase lets the user repeat that same session.
  const count = state.mode === "focus" && state.status === "completed"
    ? Math.max(0, state.completedFocuses - 1)
    : state.completedFocuses;
  const breaks = breakProgress(state).filter(({ afterFocus }) => afterFocus <= count);
  return createTimer(preferences, state.mode, count, state.completionId, state.lastFocusCompletion, breaks);
}

export function selectMode(
  state: TimerState,
  mode: Mode,
  preferences: Preferences,
): TimerState {
  if (state.status === "running" || state.mode === mode) return state;
  const newCycle = mode === "focus" && state.completedFocuses >= preferences.longBreakInterval;
  return createTimer(preferences, mode, newCycle ? 0 : state.completedFocuses, state.completionId,
    state.lastFocusCompletion, newCycle ? [] : breakProgress(state));
}

export function updateDurations(state: TimerState, preferences: Preferences): TimerState {
  // Shortening a cycle keeps the current focus in its last available slot.
  const pendingFocus = state.mode === "focus" && state.status !== "completed";
  const count = Math.min(state.completedFocuses, preferences.longBreakInterval - (pendingFocus ? 1 : 0));
  const current = count === state.completedFocuses ? state : {
    ...state,
    completedFocuses: count,
    completedBreaks: breakProgress(state).filter(({ afterFocus }) => afterFocus <= count),
  };
  // Never change a phase already in progress, including a paused phase.
  return current.status === "idle"
    ? createTimer(preferences, current.mode, current.completedFocuses, current.completionId, current.lastFocusCompletion, breakProgress(current))
    : current;
}

export function sessionNumber(state: TimerState, preferences: Preferences): number {
  const completedCurrent = state.mode !== "focus" || state.status === "completed";
  const index = Math.max(0, state.completedFocuses - (completedCurrent ? 1 : 0));
  return (index % preferences.longBreakInterval) + 1;
}

export function formatTime(milliseconds: number): string {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}
