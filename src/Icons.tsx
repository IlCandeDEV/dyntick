import type { SVGProps } from "react";

export type IconName =
  | "timer" | "play" | "pause" | "reset" | "settings" | "sun" | "moon"
  | "sound" | "muted" | "arrow" | "check" | "close" | "leaf" | "cup" | "armchair"
  | "book" | "spark" | "chevron" | "activity" | "keyboard" | "globe" | "repeat";

const paths: Record<IconName, string[]> = {
  globe: ["M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z", "M3 12h18M12 3c4 4 4 14 0 18-4-4-4-14 0-18Z"],
  repeat: ["m17 2 4 4-4 4M3 11V8a2 2 0 0 1 2-2h16", "m7 22-4-4 4-4M21 13v3a2 2 0 0 1-2 2H3"],
  activity: ["M8 2v4M16 2v4M3 10h18", "M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z", "m9 16 2 2 4-4"],
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
  close: ["m6 6 12 12M18 6 6 18"],
  leaf: ["M20 3c-9 0-15 3-15 9a6 6 0 0 0 6 6c6 0 9-6 9-15Z", "M4 21 15 10"],
  cup: ["M4 8h12v7a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V8ZM16 9h2a3 3 0 1 1 0 6h-2M7 3v2M12 3v2"],
  armchair: ["M6 10V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v5", "M5 10a2 2 0 0 1 2 2v3h10v-3a2 2 0 0 1 4 0v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2Z", "M6 19v2M18 19v2"],
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
  armchair: [0, .15],
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
        <g className="icon-motion">{paths[name].map((d, index) => <path d={d} key={index} />)}</g>
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
