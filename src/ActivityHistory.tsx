import { useEffect, useMemo, useRef, useState } from "react";
import { activityDays, type ActivityDay, type StudyActivity } from "./activity.ts";
import type { Messages } from "./i18n.ts";
import { Icon } from "./Icons.tsx";

export function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function weekFocusMinutes(days: Record<string, ActivityDay>, now: Date): number {
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  monday.setDate(monday.getDate() - (monday.getDay() + 6) % 7);
  let total = 0;
  for (let index = 0; index < 7; index++) {
    total += days[localDayKey(monday)]?.minutes ?? 0;
    monday.setDate(monday.getDate() + 1);
  }
  return total;
}

function calendarWeeks(year: number): (Date | null)[][] {
  const first = new Date(year, 0, 1, 12);
  const padding = (first.getDay() + 6) % 7;
  const cells: (Date | null)[] = Array.from({ length: padding }, () => null);
  for (const date = new Date(first); date.getFullYear() === year; date.setDate(date.getDate() + 1)) {
    cells.push(new Date(date));
  }
  while (cells.length % 7) cells.push(null);
  return Array.from({ length: cells.length / 7 }, (_, week) => cells.slice(week * 7, week * 7 + 7));
}

export function ActivityHistory({ activity, now, copy }: {
  activity: StudyActivity;
  now: number;
  copy: Messages;
}) {
  const today = localDayKey(new Date(now));
  const currentYear = new Date(now).getFullYear();
  const [year, setYear] = useState(currentYear);
  const [selected, setSelected] = useState(today);
  const previousToday = useRef(today);
  const calendar = useRef<HTMLDivElement>(null);
  const days = useMemo(() => activityDays(activity), [activity]);
  const weeks = useMemo(() => calendarWeeks(year), [year]);
  const years = useMemo(() => Array.from(new Set([
    currentYear,
    year,
    ...Object.keys(days).map((day) => Number(day.slice(0, 4))),
  ])).filter((value) => value <= currentYear).sort((a, b) => b - a), [days, currentYear, year]);
  const yearDays = Object.entries(days).filter(([key]) => key.startsWith(`${year}-`));
  const sessions = yearDays.reduce((count, [, day]) => count + day.sessions, 0);
  const selectedDate = new Date(`${selected}T12:00:00`);
  const day = days[selected] ?? { sessions: 0, minutes: 0 };
  const records = Object.values(activity.entries).filter((entry) => localDayKey(new Date(entry.completedAt)) === selected)
    .sort((a, b) => a.completedAt - b.completedAt);
  const dateFormat = new Intl.DateTimeFormat(copy.locale, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const monthFormat = new Intl.DateTimeFormat(copy.locale, { month: "short" });
  const timeFormat = new Intl.DateTimeFormat(copy.locale, { hour: "2-digit", minute: "2-digit" });

  useEffect(() => {
    // Follow midnight (including New Year) when viewing today; preserve an explicit
    // historical selection, together with its year, while the calendar remains open.
    if (previousToday.current === today) return;
    if (selected === previousToday.current) {
      setSelected(today);
      setYear(currentYear);
    }
    previousToday.current = today;
  }, [today, currentYear, selected]);

  useEffect(() => {
    // Keep the current month in view on small screens without moving the document.
    const viewport = calendar.current;
    if (!viewport) return;
    const scrollToToday = () => {
      const current = viewport.querySelector<HTMLElement>(`[data-day="${today}"]`);
      viewport.scrollLeft = current ? Math.max(0, current.offsetLeft - viewport.clientWidth + 70) : 0;
    };
    scrollToToday();
    const resize = new ResizeObserver(scrollToToday);
    resize.observe(viewport);
    return () => resize.disconnect();
  }, [year, today]);

  const chooseYear = (next: number) => {
    setYear(next);
    setSelected(next === currentYear ? today : `${next}-01-01`);
  };

  return (
    <section id="study-activity" className="activity-panel" aria-labelledby="activity-heading">
      <header className="activity-heading">
        <div><h2 id="activity-heading">{copy.activityTitle}</h2><p>{copy.activitySubtitle}</p></div>
        <label className="year-picker"><Icon name="activity" width="16" height="16" />
          <select aria-label={copy.activityYear} value={year} onChange={(event) => chooseYear(Number(event.target.value))}>
            {years.map((value) => <option value={value} key={value}>{value}</option>)}
          </select>
        </label>
      </header>
      <div className="activity-overview"><strong>{copy.activitySummary(sessions)}</strong><span>{year}</span></div>
      <p className="sr-only" id="activity-navigation">{copy.activityNavigation}</p>
      <div className="calendar-layout">
        <div className="weekday-labels" aria-hidden="true">{copy.activityWeekdays.map((label, index) => <span key={index}>{label}</span>)}</div>
        <div ref={calendar} className="calendar-scroll" data-testid="activity-calendar" role="group" aria-label={copy.activityTitle} aria-describedby="activity-navigation">
          <div className="calendar-weeks">
            {weeks.map((week, index) => {
              const monthStart = week.find((date) => date?.getDate() === 1);
              return <div className="calendar-week" key={index}>
                <span className="calendar-month" aria-hidden="true">{monthStart ? monthFormat.format(monthStart) : ""}</span>
                {week.map((date, row) => {
                  const key = date ? localDayKey(date) : "";
                  if (!date || key > today) return <span className={`activity-cell ${date ? "future" : "padding"}`} key={row} aria-hidden="true" />;
                  const data = days[key] ?? { sessions: 0, minutes: 0 };
                  const label = copy.activityDay(dateFormat.format(date), data.sessions, data.minutes);
                  return <button type="button" key={key} className="activity-cell" data-day={key} data-count={data.sessions}
                    data-level={Math.min(4, data.sessions)} data-today={key === today || undefined}
                    aria-label={label} title={label} aria-pressed={key === selected} tabIndex={key === selected ? 0 : -1}
                    onClick={() => setSelected(key)} onKeyDown={(event) => {
                      const shift = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7 }[event.key];
                      if (shift === undefined) return;
                      event.preventDefault();
                      const next = new Date(date);
                      next.setDate(next.getDate() + shift);
                      const nextKey = localDayKey(next);
                      if (next.getFullYear() !== year || nextKey > today) return;
                      setSelected(nextKey);
                      calendar.current?.querySelector<HTMLButtonElement>(`[data-day="${nextKey}"]`)?.focus({ preventScroll: false });
                    }} />;
                })}
              </div>;
            })}
          </div>
        </div>
      </div>
      <div className="calendar-footer">
        <p>{sessions === 0 ? copy.historyEmpty : copy.studyDays(yearDays.length)}</p>
        <div className="activity-legend" aria-label={`${copy.activityLess}: 0. ${copy.activityMore}: 4+ ${copy.sessionsUnit}.`}>
          <span>{copy.activityLess}</span>{[0, 1, 2, 3, 4].map((level) => <i key={level} className="activity-cell" data-level={level} aria-hidden="true" />)}<span>{copy.activityMore}</span>
        </div>
      </div>
      <div className="activity-day-details" data-testid="activity-day-details" aria-live="polite" aria-atomic="true">
        <div className="day-summary"><h3>{dateFormat.format(selectedDate)}</h3><p>{copy.sessionsCount(day.sessions)}<span>·</span>{day.minutes} min</p></div>
        {records.length === 0 ? <p className="day-empty">{copy.dayEmpty}</p> : <ol className="day-records">
          {records.map((entry) => <li key={entry.id}><Icon name="check" width="14" height="14" /><span>{copy.modeLabels.focus}</span><strong>{entry.minutes} min</strong><time dateTime={new Date(entry.completedAt).toISOString()} aria-label={`${copy.completedAt} ${timeFormat.format(entry.completedAt)}`}>{timeFormat.format(entry.completedAt)}</time></li>)}
        </ol>}
      </div>
      <p className="history-local"><Icon name="book" width="14" height="14" />{copy.historyLocal}</p>
    </section>
  );
}
