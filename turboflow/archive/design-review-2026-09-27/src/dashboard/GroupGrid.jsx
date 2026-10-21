// The garage: one row per group, with the number that matters on it.
//
// It replaced SimScale's project grid on 25 Sep 2026: cards with a picture, an
// italic "by" line and a footer of icon counts ("Statistics 1 0 0"), a
// details column you had to select a card to fill, and grid/list toggles. A
// team opening TurboFlow wants to know which car is fastest and whether
// anything is still running, so each row says exactly that: the best drag
// and its Cd, how many runs there have been, and the one in progress.
import React, { useEffect, useRef, useState } from "react";
import { Icon } from "../workbench/icons";
import { formatQuantity } from "../lib/quantities";

const MODIFIED = (p) => {
  const v = p.updatedAt || p.createdAt;
  const ms = v?.toMillis ? v.toMillis() : (typeof v === "number" ? v : 0);
  return ms;
};

export const SORTS = [
  ["modified", "Last modified"], ["name", "Name"], ["created", "Created"], ["best", "Lowest drag"],
];

export function sortGroups(rows, by, ascending, results = {}) {
  const key = {
    modified: MODIFIED,
    created: (p) => (p.createdAt?.toMillis ? p.createdAt.toMillis() : 0),
    name: (p) => (p.name || "").toLowerCase(),
    // Groups with no finished run go last whichever way round.
    best: (p) => results[p.id]?.best?.drag ?? (ascending ? Infinity : -Infinity),
  }[by] || MODIFIED;
  const out = [...rows].sort((a, b) => {
    const x = key(a);
    const y = key(b);
    return x < y ? -1 : x > y ? 1 : 0;
  });
  return ascending ? out : out.reverse();
}

function when(ms) {
  if (!ms) return "not yet";
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short", day: "numeric", year: "numeric",
  });
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function RowMenu({ onPick, name }) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (!box.current?.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === "Escape") setOpen(false); };
    addEventListener("pointerdown", away);
    addEventListener("keydown", esc);
    return () => { removeEventListener("pointerdown", away); removeEventListener("keydown", esc); };
  }, [open]);
  const items = [
    ["rename", "Rename"], ["describe", "Edit description"], ["copy", "Make a copy"],
    ["share", "Share"], ["delete", "Delete"],
  ];
  return (
    <span ref={box} className="wb-row-menu db-row-menu">
      <button type="button" className="wb-icon-btn" aria-label={`Actions for ${name}`}
        aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Icon name="dots" size={16} />
      </button>
      {open ? (
        <span className="wb-menu wb-menu-right" role="menu">
          {items.map(([id, label]) => (
            <button key={id} type="button" role="menuitem"
              className={"wb-menu-item" + (id === "delete" ? " wb-menu-item-bad" : "")}
              onClick={() => { setOpen(false); onPick(id); }}>
              {label}
            </button>
          ))}
        </span>
      ) : null}
    </span>
  );
}

function Row({ group, counts, result, thumb, onMenu }) {
  const best = result?.best;
  const live = result?.live;
  const pct = Math.round((live?.progress ?? 0) * 100);
  return (
    <li className="db-row">
      <a className="db-row-open" href={`/workbench/${group.id}`}>
        <span className="db-thumb">
          {thumb ? <img src={thumb} alt="" /> : <span>No picture yet</span>}
        </span>
        <span className="db-row-what">
          <span className="db-row-name">{group.name}</span>
          <span className="db-row-desc">{group.description || "No description"}</span>
          <span className="db-row-meta">
            {plural(counts.geometries, "car", "cars")}
            {" · "}{plural(counts.runs, "run", "runs")}
            {" · "}changed {when(MODIFIED(group))}
          </span>
        </span>
        <span className="db-row-best">
          {best ? (
            <>
              <span className="db-row-label">Best drag</span>
              <span className="db-row-fig">
                {formatQuantity(best.drag, "drag")}<span className="db-row-unit">N</span>
              </span>
              <span className="db-row-sub">
                {Number.isFinite(best.cd) ? `Cd ${formatQuantity(best.cd, "cd")} · ` : ""}
                {best.name || "a run"}
              </span>
            </>
          ) : (
            <span className="db-row-none">
              {counts.runs ? "No finished run yet" : "Not run yet"}
            </span>
          )}
        </span>
        <span className="db-row-live">
          {live ? (
            <>
              <span className="db-row-live-name">{live.name || "A run"}</span>
              <span className="db-row-progress" role="progressbar" aria-valuenow={pct}
                aria-valuemin={0} aria-valuemax={100}
                aria-label={`${live.name || "Run"} progress`}>
                <span style={{ width: `${pct}%` }} />
              </span>
              <span className="db-row-sub">{live.stageText || live.status}</span>
            </>
          ) : null}
        </span>
      </a>
      <RowMenu name={group.name} onPick={onMenu} />
    </li>
  );
}

export default function GroupGrid({
  groups, counts, results, thumbs, loading, filter, onMenu,
}) {
  if (loading) {
    // Three rows the shape of the ones that are coming.
    return (
      <ol className="db-rows" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <li key={i} className="db-row db-row-skel">
            <span className="db-thumb wb-skel" />
            <span className="db-row-what">
              <span className="wb-skel db-skel-line" />
              <span className="wb-skel db-skel-line db-skel-short" />
            </span>
          </li>
        ))}
      </ol>
    );
  }
  if (!groups.length) {
    return (
      <p className="db-empty">
        {filter === "shared"
          ? "Nobody has shared a group with you. When someone does, it is listed here."
          : "No groups yet. A group holds a car and every run of it: press New group, import a STEP, IGES or STL file, and TurboFlow builds the wind tunnel round it."}
      </p>
    );
  }
  return (
    <ol className="db-rows">
      {groups.map((p) => (
        <Row key={p.id} group={p}
          counts={counts[p.id] || { geometries: 0, simulations: 0, runs: 0 }}
          result={results[p.id]} thumb={thumbs[p.id]}
          onMenu={(what) => onMenu(what, p)} />
      ))}
    </ol>
  );
}
