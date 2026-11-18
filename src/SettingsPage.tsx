import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Switch } from "@astryxdesign/core/Switch";
import { Icon } from "./Icons.tsx";
import { parsePreferences } from "./storage.ts";
import { DEFAULT_PREFERENCES, MAX_CYCLE_SESSIONS, type Preferences } from "./timer.ts";
import { messagesFor } from "./i18n.ts";

interface Props {
  preferences: Preferences;
  onSave: (preferences: Preferences) => void;
  onPreviewSound: () => Promise<boolean>;
}

export function SettingsPage({ preferences, onSave, onPreviewSound }: Props) {
  const form = useRef<HTMLFormElement>(null);
  const [sound, setSound] = useState(preferences.soundEnabled);
  const [soundUnavailable, setSoundUnavailable] = useState(false);
  const copy = messagesFor(preferences.language);

  useEffect(() => setSound(preferences.soundEnabled), [preferences.soundEnabled]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    onSave(parsePreferences(JSON.stringify({
      ...preferences,
      focusMinutes: Number(data.get("focusMinutes")),
      shortBreakMinutes: Number(data.get("shortBreakMinutes")),
      longBreakMinutes: Number(data.get("longBreakMinutes")),
      longBreakInterval: Number(data.get("longBreakInterval")),
      soundEnabled: sound,
      theme: data.get("theme"),
    })));
  };

  const restoreDefaults = () => {
    const element = form.current;
    if (!element) return;
    for (const key of ["focusMinutes", "shortBreakMinutes", "longBreakMinutes", "longBreakInterval", "theme"] as const) {
      const input = element.elements.namedItem(key);
      if (input instanceof HTMLInputElement || input instanceof HTMLSelectElement) {
        input.value = String(DEFAULT_PREFERENCES[key]);
      }
    }
    setSound(DEFAULT_PREFERENCES.soundEnabled);
    setSoundUnavailable(false);
  };

  return (
    <section className="settings-page" aria-labelledby="settings-title" data-testid="settings-page">
      <div className="settings-surface">
        <header className="settings-header">
          <div>
            <h2 id="settings-title">{copy.settingsLink}</h2>
            <p className="settings-description">{copy.durationDescription}</p>
          </div>
          <span className="settings-page-icon" aria-hidden="true"><Icon name="settings" width="24" height="24" /></span>
        </header>
        <form ref={form} onSubmit={submit}>
          <fieldset className="settings-fieldset">
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
                      defaultValue={preferences[name]} inputMode="numeric" />
                    <span aria-hidden="true">min</span>
                  </span>
                </label>
              ))}
            </div>
            <label className="field interval-field">
              <span>{copy.longBreakEvery}</span>
              <span className="number-field">
                <input type="number" name="longBreakInterval" min="1" max={MAX_CYCLE_SESSIONS} step="1" required
                  defaultValue={preferences.longBreakInterval} inputMode="numeric" />
                <span aria-hidden="true">{copy.sessionsUnit}</span>
              </span>
            </label>
            <p className="field-hint">{copy.durationHint}</p>
          </fieldset>
          <fieldset className="settings-fieldset">
            <legend>{copy.detailsLegend}</legend>
            <div className="sound-setting">
              <Switch label={copy.soundLabel} value={sound} onChange={setSound}
                labelPosition="start" labelSpacing="spread" width="100%" />
              <Button label={copy.previewSound} variant="ghost" size="sm" isDisabled={!sound}
                icon={<Icon name="sound" width="16" height="16" />}
                onClick={async () => {
                  const available = await onPreviewSound();
                  setSoundUnavailable(!available);
                }} />
              <p className="field-hint" role="status">{soundUnavailable ? copy.soundUnavailable : ""}</p>
            </div>
            <label className="field theme-field">
              <span>{copy.appearance}</span>
              <select name="theme" key={preferences.theme} defaultValue={preferences.theme}>
                <option value="system">{copy.systemTheme}</option>
                <option value="light">{copy.light}</option>
                <option value="dark">{copy.dark}</option>
              </select>
            </label>
          </fieldset>
          <footer className="settings-footer">
            <Button label={copy.restoreDefaults} variant="ghost" onClick={restoreDefaults} />
            <Button label={copy.savePreferences} type="submit" variant="primary" className="save-button" />
          </footer>
        </form>
        <section className="keyboard-tips" aria-labelledby="keyboard-tips-title" data-testid="keyboard-tips">
          <div className="keyboard-tips-heading"><Icon name="keyboard" /><h3 id="keyboard-tips-title">{copy.keyboardTipsTitle}</h3></div>
          <dl>
            <div><dt><kbd>←</kbd><span>/</span><kbd>H</kbd></dt><dd>{copy.previousPageShortcut}</dd></div>
            <div><dt><kbd>→</kbd><span>/</span><kbd>L</kbd></dt><dd>{copy.nextPageShortcut}</dd></div>
            <div><dt><kbd>{copy.spaceKey}</kbd></dt><dd>{copy.startPauseShortcut}</dd></div>
            <div><dt><kbd>R</kbd></dt><dd>{copy.resetShortcut}</dd></div>
          </dl>
          <p>{copy.keyboardTipsNote}</p>
        </section>
      </div>
    </section>
  );
}
