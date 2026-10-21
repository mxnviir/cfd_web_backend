// The garage: every group, with its best result, one column.
//
// Same chrome and tokens as the Workbench, because they are two screens of one
// tool. SimScale's arrangement (a folder sidebar, a card grid and a details
// column that only filled once a card was selected) went on 25 Sep 2026: the
// three views are tabs over the list, and what the details column held is on
// each row or in its menu.
//
// Counts on the rows are worked out in the browser from three queries that
// this page already needs, rather than from counters kept on the group
// document. A counter is another thing to maintain in every function that
// creates or deletes a child, and the first time one drifts the dashboard
// reports a group has two simulations when it has none.
import React, { useEffect, useMemo, useState } from "react";
import { Icon } from "../workbench/icons";
import { Menu, MenuItem } from "../workbench/TopBar";
import { useUser } from "../workbench/data";
import { currentVersion } from "../lib/geometry";
import { safePath } from "../lib/pages";
import { db, auth, storage, functions } from "../lib/firebase";
import GroupGrid, { sortGroups, SORTS } from "./GroupGrid";
import { isActive } from "../workbench/JobStatus";
import {
  NewGroupDialog, ShareDialog, RenameDialog, ConfirmDialog,
} from "./dialogs";
import "../workbench/tokens.css";
import "../workbench/workbench.css";
import "./dashboard.css";

/** Every document of a collection belonging to the signed-in user, live. */
function useMine(collection, uid) {
  const [state, setState] = useState({ loading: true, rows: [] });
  useEffect(() => {
    if (!uid) { setState({ loading: false, rows: [] }); return; }
    return db.collection(collection).where("userId", "==", uid).onSnapshot(
      (snap) => setState({ loading: false, rows: snap.docs.map((d) => ({ id: d.id, ...d.data() })) }),
      () => setState({ loading: false, rows: [] }),
    );
  }, [collection, uid]);
  return state;
}

const TABS = [["mine", "My groups"], ["shared", "Shared with me"], ["recent", "Recent"]];

/**
 * Signed out: hand over to the site's own sign-in.
 *
 * Not a screen of its own. The site already signs people in - a modal with the
 * TurboFlow mark, "Continue with Google" and the terms line - and a second one
 * here meant two designs to keep in step, which lasted exactly as long as it
 * took to look at it. This sends them to that one and brings them back to
 * whatever they were trying to open.
 */
let signingOut = false;

function SignedOut() {
  useEffect(() => {
    if (signingOut) { location.replace("/"); return; }
    const next = new URLSearchParams(location.search).get("next") || location.pathname;
    // See safePath in lib/pages: the old startsWith test let `/\evil.com`
    // through, and this value is handed straight to the sign-in page.
    const safe = safePath(next, "/dashboard");
    location.replace(`/?signin=1&next=${encodeURIComponent(safe)}`);
  }, []);
  return <div className="db"><div className="wb-boot">Taking you to sign in.</div></div>;
}

export default function DashboardApp() {
  const user = useUser();
  const uid = user?.uid;

  const groups = useMine("groups", uid);
  const geometries = useMine("geometries", uid);
  const simulations = useMine("simulations", uid);
  const runs = useMine("runs", uid);

  const [view, setView] = useState("mine");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("modified");
  const [ascending, setAscending] = useState(false);
  const [dialog, setDialog] = useState(null);
  const [thumbs, setThumbs] = useState({});
  const [credits, setCredits] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!uid) return;
    return db.collection("users").doc(uid).onSnapshot(
      (s) => setCredits(s.exists ? (s.data().credits ?? 0) : 0), () => {});
  }, [uid]);

  const counts = useMemo(() => {
    const out = {};
    const bump = (pid, key) => {
      if (!pid) return;
      out[pid] = out[pid] || { geometries: 0, simulations: 0, runs: 0 };
      out[pid][key] += 1;
    };
    for (const g of geometries.rows) bump(g.groupId, "geometries");
    for (const s of simulations.rows) bump(s.groupId, "simulations");
    // Every run is a run: meshing happens inside one, so there is no separate
    // mesh object to count and `kind === "mesh"` was never written by anything.
    for (const r of runs.rows) bump(r.groupId, "runs");
    return out;
  }, [geometries.rows, simulations.rows, runs.rows]);

  // Each group's lowest drag from a finished run, and a run still going.
  const results = useMemo(() => {
    const out = {};
    for (const r of runs.rows) {
      if (!r.groupId) continue;
      const o = (out[r.groupId] = out[r.groupId] || { best: null, live: null });
      const drag = r.status === "finished" ? r.summary?.drag : null;
      if (Number.isFinite(drag) && !(o.best && o.best.drag <= drag)) {
        o.best = { drag, cd: r.summary?.cd, name: r.name };
      }
      if (isActive(r.status)) o.live = r;
    }
    return out;
  }, [runs.rows]);

  // One thumbnail per group: the first geometry that has one. Signed URLs
  // are fetched once per geometry and kept, because a re-render of the grid
  // must not fire a hundred Storage requests.
  useEffect(() => {
    let stop = false;
    (async () => {
      const wanted = {};
      for (const g of geometries.rows) {
        if (!g.groupId || wanted[g.groupId]) continue;
        const v = currentVersion(g);
        const pictured = v?.thumb_path ? v : Object.entries(g.versions ?? {})
          .filter(([, x]) => x?.thumb_path)
          .sort((a, b) => Number(b[0]) - Number(a[0]))[0]?.[1];
        if (pictured?.thumb_path) wanted[g.groupId] = pictured.thumb_path;
      }
      const next = {};
      await Promise.all(Object.entries(wanted).map(async ([pid, path]) => {
        try { next[pid] = await storage.url(path); } catch { /* no preview, that is all */ }
      }));
      if (!stop) setThumbs(next);
    })();
    return () => { stop = true; };
  }, [geometries.rows]);

  const visible = useMemo(() => {
    let rows = groups.rows;
    if (view === "recent") {
      rows = sortGroups(rows, "modified", false).slice(0, 12);
    }
    if (view === "shared") rows = rows.filter((p) => p.userId !== uid);
    const q = search.trim().toLowerCase();
    if (q) {
      rows = rows.filter((p) =>
        (p.name || "").toLowerCase().includes(q)
        || (p.description || "").toLowerCase().includes(q)
        || (p.tags || []).some((t) => t.toLowerCase().includes(q)));
    }
    return view === "recent" ? rows : sortGroups(rows, sort, ascending, results);
  }, [groups.rows, view, search, sort, ascending, uid, results]);
  /**
   * Call a backend function, without the undefined keys.
   *
   * The callable SDK encodes `undefined` as `null` rather than dropping the
   * key, so a dialog that carefully sends `description: undefined` for an
   * empty box makes the server see `null` and refuse the whole call with
   * "Expected string, received null". Stripping them here means absent is
   * absent, which is what every schema on the other side is written for.
   */
  const call = (name, payload) => {
    const clean = payload && typeof payload === "object" && !Array.isArray(payload)
      ? Object.fromEntries(Object.entries(payload).filter(([, v]) => v !== undefined))
      : payload;
    return functions.httpsCallable(name)(clean).then((r) => r.data);
  };

  const run = async (fn) => {
    setError(null);
    try { await fn(); setDialog(null); }
    catch (err) { setError(err.message || String(err)); throw err; }
  };

  const onMenu = (what, p) => {
    if (what === "copy") {
      return run(() => call("copyGroup", { group_id: p.id })).catch(() => {});
    }
    if (what === "rename") return setDialog({ kind: "rename", group: p });
    if (what === "describe") return setDialog({ kind: "describe", group: p });
    if (what === "share") return setDialog({ kind: "share", group: p });
    if (what === "delete") return setDialog({ kind: "delete", group: p });
    return undefined;
  };

  if (user === undefined) return <div className="db"><div className="wb-boot">Loading</div></div>;
  if (user === null) return <SignedOut />;

  const initial = (user.displayName || user.email || "?").trim()[0].toUpperCase();

  return (
    <div className="db wb">
      <header className="wb-topbar">
        <a className="wb-logo" href="/" aria-label="TurboFlow home">
          <svg width="28" height="28" viewBox="0 0 32 32" aria-hidden="true">
            <circle cx="16" cy="16" r="15" fill="var(--wb-accent)" />
            <path d="M8 20c6 0 6-8 12-8M8 13h5M19 22h5" fill="none" stroke="var(--wb-on-accent)"
              strokeWidth="2.2" strokeLinecap="round" />
          </svg>
        </a>
        <span className="db-brand-text">TurboFlow</span>
        <span className="db-search">
          <label htmlFor="db-q" className="wb-sr">Search groups</label>
          <input id="db-q" className="wb-field" value={search} placeholder="Search groups"
            onChange={(e) => setSearch(e.target.value)} />
          <Icon name="search" size={14} />
        </span>
        <div className="wb-topbar-right">
          <a className="wb-credits" href="/billing" title="Add credits">
            <span className="wb-credits-n">{credits == null ? "-" : credits.toLocaleString()}</span> credits
          </a>
          <button type="button" className="wb-btn wb-btn-primary"
            onClick={() => setDialog({ kind: "newGroup" })}>
            New group
          </button>
          <Menu label={<>
            <span className="wb-avatar" aria-hidden="true">{initial}</span>
            <span className="wb-user-name">{user.displayName || user.email}</span>
          </>}>
            <MenuItem onClick={() => location.assign("/billing")}>Credits and billing</MenuItem>
            <MenuItem onClick={() => location.assign("/simulations")}>Fusion 360 connection</MenuItem>
            <MenuItem onClick={() => location.assign("/docs")}>Setup guide</MenuItem>
            <MenuItem onClick={() => { signingOut = true; auth.signOut(); }}>Sign out</MenuItem>
          </Menu>
        </div>
      </header>

      <main className="db-garage">
        <div className="db-head">
          <h1 className="db-title">Garage</h1>
          <nav className="db-tabs" aria-label="Which groups">
            {TABS.map(([id, label]) => (
              <button key={id} type="button" className="db-tab"
                aria-current={view === id ? "page" : undefined}
                onClick={() => setView(id)}>
                {label}
              </button>
            ))}
          </nav>
          {view !== "recent" ? (
            <span className="db-sort">
              <select className="wb-field wb-select" value={sort} aria-label="Sort by"
                onChange={(e) => setSort(e.target.value)}>
                {SORTS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
              </select>
              <button type="button" className="wb-icon-btn wb-tip"
                data-tip={ascending ? "Ascending" : "Descending"}
                aria-label={ascending ? "Sorted ascending" : "Sorted descending"}
                onClick={() => setAscending(!ascending)}>
                <Icon name={ascending ? "chevronUp" : "chevronDown"} size={15} />
              </button>
            </span>
          ) : null}
        </div>

        {error ? (
          <div className="wb-banner db-banner" role="alert">
            <Icon name="warn" size={15} /> {error}
            <button type="button" className="wb-icon-btn" aria-label="Dismiss"
              onClick={() => setError(null)}><Icon name="x" size={13} /></button>
          </div>
        ) : null}

        <GroupGrid
          groups={visible} counts={counts} results={results} thumbs={thumbs}
          loading={groups.loading} filter={view} onMenu={onMenu}
        />
      </main>

      {dialog?.kind === "newGroup" ? (
        <NewGroupDialog onClose={() => setDialog(null)}
          onCreate={async (payload) => {
            const res = await call("createGroup", payload);
            // Straight into the Workbench with the upload dialog open, per 4.6.
            location.assign(`/workbench/${res.group_id}/geometry/new`);
          }} />
      ) : null}

      {dialog?.kind === "rename" ? (
        <RenameDialog title="Rename group" value={dialog.group.name}
          onClose={() => setDialog(null)}
          onSave={(name) => run(() => call("updateGroup", { group_id: dialog.group.id, name }))} />
      ) : null}

      {dialog?.kind === "describe" ? (
        <RenameDialog title="Description" value={dialog.group.description || ""}
          onClose={() => setDialog(null)}
          onSave={(description) =>
            run(() => call("updateGroup", { group_id: dialog.group.id, description }))} />
      ) : null}

      {dialog?.kind === "share" ? (
        <ShareDialog group={dialog.group}
          people={dialog.group.sharedEmails || {}}
          onClose={() => setDialog(null)}
          onShare={(email, permission) =>
            call("shareGroup", { group_id: dialog.group.id, email, permission })}
          onUnshare={(who) =>
            call("unshareGroup", { group_id: dialog.group.id, uid: who })} />
      ) : null}

      {dialog?.kind === "delete" ? (
        <ConfirmDialog
          title="Delete group" confirmLabel="Delete group"
          message={`Delete group "${dialog.group.name}"? This removes all geometries, simulations and results. This cannot be undone.`}
          onClose={() => setDialog(null)}
          busyLabel="Deleting…"
          onConfirm={() => run(() => call("deleteGroup", { group_id: dialog.group.id }))} />
      ) : null}
    </div>
  );
}
