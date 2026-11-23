import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./Icons.tsx";
import { cyclePhases, cycleLayout } from "./cycle.ts";
import type { Messages } from "./i18n.ts";
import type { Preferences, TimerState } from "./timer.ts";

export function CycleMap({ preferences, timer, copy }: { preferences: Preferences; timer: TimerState; copy: Messages }) {
  const viewport = useRef<HTMLDivElement>(null);
  const [availableWidth, setAvailableWidth] = useState(280);
  const [inspection, setInspection] = useState<string | null>(null);
  const phases = cyclePhases(preferences, timer);
  const current = phases.find((phase) => phase.current);
  const selected = phases.find((phase) => phase.id === inspection) ?? current;
  const layout = useMemo(() => cycleLayout(availableWidth, preferences.longBreakInterval), [availableWidth, preferences.longBreakInterval]);
  const completed = Math.min(timer.completedFocuses, preferences.longBreakInterval);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () => { if (element.clientWidth > 0) setAvailableWidth(element.clientWidth); };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => setInspection(null), [current?.id, preferences.longBreakInterval]);

  return (
    <section className="cycle-panel secondary-card" aria-labelledby="cycle-heading">
      <div className="section-heading"><h2 id="cycle-heading">{copy.cycleHeading}</h2><span>{completed}/{preferences.longBreakInterval}</span></div>
      <div className="cycle-map-viewport" ref={viewport} data-testid="cycle-map">
        <div className="cycle-map-canvas" style={{ height: layout.height }}>
          <svg className="cycle-map-track" width="100%" height={layout.height}
            viewBox={`0 0 ${layout.width} ${layout.height}`} aria-hidden="true">
            <ellipse cx={layout.width / 2} cy={layout.height / 2} rx={layout.rx} ry={layout.ry} />
            {layout.arrows.map((point, index) => <path key={index} d="m-3-3 3 3-3 3"
              transform={`translate(${point.x} ${point.y}) rotate(${point.angle})`} />)}
          </svg>
          <ol className="cycle-map-nodes" aria-label={copy.cycleSessions}>
            {phases.map((phase, index) => {
              const point = layout.points[index];
              const state = phase.current ? timer.status === "completed" ? copy.completed : copy.current : phase.done ? copy.done : copy.cyclePreview;
              const label = `${phase.mode === "focus" ? copy.sessionName(phase.session) : copy.modeLabels[phase.mode]} · ${phase.minutes} min · ${state}`;
              return <li key={phase.id}>
                <button type="button" className="cycle-node" data-mode={phase.mode}
                  data-done={phase.done} data-testid={`cycle-node-${phase.id}`}
                  aria-label={label} aria-current={phase.current ? "step" : undefined}
                  aria-pressed={selected?.id === phase.id} tabIndex={selected?.id === phase.id || (!selected && index === 0) ? 0 : -1}
                  style={{ left: point.x, top: point.y }} onClick={() => setInspection(phase.id)}
                  onKeyDown={(event) => {
                    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
                    const delta = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
                    const target = event.key === "Home" ? 0 : event.key === "End" ? phases.length - 1
                      : delta === undefined ? null : (index + delta + phases.length) % phases.length;
                    if (target === null) return;
                    event.preventDefault();
                    setInspection(phases[target].id);
                    event.currentTarget.closest("ol")?.querySelectorAll<HTMLButtonElement>("button")[target]?.focus({ preventScroll: true });
                  }}>
                  <span className="cycle-node-face">{phase.done ? <Icon name="check" width="16" height="16" />
                    : phase.mode === "focus" ? phase.session
                    : <Icon name={phase.mode === "longBreak" ? "cup" : "pause"}
                      width={phase.mode === "longBreak" ? 20 : 16} height={phase.mode === "longBreak" ? 20 : 16} />}</span>
                </button>
              </li>;
            })}
          </ol>
        </div>
        <div className="cycle-map-details" aria-live="polite" aria-atomic="true" data-testid="cycle-detail">
          <div className="cycle-map-detail-content" key={selected?.id ?? timer.mode}>
            <span>{selected ? selected.current ? timer.status === "completed" ? copy.completed : copy.current : copy.cyclePreview : copy.cycleManual}</span>
            <strong>{selected ? selected.mode === "focus" ? copy.sessionName(selected.session) : copy.modeLabels[selected.mode] : copy.modeLabels[timer.mode]}</strong>
            <span className="cycle-detail-duration">{selected?.minutes ?? Math.round(timer.durationMs / 60_000)}<small> min</small></span>
          </div>
        </div>
      </div>
      <p className="study-card-note"><Icon name="info" width="16" height="16" /><span>{copy.cycleRepeats}</span></p>
    </section>
  );
}
