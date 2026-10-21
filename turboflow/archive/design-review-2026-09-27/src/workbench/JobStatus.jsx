// The job status dock at the bottom of the viewer. Build spec 5.7.
//
// Collapsed it is a 32px bar with a summary chip. Expanded it is a table of
// every mesh and run in this group, newest first.
//
// The rows come from a Firestore listener on `runs`, never a poll: a run
// changes stage every few minutes and a poll frequent enough to catch that
// costs a read per tab per interval for hours.
import React, { useEffect, useState } from "react";
import { Icon } from "./icons";

/** "12 min 04 s", ticking, without a re-render of the whole Workbench. */
function Runtime({ startedAt, finishedAt }) {
  const [, force] = useState(0);
  const running = startedAt && !finishedAt;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [running]);

  const start = startedAt?.toMillis ? startedAt.toMillis() : startedAt;
  if (!start) return <span className="wb-dim">not started</span>;
  const end = finishedAt?.toMillis ? finishedAt.toMillis() : (finishedAt || Date.now());
  const s = Math.max(0, Math.round((end - start) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return (
    <span>
      {h ? `${h} h ` : ""}{m} min {String(s % 60).padStart(2, "0")} s
    </span>
  );
}

/**
 * Every status the worker writes, and what to call it.
 *
 * This knew three of them. The worker walks through nine, so a run spent its
 * upload, its import and its whole results download counted as neither active
 * nor finished: it dropped out of the "1 running" chip, lost its Cancel
 * button, and showed a blank status cell. The list is the one in
 * functions/src/lib/types.ts; keep them together.
 */
const LABEL = {
  queued: "Queued",
  uploading_geometry: "Uploading",
  processing: "Reading geometry",
  creating_simulation: "Sending setup",
  checking: "Checking",
  meshing: "Meshing",
  running: "Running",
  downloading_results: "Downloading",
  downloading: "Downloading",
  finished: "Finished", failed: "Failed", cancelled: "Cancelled",
  cancelling: "Cancelling",
};

/** Not finished, failed or cancelled: still ours to watch and to cancel. */
const DONE = new Set(["finished", "failed", "cancelled"]);
export const isActive = (status) => !DONE.has(String(status ?? ""));

/** The ones worth drawing a progress bar for. */
const WITH_PROGRESS = new Set(["meshing", "running", "downloading_results", "downloading"]);

function StatusCell({ run }) {
  const s = run.status;
  if (WITH_PROGRESS.has(s)) {
    const pct = Math.round((run.progress ?? 0) * 100);
    return (
      <span className="wb-job-status">
        <span className="wb-progress" role="progressbar" aria-valuenow={pct}
          aria-valuemin={0} aria-valuemax={100}>
          <span className="wb-progress-fill" style={{ width: `${pct}%` }} />
        </span>
        <span>{LABEL[s]} {pct}%</span>
      </span>
    );
  }
  const tone = s === "finished" ? "ok" : s === "failed" ? "bad"
    : s === "cancelled" ? "warn" : "dim";
  return <span className={`wb-job-status wb-${tone}`}>{LABEL[s] || s}</span>;
}

export default function JobStatus({ runs, onView, onCancel, onLog }) {
  const [open, setOpen] = useState(false);

  const active = runs.filter((r) => isActive(r.status));
  const done = runs.filter((r) => r.status === "finished");
  const chip = active.length ? `${active.length} running`
    : done.length ? `${done.length} finished` : "";

  // Newest first. A run with no created_at yet (the write is still in flight)
  // sorts to the top, which is where the user just put it.
  const rows = [...runs].sort((a, b) => {
    const at = (r) => (r.createdAt?.toMillis ? r.createdAt.toMillis() : Number.MAX_SAFE_INTEGER);
    return at(b) - at(a);
  });

  return (
    <div className={"wb-jobs" + (open ? " wb-jobs-open" : "")}>
      <button type="button" className="wb-jobs-bar" onClick={() => setOpen((v) => !v)}
        aria-expanded={open}>
        <Icon name={open ? "chevronDown" : "chevronUp"} size={14} />
        <span>Job status</span>
        {chip ? <span className="wb-chip">{chip}</span> : null}
      </button>

      {open ? (
        <div className="wb-jobs-body wb-scroll">
          {rows.length ? (
            <table className="wb-jobs-table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  {/* SimScale has a Type column because meshing is a separate
                      job there. In TurboFlow meshing is a stage inside the run,
                      so the column read "Simulation" on every row for ever and
                      cost 78px of a 431px panel to say nothing. */}
                  <th scope="col">Status</th>
                  <th scope="col">Runtime</th>
                  <th scope="col">Cost</th>
                  <th scope="col"><span className="wb-sr">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <div>{r.name || "Run"}</div>
                      <div className="wb-dim">{r.simulationName || ""}</div>
                    </td>
                    <td><StatusCell run={r} /></td>
                    <td><Runtime startedAt={r.startedAt} finishedAt={r.finishedAt} /></td>
                    <td>{r.credits != null ? `${r.credits} credits` : <span className="wb-dim">-</span>}</td>
                    <td className="wb-jobs-actions">
                      {isActive(r.status) ? (
                        <button type="button" className="wb-link" onClick={() => onCancel(r)}>
                          Cancel
                        </button>
                      ) : null}
                      <button type="button" className="wb-link" onClick={() => onView(r)}>View</button>
                      <button type="button" className="wb-link" onClick={() => onLog(r)}>Log</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="wb-empty">Nothing has been run in this group yet.</div>
          )}
        </div>
      ) : null}
    </div>
  );
}
