import type { FocusCompletion } from "./timer.ts";
import { readStorage, type StorageLike } from "./storage.ts";

export const ACTIVITY_KEY = "dyntick.activity.v1";

export interface StudyActivity {
  version: 1;
  entries: Record<string, FocusCompletion>;
}

export interface ActivityDay {
  sessions: number;
  minutes: number;
}

export function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function emptyActivity(): StudyActivity {
  return { version: 1, entries: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validCompletion(id: string, value: unknown): value is FocusCompletion {
  return id.length > 0 && id.length <= 128 && isRecord(value) &&
    value.id === id &&
    Number.isSafeInteger(value.completedAt) && Number(value.completedAt) >= 0 &&
    Number(value.completedAt) <= 8_640_000_000_000_000 &&
    Number.isSafeInteger(value.minutes) && Number(value.minutes) >= 1 && Number(value.minutes) <= 180;
}

export function parseActivity(raw: string | null): StudyActivity {
  try {
    const value: unknown = raw ? JSON.parse(raw) : null;
    if (!isRecord(value) || value.version !== 1 || !isRecord(value.entries)) return emptyActivity();
    const entries: [string, FocusCompletion][] = [];
    for (const [id, completion] of Object.entries(value.entries)) {
      if (validCompletion(id, completion)) {
        entries.push([id, { id, completedAt: completion.completedAt, minutes: completion.minutes }]);
      }
    }
    return { version: 1, entries: Object.fromEntries(entries) };
  } catch {
    return emptyActivity();
  }
}

/** Merge browser tabs by the unique completion ID, keeping concurrent sessions. */
export function mergeActivity(left: StudyActivity, right: StudyActivity): StudyActivity {
  let entries: Record<string, FocusCompletion> | null = null;
  for (const [id, completion] of Object.entries(right.entries)) {
    const previous = Object.hasOwn(left.entries, id) ? left.entries[id] : undefined;
    // Conflicting copies of an ID converge deterministically instead of ping-ponging.
    if (previous && (previous.completedAt < completion.completedAt ||
      (previous.completedAt === completion.completedAt && previous.minutes <= completion.minutes))) continue;
    entries ??= { ...left.entries };
    Object.defineProperty(entries, id, { value: completion, enumerable: true, configurable: true, writable: true });
  }
  return entries ? { version: 1, entries } : left;
}

export function recordCompletion(
  activity: StudyActivity,
  completion: FocusCompletion,
): StudyActivity {
  return mergeActivity(activity, {
    version: 1,
    entries: { [completion.id]: completion },
  });
}

export function activityDays(activity: StudyActivity): Record<string, ActivityDay> {
  const days: Record<string, ActivityDay> = {};
  for (const completion of Object.values(activity.entries)) {
    const date = new Date(completion.completedAt);
    if (!Number.isFinite(date.getTime())) continue;
    const key = localDayKey(date);
    const day = days[key] ??= { sessions: 0, minutes: 0 };
    day.sessions += 1;
    day.minutes += completion.minutes;
  }
  return days;
}

export function calendarMonths(year: number) {
  return Array.from({ length: 12 }, (_, month) => {
    const first = new Date(year, month, 1, 12);
    const length = new Date(year, month + 1, 0, 12).getDate();
    const startRow = (first.getDay() + 6) % 7;
    const dates = Array.from({ length }, (_, index) => new Date(year, month, index + 1, 12));
    return { first, startRow, dates };
  });
}

export function monthlyFocus(days: Record<string, ActivityDay>, today: string, period?: { year: number; month: number }) {
  const [currentYear, currentMonth, dayOfMonth] = today.split("-").map(Number);
  const { year, month } = period ?? { year: currentYear, month: currentMonth };
  const first = new Date(year, month - 1, 1, 12);
  const daysInMonth = new Date(year, month, 0, 12).getDate();
  const monthKey = localDayKey(first).slice(0, -3);
  const currentMonthKey = today.slice(0, -3);
  const elapsed = monthKey < currentMonthKey ? daysInMonth : monthKey === currentMonthKey ? dayOfMonth : 0;
  const minutes = Array.from({ length: elapsed }, (_, index) =>
    days[`${monthKey}-${String(index + 1).padStart(2, "0")}`]?.minutes ?? 0);
  let windowTotal = 0;
  const averages = minutes.map((value, index) => {
    windowTotal += value - (minutes[index - 7] ?? 0);
    return windowTotal / Math.min(index + 1, 7);
  });
  const record = Object.entries(days).reduce((highest, [date, entry]) => {
    const hasElapsed = date.length < today.length || (date.length === today.length && date <= today);
    return hasElapsed ? Math.max(highest, entry.minutes) : highest;
  }, 0);
  return { first, monthKey, daysInMonth, minutes, averages, record };
}

export function sameActivity(left: StudyActivity, right: StudyActivity): boolean {
  const leftIds = Object.keys(left.entries);
  const rightIds = Object.keys(right.entries);
  return leftIds.length === rightIds.length && leftIds.every((id) => {
    const a = left.entries[id];
    const b = Object.hasOwn(right.entries, id) ? right.entries[id] : undefined;
    return b !== undefined && a.completedAt === b.completedAt && a.minutes === b.minutes;
  });
}

/** Canonical ordering avoids storage events caused only by different merge order. */
export function serializeActivity(activity: StudyActivity): string {
  const entries = Object.fromEntries(Object.keys(activity.entries).sort().map((id) => {
    const completion = activity.entries[id];
    return [id, { id, completedAt: completion.completedAt, minutes: completion.minutes }];
  }));
  return JSON.stringify({ version: 1, entries });
}

/** Read before writing so a tab never knowingly overwrites another tab's sessions. */
export function persistActivity(
  activity: StudyActivity,
  storage: StorageLike | null,
): { activity: StudyActivity; persisted: boolean } {
  const raw = readStorage(storage, ACTIVITY_KEY);
  const merged = mergeActivity(activity, parseActivity(raw));
  const serialized = serializeActivity(merged);
  if (raw === serialized) return { activity: merged, persisted: true };
  try {
    if (!storage) return { activity: merged, persisted: false };
    storage.setItem(ACTIVITY_KEY, serialized);
    return { activity: merged, persisted: true };
  } catch {
    return { activity: merged, persisted: false };
  }
}
