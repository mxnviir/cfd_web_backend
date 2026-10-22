// The draft a panel edits, and how it reaches the database. Build spec 5.4.
//
// Ground rule 6 calls this the single most common thing a builder gets wrong,
// so it is one hook and every panel uses it. Typing changes the draft and
// nothing else. The blue tick and Enter save. Escape and the white X discard.
// Moving to another node saves a valid draft and refuses to leave an invalid
// one.
//
// The last part is why this hook, not just local state inside each panel: the
// tree has to be able to ask "may I leave?" before it changes the route, and
// only something outside the panel can answer that.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/** A deep clone that does not care about prototypes, because this is JSON. */
const copy = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

/** Read and write a nested path: at(o, "velocity.value.x") */
export function at(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
}

export function setAt(obj, path, value) {
  const keys = path.split(".");
  const out = copy(obj) ?? {};
  let node = out;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const k = keys[i];
    if (node[k] == null || typeof node[k] !== "object") node[k] = {};
    node = node[k];
  }
  node[keys[keys.length - 1]] = value;
  return out;
}

export default function useDraft(saved, onSave, { validate } = {}) {
  const [draft, setDraft] = useState(() => copy(saved));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const savedRef = useRef(saved);

  // Follow the database, but never over the top of unsaved edits. A snapshot
  // arriving while somebody is typing must not wipe what they typed; that is
  // the other half of the same rule.
  useEffect(() => {
    savedRef.current = saved;
    if (!dirty) setDraft(copy(saved));
  }, [saved, dirty]);

  const errors = useMemo(() => (validate ? validate(draft) || {} : {}), [validate, draft]);
  const invalid = Object.keys(errors).length > 0;

  /**
   * Write a value, or a function of the value that is already there.
   *
   * The functional form is not a convenience. A panel that reads the current
   * list from its render closure and writes a new one is correct only while
   * no two writes happen between renders, and clicking three faces into an
   * assignment box in quick succession does exactly that: all three read the
   * same empty list and the last one wins, so two of the three clicks
   * silently do nothing.
   */
  const set = useCallback((path, value) => {
    setDirty(true);
    setDraft((d) => {
      if (typeof path !== "string") {
        return { ...d, ...(typeof path === "function" ? path(d) : path) };
      }
      const next = typeof value === "function" ? value(at(d, path)) : value;
      return setAt(d, path, next);
    });
  }, []);

  const commit = useCallback(async () => {
    if (invalid) return false;
    setSaving(true);
    setError(null);
    try {
      await onSave(draft);
      setDirty(false);
      return true;
    } catch (err) {
      setError(err.message || String(err));
      return false;
    } finally {
      setSaving(false);
    }
  }, [draft, invalid, onSave]);

  const discard = useCallback(() => {
    setDraft(copy(savedRef.current));
    setDirty(false);
    setError(null);
  }, []);

  /**
   * What the tree calls before it navigates away.
   *
   * Saves a clean draft and refuses to move on a broken one, which is
   * SimScale's behaviour and the reason a half-finished boundary condition
   * cannot be abandoned by clicking elsewhere.
   */
  const leave = useCallback(async () => {
    if (!dirty) return true;
    if (invalid) return false;
    return commit();
  }, [dirty, invalid, commit]);

  return { draft, set, dirty, saving, error, errors, invalid, commit, discard, leave };
}
