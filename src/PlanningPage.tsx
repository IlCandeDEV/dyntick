import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from "react";
import { Button } from "@astryxdesign/core/Button";
import { localDayKey } from "./activity.ts";
import { ExamDatePicker } from "./ExamDatePicker.tsx";
import { Icon, type IconName } from "./Icons.tsx";
import { SelectMenu } from "./SelectMenu.tsx";
import type { Messages } from "./i18n.ts";
import {
  academicYearAt, EXAM_SESSIONS, formatExamDate, formatSessionMonths, MAX_EXAM_CREDITS, MAX_EXAM_NAME_LENGTH, isExamSession, parseExamDate,
  type CreditSystem, type DateFormat, type Exam, type ExamAction, type ExamPatch, type ExamSession, type MonthLabel, type SessionMonths,
} from "./planning.ts";
import { newClientId } from "./protocol.ts";

type Editor = { exam: Exam; creating: boolean };
type Drag = { examId: string; destination?: ExamSession | null };

const SESSION_ICONS: Record<ExamSession, IconName> = { winter: "snow", summer: "waves", resit: "lifebuoy" };

function ExamEditor({ editor, currentExam, creditSystem, dateFormat, messages, today, disabled, status, onChange, onDismiss }: {
  editor: Editor;
  currentExam: Exam | undefined;
  creditSystem: CreditSystem;
  dateFormat: DateFormat;
  messages: Messages;
  today: string;
  disabled: boolean;
  status: string;
  onChange: (action: ExamAction) => void;
  onDismiss: () => void;
}) {
  const { exam, creating } = editor;
  const copy = messages.planning;
  const dialog = useRef<HTMLDialogElement>(null);
  const dateField = useRef<HTMLInputElement>(null);
  const confirmButton = useRef<HTMLParagraphElement>(null);
  const [name, setName] = useState(exam.name);
  const [session, setSession] = useState(exam.session);
  const [creditInput, setCreditInput] = useState(String(exam.credits));
  // Keep the order of an in-progress entry if Settings is edited on another device.
  const [inputFormat] = useState(dateFormat);
  const [dateInput, setDateInput] = useState(() => exam.examDate ? formatExamDate(exam.examDate, inputFormat) : "");
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [submitted, setSubmitted] = useState<ExamPatch | null>(null);
  const trimmedName = name.trim();
  const nameEdited = creating || trimmedName !== exam.name;
  // Older titles can still be kept when only the session changes.
  const invalidName = !trimmedName || (nameEdited && trimmedName.length > MAX_EXAM_NAME_LENGTH);
  const credits = Number(creditInput);
  const invalidCredits = !creditInput || !Number.isInteger(credits) || credits < 0 || credits > MAX_EXAM_CREDITS;
  const examDate = parseExamDate(dateInput, inputFormat);
  const invalidDate = dateInput.trim() !== "" && examDate === null;
  const datePattern = messages.datePatterns[inputFormat];

  useLayoutEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  useLayoutEffect(() => {
    if (confirming) confirmButton.current?.focus();
  }, [confirming]);

  useEffect(() => {
    if (submitted && currentExam &&
      (submitted.name === undefined || submitted.name === currentExam.name) &&
      (submitted.session === undefined || submitted.session === currentExam.session) &&
      (submitted.credits === undefined || submitted.credits === currentExam.credits) &&
      (submitted.examDate === undefined || submitted.examDate === currentExam.examDate)) onDismiss();
  }, [submitted, currentExam, onDismiss]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (disabled || invalidName || invalidCredits || invalidDate || confirming) return;
    if (creating) {
      onChange({ type: "exam.create", exam: { ...exam, name: trimmedName, session, credits, examDate } });
      return;
    }
    // Only send the fields edited here, preserving other changes received while the dialog was open.
    const patch: ExamPatch = {};
    if (nameEdited && trimmedName !== currentExam?.name) patch.name = trimmedName;
    if (session !== exam.session && session !== currentExam?.session) patch.session = session;
    if (credits !== exam.credits && credits !== currentExam?.credits) patch.credits = credits;
    if (examDate !== (exam.examDate ?? null) && examDate !== currentExam?.examDate) patch.examDate = examDate;
    if (Object.keys(patch).length === 0) { onDismiss(); return; }
    setSubmitted(patch);
    onChange({ type: "exam.update", id: exam.id, patch });
  };

  return <>
    <dialog ref={dialog} className="exam-editor" aria-labelledby="exam-editor-title" onCancel={(event) => {
      if (event.target !== event.currentTarget) return;
      event.preventDefault();
      onDismiss();
    }}>
      <h2 id="exam-editor-title">{creating ? copy.addExam : copy.editExam}</h2>
      <form onSubmit={submit}>
        <fieldset disabled={disabled || confirming}>
          <label className="field">
            <span>{copy.examName}</span>
            <input type="text" name="examName" value={name} maxLength={MAX_EXAM_NAME_LENGTH} required
              autoFocus onChange={(event) => setName(event.currentTarget.value)} />
          </label>
          <div className="exam-editor-details">
            <SelectMenu label={copy.session} icon="planning" isLabelHidden={false} isDisabled={disabled || confirming}
              value={session ?? "unscheduled"} options={[
                { value: "unscheduled", label: copy.unscheduled },
                ...EXAM_SESSIONS.map((period) => ({ value: period, label: copy.sessions[period] })),
              ]} onChange={(value) => setSession(isExamSession(value) ? value : null)} />
            <label className="field">
              <span>{copy.examCredits} ({creditSystem})</span>
              <span className="number-field">
                <input type="number" name="examCredits" inputMode="numeric" min={0} max={MAX_EXAM_CREDITS} step={1} required
                  value={creditInput} onChange={(event) => setCreditInput(event.currentTarget.value)}
                  aria-invalid={invalidCredits || undefined} aria-describedby={invalidCredits ? "exam-credit-range" : undefined} />
              </span>
            </label>
          </div>
          {invalidCredits && <p id="exam-credit-range" className="field-hint">{copy.examCreditRange(MAX_EXAM_CREDITS)}</p>}
          <div className="exam-editor-date">
            <label className="field">
              <span>{copy.examDate}</span>
              <input ref={dateField} type="text" name="examDate" placeholder={datePattern} autoComplete="off" spellCheck={false}
                value={dateInput} onChange={(event) => setDateInput(event.currentTarget.value)}
                onBlur={() => { if (examDate) setDateInput(formatExamDate(examDate, inputFormat)); }}
                aria-invalid={invalidDate || undefined} aria-describedby={invalidDate ? "exam-date-hint" : undefined} />
            </label>
            <Button label={copy.openExamCalendar} type="button" variant="ghost" size="sm" isIconOnly aria-haspopup="dialog"
              icon={<Icon name="calendar" width="18" height="18" />} className="settings-secondary-action" onClick={(event) => {
                event.currentTarget.focus({ preventScroll: true });
                setCalendarOpen(true);
              }} />
            {dateInput && <Button label={copy.clearExamDate} type="button" variant="ghost" size="sm"
              className="settings-secondary-action" onClick={() => {
                setDateInput("");
                dateField.current?.focus();
              }} />}
          </div>
          {invalidDate && <p id="exam-date-hint" className="field-hint">{copy.invalidExamDate(datePattern)}</p>}
        </fieldset>
        <p className="exam-editor-status" role="status">{status}</p>
        <footer className="exam-editor-actions">
          {confirming ? <>
            <p className="exam-remove-question" ref={confirmButton} tabIndex={-1}>{copy.confirmRemove}</p>
            <Button label={copy.back} type="button" variant="ghost" onClick={() => setConfirming(false)} />
            <Button label={copy.removeExam} type="button" variant="secondary" className="exam-remove-button"
              isDisabled={disabled} onClick={() => onChange({ type: "exam.delete", id: exam.id })} />
          </> : <>
            {!creating && <Button label={copy.removeExam} type="button" variant="ghost" className="exam-remove-trigger"
              isDisabled={disabled} onClick={() => setConfirming(true)} />}
            <Button label={copy.cancel} type="button" variant="ghost" onClick={onDismiss} />
            <Button label={creating ? copy.addExam : copy.saveExam} type="submit" variant="primary" className="save-button"
              isDisabled={disabled || invalidName || invalidCredits || invalidDate} />
          </>}
        </footer>
      </form>
    </dialog>
    {calendarOpen && <ExamDatePicker selected={examDate} today={today} copy={messages}
      onSelect={(date) => { setDateInput(formatExamDate(date, inputFormat)); setCalendarOpen(false); }}
      onDismiss={() => setCalendarOpen(false)} />}
  </>;
}

export function PlanningPage({ exams, creditSystem, sessionMonths, monthLabels, dateFormat, now, active, disabled, status, copy: messages, onChange }: {
  exams: readonly Exam[];
  creditSystem: CreditSystem;
  sessionMonths: Readonly<SessionMonths>;
  monthLabels: readonly MonthLabel[];
  dateFormat: DateFormat;
  now: number;
  active: boolean;
  disabled: boolean;
  status: string;
  copy: Messages;
  onChange: (action: ExamAction) => void;
}) {
  const copy = messages.planning;
  const [selectedYear, setSelectedYear] = useState<number | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const currentYear = academicYearAt(new Date(now));
  const year = selectedYear ?? currentYear;
  const years = useMemo(() => [...new Set([currentYear - 1, currentYear, currentYear + 1, year,
    ...exams.map((exam) => exam.academicYear)])].sort((left, right) => right - left), [currentYear, exams, year]);
  const yearExams = useMemo(() => exams.filter((exam) => exam.academicYear === year), [exams, year]);
  const currentExam = editor ? exams.find((exam) => exam.id === editor.exam.id) : undefined;
  const draggedExam = drag ? yearExams.find((exam) => exam.id === drag.examId) : undefined;
  const editorFinished = editor && editor.creating === Boolean(currentExam);

  const dismissEditor = () => {
    setEditor(null);
    if (!editor || !active) return;
    const cardId = `exam-card-${editor.exam.id}`;
    requestAnimationFrame(() => {
      if (document.getElementById("panel-planning")?.inert || document.querySelector(".exam-editor[open]")) return;
      const target = document.getElementById(cardId) ?? document.getElementById("planning-add-exam");
      target?.focus({ preventScroll: true });
    });
  };

  useEffect(() => {
    if (!active) { setEditor(null); setDrag(null); }
  }, [active]);

  useEffect(() => {
    if (editorFinished) dismissEditor();
  }, [editorFinished]);

  function examZone(session: ExamSession | null) {
    const title = session ? copy.sessions[session] : copy.unscheduled;
    const iconSize = session ? 28 : 19;
    const items = yearExams.filter((exam) => exam.session === session);
    const totalCredits = items.reduce((total, exam) => total + exam.credits, 0);
    const canDrop = !disabled && draggedExam && draggedExam.session !== session;
    const destination = session ?? "unscheduled";
    return (
      <section className="exam-zone" aria-labelledby={`exam-zone-${destination}`} data-exam-zone={destination}
        data-drop-ready={!!canDrop} data-drop-active={!!canDrop && drag?.destination === session}
        onDragOver={(event) => {
          if (!canDrop) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          if (drag?.destination !== session) setDrag({ examId: draggedExam.id, destination: session });
        }}
        onDragLeave={(event) => {
          if (drag && drag.destination === session && !(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) {
            setDrag({ examId: drag.examId });
          }
        }}
        onDrop={(event: DragEvent<HTMLElement>) => {
          if (!canDrop) return;
          event.preventDefault();
          setDrag(null);
          if (event.dataTransfer.getData("text/plain") === draggedExam.id) {
            onChange({ type: "exam.update", id: draggedExam.id, patch: { session } });
          }
        }}>
        <header className="exam-zone-header">
          <span className="exam-zone-icon">
            <Icon name={session ? SESSION_ICONS[session] : "calendar-pending"} width={iconSize} height={iconSize} />
          </span>
          <div>
            <h3 id={`exam-zone-${destination}`}>{title}</h3>
            {session && <>
              <p>{formatSessionMonths(sessionMonths[session], monthLabels)}</p>
              <p className="exam-zone-totals" data-testid="exam-zone-totals">
                <span>{copy.examCount(items.length)}</span><span>{totalCredits} {creditSystem}</span>
              </p>
            </>}
          </div>
        </header>
        {items.length > 0 ? <ul className="exam-tiles">
          {items.map((exam) => <li key={exam.id}>
            <button type="button" id={`exam-card-${exam.id}`} className="exam-tile secondary-card" disabled={disabled} draggable={!disabled}
              data-dragging={exam.id === drag?.examId} aria-haspopup="dialog"
              onClick={() => setEditor({ exam, creating: false })}
              onDragStart={(event) => {
                event.dataTransfer.setData("text/plain", exam.id);
                event.dataTransfer.effectAllowed = "move";
                setDrag({ examId: exam.id });
              }} onDragEnd={() => setDrag(null)}>
              <span className="exam-tile-emblem"><Icon name="book" width="17" height="17" /></span>
              <span className="exam-tile-copy">
                <span className="exam-tile-title">{exam.name}</span>
                <span className="exam-tile-credits">{exam.credits} {creditSystem}</span>
                {exam.examDate && <time className="exam-tile-date" dateTime={exam.examDate}>
                  <Icon name="calendar" width="12" height="12" />
                  {formatExamDate(exam.examDate, dateFormat)}
                </time>}
              </span>
              <span className="exam-tile-actions">
                <Icon className="exam-tile-edit" name="pencil" width="18" height="18" strokeWidth={2.45} />
                <Icon className="exam-tile-grip" name="grip" width="17" height="17" strokeWidth={3.6} />
              </span>
            </button>
          </li>)}
        </ul> : <p className="exam-zone-empty">{session ? copy.noPlannedExams : copy.noUnscheduledExams}</p>}
      </section>
    );
  }

  return (
    <section className="planning-page" aria-labelledby="exam-session-title">
      <header className="planning-header">
        <div className="planning-intro">
          <h2 id="exam-session-title">{copy.examSession}</h2>
          <p>
            <span className="planning-pointer-hint">{copy.instructions}</span>
            <span className="planning-touch-hint">{copy.touchInstructions}</span>
          </p>
        </div>
        <div className="planning-controls">
          <SelectMenu label={copy.academicYear} icon="calendar" className="planning-year" isLabelHidden={false}
            value={String(year)} options={years.map((start) => ({ value: String(start), label: `${start}–${start + 1}` }))}
            onChange={(value) => { if (value !== null) setSelectedYear(Number(value)); }} />
          <Button id="planning-add-exam" label={copy.addExam} variant="primary" className="save-button" aria-haspopup="dialog"
            icon={<Icon name="plus" width="17" height="17" />} isDisabled={disabled} onClick={() => {
              setSelectedYear(year);
              setEditor({ creating: true, exam: { id: newClientId(), name: "", academicYear: year, session: null, credits: 0, examDate: null } });
            }} />
        </div>
      </header>
      <ol className="exam-timeline" role="list">
        {EXAM_SESSIONS.map((session) => <li key={session}>{examZone(session)}</li>)}
      </ol>
      {examZone(null)}
      {active && editor && !editorFinished && <ExamEditor key={editor.exam.id} editor={editor} currentExam={currentExam}
        creditSystem={creditSystem} dateFormat={dateFormat} today={localDayKey(new Date(now))} messages={messages} disabled={disabled}
        status={status} onChange={onChange} onDismiss={dismissEditor} />}
    </section>
  );
}
