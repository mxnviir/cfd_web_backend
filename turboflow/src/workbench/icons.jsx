// One icon set for the whole Workbench, drawn inline. Build spec 2.2.
//
// One set, one colour, one stroke weight. Icon fonts and per-icon <img> tags
// both cost a request and neither can take `currentColor`, which is what makes
// a disabled button's icon go grey with its label instead of staying black.
//
// These are 24-unit line drawings in the Lucide style, rendered at whatever
// `size` the caller asks for. No emoji anywhere, per DESIGN_RULES.md.
import React from "react";

const P = {
  chevronDown: "M6 9l6 6 6-6",
  chevronRight: "M9 6l6 6-6 6",
  chevronUp: "M18 15l-6-6-6 6",
  chevronLeft: "M15 18l-6-6 6-6",
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
  x: "M18 6L6 18M6 6l12 12",
  check: "M20 6L9 17l-5-5",
  search: "M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.35-4.35",
  gear: "M12 15a3 3 0 100-6 3 3 0 000 6z"
    + "M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 "
    + "1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 "
    + "0 008.6 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 "
    + "1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 "
    + "8.6a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 "
    + "001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 "
    + "1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 "
    + "1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z",
  copy: "M9 9h10v10a2 2 0 01-2 2H9a2 2 0 01-2-2V9zM5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1",
  share: "M4 12v7a2 2 0 002 2h12a2 2 0 002-2v-7M16 6l-4-4-4 4M12 2v14",
  download: "M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3",
  upload: "M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12",
  trash: "M3 6h18M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6",
  pencil: "M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z",
  dots: "M12 6.5v.01M12 12v.01M12 17.5v.01",
  help: "M12 21a9 9 0 100-18 9 9 0 000 18zM9.1 9a3 3 0 015.8 1c0 2-3 3-3 3M12 17h.01",
  info: "M12 21a9 9 0 100-18 9 9 0 000 18zM12 16v-4M12 8h.01",
  chat: "M21 11.5a8.4 8.4 0 01-9 8.4 8.4 8.4 0 01-3.8-.9L3 21l1.9-5a8.4 8.4 0 01-.9-3.8 8.4 8.4 0 018.4-8.4h.5a8.4 8.4 0 018.1 8.1z",
  home: "M3 10l9-7 9 7v10a2 2 0 01-2 2H5a2 2 0 01-2-2z",
  folder: "M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z",
  file: "M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8zM14 2v6h6",
  eye: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7zM12 15a3 3 0 100-6 3 3 0 000 6z",
  eyeOff: "M17.9 17.9A10.1 10.1 0 0112 19c-6.4 0-10-7-10-7a18 18 0 015.1-5.9M9.9 4.2A9.1 9.1 0 0112 4c6.4 0 10 7 10 7a18 18 0 01-2.2 3.2M1 1l22 22M9.9 9.9a3 3 0 004.2 4.2",
  play: "M6 4l14 8-14 8z",
  stop: "M6 6h12v12H6z",
  clock: "M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3 2",
  // A wireframe cube, the base of every selection-mode button.
  cube: "M12 2.5l8.5 4.9v9.2L12 21.5l-8.5-4.9V7.4zM3.5 7.4L12 12.3l8.5-4.9M12 12.3v9.2",
  // Same cube with one face filled: select faces.
  cubeFace: "M12 2.5l8.5 4.9v9.2L12 21.5l-8.5-4.9V7.4zM3.5 7.4L12 12.3l8.5-4.9M12 12.3v9.2M12 12.3l8.5-4.9v9.2L12 21.5z",
  // Cube with its vertices marked: select edges and nodes.
  cubeNode: "M12 2.5l8.5 4.9v9.2L12 21.5l-8.5-4.9V7.4zM3.5 7.4L12 12.3l8.5-4.9M12 12.3v9.2M12 1.2v2.6M2.2 7v1.8M21.8 7v1.8",
  layers: "M12 2L2 7l10 5 10-5zM2 17l10 5 10-5M2 12l10 5 10-5",
  grid: "M3 3h18v18H3zM3 9h18M3 15h18M9 3v18M15 3v18",
  boxSelect: "M3 7V5a2 2 0 012-2h2M17 3h2a2 2 0 012 2v2M21 17v2a2 2 0 01-2 2h-2M7 21H5a2 2 0 01-2-2v-2M9 12h6M12 9v6",
  fit: "M3 8V5a2 2 0 012-2h3M16 3h3a2 2 0 012 2v3M21 16v3a2 2 0 01-2 2h-3M8 21H5a2 2 0 01-2-2v-3",
  clip: "M3 17l8-14 10 6-8 14zM11 3l10 6",
  ruler: "M2 14l8-8 12 12-8 8zM6 10l2 2M9 7l2 2M12 4l2 2",
  rotateCw: "M21 12a9 9 0 11-3-6.7M21 3v6h-6",
  rotateCcw: "M3 12a9 9 0 103-6.7M3 3v6h6",
  warn: "M12 3l10 17H2zM12 9v5M12 17.5v.01",
  refresh: "M21 12a9 9 0 11-2.6-6.3M21 3v6h-6",
  link: "M10 13a5 5 0 007.5.6l3-3a5 5 0 00-7-7l-1.7 1.7M14 11a5 5 0 00-7.5-.6l-3 3a5 5 0 007 7l1.7-1.7",
};

/** A stroked line icon. `size` is the drawn box in CSS pixels. */
export function Icon({ name, size = 16, strokeWidth = 1.7, className, title }) {
  const d = P[name];
  if (!d) return null;
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={strokeWidth}
      strokeLinecap="round" strokeLinejoin="round"
      className={className} aria-hidden={title ? undefined : "true"}
      role={title ? "img" : undefined} focusable="false"
    >
      {title ? <title>{title}</title> : null}
      {d.split("M").filter(Boolean).map((seg, i) => <path key={i} d={"M" + seg} />)}
    </svg>
  );
}

/**
 * The status dot beside a tree node. Build spec 5.3.
 *
 * Shape carries the meaning as well as colour: a filled tick, a hollow ring
 * and a cross read differently in a screenshot printed in black and white,
 * which is how most of these end up in an engineering portfolio.
 */
export function StatusDot({ state, size = 14 }) {
  const s = size;
  const ring = (stroke) => (
    <circle cx="12" cy="12" r="8" fill="none" stroke={stroke} strokeWidth="2" />
  );
  const body = {
    complete: (
      <>
        <circle cx="12" cy="12" r="9" fill="var(--wb-ok)" />
        <path d="M8 12.2l2.6 2.6L16 9.4" fill="none" stroke="var(--wb-on-accent, #fff)"
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </>
    ),
    incomplete: ring("var(--wb-bad)"),
    optional: ring("var(--wb-accent)"),
    // A run in flight, and a run that was stopped. Same ring as "optional"
    // until they earn their own, but never the same word: a cancelled run
    // announced as "Optional" tells a screen reader nothing true about it.
    running: ring("var(--wb-accent)"),
    cancelled: ring("var(--wb-warn)"),
    error: (
      <>
        <circle cx="12" cy="12" r="9" fill="var(--wb-bad)" />
        <path d="M9 9l6 6M15 9l-6 6" fill="none" stroke="var(--wb-on-accent, #fff)"
          strokeWidth="2" strokeLinecap="round" />
      </>
    ),
  }[state] || ring("var(--wb-ink-3)");

  const label = {
    complete: "Complete", incomplete: "Required and incomplete",
    optional: "Optional", error: "Error",
    running: "In progress", cancelled: "Cancelled",
  }[state] || "Not set";

  return (
    <svg width={s} height={s} viewBox="0 0 24 24" role="img" focusable="false">
      <title>{label}</title>
      {body}
    </svg>
  );
}
