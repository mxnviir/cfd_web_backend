// The selection model. Build spec 6.3.
//
//   selection = { mode: 'solid'|'face'|'edge'|'node', ids: Set }
//
// Click selects one and clears the rest. Ctrl or Cmd click toggles. Shift
// click adds. A click on empty background clears.
//
// Selection is held as face ids even in solid mode, because that is what the
// viewer paints and what an assignment eventually stores. Solid mode changes
// what a click means, not what a selection is.
import { useCallback, useMemo, useRef, useState } from "react";

export default function useSelection(viewer) {
  const [mode, setMode] = useState("face");
  const [ids, setIds] = useState([]);
  const [hover, setHover] = useState([]);
  const [hidden, setHidden] = useState([]);
  // Assignment mode: while a panel owns the clicks, they go into its list
  // rather than changing what is selected. Build spec 5.4.
  const [assigning, setAssigningState] = useState(null);

  /*
   * A state setter given a function calls it with the previous state, which
   * is React's updater form. The sink a panel installs here IS a function,
   * so `setAssigning(fn)` handed the panel's callback the old callback
   * instead of the clicked faces, and the viewer threw "clicked is not
   * iterable" on the first click into an assignment box.
   */
  const setAssigning = useCallback((fn) => setAssigningState(() => fn), []);
  // What the open panel has already assigned, painted blue so the user can
  // see which faces are spoken for before they click. Build spec 5.4.
  const [assigned, setAssignedFaces] = useState([]);
  const assignRef = useRef(null);
  assignRef.current = assigning;

  /** What a click on this face means, given the mode. */
  const expand = useCallback((face) => {
    if (face == null) return [];
    if (mode === "solid" && viewer) return viewer.facesOfSolids([face]);
    return [face];
  }, [mode, viewer]);

  const click = useCallback((face, event) => {
    const next = expand(face);
    if (assignRef.current) {
      assignRef.current(next);
      return;
    }
    if (face == null) { setIds([]); return; }
    const toggle = event?.ctrlKey || event?.metaKey;
    const add = event?.shiftKey;
    setIds((prev) => {
      if (toggle) {
        const set = new Set(prev);
        for (const f of next) { if (set.has(f)) set.delete(f); else set.add(f); }
        return [...set];
      }
      if (add) return [...new Set([...prev, ...next])];
      return next;
    });
  }, [expand]);

  const hoverFace = useCallback((face) => {
    setHover(face == null ? [] : expand(face));
  }, [expand]);

  const actions = useMemo(() => ({
    clear: () => setIds([]),
    set: (list) => setIds([...new Set(list)]),
    add: (list) => setIds((p) => [...new Set([...p, ...list])]),
    invert: () => setIds((p) => {
      const has = new Set(p);
      const out = [];
      for (let i = 0; i < (viewer?.faces.length || 0); i += 1) if (!has.has(i)) out.push(i);
      return out;
    }),
    hide: () => setHidden((h) => [...new Set([...h, ...ids])]),
    showAll: () => setHidden([]),
    isolate: () => {
      const keep = new Set(ids);
      const out = [];
      for (let i = 0; i < (viewer?.faces.length || 0); i += 1) if (!keep.has(i)) out.push(i);
      setHidden(out);
    },
    expandTangent: () => viewer && setIds(viewer.tangentFaces(ids)),
    expandArea: () => viewer && setIds(viewer.sameArea(ids)),
    expandRadius: () => viewer && setIds(viewer.sameRadius(ids)),
  }), [ids, viewer]);

  /*
   * One object, memoised.
   *
   * A fresh object literal every render is a fresh dependency for every
   * effect that watches it, and the panel's effects write state, so the pair
   * of them looped until React gave up with "Maximum update depth exceeded"
   * and unmounted the whole Workbench to a blank page.
   */
  return useMemo(() => ({
    mode, setMode, ids, hover, hidden, setHidden, assigning, setAssigning,
    assigned, setAssignedFaces, click, hoverFace, ...actions,
  }), [mode, ids, hover, hidden, assigning, assigned, setAssigning, click, hoverFace, actions]);
}
