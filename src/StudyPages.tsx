import type { ReactNode } from "react";

export const STUDY_PAGES = ["pomodoro", "activity", "planning", "settings"] as const;
export type StudyPage = typeof STUDY_PAGES[number];
export type PageDirection = "forward" | "backward";

export function pageFromHash(): StudyPage {
  const value = location.hash.slice(1);
  if (value === "settings" || value === "planning") return value;
  if (value === "activity" || value === "study-activity") return "activity";
  return "pomodoro";
}

export function StudyPages({ active, direction, pages }: {
  active: StudyPage;
  direction: PageDirection | null;
  pages: Record<StudyPage, ReactNode>;
}) {
  return (
    <>
      {STUDY_PAGES.map((page) => (
        <div key={page} id={`panel-${page}`} className="page-panel" role="tabpanel"
          aria-labelledby={`tab-${page}`} hidden={active !== page} inert={active !== page}
          data-enter={active === page ? direction ?? undefined : undefined}>
          {pages[page]}
        </div>
      ))}
    </>
  );
}
