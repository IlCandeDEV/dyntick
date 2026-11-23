import type { SVGProps } from "react";

export type IconName =
  | "timer" | "play" | "pause" | "reset" | "settings" | "sun" | "moon"
  | "sound" | "muted" | "arrow" | "check" | "close" | "lifebuoy" | "cup" | "display"
  | "book" | "spark" | "chevron" | "activity" | "calendar" | "calendar-pending" | "keyboard" | "globe" | "repeat"
  | "planning" | "snow" | "waves" | "plus" | "grip" | "pencil" | "info";

const calendarOutline = ["M8 2v4M16 2v4M3 10h18", "M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"];

const paths: Record<IconName, string[]> = {
  globe: ["M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z", "M3 12h18M12 3c4 4 4 14 0 18-4-4-4-14 0-18Z"],
  repeat: ["m17 2 4 4-4 4M3 11V8a2 2 0 0 1 2-2h16", "m7 22-4-4 4-4M21 13v3a2 2 0 0 1-2 2H3"],
  calendar: calendarOutline,
  "calendar-pending": [
    "M8 2v4M16 2v4M3 9h18M10 20H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4",
    "M22 17.5a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0ZM17.5 15.5v2l1.25 1",
  ],
  activity: [...calendarOutline, "m9 16 2 2 4-4"],
  planning: ["M3 12h18M5 5v14M12 2v20M19 5v14"],
  snow: ["M12 2v20M3.34 7l17.32 10M20.66 7 3.34 17", "m9 4 3 3 3-3m-6 16 3-3 3 3M4 10l4-1-1-4m10 14-1-4 4-1M4 14l4 1-1 4m10-14-1 4 4 1"],
  waves: [
    "M3 6c2.25 0 2.25 2 4.5 2s2.25-2 4.5-2 2.25 2 4.5 2 2.25-2 4.5-2",
    "M3 11c2.25 0 2.25 2 4.5 2s2.25-2 4.5-2 2.25 2 4.5 2 2.25-2 4.5-2",
    "M3 16c2.25 0 2.25 2 4.5 2s2.25-2 4.5-2 2.25 2 4.5 2 2.25-2 4.5-2",
  ],
  plus: ["M12 5v14M5 12h14"],
  grip: ["M8 5h.01M16 5h.01M8 12h.01M16 12h.01M8 19h.01M16 19h.01"],
  pencil: ["M4 20l1-4.5 11-11a2.5 2.5 0 0 1 3.5 3.5l-11 11L4 20ZM14.5 6l3.5 3.5"],
  timer: ["M10 2h4M12 2v3M18 6l1.5-1.5", "M20 13a8 8 0 1 1-16 0 8 8 0 0 1 16 0", "M12 9v4l2 2"],
  play: ["m8 5 11 7-11 7V5Z"],
  pause: ["M7 5h3v14H7ZM14 5h3v14h-3Z"],
  reset: ["M3 10a9 9 0 1 1 1.5 7M3 4v6h6"],
  settings: ["M4 7h3m4 0h9M4 17h9m4 0h3", "M11 7a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM17 17a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z"],
  sun: ["M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0", "M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5"],
  moon: ["M20.8 13.2A9 9 0 0 1 10.8 3.2 9 9 0 1 0 20.8 13.2Z"],
  sound: ["M11 4 6 8H3v8h3l5 4V4Z", "M15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14"],
  muted: ["M11 4 6 8H3v8h3l5 4V4Z", "m16 9 5 6M21 9l-5 6"],
  arrow: ["M4 12h16m-6-6 6 6-6 6"],
  check: ["m5 12 4 4L19 6"],
  info: ["M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z", "M12 11v5m0-8h.01"],
  close: ["m6 6 12 12M18 6 6 18"],
  lifebuoy: ["M20.4 12a8.4 8.4 0 1 1-16.8 0 8.4 8.4 0 0 1 16.8 0ZM16.1 12a4.1 4.1 0 1 1-8.2 0 4.1 4.1 0 0 1 8.2 0Z"],
  display: ["M3 5h18v12H3z", "M12 17v4m-4 0h8"],
  cup: ["M4 8h12v7a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V8ZM16 9h2a3 3 0 1 1 0 6h-2M7 3v2M12 3v2"],
  book: ["M12 6C8 3 4 4 2 5v14c3-1 6-1 10 1 4-2 7-2 10-1V5c-2-1-6-2-10 1ZM12 6v14"],
  spark: ["m12 3 2.7 6.3L21 12l-6.3 2.7L12 21l-2.7-6.3L3 12l6.3-2.7L12 3Z"],
  chevron: ["m9 5 7 7-7 7"],
  keyboard: ["M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z", "M7 9h1m3 0h1m3 0h2M7 13h1m3 0h1m3 0h2M8 16h8"],
};

// Optical adjustments in viewBox units balance asymmetric ink, rather than its box.
// Keep these outside the motion group so hover never replaces the resting alignment.
const opticalOffsets: Partial<Record<IconName, readonly [number, number]>> = {
  timer: [0, .35],
  play: [.55, 0],
  pause: [0, .15],
  reset: [.35, .2],
  moon: [.65, -.55],
  sound: [.6, 0],
  muted: [1, 0],
  arrow: [-.65, 0],
  check: [0, .2],
  cup: [.15, .35],
  book: [0, -.15],
  chevron: [-.5, 0],
};

export function Icon({ name, className, ...props }: SVGProps<SVGSVGElement> & { name: IconName }) {
  const [x, y] = opticalOffsets[name] ?? [0, 0];
  return (
    <svg className={`ui-icon${className ? ` ${className}` : ""}`} data-icon={name}
      width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <g className="icon-optical" transform={`translate(${x} ${y})`}>
        <g className="icon-motion">
          {paths[name].map((d, index) => <path className={name === "lifebuoy" ? "lifebuoy-ring" : undefined}
            d={d} key={index} />)}
          {name === "lifebuoy" && <>
            <circle className="lifebuoy-bands" cx="12" cy="12" r="6.25" strokeWidth="4.3"
              strokeLinecap="butt" strokeDasharray="4 5.817" transform="rotate(26.7 12 12)" />
            <path d="M6 6C7.8-.25 16.2-.25 18 6C24.25 7.8 24.25 16.2 18 18C16.2 24.25 7.8 24.25 6 18C-.25 16.2-.25 7.8 6 6Z"
              strokeWidth=".85" transform="rotate(45 12 12)" />
          </>}
        </g>
      </g>
    </svg>
  );
}

export function BrandMark() {
  return (
    <svg className="ui-icon brand-symbol" data-icon="brand" width="32" height="32" viewBox="0 0 32 32" fill="none" stroke="currentColor"
      strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <g className="icon-motion">
      <path d="M16 10C12 7.1 7.8 6.5 3 7.6v17.3c4.8-1.1 9-.5 13 2.4 3.2-2.3 6.9-3.2 11.5-2.6V17" />
      <path d="M16 27.3V10c1-.8 2.2-1.5 3.5-2M7.7 12.7l3.6.6M7.7 17.6l3.6.6" />
      <path d="m22 9.5 2.8 2.8L30 6.4" />
      </g>
    </svg>
  );
}
