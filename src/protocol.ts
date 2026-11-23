import type { StudyActivity } from "./activity.ts";
import type { Exam, PlanningAction, SessionMonths } from "./planning.ts";
import type { Mode, Preferences, TimerState } from "./timer.ts";

/** The single user's durable state, shared by every device using this installation. */
export interface Snapshot {
  schemaVersion: 2;
  instanceId: string;
  revision: number;
  serverNow: number;
  initialized: boolean;
  preferences: Preferences;
  timer: TimerState;
  activity: StudyActivity;
  exams: Exam[];
  sessionMonths: SessionMonths;
}

export type Action =
  | { type: "start" | "pause" | "reset" }
  | { type: "mode"; mode: Mode }
  | { type: "preferences"; patch: Partial<Preferences>; sessionMonths?: Readonly<SessionMonths> }
  | PlanningAction;

export function newClientId(): string {
  // randomUUID is unavailable over plain HTTP on a LAN address.
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export interface ActionRequest {
  requestId: string;
  instanceId: string;
  revision: number;
  action: Action;
}

export interface ImportRequest {
  requestId: string;
  instanceId: string;
  preferences?: Preferences;
  timer?: TimerState;
  activity?: StudyActivity;
}
