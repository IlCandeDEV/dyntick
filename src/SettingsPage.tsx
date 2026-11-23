import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Switch } from "@astryxdesign/core/Switch";
import { Icon } from "./Icons.tsx";
import { SelectMenu } from "./SelectMenu.tsx";
import { parsePreferences } from "./storage.ts";
import { DEFAULT_PREFERENCES, MAX_CYCLE_SESSIONS, type Preferences } from "./timer.ts";
import { messagesFor, type Messages } from "./i18n.ts";
import {
  CREDIT_SYSTEMS, DATE_FORMATS, DEFAULT_SESSION_MONTHS, EXAM_MONTHS, EXAM_SESSIONS, formatSessionMonths, isCreditSystem, isDateFormat, type ExamMonth, type ExamSession, type MonthLabel,
  type SessionMonths, type SessionMonthsAction,
} from "./planning.ts";

type PlanningCopy = Messages["planning"];

interface Props {
  preferences: Preferences;
  sessionMonths: Readonly<SessionMonths>;
  monthLabels: readonly MonthLabel[];
  active: boolean;
  status: string;
  onSave: (preferences: Preferences, sessionMonths?: Readonly<SessionMonths>) => Promise<boolean>;
  onSessionMonthsChange: (action: SessionMonthsAction) => void;
  disabled?: boolean;
  onPreviewSound: () => Promise<boolean>;
}

function sameMonths(left: readonly ExamMonth[], right: readonly ExamMonth[]): boolean {
  return left.length === right.length && left.every((month, index) => month === right[index]);
}

function SessionMonthsEditor({ session, months, labels, copy, disabled, status, staged, onChange, onDismiss }: {
  session: ExamSession;
  months: readonly ExamMonth[];
  labels: readonly MonthLabel[];
  copy: PlanningCopy;
  disabled: boolean;
  status: string;
  staged: boolean;
  onChange: (action: SessionMonthsAction) => void;
  onDismiss: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [initialMonths] = useState(months);
  const [selected, setSelected] = useState(months);
  const [submitted, setSubmitted] = useState<readonly ExamMonth[] | null>(null);
  const canSave = !disabled && selected.length > 0 && !sameMonths(selected, initialMonths);

  useLayoutEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  useEffect(() => {
    if (submitted && sameMonths(submitted, months)) onDismiss();
  }, [months, onDismiss, submitted]);

  return (
    <dialog ref={dialog} className="exam-editor session-month-editor" aria-labelledby="session-months-title" onCancel={(event) => {
      event.preventDefault();
      onDismiss();
    }}>
      <h2 id="session-months-title">{copy.sessions[session]}</h2>
      <form onSubmit={(event) => {
        event.preventDefault();
        if (!canSave) return;
        if (sameMonths(selected, months)) { onDismiss(); return; }
        setSubmitted(selected);
        onChange({ type: "session.months", session, months: selected });
      }}>
        <fieldset disabled={disabled}>
          <legend>{copy.selectMonths}</legend>
          <div className="session-month-options">
            {labels.map(({ month, full }, index) => <label key={month} className="session-month-option">
              <input type="checkbox" checked={selected.includes(month)} autoFocus={index === 0} onChange={(event) => {
                const checked = event.currentTarget.checked;
                setSelected((current) => EXAM_MONTHS.filter((value) => value === month ? checked : current.includes(value)));
              }} />
              <span>{full}</span>
            </label>)}
          </div>
        </fieldset>
        <p className="exam-editor-status" role="status">{status}</p>
        <footer className="exam-editor-actions">
          <Button label={copy.cancel} type="button" variant="ghost" onClick={onDismiss} />
          <Button label={staged ? copy.applyMonths : copy.saveMonths} type="submit" variant="primary" className="save-button" isDisabled={!canSave} />
        </footer>
      </form>
    </dialog>
  );
}

export function SettingsPage({ preferences, sessionMonths, monthLabels, active, status,
  onSave, onSessionMonthsChange, onPreviewSound, disabled = false }: Props) {
  const form = useRef<HTMLFormElement>(null);
  const [sound, setSound] = useState(preferences.soundEnabled);
  const [theme, setTheme] = useState(preferences.theme);
  const [creditSystem, setCreditSystem] = useState(preferences.creditSystem);
  const [dateFormat, setDateFormat] = useState(preferences.dateFormat);
  const [soundUnavailable, setSoundUnavailable] = useState(false);
  const [monthSession, setMonthSession] = useState<ExamSession | null>(null);
  const [sessionMonthsDraft, setSessionMonthsDraft] = useState<Readonly<SessionMonths> | null>(null);
  const shownSessionMonths = sessionMonthsDraft ?? sessionMonths;
  const copy = messagesFor(preferences.language);
  const dismissMonths = useCallback(() => setMonthSession(null), []);

  useEffect(() => setSound(preferences.soundEnabled), [preferences.soundEnabled]);
  useEffect(() => setTheme(preferences.theme), [preferences.theme]);
  useEffect(() => setCreditSystem(preferences.creditSystem), [preferences.creditSystem]);
  useEffect(() => setDateFormat(preferences.dateFormat), [preferences.dateFormat]);
  useEffect(() => { if (!active) dismissMonths(); }, [active, dismissMonths]);
  useEffect(() => {
    if (sessionMonthsDraft && EXAM_SESSIONS.every((session) => sameMonths(sessionMonthsDraft[session], sessionMonths[session]))) {
      setSessionMonthsDraft(null);
    }
  }, [sessionMonths, sessionMonthsDraft]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (disabled) return;
    const data = new FormData(event.currentTarget);
    onSave(parsePreferences(JSON.stringify({
      ...preferences,
      focusMinutes: Number(data.get("focusMinutes")),
      shortBreakMinutes: Number(data.get("shortBreakMinutes")),
      longBreakMinutes: Number(data.get("longBreakMinutes")),
      longBreakInterval: Number(data.get("longBreakInterval")),
      soundEnabled: sound,
      theme,
      creditSystem,
      dateFormat,
    })), sessionMonthsDraft ?? undefined);
  };

  const restoreDefaults = () => {
    const element = form.current;
    if (!element) return;
    for (const key of ["focusMinutes", "shortBreakMinutes", "longBreakMinutes", "longBreakInterval"] as const) {
      const input = element.elements.namedItem(key);
      if (input instanceof HTMLInputElement) {
        input.value = String(DEFAULT_PREFERENCES[key]);
      }
    }
    setSound(DEFAULT_PREFERENCES.soundEnabled);
    setTheme(DEFAULT_PREFERENCES.theme);
    setCreditSystem(DEFAULT_PREFERENCES.creditSystem);
    setDateFormat(DEFAULT_PREFERENCES.dateFormat);
    setSoundUnavailable(false);
    setSessionMonthsDraft(DEFAULT_SESSION_MONTHS);
  };

  return (
    <div className="settings-page" data-testid="settings-page">
      <section className="settings-surface" aria-labelledby="settings-title">
        <header className="settings-header">
          <h2 id="settings-title">{copy.settingsLink}</h2>
        </header>
        <form ref={form} onSubmit={submit}>
          <section className="settings-category" aria-labelledby="settings-general-title">
            <h3 id="settings-general-title">{copy.settingsGeneral}</h3>
            <div className="settings-general-fields">
              <SelectMenu label={copy.appearance} icon={theme === "system" ? "display" : theme === "light" ? "sun" : "moon"}
                isLabelHidden={false} isDisabled={disabled} value={theme} options={[
                  { value: "system", label: copy.systemTheme },
                  { value: "light", label: copy.light },
                  { value: "dark", label: copy.dark },
                ]} onChange={(value) => {
                  if (value === "system" || value === "light" || value === "dark") setTheme(value);
                }} />
              <SelectMenu label={copy.dateFormatLabel} icon="calendar" isLabelHidden={false} isDisabled={disabled} value={dateFormat}
                options={DATE_FORMATS.map((format) => ({ value: format, label: `${copy.dateFormatNames[format]} (${copy.datePatterns[format]})` }))}
                onChange={(value) => { if (isDateFormat(value)) setDateFormat(value); }} />
            </div>
          </section>
          <section className="settings-category" aria-labelledby="settings-pomodoro-title">
            <h3 id="settings-pomodoro-title">Pomodoro</h3>
            <div className="settings-pomodoro-fields">
              <fieldset className="settings-fieldset" disabled={disabled}>
                <legend>{copy.durationLegend}</legend>
                <p className="settings-description">{copy.durationDescription}</p>
                <div className="duration-fields">
                  {([
                    ["focusMinutes", copy.modeLabels.focus],
                    ["shortBreakMinutes", copy.modeLabels.shortBreak],
                    ["longBreakMinutes", copy.modeLabels.longBreak],
                  ] as const).map(([name, label]) => (
                    <label className="field" key={name}>
                      <span>{label}</span>
                      <span className="number-field">
                        <input type="number" name={name} min="1" max="180" step="1" required
                          key={preferences[name]} defaultValue={preferences[name]} inputMode="numeric" />
                        <span aria-hidden="true">min</span>
                      </span>
                    </label>
                  ))}
                </div>
                <label className="field interval-field">
                  <span>{copy.longBreakEvery}</span>
                  <span className="number-field">
                    <input type="number" name="longBreakInterval" min="1" max={MAX_CYCLE_SESSIONS} step="1" required
                      key={preferences.longBreakInterval} defaultValue={preferences.longBreakInterval} inputMode="numeric" />
                    <span aria-hidden="true">{copy.sessionsUnit}</span>
                  </span>
                </label>
                <p className="field-hint">{copy.durationHint}</p>
              </fieldset>
              <fieldset className="settings-fieldset" disabled={disabled}>
                <legend>{copy.soundLegend}</legend>
                <div className="sound-setting">
                  <Switch label={copy.soundLabel} value={sound} onChange={setSound}
                    labelPosition="start" labelSpacing="spread" width="100%" />
                  <Button label={copy.previewSound} variant="ghost" size="sm" isDisabled={!sound}
                    className="settings-secondary-action" icon={<Icon name="sound" width="16" height="16" />}
                    onClick={async () => {
                      const available = await onPreviewSound();
                      setSoundUnavailable(!available);
                    }} />
                  <p className="field-hint" role="status">{soundUnavailable ? copy.soundUnavailable : ""}</p>
                </div>
              </fieldset>
            </div>
          </section>
          <section className="settings-category" aria-labelledby="settings-activity-title">
            <h3 id="settings-activity-title">{copy.activityLink}</h3>
            <p className="settings-empty">{copy.noActivitySettings}</p>
          </section>
          <section className="settings-category" aria-labelledby="settings-planning-title">
            <h3 id="settings-planning-title">{copy.planning.title}</h3>
            <SelectMenu label={copy.planning.creditSystem} icon="book" className="settings-credit-field"
              isLabelHidden={false} isDisabled={disabled} value={creditSystem}
              options={CREDIT_SYSTEMS.map((system) => ({ value: system, label: system }))}
              onChange={(value) => { if (isCreditSystem(value)) setCreditSystem(value); }} />
            <section className="settings-exam-periods" aria-labelledby="settings-exam-periods-title">
              <h4 id="settings-exam-periods-title">{copy.planning.examPeriods}</h4>
              <ul className="settings-exam-period-list" role="list">
                {EXAM_SESSIONS.map((session) => (
                  <li key={session}>
                    <div>
                      <h5>{copy.planning.sessions[session]}</h5>
                      <p>{formatSessionMonths(shownSessionMonths[session], monthLabels)}</p>
                    </div>
                    <Button label={copy.planning.editMonths} type="button" variant="secondary" size="sm" className="settings-secondary-action"
                      aria-label={copy.planning.editSessionMonths(copy.planning.sessions[session])} aria-haspopup="dialog"
                      isDisabled={disabled} onClick={() => setMonthSession(session)} />
                  </li>
                ))}
              </ul>
            </section>
          </section>
          <footer className="settings-footer">
            <Button label={copy.restoreDefaults} type="button" variant="ghost" className="settings-secondary-action"
              onClick={restoreDefaults} isDisabled={disabled} />
            <Button label={copy.savePreferences} type="submit" variant="primary" className="save-button" isDisabled={disabled} />
          </footer>
        </form>
      </section>
      <aside className="keyboard-tips" aria-labelledby="keyboard-tips-title" data-testid="keyboard-tips">
        <div className="keyboard-tips-heading"><Icon name="keyboard" /><h2 id="keyboard-tips-title">{copy.keyboardTipsTitle}</h2></div>
        <dl>
          <div><dt><kbd>←</kbd><span>/</span><kbd>H</kbd></dt><dd>{copy.previousPageShortcut}</dd></div>
          <div><dt><kbd>→</kbd><span>/</span><kbd>L</kbd></dt><dd>{copy.nextPageShortcut}</dd></div>
          <div><dt><kbd>{copy.spaceKey}</kbd></dt><dd>{copy.startPauseShortcut}</dd></div>
          <div><dt><kbd>R</kbd></dt><dd>{copy.resetShortcut}</dd></div>
        </dl>
        <p>{copy.keyboardTipsNote}</p>
      </aside>
      {active && monthSession && <SessionMonthsEditor key={monthSession} session={monthSession} months={shownSessionMonths[monthSession]}
        labels={monthLabels} copy={copy.planning} disabled={disabled} status={status} staged={sessionMonthsDraft !== null}
        onChange={(action) => {
          if (sessionMonthsDraft) setSessionMonthsDraft({ ...sessionMonthsDraft, [action.session]: action.months });
          else onSessionMonthsChange(action);
        }} onDismiss={dismissMonths} />}
    </div>
  );
}
