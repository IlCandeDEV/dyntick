import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@astryxdesign/core/Button";
import type { Messages } from "./i18n.ts";
import { examMonthLabels } from "./planning.ts";
import { SelectMenu } from "./SelectMenu.tsx";

const DAY_OFFSET: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };

export function ExamDatePicker({ selected, today, copy, onSelect, onDismiss }: {
  selected: string | null;
  today: string;
  copy: Messages;
  onSelect: (date: string) => void;
  onDismiss: () => void;
}) {
  const [origin] = useState(() => (selected ?? today).split("-").map(Number));
  const [yearInput, setYearInput] = useState(String(origin[0]));
  const [month, setMonth] = useState(origin[1]);
  const [day, setDay] = useState(origin[2]);
  const dialog = useRef<HTMLDialogElement>(null);
  const focusedDay = useRef<HTMLButtonElement>(null);
  const focusRequested = useRef(false);
  const validYear = /^\d{1,4}$/.test(yearInput) && Number(yearInput) >= 1;
  const year = validYear ? Number(yearInput) : origin[0];
  const monthKey = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
  const first = new Date(`${monthKey}-01T12:00:00Z`);
  const last = new Date(first);
  last.setUTCMonth(month, 0);
  const daysInMonth = last.getUTCDate();
  const startColumn = (first.getUTCDay() + 6) % 7 + 1;
  const activeDay = Math.min(day, daysInMonth);
  const { dateFormat, months } = useMemo(() => ({
    dateFormat: new Intl.DateTimeFormat(copy.locale, { dateStyle: "full", timeZone: "UTC" }),
    months: examMonthLabels(copy.locale).sort((a, b) => a.month - b.month)
      .map(({ month, full }) => ({ value: String(month), label: full })),
  }), [copy.locale]);

  useLayoutEffect(() => {
    const element = dialog.current;
    element?.showModal();
    focusedDay.current?.focus({ preventScroll: true });
    return () => element?.close();
  }, []);

  useLayoutEffect(() => {
    if (!focusRequested.current) return;
    focusRequested.current = false;
    focusedDay.current?.focus();
  }, [activeDay, month, year]);

  const navigate = (event: KeyboardEvent<HTMLButtonElement>, date: Date) => {
    const offset = DAY_OFFSET[event.key];
    if (offset === undefined || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    event.preventDefault();
    const next = new Date(date);
    next.setUTCDate(next.getUTCDate() + offset);
    const nextYear = next.getUTCFullYear();
    if (nextYear < 1 || nextYear > 9999) return;
    focusRequested.current = true;
    setDay(next.getUTCDate());
    setMonth(next.getUTCMonth() + 1);
    if (nextYear !== year) setYearInput(String(nextYear));
  };

  return (
    <dialog ref={dialog} className="exam-editor exam-date-picker" aria-labelledby="exam-calendar-title" onCancel={(event) => {
      if (event.target !== event.currentTarget) return;
      event.preventDefault();
      onDismiss();
    }}>
      <h2 id="exam-calendar-title">{copy.planning.examDate}</h2>
      <div className="exam-calendar-controls">
        <SelectMenu label={copy.planning.examCalendarMonth} icon="calendar" isLabelHidden={false}
          value={String(month)} options={months} onChange={(value) => { if (value !== null) setMonth(Number(value)); }} />
        <label className="field">
          <span>{copy.planning.examCalendarYear}</span>
          <span className="number-field">
            <input type="number" min={1} max={9999} step={1} inputMode="numeric" value={yearInput}
              aria-invalid={!validYear || undefined} onChange={(event) => setYearInput(event.currentTarget.value)} />
          </span>
        </label>
      </div>
      <div className="exam-calendar-days" role="group" aria-label={`${months[month - 1].label} ${year}`}>
        {copy.activityWeekdays.map((label) => <span key={label} aria-hidden="true">{label}</span>)}
        {Array.from({ length: daysInMonth }, (_, index) => {
          const date = new Date(first);
          date.setUTCDate(index + 1);
          const value = date.toISOString().slice(0, 10);
          const focused = activeDay === index + 1;
          return <button key={index} ref={focused ? focusedDay : undefined} type="button" disabled={!validYear}
            aria-label={dateFormat.format(date)} aria-current={value === today ? "date" : undefined}
            aria-pressed={value === selected} tabIndex={focused ? 0 : -1}
            style={index === 0 ? { gridColumnStart: startColumn } : undefined}
            onKeyDown={(event) => navigate(event, date)} onClick={() => onSelect(value)}>{index + 1}</button>;
        })}
      </div>
      <footer className="exam-editor-actions">
        <Button label={copy.planning.cancel} type="button" variant="ghost" onClick={onDismiss} />
      </footer>
    </dialog>
  );
}
