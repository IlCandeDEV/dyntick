import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Theme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import { BrandMark, Icon } from "./Icons.tsx";
import { SettingsPage } from "./SettingsPage.tsx";
import { PlanningPage } from "./PlanningPage.tsx";
import { LanguagePicker } from "./LanguagePicker.tsx";
import { CycleMap } from "./CycleMap.tsx";
import { SiteFooter } from "./SiteFooter.tsx";
import { pageFromHash, STUDY_PAGES, StudyPages, type PageDirection, type StudyPage } from "./StudyPages.tsx";
import { usePomodoro } from "./usePomodoro.ts";
import { messagesFor } from "./i18n.ts";
import { ActivityHistory, weekFocusMinutes } from "./ActivityHistory.tsx";
import { activityDays, localDayKey } from "./activity.ts";
import { examMonthLabels } from "./planning.ts";
import { formatTime, MODES, nextMode, remainingAt, type TimerState } from "./timer.ts";

function useSystemDark() {
  const [dark, setDark] = useState(() => matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const update = () => setDark(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return dark;
}

const DIAL_RADIUS = 150;
const DIAL_CIRCUMFERENCE = 2 * Math.PI * DIAL_RADIUS;

function TimerFace({ timer, getNow, active, time, label }: {
  timer: TimerState;
  getNow: () => number;
  active: boolean;
  time: string;
  label: string;
}) {
  const ringRef = useRef<SVGCircleElement>(null);
  const markerRef = useRef<SVGGElement>(null);
  const { durationMs, remainingMs, endAt, status } = timer;

  useLayoutEffect(() => {
    const ring = ringRef.current;
    const marker = markerRef.current;
    if (!ring || !marker) return;

    const draw = (remaining: number) => {
      const progress = Math.max(0, Math.min(1, remaining / durationMs));
      ring.setAttribute("stroke-dashoffset", String(DIAL_CIRCUMFERENCE * (1 - progress)));
      marker.setAttribute("transform", `rotate(${progress * 360} 180 180)`);
    };

    if (endAt === null || !active) {
      draw(endAt === null ? remainingMs : endAt - getNow());
      return;
    }

    const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    let deadline = 0;
    let lastDraw = 0;
    const tick = () => {
      const timestamp = performance.now();
      const remaining = deadline - timestamp;
      if (!reducedMotion.matches || timestamp - lastDraw >= 250 || remaining <= 0) {
        draw(remaining);
        lastDraw = timestamp;
      }
      if (remaining > 0) frame = requestAnimationFrame(tick);
    };
    const sync = () => {
      cancelAnimationFrame(frame);
      if (document.hidden) return;
      // Anchor this run to the server deadline without retargeting it on each poll.
      lastDraw = performance.now();
      const remaining = endAt - getNow();
      deadline = lastDraw + remaining;
      draw(remaining);
      if (remaining > 0) frame = requestAnimationFrame(tick);
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", sync);
    };
  }, [active, durationMs, endAt, getNow, remainingMs]);

  return (
    <div className="timer-face" data-running={status === "running"} data-completed={status === "completed"}>
      <svg className="timer-dial" viewBox="0 0 360 360" aria-hidden="true">
        <circle className="dial-track" cx="180" cy="180" r={DIAL_RADIUS} />
        <circle ref={ringRef} className="dial-progress" cx="180" cy="180" r={DIAL_RADIUS}
          strokeDasharray={DIAL_CIRCUMFERENCE}
          transform="rotate(-90 180 180)" />
        <g ref={markerRef} className="dial-marker">
          <circle cx="180" cy="30" r="4" />
        </g>
      </svg>
      <div className="timer-content">
        <p className="timer-caption">{label}</p>
        <div className="timer-value" role="timer" aria-live="off" aria-label={time} data-testid="countdown" data-wide={time.length > 5}>
          <span className="timer-digits" aria-hidden="true">
            {Array.from(time).map((character, index) => character === ":"
              ? <span className="timer-colon" key={index}>:</span>
              : <span className="timer-digit" key={index}><span className="digit-glyph" key={character}>{character}</span></span>)}
          </span>
        </div>
      </div>
    </div>
  );
}

export function App() {
  const pomodoro = usePomodoro();
  const { timer, preferences, now, getNow, savePreferences, primaryAction, reset, controlsDisabled } = pomodoro;
  const [{ page: activePage, direction }, setNavigation] = useState<{ page: StudyPage; direction: PageDirection | null }>(
    () => ({ page: pageFromHash(), direction: null }),
  );
  const [notice, setNotice] = useState<"preferencesSaved" | null>(null);
  const copy = messagesFor(preferences.language);
  const monthLabels = useMemo(() => examMonthLabels(copy.locale), [copy.locale]);
  const systemDark = useSystemDark();
  const isDark = preferences.theme === "dark" || (preferences.theme === "system" && systemDark);
  const isRunning = timer.status === "running";
  const completed = timer.status === "completed";
  const isBreak = timer.mode !== "focus";
  const remaining = remainingAt(timer, now);
  const time = formatTime(remaining);
  const next = nextMode(timer, preferences);
  const days = useMemo(() => activityDays(pomodoro.activity), [pomodoro.activity]);
  const todayKey = localDayKey(new Date(now));
  const todayActivity = days[todayKey] ?? { sessions: 0, minutes: 0 };
  const cycleCount = Math.floor(todayActivity.sessions / preferences.longBreakInterval);
  const weekMinutes = weekFocusMinutes(days, new Date(now));
  const activityPage = useMemo(() => (
    <ActivityHistory activity={pomodoro.activity} days={days} today={todayKey} copy={copy} />
  ), [pomodoro.activity, days, todayKey, copy]);
  const date = new Intl.DateTimeFormat(copy.locale, { weekday: "long", day: "numeric", month: "long" }).format(now);

  const primaryLabel = isRunning ? copy.pause : timer.status === "paused" ? copy.resume
    : completed ? copy.nextActions[next] : isBreak ? copy.startBreak : copy.startFocus;
  const status = completed ? copy.completed : isRunning
    ? isBreak ? copy.recharging : copy.focusing
    : timer.status === "paused" ? copy.paused : copy.ready;

  const tabs = {
    pomodoro: { label: "Pomodoro", icon: "timer" },
    activity: { label: copy.activityLink, icon: "activity" },
    planning: { label: copy.planning.title, icon: "planning" },
    settings: { label: copy.settingsLink, icon: "settings" },
  } as const;
  const syncState = pomodoro.connection === "offline" ? "offline" : !pomodoro.ready ? "loading"
    : pomodoro.busy ? "saving" : pomodoro.conflict ? "conflict" : "saved";
  const synced = syncState === "saved";
  const syncFailed = syncState === "offline" || syncState === "conflict";
  const syncMessage = syncState === "offline" ? copy.syncOffline : syncState === "loading" ? copy.syncLoading
    : syncState === "saving" ? copy.syncSaving : syncState === "conflict" ? copy.syncConflict : "";

  const navigateTo = useCallback((page: StudyPage) => {
    setNavigation((current) => {
      if (current.page === page) return current;
      const forward = STUDY_PAGES.indexOf(page) > STUDY_PAGES.indexOf(current.page);
      return { page, direction: forward ? "forward" : "backward" };
    });
  }, []);

  const selectPage = useCallback((page: StudyPage) => {
    if (page === activePage) return;
    history.pushState(null, "", `#${page}`);
    navigateTo(page);
  }, [activePage, navigateTo]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.shiftKey && event.key.startsWith("Arrow")) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest(
        'input, textarea, select, dialog, [role="textbox"], [role="combobox"], [role="listbox"], [role="option"], [role="menu"], [role="menuitem"], [role="slider"], [role="spinbutton"]',
      ))) return;
      const key = event.key.toLowerCase();
      const direction = key === "arrowleft" || key === "h" ? -1 : key === "arrowright" || key === "l" ? 1 : 0;
      if (!direction) return;
      event.preventDefault();
      const index = Math.max(0, Math.min(STUDY_PAGES.length - 1, STUDY_PAGES.indexOf(activePage) + direction));
      const nextPage = STUDY_PAGES[index];
      if (nextPage === activePage) return;
      selectPage(nextPage);
      const fromTabs = target instanceof HTMLElement && target.closest('[role="tablist"]');
      document.getElementById(fromTabs ? `tab-${nextPage}` : "main-content")?.focus({ preventScroll: true });
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [activePage, selectPage]);

  useEffect(() => {
    // Keep legacy activity links usable without scrolling to a hidden panel.
    const canonicalHash = `#${pageFromHash()}`;
    if (location.hash !== canonicalHash) history.replaceState(null, "", canonicalHash);
    const syncPage = () => navigateTo(pageFromHash());
    window.addEventListener("hashchange", syncPage);
    window.addEventListener("popstate", syncPage);
    return () => {
      window.removeEventListener("hashchange", syncPage);
      window.removeEventListener("popstate", syncPage);
    };
  }, [navigateTo]);

  useEffect(() => {
    document.documentElement.lang = preferences.language;
    document.querySelector('meta[name="description"]')?.setAttribute("content", copy.description);
    const pageTitle = activePage === "pomodoro" ? copy.modeLabels[timer.mode] : tabs[activePage].label;
    document.title = `${isRunning || timer.status === "paused" || completed ? `${time} · ` : ""}${pageTitle} · Dyntick`;
  }, [time, timer.mode, timer.status, isRunning, completed, copy, preferences.language, activePage]);

  useEffect(() => {
    // Keep the application palette in sync with the Astryx controls.
    document.documentElement.dataset.theme = preferences.theme;
  }, [preferences.theme]);

  useEffect(() => {
    if (activePage !== "pomodoro") return;
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && target.isContentEditable) return;
      if (target instanceof Element && target.closest(
        'input, textarea, select, dialog, [role="textbox"], [role="combobox"], [role="listbox"], [role="option"], [role="menu"], [role="menuitem"], [role="slider"], [role="spinbutton"]',
      )) return;
      if (event.code === "Space") {
        if (target instanceof Element && target.closest('button, a, [role="button"], [role="link"], [role="tab"], [role="switch"]')) return;
        event.preventDefault();
        primaryAction();
      } else if (event.key.toLowerCase() === "r") {
        event.preventDefault();
        reset();
      }
    };
    globalThis.addEventListener("keydown", keydown);
    return () => globalThis.removeEventListener("keydown", keydown);
  }, [activePage, primaryAction, reset]);

  useEffect(() => {
    if (!notice) return;
    const timeout = setTimeout(() => setNotice(null), 3500);
    return () => clearTimeout(timeout);
  }, [notice]);

  return (
    <Theme theme={neutralTheme} mode={preferences.theme}>
      <div className="app-shell" data-mode={timer.mode} data-page={activePage} data-state-ready={pomodoro.ready}
        data-revision={pomodoro.revision} data-instance={pomodoro.instanceId}>
        <a className="skip-link" href="#main-content" onClick={(event) => {
          event.preventDefault();
          document.getElementById("main-content")?.focus();
        }}>{copy.skipToContent}</a>
        <div className="workspace">
          <header className="topbar">
            <a className="brand" href="#pomodoro" aria-label={copy.brandLabel}
              onClick={(event) => { event.preventDefault(); selectPage("pomodoro"); }}>
              <span className="brand-mark"><BrandMark /></span><span>Dyntick<span className="brand-dot">.</span></span>
            </a>
            <nav className="main-nav" role="tablist" aria-label={copy.mainNavigation}
              style={{ "--page-count": STUDY_PAGES.length, "--active-page": STUDY_PAGES.indexOf(activePage) } as CSSProperties}
              onKeyDown={(event) => {
                if (event.repeat || event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
                const elements = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
                const focused = elements.indexOf(document.activeElement as HTMLButtonElement);
                if (focused < 0) return;
                const nextIndex = event.key === "ArrowRight" ? Math.min(focused + 1, elements.length - 1)
                  : event.key === "ArrowLeft" ? Math.max(focused - 1, 0)
                  : event.key === "Home" ? 0 : event.key === "End" ? elements.length - 1 : null;
                if (nextIndex === null) return;
                event.preventDefault();
                selectPage(STUDY_PAGES[nextIndex]);
                elements[nextIndex].focus({ preventScroll: true });
              }}>
              {STUDY_PAGES.map((page) => (
                <button type="button" key={page} id={`tab-${page}`} role="tab"
                  aria-controls={`panel-${page}`} aria-selected={activePage === page}
                  tabIndex={activePage === page ? 0 : -1} onClick={() => selectPage(page)}>
                  <Icon name={tabs[page].icon} width="18" height="18" /><span>{tabs[page].label}</span>
                </button>
              ))}
            </nav>
            <div className="topbar-actions">
              <LanguagePicker language={preferences.language} label={copy.languageSelector} disabled={controlsDisabled}
                onChange={(language) => savePreferences({ ...preferences, language })} />
              <Button label={isDark ? copy.lightTheme : copy.darkTheme} variant="ghost"
                isIconOnly icon={<Icon name={isDark ? "sun" : "moon"} />} className="icon-button" isDisabled={controlsDisabled}
                onClick={() => savePreferences({ ...preferences, theme: isDark ? "light" : "dark" })} />
            </div>
          </header>

          <main id="main-content" tabIndex={-1}>
            <header className="page-heading">
              <h1>{copy.heading}</h1>
              <p className="heading-date">{date}</p>
              <p className="welcome-subtitle">{copy.subheading}</p>
              <div className="sync-status" data-testid="sync-status" data-sync-state={syncState} role="status" aria-atomic="true">
                <span className="sync-badge">
                  <Icon name={synced ? "check" : syncFailed ? "close" : "repeat"} width="15" height="15" />
                  {synced ? copy.syncSynced : copy.syncUnsynced}
                </span>
                {syncMessage && <span className="sr-only">{syncMessage}</span>}
              </div>
              {syncFailed && <div className="sync-alert">
                <p aria-hidden="true">{syncMessage}</p>
                {syncState === "offline" && <button type="button" onClick={() => { void pomodoro.retry(); }} disabled={pomodoro.busy}>{copy.syncRetry}</button>}
              </div>}
            </header>

            <StudyPages active={activePage} direction={direction} pages={{
              pomodoro: <div className="focus-layout">
              <section className="timer-panel" aria-label={copy.pomodoroTimer}>
                <div className="timer-status-row">
                  <div className={`status-pill ${isRunning ? "is-running" : ""}`} role="status"><span />{status}</div>
                  <Button label={preferences.soundEnabled ? copy.muteSound : copy.enableSound}
                    variant="ghost" isIconOnly icon={<Icon name={preferences.soundEnabled ? "sound" : "muted"} />}
                    className="icon-button sound-button" aria-pressed={preferences.soundEnabled} isDisabled={controlsDisabled}
                    onClick={() => savePreferences({ ...preferences, soundEnabled: !preferences.soundEnabled })} />
                </div>
                <div className="timer-panel-top">
                  <div className="mode-selector" role="group" aria-label={copy.timerModes}>
                    {MODES.map((mode) => (
                      <button key={mode} type="button" aria-pressed={timer.mode === mode}
                        disabled={controlsDisabled || (isRunning && timer.mode !== mode)}
                        title={isRunning && timer.mode !== mode ? copy.pauseToChangeMode : undefined}
                        onClick={() => pomodoro.changeMode(mode)}>{copy.modeLabels[mode]}</button>
                    ))}
                  </div>
                </div>
                <TimerFace timer={timer} getNow={getNow} active={activePage === "pomodoro"}
                  time={time} label={completed ? copy.completed : copy.modeLabels[timer.mode]} />
                <div className="timer-actions">
                  <Button label={primaryLabel} variant="primary" size="lg" className="primary-action" isDisabled={controlsDisabled}
                    icon={<Icon name={isRunning ? "pause" : completed ? "arrow" : "play"} width="19" height="19" />}
                    onClick={primaryAction} />
                  <Button label={copy.reset} variant="secondary" size="lg" isIconOnly
                    icon={<Icon name="reset" />} className="reset-action" onClick={reset} isDisabled={controlsDisabled} />
                </div>
              </section>

              <aside className="session-aside" aria-label={copy.studyRhythm}>
                <section className="today-panel secondary-card" aria-labelledby="today-heading">
                  <div className="section-heading"><h2 id="today-heading">{copy.todayTitle}</h2></div>
                  <div className="today-total"><strong data-testid="today-sessions">{todayActivity.sessions}</strong><span>{copy.sessionUnit(todayActivity.sessions)}</span></div>
                  <dl className="today-metrics">
                    <div><dt>{copy.focusMinutesLabel}</dt><dd>{todayActivity.minutes}<span> min</span></dd></div>
                    <div><dt>{copy.weekTitle}</dt><dd>{weekMinutes}<span> min</span></dd></div>
                    <div><dt>{copy.cycleCount}</dt><dd data-testid="today-cycle-count">{cycleCount}</dd></div>
                  </dl>
                  <p className="study-card-note">
                    <Icon name="info" width="16" height="16" />
                    <span>{copy.cycleDefinition(copy.sessionsCount(preferences.longBreakInterval))}</span>
                  </p>
                </section>
                <CycleMap preferences={preferences} timer={timer} copy={copy} />
              </aside>
              </div>,
              activity: activityPage,
              planning: <PlanningPage active={activePage === "planning"} exams={pomodoro.exams} creditSystem={preferences.creditSystem} sessionMonths={pomodoro.sessionMonths}
                monthLabels={monthLabels} dateFormat={preferences.dateFormat} now={now}
                disabled={controlsDisabled} status={syncMessage} copy={copy} onChange={pomodoro.changePlanning} />,
              settings: <SettingsPage preferences={preferences} active={activePage === "settings"} disabled={controlsDisabled}
                sessionMonths={pomodoro.sessionMonths} monthLabels={monthLabels} status={syncMessage} onSessionMonthsChange={pomodoro.changePlanning}
                onSave={async (nextPreferences, sessionMonthsDraft) => {
                  const saved = await savePreferences(nextPreferences, sessionMonthsDraft);
                  if (saved) setNotice("preferencesSaved");
                  return saved;
                }}
                onPreviewSound={pomodoro.previewSound} />,
            }} />

            <SiteFooter copy={copy} />
          </main>
        </div>
        <div className={`toast ${notice ? "is-visible" : ""}`} role="status">{notice && <><Icon name="check" width="17" height="17" />{copy[notice]}</>}</div>
      </div>
    </Theme>
  );
}
