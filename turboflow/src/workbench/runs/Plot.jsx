// The convergence and residual charts. Build spec 11.3.
//
// Drawn with an SVG polyline rather than a chart library. A residual plot is
// six series of at most two thousand points on a log axis, and every library
// that draws it brings 60 to 150 kB with it for features this needs none of.
// The whole thing here is about a hundred lines and no dependency.
//
// A log axis is not a preference. Residuals span 1e-8 to 1e0, and on a
// linear scale every series is flat against zero from the tenth iteration
// on, which is exactly the part a team needs to read.
import React, { useMemo, useRef, useState } from "react";
import { Icon } from "../icons";

/* Series colours, from the stylesheet.
 *
 * These were six SimScale hexes, so a residual plot came out in their palette
 * on TurboFlow's dark ground: mid-blue lines on near-black, and axis text in a
 * grey chosen to sit on white. currentColor and the CSS custom properties let
 * the plot follow the theme like everything else.
 *
 * Six because that is how many series a residual plot has (Ux, Uy, Uz, p, k,
 * omega) and they have to stay apart from each other in both themes. */
const COLOURS = [
  "var(--wb-series-1)", "var(--wb-series-2)", "var(--wb-series-3)",
  "var(--wb-series-4)", "var(--wb-series-5)", "var(--wb-series-6)",
];

/**
 * A value on this chart, written for reading rather than for precision.
 *
 * `toPrecision(4)` was here too, and on a residual it is unreadable: a
 * converged Ux of 1.234e-6 came out as "0.000001234". Residuals are read as
 * orders of magnitude, so they go exponential; forces and moments are read as
 * quantities, so they keep a fixed number of places and line up in the legend.
 */
function readable(v, logScale) {
  if (!Number.isFinite(v)) return "-";
  if (v === 0) return "0";
  if (logScale || Math.abs(v) < 1e-3) return v.toExponential(2);
  if (Math.abs(v) >= 1e5) return v.toExponential(2);
  return v.toFixed(Math.abs(v) < 1 ? 4 : 3);
}

/**
 * Round numbers along the x axis.
 *
 * There were none. The axis was titled "Iteration" and carried not one value,
 * so a team could see that their residuals fell and could not say whether that
 * happened by iteration 80 or iteration 800 - which is the thing you look at a
 * convergence plot to find out. Ticks land on 1, 2 or 5 times a power of ten,
 * so they read as 200, 400, 600 rather than 237, 474, 711.
 */
function niceLinearTicks(lo, hi, want = 5) {
  const span = hi - lo;
  if (!(span > 0)) return [lo];
  const raw = span / want;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 0.001; v += step) {
    out.push(Math.round(v * 1e6) / 1e6);
  }
  return out.length ? out : [lo, hi];
}
const W = 560;
const H = 260;
const PAD = { top: 12, right: 14, bottom: 34, left: 54 };

function niceLogTicks(lo, hi) {
  const out = [];
  for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e += 1) {
    out.push(10 ** e);
  }
  return out;
}

export default function Plot({ title, series, xLabel = "Iteration", yLabel, logDefault }) {
  const [log, setLog] = useState(!!logDefault);
  const [at, setAt] = useState(null);
  const svg = useRef(null);

  const model = useMemo(() => {
    const names = Object.keys(series || {});
    let xMin = Infinity;
    let xMax = -Infinity;
    let yMin = Infinity;
    let yMax = -Infinity;
    for (const n of names) {
      for (const [x, y] of series[n]) {
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        if (x < xMin) xMin = x;
        if (x > xMax) xMax = x;
        // A log axis cannot show zero or a negative, and a residual that
        // reaches exactly zero is a converged one, so it is clamped to the
        // bottom of the axis rather than dropped.
        const v = log ? Math.max(y, 1e-12) : y;
        if (v < yMin) yMin = v;
        if (v > yMax) yMax = v;
      }
    }
    if (!Number.isFinite(xMin)) return null;

    /*
     * Scale to the settled part of the run, not the first few iterations.
     *
     * A solver's opening iterations are nonsense: Run 12's drag swung between
     * -68 N and +104 N before settling at 0.21 N. Scaled to all of it, the
     * answer is a flat line on the zero axis and the chart shows a team
     * nothing but their own transient.
     *
     * So the axis is taken from the last three quarters, and the early points
     * are still drawn and simply run off the top. Only on a linear axis: a log
     * residual plot spans its decades on purpose and needs no help.
     */
    let clipped = false;
    if (!log) {
      const cut = xMin + (xMax - xMin) * 0.25;
      let tMin = Infinity;
      let tMax = -Infinity;
      for (const n of names) {
        for (const [x, y] of series[n]) {
          if (x < cut || !Number.isFinite(y)) continue;
          if (y < tMin) tMin = y;
          if (y > tMax) tMax = y;
        }
      }
      // Only worth doing when the transient really is dominating: if the
      // settled range is most of the full range there is nothing to gain.
      if (Number.isFinite(tMin) && (tMax - tMin) < (yMax - yMin) * 0.5) {
        const pad = Math.max((tMax - tMin) * 0.15, 1e-9);
        yMin = tMin - pad;
        yMax = tMax + pad;
        clipped = true;
      }
    }

    if (yMin === yMax) { yMin -= 1; yMax += 1; }
    if (log) { yMin = Math.max(yMin, 1e-12); }
    return { names, xMin, xMax, yMin, yMax, clipped };
  }, [series, log]);

  if (!model) {
    return (
      <div className="wb-plot">
        <h4>{title}</h4>
        <p className="wb-dim">No data yet.</p>
      </div>
    );
  }

  const { names, xMin, xMax, yMin, yMax, clipped } = model;
  const clipId = `wb-plot-clip-${title.replace(/\W+/g, "")}`;
  const px = (x) => PAD.left + ((x - xMin) / Math.max(xMax - xMin, 1e-12))
    * (W - PAD.left - PAD.right);
  const py = (y) => {
    const v = log
      ? (Math.log10(Math.max(y, 1e-12)) - Math.log10(yMin))
        / Math.max(Math.log10(yMax) - Math.log10(yMin), 1e-12)
      : (y - yMin) / Math.max(yMax - yMin, 1e-12);
    return H - PAD.bottom - v * (H - PAD.top - PAD.bottom);
  };

  const ticks = log ? niceLogTicks(yMin, yMax)
    : [0, 0.25, 0.5, 0.75, 1].map((f) => yMin + f * (yMax - yMin));

  const download = (kind) => {
    if (kind === "csv") {
      const rows = [[xLabel, ...names].join(",")];
      const xs = [...new Set(names.flatMap((n) => series[n].map(([x]) => x)))].sort((a, b) => a - b);
      for (const x of xs) {
        rows.push([x, ...names.map((n) => {
          const hit = series[n].find(([sx]) => sx === x);
          return hit ? hit[1] : "";
        })].join(","));
      }
      const blob = new Blob([rows.join("\n")], { type: "text/csv" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${title.replace(/\s+/g, "-").toLowerCase()}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    }
  };

  return (
    <div className="wb-plot">
      <div className="wb-plot-head">
        <h4>{title}</h4>
        {/* Said, not silently done. An axis that does not cover every point on
            the chart has to admit it, or the first iterations look like data
            that went missing. */}
        {clipped ? (
          <span className="wb-dim wb-plot-note">scaled past the start-up</span>
        ) : null}
        <button type="button" className="wb-link" onClick={() => setLog((v) => !v)}>
          {log ? "Linear scale" : "Log scale"}
        </button>
        <button type="button" className="wb-link" onClick={() => download("csv")}>
          Download CSV
        </button>
      </div>

      <svg ref={svg} viewBox={`0 0 ${W} ${H}`} className="wb-plot-svg"
        role="img" aria-label={`${title} chart`}
        onMouseMove={(e) => {
          const r = svg.current.getBoundingClientRect();
          const x = ((e.clientX - r.left) / r.width) * W;
          if (x < PAD.left || x > W - PAD.right) { setAt(null); return; }
          setAt(xMin + ((x - PAD.left) / (W - PAD.left - PAD.right)) * (xMax - xMin));
        }}
        onMouseLeave={() => setAt(null)}
      >
        <defs>
          {/* The early iterations are still drawn; they run off the top rather
              than being dropped, so a team can see there was a transient
              without the axis being given over to it. */}
          <clipPath id={clipId}>
            <rect x={PAD.left} y={PAD.top}
              width={W - PAD.left - PAD.right} height={H - PAD.top - PAD.bottom} />
          </clipPath>
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={py(t)} y2={py(t)}
              stroke="var(--wb-rule)" strokeWidth="1" />
            <text x={PAD.left - 6} y={py(t) + 3} textAnchor="end"
              fontSize="10" fill="var(--wb-ink-3)">
              {log ? t.toExponential(0) : t.toPrecision(3)}
            </text>
          </g>
        ))}
        <line x1={PAD.left} x2={W - PAD.right} y1={H - PAD.bottom} y2={H - PAD.bottom}
          stroke="var(--wb-rule-strong, var(--wb-rule))" />
        {/* The x scale, which the chart never showed. A tick mark as well as a
            label, so the value is tied to a place on the axis rather than
            floating under it. */}
        {niceLinearTicks(xMin, xMax).map((t) => (
          <g key={`x${t}`}>
            <line x1={px(t)} x2={px(t)} y1={H - PAD.bottom} y2={H - PAD.bottom + 4}
              stroke="var(--wb-rule-strong, var(--wb-rule))" />
            <text x={px(t)} y={H - PAD.bottom + 15} textAnchor="middle"
              fontSize="10" fill="var(--wb-ink-3)">
              {t >= 1000 ? `${t / 1000}k` : t}
            </text>
          </g>
        ))}
        <text x={(W - PAD.left) / 2 + PAD.left / 2} y={H - 6} textAnchor="middle"
          fontSize="11" fill="var(--wb-ink-2)">{xLabel}</text>
        {yLabel ? (
          <text x={12} y={H / 2} fontSize="11" fill="var(--wb-ink-2)" textAnchor="middle"
            transform={`rotate(-90 12 ${H / 2})`}>{yLabel}</text>
        ) : null}

        {names.map((n, i) => (
          <polyline
            key={n} fill="none" stroke={COLOURS[i % COLOURS.length]} strokeWidth="1.4"
            clipPath={`url(#${clipId})`}
            points={series[n]
              .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y))
              .map(([x, y]) => `${px(x)},${py(y)}`).join(" ")}
          />
        ))}

        {at != null ? (
          <line x1={px(at)} x2={px(at)} y1={PAD.top} y2={H - PAD.bottom}
            stroke="var(--wb-ink-3)" strokeDasharray="3 3" />
        ) : null}
      </svg>

      <div className="wb-plot-legend">
        {names.map((n, i) => {
          const nearest = at == null ? null : series[n].reduce((best, p) =>
            (best == null || Math.abs(p[0] - at) < Math.abs(best[0] - at) ? p : best), null);
          return (
            <span key={n} className="wb-plot-key">
              <span className="wb-plot-swatch"
                style={{ background: COLOURS[i % COLOURS.length] }} />
              {n}
              {nearest ? <span className="wb-plot-read"> {readable(nearest[1], log)}</span> : null}
            </span>
          );
        })}
      </div>
    </div>
  );
}
