// What a finished run produced, and how to get at it.
//
// The full post-processor is build spec section 12: filters, a legend, parts,
// cutting planes, streamlines. It needs a VTK service behind it and it is not
// built yet. Until it is, "Post-process results" navigated to a route where
// nothing rendered at all: the panel disappeared and the viewer sat there, and
// nothing on screen said whether the run had produced anything.
//
// So this is the honest interim. It lists what the run actually wrote, with
// every file a download away, and says plainly what is still coming. A team can
// get their drag number and their fields out of TurboFlow today; they just
// cannot yet colour the car with them in the browser.
import React, { useEffect, useState } from "react";
import { Note } from "../panels/fields";
import { Icon } from "../icons";
import { storage, auth } from "../../lib/backend";
import { finishRun } from "../results/finish";
import { Summary } from "./RunPanel";

const KB = (n) => (n == null ? null : `${Math.round(n / 1024).toLocaleString()} KB`);

/** A download that resolves its URL only when asked, so nothing is fetched early. */
function FileRow({ label, path, hint }) {
  const [state, setState] = useState("idle");
  if (!path) return null;
  const open = async () => {
    setState("working");
    try {
      const url = await storage.url(path);
      window.open(url, "_blank", "noopener");
      setState("idle");
    } catch (err) {
      setState(err?.message || "Could not open that file.");
    }
  };
  return (
    <li className="wb-filerow">
      <span className="wb-filerow-main">
        <b>{label}</b>
        {hint ? <span className="wb-muted"> {hint}</span> : null}
      </span>
      <button type="button" className="wb-btn" onClick={open} disabled={state === "working"}>
        <Icon name="download" size={14} /> {state === "working" ? "Opening" : "Download"}
      </button>
      {state !== "idle" && state !== "working" ? <span className="wb-perror">{state}</span> : null}
    </li>
  );
}

/**
 * What each field is, in the words and units a team reads it in.
 *
 * The units are the solver's own, read from the case headers: SimScale writes
 * pressure in pascals, relative to the outlet, not the kinematic pressure
 * OpenFOAM's incompressible solvers use internally.
 */
const FIELD_INFO = {
  p: { label: "Pressure", unit: "Pa", scale: "div" },
  U: { label: "Air speed", unit: "m/s", scale: "seq" },
  k: { label: "Turbulent kinetic energy", unit: "m²/s²", scale: "seq" },
  omega: { label: "Specific dissipation", unit: "1/s", scale: "seq" },
  nut: { label: "Turbulent viscosity", unit: "m²/s", scale: "seq" },
};
const STEPS = { div: 11, seq: 7 };

const fmt = (v) => {
  if (!Number.isFinite(v)) return "";
  const a = Math.abs(v);
  return a !== 0 && (a < 0.01 || a >= 1e5) ? v.toExponential(2) : Number(v.toPrecision(3)).toString();
};

/**
 * The legend drawn over the viewer while a field is showing.
 *
 * The bar is built from the same steps the car is coloured with, as blocks
 * rather than a CSS gradient: the reader sees the actual stops.
 */
export function FieldLegend({ field }) {
  if (!field) return null;
  return (
    <div className="wb-field-legend" aria-label={`Colour scale: ${field.label}`}>
      <div className="wb-field-legend-title">{field.label}, {field.unit}</div>
      <div className="wb-field-legend-bar" aria-hidden="true">
        {field.stops.map((s, i) => <span key={i} style={{ background: s }} />)}
      </div>
      <div className="wb-field-legend-ticks">
        <span>{fmt(field.lo)}</span>
        {field.scale === "div" ? <span>0</span> : null}
        <span>{fmt(field.hi)}</span>
      </div>
      {field.half ? (
        <p className="wb-field-legend-note">
          Half the car, as it was solved. The other half is its mirror image.
        </p>
      ) : null}
    </div>
  );
}

export default function ResultsPanel({ run, engine, onField }) {
  // The worker writes results_glb_path and results_fields; the Firestore shim
  // in lib/backend.js converts top-level keys to camelCase on the way in, so
  // what arrives here is resultsGlbPath and resultsFields. Two separate
  // mistakes were made on this one line: first reading a `results` object that
  // nothing has ever written, then reading the worker's snake_case spelling
  // rather than the spelling the client is handed.
  const glbPath = run?.resultsGlbPath ?? null;
  const casePath = run?.casePath ?? null;
  const fields = run?.resultsFields ?? {};
  const summary = run?.summary ?? {};
  // Pressure first, then speed, then the turbulence quantities: the order a
  // team reads them in, not the order the database happens to hold them.
  const names = Object.keys(FIELD_INFO).filter((n) => fields[n]);
  const root = React.useRef(null);
  const [shown, setShown] = useState("");
  const [state, setState] = useState("idle");

  // Put the model back when this panel closes or moves to another run.
  useEffect(() => () => { engine?.hideField(); onField?.(null); }, [engine, run?.id]);

  // FINISH. A run arrives with SimScale's case and no viewer files; the
  // owner's first look converts it here, once, and the row updates itself
  // (resultsGlbPath appears) when it is filed. A collaborator waits for that.
  const isOwner = !!run && auth.currentUser?.uid === run.userId;
  const needsFinish = run?.status === "finished" && !!casePath && !glbPath;
  const [finishing, setFinishing] = useState(null);
  useEffect(() => {
    if (!needsFinish || !isOwner || finishing) return;
    setFinishing({ fraction: 0, text: "Preparing the 3D results" });
    finishRun(run, (fraction, text) => setFinishing({ fraction, text }))
      .catch((err) => setFinishing({ error: err?.message || String(err) }));
  }, [needsFinish, isOwner, run?.id, finishing === null]);

  const colourBy = async (name) => {
    setShown(name);
    if (!name) { engine?.hideField(); onField?.(null); setState("idle"); return; }
    const info = FIELD_INFO[name];
    const f = fields[name];
    setState("working");
    try {
      const css = getComputedStyle(root.current);
      const stops = Array.from({ length: STEPS[info.scale] },
        (_, i) => css.getPropertyValue(`--wb-${info.scale}-${i + 1}`).trim());
      const [glbUrl, fieldUrl] = await Promise.all([storage.url(glbPath), storage.url(f.path)]);
      const res = await fetch(fieldUrl);
      if (!res.ok) throw new Error(`the ${info.label.toLowerCase()} values could not be read (${res.status})`);
      const values = new Float32Array(await res.arrayBuffer());
      // Pressure is centred on zero, so suction and pressure of the same size
      // get the same depth of colour. Magnitudes run from their smallest.
      const reach = Math.max(Math.abs(f.min), Math.abs(f.max));
      const lo = info.scale === "div" ? -reach : f.min;
      const hi = info.scale === "div" ? reach : f.max;
      await engine.showField(glbUrl, values, stops, lo, hi);
      onField?.({ ...info, lo, hi, stops, half: !!summary.doubled });
      setState("idle");
    } catch (err) {
      setState(err?.message || String(err));
    }
  };

  if (run?.status !== "finished") {
    return (
      <Note>
        This run has not finished, so there are no results yet.
        {run?.status === "failed" ? " It failed; the reason is on the run." : null}
      </Note>
    );
  }

  return (
    <div ref={root}>
      <Summary summary={summary} />

      {needsFinish ? (
        isOwner ? (
          <div className="wb-field-pick" role="status">
            {finishing?.error ? (
              <p className="wb-perror" role="alert">
                The 3D results could not be prepared: {finishing.error}
                {" "}<button type="button" className="wb-btn" onClick={() => setFinishing(null)}>Try again</button>
              </p>
            ) : (
              <span className="wb-muted">
                {finishing?.text ?? "Preparing the 3D results"} {Math.round((finishing?.fraction ?? 0) * 100)}%
                {" "}(once, the first time this run is opened)
              </span>
            )}
          </div>
        ) : (
          <Note>
            The 3D results are prepared the first time the run's owner opens
            it. The forces above are ready now.
          </Note>
        )
      ) : null}

      {glbPath && names.length ? (
        <div className="wb-field-pick">
          <label htmlFor="wb-colour-by">Colour the car by</label>
          <select id="wb-colour-by" className="wb-field wb-select" value={shown}
            disabled={!engine || state === "working"}
            onChange={(e) => colourBy(e.target.value)}>
            <option value="">Nothing, show the model</option>
            {names.map((n) => <option key={n} value={n}>{FIELD_INFO[n].label}</option>)}
          </select>
          {state === "working" ? <span className="wb-muted">Loading the results</span> : null}
          {state !== "idle" && state !== "working" ? <p className="wb-perror" role="alert">{state}</p> : null}
        </div>
      ) : null}

      <ul className="wb-filelist">
        <FileRow label="Full case for ParaView" path={casePath}
          hint="OpenFOAM. Unzip it and open case.foam. Kept for 90 days." />
        <FileRow label="Surface model" path={glbPath}
          hint="glTF, the car's surface as the solver saw it" />
        {names.map((n) => (
          <FileRow key={n} label={`${FIELD_INFO[n].label}, ${FIELD_INFO[n].unit}`} path={fields[n]?.path}
            hint={Number.isFinite(fields[n]?.min)
              ? `${fmt(fields[n].min)} to ${fmt(fields[n].max)}, one value per surface point`
              : "one value per surface point"} />
        ))}
      </ul>

      {!names.length && !needsFinish ? (
        <Note>
          This run has no surface results. That happens when the solver stopped
          before its first write, or when the run finished before TurboFlow could
          read the results SimScale sends. The forces above come from the plots
          and do not depend on it.
        </Note>
      ) : null}
    </div>
  );
}
