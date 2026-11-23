import { useMemo, useState, type CSSProperties } from "react";
import { monthlyFocus, type ActivityDay } from "./activity.ts";
import type { Messages } from "./i18n.ts";
import { SelectMenu } from "./SelectMenu.tsx";

function averageCurve(values: readonly number[], axisMax: number): string {
  const levels = values.map((value) => 100 * (1 - value / axisMax));
  if (levels.length === 1) return `M 0.28 ${levels[0]} H 0.72`;
  return levels.reduce((path, level, index) => index === 0
    ? `M 0.5 ${level}`
    : `${path} C ${index} ${levels[index - 1]} ${index} ${level} ${index + 0.5} ${level}`, "");
}

export function TimeTracking({ days, today, year, copy }: {
  days: Record<string, ActivityDay>;
  today: string;
  year: number;
  copy: Messages;
}) {
  const [selectedMonth, setSelectedMonth] = useState<number | null>(null);
  const [currentYear, currentMonth] = today.split("-").map(Number);
  const month = selectedMonth ?? (year === currentYear ? currentMonth : 1);
  const { first, monthKey, daysInMonth, minutes, averages, record } = useMemo(() => monthlyFocus(days, today, { year, month }), [days, today, year, month]);
  const [selection, setSelection] = useState<{ month: string; day: number } | null>(null);
  const selected = selection?.month === monthKey ? Math.min(selection.day, minutes.length) : minutes.length;
  const monthOptions = useMemo(() => {
    const format = new Intl.DateTimeFormat(copy.locale, { month: "long" });
    return Array.from({ length: 12 }, (_, index) => ({ value: String(index + 1), label: format.format(new Date(year, index, 1, 12)) }));
  }, [copy.locale, year]);
  const dayFormat = useMemo(() => new Intl.DateTimeFormat(copy.locale, { day: "numeric", month: "short" }), [copy.locale]);
  const numberFormat = useMemo(() => new Intl.NumberFormat(copy.locale, { maximumFractionDigits: 1 }), [copy.locale]);
  const chartCopy = copy.timeTracking;
  const targetStep = Math.max(60, record * 1.08) / 4;
  const magnitude = 10 ** Math.floor(Math.log10(targetStep));
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude).find((candidate) => candidate >= targetStep)!;
  const axisMax = 4 * step;
  const recordLevel = 100 * (1 - record / axisMax);
  const curve = averageCurve(averages, axisMax);
  const tickDays = [1, 5, 10, 15, 20, 25, daysInMonth];
  const dateAt = (day: number) => new Date(first.getFullYear(), first.getMonth(), day, 12);

  return (
    <section className="time-tracking-card" aria-labelledby="time-tracking-title" data-month={monthKey}>
      <header className="time-tracking-heading">
        <div>
          <h2 id="time-tracking-title">{chartCopy.title}</h2>
          <p className="time-tracking-year">{year}</p>
        </div>
        <SelectMenu label={chartCopy.month} icon="calendar" className="tracking-month-picker" value={String(month)}
          options={monthOptions} onChange={(value) => { if (value !== null) setSelectedMonth(Number(value)); }} />
      </header>
      {minutes.length > 0 && <p className="sr-only" id="time-tracking-navigation">{chartCopy.navigation}</p>}
      <div className="time-tracking-plot" style={{ "--tracking-days": daysInMonth } as CSSProperties}>
        <div className="time-tracking-scale" aria-hidden="true">
          {[4, 3, 2, 1, 0].map((tick) => <span key={tick}>{numberFormat.format(tick * step)}</span>)}
        </div>
        <div className="time-tracking-area" role="group" aria-label={chartCopy.daily} aria-describedby={minutes.length > 0 ? "time-tracking-navigation" : undefined}>
          <div className="time-tracking-columns">
            {Array.from({ length: daysInMonth }, (_, index) => {
              const day = index + 1;
              const value = minutes[index];
              if (value === undefined) return <span key={day} className="time-tracking-future" aria-hidden="true" />;
              const label = chartCopy.dayLabel(dayFormat.format(dateAt(day)), numberFormat.format(value));
              return <button type="button" key={day} className="time-tracking-day" data-tracking-day={day} data-minutes={value}
                tabIndex={day === selected ? 0 : -1} aria-pressed={day === selected} aria-label={label} title={label}
                onClick={() => setSelection({ month: monthKey, day })} onKeyDown={(event) => {
                  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                  event.preventDefault();
                  const next = day + (event.key === "ArrowLeft" ? -1 : 1);
                  if (next < 1 || next > minutes.length) return;
                  setSelection({ month: monthKey, day: next });
                  event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-tracking-day="${next}"]`)?.focus();
                }}>
                <span className="time-tracking-bar" aria-hidden="true" style={{ height: `${100 * value / axisMax}%` }} />
              </button>;
            })}
          </div>
          <svg className="time-tracking-lines" viewBox={`0 0 ${daysInMonth} 100`} preserveAspectRatio="none" aria-hidden="true">
            {record > 0 && <line className="time-tracking-record" x1="0" x2={daysInMonth} y1={recordLevel} y2={recordLevel} />}
            {curve && <>
              <path className="time-tracking-average-halo" d={curve} />
              <path className="time-tracking-average" d={curve} />
            </>}
          </svg>
        </div>
        <div className="time-tracking-dates" aria-hidden="true">
          {tickDays.map((day) => <span key={day} style={{ gridColumn: day }}>{day}</span>)}
        </div>
      </div>
      <ul className="time-tracking-legend" role="list">
        <li><i className="time-tracking-key-bars" aria-hidden="true" />{chartCopy.daily}</li>
        <li><i className="time-tracking-key-average" aria-hidden="true" />{chartCopy.average} <strong>{selected > 0 ? `${numberFormat.format(averages[selected - 1])} min` : "—"}</strong></li>
        <li><i className="time-tracking-key-record" aria-hidden="true" />{chartCopy.record} <strong>{numberFormat.format(record)} min</strong></li>
      </ul>
    </section>
  );
}
