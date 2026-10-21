// One run: where it is, what it cost, and what it found. Build spec 11.2.
//
// The stage text is the point of this panel. A CFD run is twenty minutes in
// which nothing visible happens, and the difference between a team waiting
// and a team reloading the page is whether the screen says "Meshing 43%" or
// shows a spinner.
import React, { useEffect, useState } from "react";
import { Icon } from "../icons";
import Plot from "./Plot";
import { storage } from "../../lib/firebase";
import {
  HEADLINE, SECONDARY, MIRRORED,
  formatQuantity, unitOf, labelOf, compareQuantity, describeChange,
} from "../../lib/quantities";

/**
 * SimScale's own account of the run, fetched when the section is opened.
 *
 * The panel used to take an `events` prop from `run.events`, and nothing has
 * ever written an `events` field onto a run, so the log read "No events
 * recorded for this run" for every run there has ever been. The log is real
 * and it is saved: the worker puts it in storage next to the results, and now
 * records where. Fetched on open rather than with the run, because it is the
 * one thing here nobody looks at unless something went wrong.
 */
function useEventLog(run, open) {
  const [state, setState] = useState({ status: "idle", entries: [] });
  const paths = run?.logPaths ?? {};
  const path = paths.run || paths.mesh || null;
  useEffect(() => {
    if (!open || !path) return undefined;
    let live = true;
    setState({ status: "loading", entries: [] });
    storage.getJson(path)
      .then((data) => {
        if (!live) return;
        const raw = data?.entries || data?.events || (Array.isArray(data) ? data : []);
        setState({ status: "ready", entries: raw });
      })
      .catch((err) => live && setState({ status: err?.message || "Could not read the log.", entries: [] }));
    return () => { live = false; };
  }, [open, path]);
  return state;
}

const TONE = {
  queued: "dim", uploading_geometry: "dim", processing: "dim", checking: "dim",
  meshing: "accent", running: "accent", downloading_results: "accent",
  finished: "ok", failed: "bad", cancelled: "warn",
};

/** "14 min 02 s", ticking while the run is alive. */
function Elapsed({ from, to }) {
  const [, force] = useState(0);
  const live = from && !to;
  useEffect(() => {
    if (!live) return undefined;
    const t = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [live]);
  const start = from?.toMillis ? from.toMillis() : from;
  if (!start) return <span className="wb-dim">not started</span>;
  const end = to?.toMillis ? to.toMillis() : (to || Date.now());
  const s = Math.max(0, Math.round((end - start) / 1000));
  const m = Math.floor(s / 60);
  return <span>{m} min {String(s % 60).padStart(2, "0")} s</span>;
}

function when(v) {
  const ms = v?.toMillis ? v.toMillis() : v;
  if (!ms) return "-";
  return new Date(ms).toLocaleString(undefined, {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit",
  });
}

/**
 * The finished run before this one, in the same simulation.
 *
 * A CFD result on its own is a number. Against the last run it answers the
 * question a team actually has: did that change help. Only finished runs with
 * a summary count - comparing against a run that failed during meshing would
 * be comparing against nothing.
 */
export function previousRun(runs, run) {
  if (!run || !Array.isArray(runs)) return null;
  const at = (r) => {
    const v = r?.createdAt;
    return v?.toMillis ? v.toMillis() : Number(v) || 0;
  };
  const mine = at(run);
  return runs
    .filter((r) => r.id !== run.id
      && r.simulationId === run.simulationId
      && r.status === "finished"
      && r.summary
      && at(r) < mine)
    .sort((a, b) => at(b) - at(a))[0] ?? null;
}

/**
 * What a finished run produced, in the order a team reads it.
 *
 * This was five rows of a table, every figure the same size, every one put
 * through `toPrecision(4)`. Two things were wrong with that.
 *
 * Hierarchy: drag in newtons is the number that goes into a lap-time
 * calculation and Cd is the number a team is judged on. Lift and Cl matter
 * once those are read. Side force is zero on a half model by construction.
 * Five equal rows make the reader find the important one themselves, every
 * time.
 *
 * Precision: four significant figures is a property of the number rather than
 * of the quantity, so 0.127 N printed as "0.1270" - a digit the solve does not
 * support - and a column of results did not line up, because four significant
 * figures is a different number of decimal places for every value. See
 * lib/quantities.js.
 *
 * `previous` is the run before this one in the same simulation, when there is
 * one. A CFD result on its own is a number; against the last run it is an
 * answer to "did that change help".
 *
 * Exported because the results panel needs the same block. Two copies of this
 * had already drifted once: the copy over there read summary.drag_n, which is
 * a field on the *job* document, so a finished run showed no drag at all.
 */
export function Summary({ summary, previous = null }) {
  if (!summary) return null;
  const has = (k) => summary[k] != null && Number.isFinite(Number(summary[k]));

  const lead = HEADLINE.filter(has);
  const rest = SECONDARY.filter(has);
  // Zero by construction on a half model. Printing three zeroes invites the
  // reader to wonder whether the solve went wrong; one sentence does not.
  const mirrored = MIRRORED.filter((k) => has(k) && Number(summary[k]) !== 0);
  const mirroredAreZero = summary.doubled && MIRRORED.some(has);

  if (!lead.length && !rest.length) return null;

  const cmp = (k) => (previous ? compareQuantity(summary[k], previous[k], k) : null);

  return (
    <div className="wb-results">
      {lead.length ? (
        <div className="wb-results-lead">
          {lead.map((k) => (
            <Figure key={k} k={k} value={summary[k]} cmp={cmp(k)} lead />
          ))}
        </div>
      ) : null}

      {rest.length ? (
        <div className="wb-results-rest">
          {rest.map((k) => (
            <Figure key={k} k={k} value={summary[k]} cmp={cmp(k)} />
          ))}
        </div>
      ) : null}

      {mirrored.length ? (
        <div className="wb-results-rest">
          {mirrored.map((k) => (
            <Figure key={k} k={k} value={summary[k]} cmp={cmp(k)} />
          ))}
        </div>
      ) : null}

      {previous ? (
        <p className="wb-results-note">
          Change against <b>{previous.name || "the previous run"}</b>.
        </p>
      ) : null}

      {/* Half a car in a mirrored tunnel gives half the newtons, and the
          doubling happens in the worker. Said here because a team checking
          TurboFlow against SimScale's own plot would otherwise find a factor
          of two and not know which of the two was lying. */}
      {summary.doubled ? (
        <p className="wb-results-note">
          Half the car was solved against a mirror, so drag, lift and pitch are
          doubled here to give the whole car. Cd and Cl are not: the reference
          area was halved along with the force, so they were already right.
          {mirroredAreZero
            ? " Side force and the roll and yaw moments cancel between the two halves, so they are nothing."
            : ""}
        </p>
      ) : null}
    </div>
  );
}

/**
 * One figure: its name, the number, its unit, and what it did since last time.
 *
 * The change carries an arrow as well as a colour. One man in twelve cannot
 * tell the green from the red, and "drag went down" is the whole point of the
 * line.
 */
function Figure({ k, value, cmp, lead = false }) {
  const unit = unitOf(k);
  return (
    <div className={lead ? "wb-figure wb-figure-lead" : "wb-figure"}>
      <span className="wb-figure-label">{labelOf(k)}</span>
      <span className="wb-figure-value">
        {formatQuantity(value, k)}
        {unit ? <span className="wb-figure-unit">{unit}</span> : null}
      </span>
      {cmp && cmp.delta !== 0 ? (
        <span className={`wb-figure-delta wb-delta-${cmp.direction}`}
          title={describeChange(cmp)}>
          <span aria-hidden="true">{cmp.delta < 0 ? "\u25be" : "\u25b4"}</span>
          {formatQuantity(Math.abs(cmp.delta), k)}
          {cmp.percent == null ? null : (
            <span className="wb-figure-pct">{Math.abs(cmp.percent).toFixed(1)}%</span>
          )}
          <span className="wb-sr">{describeChange(cmp)}</span>
        </span>
      ) : cmp ? (
        <span className="wb-figure-delta wb-delta-neutral">no change</span>
      ) : null}
    </div>
  );
}


/**
 * The stored plot shape turned into the pairs Plot draws.
 *
 * export_plots writes a group of parallel arrays sharing one iteration axis:
 *
 *   forces:    { iterations: [...], drag: [...], lift: [...], side: [...] }
 *   residuals: { iterations: [...], series: { Ux: [...], p: [...] } }
 *
 * Plot wants { name: [[x, y], ...] }. Nothing converted between the two, so
 * `series[n]` was a list of plain numbers and destructuring one as [x, y]
 * threw "is not iterable". The whole run panel went to the error boundary and
 * read "This panel could not be drawn" for any run that had reached the end.
 *
 * It had never been seen because the force plot was matched by a name the
 * Workbench does not use, so `plots` had never actually carried forces, and no
 * run before this one had survived long enough to carry residuals either.
 */
function toPairs(iterations, ys) {
  const xs = iterations ?? [];
  if (!Array.isArray(ys)) return null;
  const out = [];
  for (let i = 0; i < ys.length; i += 1) {
    const x = xs[i] ?? i;
    const y = ys[i];
    if (Number.isFinite(x) && Number.isFinite(y)) out.push([x, y]);
  }
  return out.length ? out : null;
}

/** One named series per key that is actually present. */
function groupSeries(block, keys) {
  if (!block) return null;
  const out = {};
  for (const [key, label] of keys) {
    const pairs = toPairs(block.iterations, block[key]);
    if (pairs) out[label] = pairs;
  }
  return Object.keys(out).length ? out : null;
}

/** Residuals keep their own names, one series per solved variable. */
function residualSeries(block) {
  if (!block?.series) return null;
  const out = {};
  for (const [name, ys] of Object.entries(block.series)) {
    const pairs = toPairs(block.iterations, ys);
    if (pairs) out[name] = pairs;
  }
  return Object.keys(out).length ? out : null;
}

export default function RunPanel({ run, previous = null, onCancel, onPostProcess, onLog }) {
  const [showLog, setShowLog] = useState(false);
  const log = useEventLog(run, showLog);
  const residuals = residualSeries(run.plots?.residuals);
  const forces = groupSeries(run.plots?.forces,
    [["drag", "Drag"], ["lift", "Lift"], ["side", "Side"]]);
  const moments = groupSeries(run.plots?.moments,
    [["roll", "Roll"], ["pitch", "Pitch"], ["yaw", "Yaw"]]);
  const alive = ["queued", "uploading_geometry", "processing", "checking",
    "meshing", "running", "downloading_results"].includes(run.status);
  const tone = TONE[run.status] || "dim";
  const pct = Math.round((run.progress ?? 0) * 100);

  return (
    <>
      <div className="wb-prow">
        <span className="wb-plabel">Creation time</span>
        <span className="wb-pcontrol">{when(run.createdAt)}</span>
      </div>
      <div className="wb-prow">
        <span className="wb-plabel">End time</span>
        <span className="wb-pcontrol">{when(run.finishedAt)}</span>
      </div>
      <div className="wb-prow">
        {/* Before the worker picks the job up, this is time spent waiting, not
            time spent solving. Labelling it "Runtime" told a user whose run sat
            in a Cloud Run queue for eight minutes that their car had been in a
            wind tunnel for eight minutes. */}
        <span className="wb-plabel">{run.startedAt ? "Runtime" : "Waiting"}</span>
        <span className="wb-pcontrol">
          <Elapsed from={run.startedAt || run.createdAt} to={run.finishedAt} />
        </span>
      </div>

      <div className={`wb-runstatus wb-runstatus-${tone}`}>
        <strong>{run.stageText || run.status}</strong>
        {alive ? (
          <span className="wb-progress" role="progressbar" aria-valuenow={pct}
            aria-valuemin={0} aria-valuemax={100}>
            <span className="wb-progress-fill" style={{ width: `${pct}%` }} />
          </span>
        ) : null}
        {/* A failed run beside a red "30 credits" reads as thirty credits
            gone. When the charge was reversed - which it always is when the
            run never reached the solver - say that instead. */}
        <span className="wb-dim">
          {run.refunded > 0 ? `${run.refunded} credits refunded`
            : run.credits != null ? `${run.credits} credits` : ""}
        </span>
      </div>

      {run.error ? <p className="wb-perror">{run.error}</p> : null}
      {/* The technical string, kept out of the headline. A user does not need
          "KeyError: -1" to understand that the run failed, but whoever they
          send the link to does. */}
      {run.errorDetail ? (
        <details className="wb-errdetail">
          <summary>Technical detail</summary>
          <code>{run.errorDetail}</code>
        </details>
      ) : null}

      {run.summary ? <Summary summary={run.summary} previous={previous?.summary ? { ...previous.summary, name: previous.name } : null} /> : null}

      <button type="button" className="wb-psection-head" aria-expanded={showLog}
        onClick={() => setShowLog((v) => !v)}>
        <span>Event log</span>
        <Icon name={showLog ? "chevronDown" : "chevronRight"} size={13} />
      </button>
      {showLog ? (
        <div className="wb-eventlog wb-scroll">
          {log.entries.length ? log.entries.map((e, i) => (
            <div key={i} className={`wb-event wb-event-${(e.severity || e.level || "info").toLowerCase()}`}>
              <span className="wb-dim">{e.time || e.timestamp || ""}</span>{" "}
              {e.message || e.description || ""}
            </div>
          )) : (
            <p className="wb-dim">
              {log.status === "loading" ? "Reading the log"
                : !run.logPaths ? "The solver has not written its log yet."
                  : log.status === "ready" ? "The solver logged nothing for this run."
                    : log.status}
            </p>
          )}
        </div>
      ) : null}

      {residuals ? (
        <Plot title="Residuals" series={residuals} yLabel="Residual" logDefault />
      ) : null}
      {forces ? (
        <Plot title="Forces" series={forces} yLabel="Force (N)" />
      ) : null}
      {/* The worker has always written these and nothing ever drew them.
          Pitch is what tells a team where their downforce actually sits. */}
      {moments ? (
        <Plot title="Moments" series={moments} yLabel="Moment (N m)" />
      ) : null}

      <div className="wb-runfoot">
        <button type="button" className="wb-icon-btn wb-tip" data-tip="Solver log"
          aria-label="Solver log" onClick={onLog}>
          <Icon name="file" size={15} />
        </button>
        {alive ? (
          <button type="button" className="wb-btn" onClick={onCancel}>Cancel</button>
        ) : null}
        {run.status === "finished" ? (
          <button type="button" className="wb-btn wb-btn-primary" onClick={onPostProcess}>
            Post-process results
          </button>
        ) : null}
      </div>
    </>
  );
}
