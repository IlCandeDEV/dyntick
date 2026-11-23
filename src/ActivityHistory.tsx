import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { calendarMonths, localDayKey, type ActivityDay, type StudyActivity } from "./activity.ts";
import type { Messages } from "./i18n.ts";
import { Icon } from "./Icons.tsx";
import { SelectMenu } from "./SelectMenu.tsx";
import { TimeTracking } from "./TimeTracking.tsx";

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

export function ActivityHistory({ activity, days, today, copy }: {
  activity: StudyActivity;
  days: Record<string, ActivityDay>;
  today: string;
  copy: Messages;
}) {
  const currentYear = Number(today.split("-")[0]);
  const [year, setYear] = useState(currentYear);
  const [selected, setSelected] = useState(today);
  const previousToday = useRef(today);
  const calendar = useRef<HTMLDivElement>(null);
  const months = useMemo(() => calendarMonths(year), [year]);
  const years = useMemo(() => Array.from(new Set([
    currentYear,
    currentYear + 1,
    year,
    ...Object.keys(days).map((day) => Number(day.slice(0, 4))),
  ])).filter((value) => value <= currentYear + 1).sort((a, b) => b - a), [days, currentYear, year]);
  const futureYear = year > currentYear;
  const yearDays = Object.entries(days).filter(([key]) => key.startsWith(`${year}-`) && key <= today);
  const sessions = yearDays.reduce((count, [, day]) => count + day.sessions, 0);
  const selectedDate = new Date(`${selected}T12:00:00`);
  const day = days[selected] ?? { sessions: 0, minutes: 0 };
  const records = Object.values(activity.entries).filter((entry) => localDayKey(new Date(entry.completedAt)) === selected)
    .sort((a, b) => a.completedAt - b.completedAt);
  const { dateFormat, monthFormat } = useMemo(() => ({
    dateFormat: new Intl.DateTimeFormat(copy.locale, { weekday: "long", day: "numeric", month: "long", year: "numeric" }),
    monthFormat: new Intl.DateTimeFormat(copy.locale, { month: "short" }),
  }), [copy.locale]);

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

  const chooseYear = (next: number) => {
    setYear(next);
    setSelected(next === currentYear ? today : `${next}-01-01`);
  };

  return <>
    <section id="study-activity" className="activity-panel" aria-labelledby="activity-heading">
      <header className="activity-heading">
        <h2 id="activity-heading">{copy.activityTitle}</h2>
        <SelectMenu label={copy.activityYear} icon="calendar" className="activity-year" value={String(year)}
          options={years.map((year) => ({ value: String(year), label: String(year) }))}
          onChange={(value) => { if (value !== null) chooseYear(Number(value)); }} />
      </header>
      <div className="activity-overview"><strong>{copy.activitySummary(sessions)}</strong><span>{year}</span></div>
      {!futureYear && <p className="sr-only" id="activity-navigation">{copy.activityNavigation}</p>}
      <div ref={calendar} className="calendar-layout" data-testid="activity-calendar" role="group" aria-label={copy.activityTitle}
        aria-describedby={futureYear ? undefined : "activity-navigation"}>
        <div className="calendar-months">
          {months.map(({ first, startRow, dates }) => <Fragment key={first.getMonth()}>
            <div className="weekday-labels" aria-hidden="true">
              {copy.activityWeekdays.map((label, index) => <span key={index}>{label}</span>)}
            </div>
            <div className="calendar-month">
              <span className="calendar-month-label" aria-hidden="true">{monthFormat.format(first)}</span>
              <div className="calendar-month-days">
                {Array.from({ length: startRow }, (_, row) => <span key={row} aria-hidden="true" />)}
                {dates.map((date) => {
                  const key = localDayKey(date);
                  if (key > today) return <span className="activity-cell future" key={key} aria-hidden="true" />;
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
              </div>
            </div>
          </Fragment>)}
        </div>
      </div>
      <div className="calendar-footer">
        <p>{sessions === 0 ? copy.historyEmpty : copy.studyDays(yearDays.length)}</p>
        <div className="activity-legend" aria-label={`${copy.activityLess}: 0. ${copy.activityMore}: 4+ ${copy.sessionsUnit}.`}>
          <span>{copy.activityLess}</span>{[0, 1, 2, 3, 4].map((level) => <i key={level} className="activity-cell" data-level={level} aria-hidden="true" />)}<span>{copy.activityMore}</span>
        </div>
      </div>
      {!futureYear && <div className="activity-day-details" data-testid="activity-day-details" aria-live="polite" aria-atomic="true">
        <div className="day-summary">
          <h3>{dateFormat.format(selectedDate)}</h3>
          <p>{copy.sessionsCount(day.sessions)}<span>·</span>{day.minutes} min</p>
        </div>
        {records.length === 0 ? <p className="day-empty">{copy.dayEmpty}</p> : <ol key={selected} className="day-records" role="list">
          {records.map((entry) => <li key={entry.id}>
            <span className="day-record-dot" aria-hidden="true" />
            <span className="day-record-label">{copy.activityFocusSession}</span>
            <span className="day-record-divider" aria-hidden="true" />
            <strong>{entry.minutes} min</strong>
          </li>)}
        </ol>}
      </div>}
      <p className="history-local"><Icon name="info" width="14" height="14" />{copy.historyLocal}</p>
    </section>
    <TimeTracking key={year} year={year} days={days} today={today} copy={copy} />
  </>;
}
