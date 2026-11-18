import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

export const STUDY_PAGES = ["pomodoro", "activity", "settings"] as const;
export type StudyPage = typeof STUDY_PAGES[number];

export function pageFromHash(): StudyPage {
  const value = location.hash.slice(1);
  if (value === "settings") return "settings";
  if (value === "activity" || value === "study-activity") return "activity";
  return "pomodoro";
}

export function StudyPages({ active, pages }: {
  active: StudyPage;
  pages: Record<StudyPage, ReactNode>;
}) {
  const panels = useRef<(HTMLDivElement | null)[]>([]);
  const [height, setHeight] = useState<number>();
  const index = STUDY_PAGES.indexOf(active);

  useLayoutEffect(() => {
    const panel = panels.current[index];
    if (!panel) return;
    const measure = () => setHeight(Math.ceil(panel.getBoundingClientRect().height));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [index]);

  return (
    <div className="page-viewport" style={{ height }}>
      <div className="page-track" style={{ transform: `translate3d(${-index * 100}%, 0, 0)` }}>
        {STUDY_PAGES.map((page, panelIndex) => (
          <div key={page} id={`panel-${page}`} className="page-panel" role="tabpanel"
            aria-labelledby={`tab-${page}`} aria-hidden={active !== page} inert={active !== page}
            ref={(element) => { panels.current[panelIndex] = element; }}>
            {pages[page]}
          </div>
        ))}
      </div>
    </div>
  );
}
