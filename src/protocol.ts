import type { StudyActivity } from "./activity.ts";
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
}

export type Action =
  | { type: "start" | "pause" | "reset" }
  | { type: "mode"; mode: Mode }
  | { type: "preferences"; patch: Partial<Preferences> };

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
