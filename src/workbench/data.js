// Everything the Workbench reads from the database, in one place.
//
// One listener per collection, started once when the group opens and stopped
// when it closes. The spec is explicit about this in 5.7: job status comes
// from a listener on `runs` and the browser never polls. The same applies to
// the rest of it, and for a reason beyond tidiness. A poll shows a stale tree
// for as long as its interval; a listener shows the run going from queued to
// running the moment the pipeline says so, which is the difference between the
// Workbench feeling alive and feeling like a page you have to refresh.
import { useEffect, useMemo, useRef, useState } from "react";
import { db, auth, isLocal, functions } from "../lib/backend";

/** Who is signed in, or null. `undefined` while Auth is still deciding. */
export function useUser() {
  const [user, setUser] = useState(undefined);
  useEffect(() => {
    let stopped = false;
    const off = auth.onAuthStateChanged(async (u) => {
      // Local development only: the Workbench bounces to sign-in without a
      // user, so a localhost page signs in anonymously instead of clicking
      // through Google, and makes itself an account (a development project
      // allows that for an anonymous session; production allows Google
      // only). Non-localhost keeps the real sign-in flow.
      if (!u && isLocal) {
        try { await auth.signInAnonymously(); } catch { if (!stopped) setUser(null); }
        return;
      }
      if (u?.isAnonymous && isLocal) {
        await functions.httpsCallable("ensureAccount")({}).catch(() => undefined);
      }
      if (!stopped) setUser(u);
    });
    return () => { stopped = true; off(); };
  }, []);
  return user;
}

/**
 * One document, live.
 *
 * A row this user may not read and a row that is not there look the same:
 * RLS filters it out and the read comes back empty, so nobody can probe
 * which group ids are real. To this user the two are the same thing anyway:
 * a group they cannot open. Only a genuine failure, such as the network
 * being down, is reported as an error.
 */
const GONE = new Set(["permission-denied", "not-found"]);

export function useDoc(collection, id) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  useEffect(() => {
    if (!id) { setState({ loading: false, data: null, error: null }); return; }
    return db.collection(collection).doc(id).onSnapshot(
      (snap) => setState({
        loading: false,
        data: snap.exists ? { id: snap.id, ...snap.data() } : null,
        error: null,
      }),
      (error) => setState({
        loading: false,
        data: null,
        error: GONE.has(error?.code) ? null : error,
      }),
    );
  }, [collection, id]);
  return state;
}

/**
 * Every document in a collection belonging to one group, live.
 *
 * Ordered in the browser rather than by the query. An orderBy on a field some
 * documents do not have drops those documents silently, and a geometry written
 * before created_at existed would simply not appear in the tree with no error
 * anywhere to explain it.
 */
export function useGroupCollection(collection, groupId, orderField = "createdAt") {
  const [state, setState] = useState({ loading: true, rows: [], error: null });
  useEffect(() => {
    if (!groupId) { setState({ loading: false, rows: [], error: null }); return; }
    return db.collection(collection).where("groupId", "==", groupId).onSnapshot(
      (snap) => setState({
        loading: false,
        rows: snap.docs.map((d) => ({ id: d.id, ...d.data() })),
        error: null,
      }),
      (error) => setState({ loading: false, rows: [], error }),
    );
  }, [collection, groupId]);

  const rows = useMemo(() => {
    const at = (r) => {
      const v = r[orderField];
      return v?.toMillis ? v.toMillis() : (typeof v === "number" ? v : 0);
    };
    return [...state.rows].sort((a, b) => at(a) - at(b));
  }, [state.rows, orderField]);

  return { ...state, rows };
}

/**
 * One writer for every save, so the "All changes saved" text in the top bar is
 * always telling the truth. Build spec 3.2.
 *
 * The status is deliberately not a plain boolean. Two saves can be in flight at
 * once, and a counter is the only way "saving" survives the first of them
 * finishing while the second is still going.
 */
export function useSaver() {
  const [status, setStatus] = useState("saved");   // saved | saving | error
  const pending = useRef(0);
  const lastFailed = useRef(null);

  const save = async (fn) => {
    pending.current += 1;
    setStatus("saving");
    try {
      const out = await fn();
      pending.current -= 1;
      if (pending.current === 0) setStatus("saved");
      return out;
    } catch (err) {
      pending.current -= 1;
      lastFailed.current = fn;
      setStatus("error");
      throw err;
    }
  };

  const retry = () => (lastFailed.current ? save(lastFailed.current) : undefined);
  return { status, save, retry };
}

/**
 * Warn when the same group is open twice. Build spec 3.3.
 *
 * A tab id and a thirty second heartbeat on the group document. Whoever
 * wrote last owns it; everyone else shows the banner. This does not lock
 * anything, and it is not meant to: two people editing one group is rare
 * enough that telling them beats blocking one of them out.
 */
const TAB_ID = Math.random().toString(36).slice(2, 10);

export function useTabLock(groupId, group) {
  const [conflict, setConflict] = useState(false);

  useEffect(() => {
    if (!groupId) return;
    let stopped = false;
    const beat = () => {
      if (stopped) return;
      db.collection("groups").doc(groupId)
        .update({ lock: { tab: TAB_ID, at: Date.now() } })
        .catch(() => {});                 // a viewer cannot write; that is fine
    };
    beat();
    const timer = setInterval(beat, 30000);
    return () => { stopped = true; clearInterval(timer); };
  }, [groupId]);

  useEffect(() => {
    const lock = group?.lock;
    // Older than a minute and a half means the other tab is gone, not busy:
    // three missed heartbeats.
    setConflict(!!lock && lock.tab !== TAB_ID && Date.now() - (lock.at || 0) < 90000);
  }, [group?.lock]);

  return conflict;
}
