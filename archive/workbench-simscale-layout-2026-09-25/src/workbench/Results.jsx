// What the runs did: status while they go, numbers and plots when they finish.
//
// Its own view rather than a panel floating over the model, because reading a
// convergence plot and turning a car round are two different jobs and the one
// you are not doing should not be taking half the screen. In split view they
// sit side by side with a divider you can move, which is the case where you
// are doing both: watching residuals while you look at the thing they belong
// to.
import React, { useEffect, useState } from "react";
import { Icon, StatusDot } from "./icons";
import RunPanel, { previousRun } from "./runs/RunPanel";
import { Note } from "./panels/fields";

const dotFor = (status) => (status === "finished" ? "complete"
  : status === "failed" ? "error"
    : status === "cancelled" ? "cancelled" : "running");

/** One row per run, newest last, with whatever number it has so far. */
function RunList({ runs, selected, onSelect }) {
  return (
    <div className="rv-list">
      {runs.map((r, i) => (
        <button
          key={r.id} type="button"
          className={"rv-run" + (r.id === selected ? " rv-run-on" : "")}
          aria-current={r.id === selected}
          onClick={() => onSelect(r.id)}
        >
          <StatusDot state={dotFor(r.status)} />
          <span className="rv-run-name">{r.name || `Run ${i + 1}`}</span>
          <span className="rv-run-val">
            {r.summary?.drag != null
              ? `${r.summary.drag.toFixed(3)} N`
              : r.status === "failed" ? "failed"
                : r.stageText || r.status}
          </span>
        </button>
      ))}
    </div>
  );
}

export default function Results({ runs = [], simulation, onCancel, onPostProcess, compact }) {
  // Whichever run the user last looked at, defaulting to the newest. Held here
  // rather than in the URL: switching views should not lose it, and it is not
  // worth a history entry.
  const [picked, setPicked] = useState(null);
  const newest = runs.length ? runs[runs.length - 1] : null;
  const run = runs.find((r) => r.id === picked) ?? newest;

  // Follow the newest run when one is queued, unless the user has chosen one.
  useEffect(() => {
    if (!picked && newest) setPicked(newest.id);
  }, [newest, picked]);

  if (!runs.length) {
    return (
      <div className="wb-card rv rv-empty">
        <Icon name="play" size={22} />
        <p className="rv-empty-title">No runs yet</p>
        <p className="rv-empty-note">
          Finish the steps and queue one. Its progress, its forces and its
          convergence all appear here.
        </p>
      </div>
    );
  }

  return (
    <div className={"wb-card rv" + (compact ? " rv-compact" : "")}>
      <div className="rv-head">
        <span className="rv-title">
          {simulation?.name ? `${simulation.name} · ` : ""}Runs
          <span className="wb-dim"> ({runs.length})</span>
        </span>
      </div>
      <RunList runs={runs} selected={run?.id} onSelect={setPicked} />
      <div className="rv-body wb-scroll">
        {run ? (
          <RunPanel
            run={run}
            previous={previousRun(runs, run)}
            onCancel={() => onCancel?.(run)}
            onPostProcess={() => onPostProcess?.(run)}
            onLog={() => onPostProcess?.(run, "log")}
          />
        ) : <Note>Pick a run.</Note>}
      </div>
    </div>
  );
}
