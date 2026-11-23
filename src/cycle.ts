import { type Mode, type Preferences, type TimerState } from "./timer.ts";

export interface CyclePhase {
  id: string;
  mode: Mode;
  session: number;
  minutes: number;
  current: boolean;
  done: boolean;
}

/** Project the configured cycle without changing the timer or claiming skipped work. */
export function cyclePhases(preferences: Preferences, timer: TimerState): CyclePhase[] {
  const total = preferences.longBreakInterval;
  let current = -1;
  if (timer.mode === "focus") {
    const slot = Math.max(0, Math.min(total - 1, timer.completedFocuses - (timer.status === "completed" ? 1 : 0)));
    current = slot * 2;
  } else if (timer.mode === "shortBreak" && timer.completedFocuses > 0 && timer.completedFocuses < total) {
    current = (timer.completedFocuses - 1) * 2 + 1;
  } else if (timer.mode === "longBreak" && timer.completedFocuses >= total) {
    current = total * 2 - 1;
  }
  const phases: CyclePhase[] = [];
  for (let index = 0; index < total; index++) {
    for (const mode of ["focus", index === total - 1 ? "longBreak" : "shortBreak"] as const) {
      const active = phases.length === current;
      phases.push({
        id: `${mode}-${index + 1}`, mode, session: index + 1,
        minutes: active ? Math.round(timer.durationMs / 60_000) : mode === "focus"
          ? preferences.focusMinutes : mode === "shortBreak" ? preferences.shortBreakMinutes : preferences.longBreakMinutes,
        current: active,
        done: mode === "focus" ? index < timer.completedFocuses :
          (active && timer.status === "completed") ||
          (timer.completedBreaks?.some((entry) => entry.mode === mode && entry.afterFocus === index + 1) ?? false),
      });
    }
  }
  return phases;
}

/** Fit a true oval to the card while keeping targets and the center label apart. */
export function cycleLayout(availableWidth: number, sessions: number) {
  const width = Math.max(1, Math.floor(availableWidth));
  const inset = 28;
  const count = sessions * 2;
  const rx = (width - inset * 2) / 2;
  for (let height = 232; height <= 800; height += 4) {
    const ry = (height - inset * 2) / 2;
    let length = 0;
    const samples = Array.from({ length: 361 }, (_, index) => {
      const angle = -Math.PI * .75 + index * Math.PI * 2 / 360;
      return { x: width / 2 + rx * Math.cos(angle), y: height / 2 + ry * Math.sin(angle), angle, length: 0 };
    });
    for (let index = 1; index < samples.length; index++) {
      length += Math.hypot(samples[index].x - samples[index - 1].x, samples[index].y - samples[index - 1].y);
      samples[index].length = length;
    }
    const pointAt = (fraction: number) => {
      const distance = ((fraction % 1 + 1) % 1) * length;
      let index = 1;
      while (samples[index].length < distance) index++;
      const before = samples[index - 1], after = samples[index];
      const mix = (distance - before.length) / (after.length - before.length);
      const angle = before.angle + (after.angle - before.angle) * mix;
      return {
        x: before.x + (after.x - before.x) * mix,
        y: before.y + (after.y - before.y) * mix,
        angle: Math.atan2(ry * Math.cos(angle), -rx * Math.sin(angle)) * 180 / Math.PI,
      };
    };
    const captionWidth = Math.min(110, width - 112);
    const caption = { left: width / 2 - captionWidth / 2, right: width / 2 + captionWidth / 2, top: height / 2 - 40, bottom: height / 2 + 40 };
    const apart = (a: typeof caption, b: typeof caption) => a.right + 3 <= b.left || b.right + 3 <= a.left || a.bottom + 3 <= b.top || b.bottom + 3 <= a.top;
    for (let shift = 0; shift < 24; shift++) {
      const offset = shift / (count * 24);
      const points = Array.from({ length: count }, (_, index) => pointAt(index / count + offset));
      const targets = points.map((point, index) => ({
        left: point.x - (index === count - 1 ? 26 : 22), right: point.x + (index === count - 1 ? 26 : 22),
        top: point.y - 22, bottom: point.y + 22,
      }));
      if (targets.every((target, index) => apart(target, caption) && targets.slice(index + 1).every(other => apart(target, other)))) {
        const arrows = points.map((_, index) => pointAt((index + .5) / count + offset));
        return { width, height, inset, rx, ry, points, arrows };
      }
    }
  }
  throw new RangeError("The cycle card is too narrow for accessible targets");
}
