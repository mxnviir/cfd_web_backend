// Dashboard dialogs: new group, new folder, share, rename, confirm.
// Build spec 4.6 and 4.7.
//
// One Modal frame so every dialog closes the same way (Escape, the X, a click
// on the scrim) and traps focus the same way. Ground rule: never alert().
import React, { useEffect, useRef, useState } from "react";
import { Icon } from "../workbench/icons";

/** Categories, exactly as build spec 4.6 lists them. */
// What a collaborator can be given. The server also accepts "copy", but
// copyGroup lets only the owner copy, so offering it would promise something
// that does not happen. This list was referenced and never defined, and opening
// Share from anywhere threw and blanked the whole page.
const PERMISSIONS = [["view", "Can view"], ["edit", "Can edit"]];

export const CATEGORIES = [
  ["aerospace", "Aerospace"], ["automotive", "Automotive"],
  ["architecture", "Architecture"], ["consumer", "Consumer products"],
  ["education", "Education"], ["energy", "Energy"],
  ["industrial", "Industrial"], ["marine", "Marine"],
  ["medical", "Medical"], ["other", "Other"],
];

export function Modal({ title, onClose, children, footer, width }) {
  const card = useRef(null);

  useEffect(() => {
    const prev = document.activeElement;
    // Focus the first real control, so a keyboard user is inside the dialog
    // rather than still behind it.
    card.current?.querySelector("input, textarea, select, button")?.focus();
    const key = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); return; }
      if (e.key !== "Tab") return;
      const items = [...card.current.querySelectorAll(
        'a[href], button:not(:disabled), input:not(:disabled), select, textarea, [tabindex]:not([tabindex="-1"])')];
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    addEventListener("keydown", key, true);
    return () => { removeEventListener("keydown", key, true); prev?.focus?.(); };
  }, [onClose]);

  return (
    <div className="db-scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="db-modal" style={width ? { width } : undefined} ref={card}
        role="dialog" aria-modal="true" aria-label={title}>
        <header className="db-modal-head">
          <h2>{title}</h2>
          <button type="button" className="wb-icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </header>
        <div className="db-modal-body">{children}</div>
        {footer ? <footer className="db-modal-foot">{footer}</footer> : null}
      </div>
    </div>
  );
}

function Tags({ value, onChange }) {
  const [text, setText] = useState("");
  const add = () => {
    const t = text.trim();
    // 3 to 50 characters and at most 12, matching the callable's schema. A
    // dialog that accepts what the server refuses just moves the error later.
    if (t.length < 3 || t.length > 50 || value.length >= 12 || value.includes(t)) return;
    onChange([...value, t]);
    setText("");
  };
  return (
    <div className="db-taginput">
      {value.map((t) => (
        <span key={t} className="db-tag">
          {t}
          <button type="button" aria-label={`Remove ${t}`}
            onClick={() => onChange(value.filter((x) => x !== t))}>
            <Icon name="x" size={11} />
          </button>
        </span>
      ))}
      <input
        value={text} onChange={(e) => setText(e.target.value)}
        placeholder={value.length ? "" : "aero, 2026"}
        aria-label="Add a tag"
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(); }
          if (e.key === "Backspace" && !text && value.length) onChange(value.slice(0, -1));
        }}
        onBlur={add}
      />
    </div>
  );
}

export function NewGroupDialog({ onClose, onCreate }) {
  const [v, setV] = useState({
    name: "", description: "", category: "education", tags: [],
    unit_system: "SI", api_access: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (patch) => setV((s) => ({ ...s, ...patch }));
  const nameOk = v.name.trim().length >= 1 && v.name.trim().length <= 200;

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      await onCreate({
        name: v.name.trim(),
        description: v.description.trim() || undefined,
        category: v.category,
        tags: v.tags.length ? v.tags : undefined,
        unit_system: v.unit_system,
      });
    } catch (err) {
      setError(err.message || String(err));
      setBusy(false);
    }
  };

  return (
    <Modal
      title="New group" onClose={onClose}
      footer={
        <>
          <button type="button" className="wb-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="wb-btn wb-btn-primary"
            disabled={!nameOk || busy} onClick={create}>
            {busy ? "Creating…" : "Create group"}
          </button>
        </>
      }
    >
      <div className="db-field">
        <label htmlFor="np-name">Group title</label>
        <input id="np-name" className="wb-field" value={v.name} maxLength={200}
          onChange={(e) => set({ name: e.target.value })}
          onKeyDown={(e) => { if (e.key === "Enter" && nameOk && !busy) create(); }} />
        <div className="db-hint">
          Describe the car and the method, e.g. "Car v3, k-omega SST"
        </div>
      </div>

      <div className="db-field">
        <label htmlFor="np-desc">Description</label>
        <textarea id="np-desc" className="wb-field" value={v.description} maxLength={2000}
          onChange={(e) => set({ description: e.target.value })} />
      </div>

      <div className="db-field">
        <label htmlFor="np-cat">Category</label>
        <select id="np-cat" className="wb-field wb-select" value={v.category}
          onChange={(e) => set({ category: e.target.value })}>
          {CATEGORIES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
      </div>

      <div className="db-field">
        <label id="np-tags-l">Tags</label>
        <div aria-labelledby="np-tags-l">
          <Tags value={v.tags} onChange={(tags) => set({ tags })} />
        </div>
        <div className="db-hint">Up to 12, each 3 to 50 characters. Enter adds one.</div>
      </div>

      <details className="db-adv">
        <summary>Advanced settings</summary>
        <div className="db-field">
          <label id="np-unit-l">Unit system</label>
          <div className="db-radio-row" role="radiogroup" aria-labelledby="np-unit-l">
            {["SI", "IMPERIAL"].map((u) => (
              <label key={u} className="db-radio">
                <input type="radio" name="np-unit" checked={v.unit_system === u}
                  onChange={() => set({ unit_system: u })} />
                {u === "SI" ? "SI" : "Imperial"}
              </label>
            ))}
          </div>
          <div className="db-hint">
            Only changes what the fields show. Everything is stored in SI.
          </div>
        </div>
      </details>

      <p className="db-hint">Every TurboFlow group is private to you and the people you share it with.</p>
      {error ? <div className="db-error">{error}</div> : null}
    </Modal>
  );
}
export function ShareDialog({ group, people, onClose, onShare, onUnshare }) {
  const [email, setEmail] = useState("");
  const [permission, setPermission] = useState("view");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);

  // An address with no TurboFlow account shares nothing, and the server says
  // so with `pending` (shareGroup in functions/src/groups). The dialog used to
  // clear the field and show nothing, so the owner saw their typing vanish and
  // nobody appear. It says what happened now. This tells the owner nothing the
  // list below would not: a registered address appears there, and this one
  // does not.
  const add = async () => {
    const who = email.trim();
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const res = await onShare(who, permission);
      setEmail("");
      if (res?.pending) {
        setNote(`Nothing was shared: no one has signed in to TurboFlow as ${who} yet. Ask them to sign in once, then add them again.`);
      }
    }
    catch (err) { setError(err.message || String(err)); }
    finally { setBusy(false); }
  };

  const shared = Object.entries(group.sharedWith || {});

  return (
    <Modal title={`Share "${group.name}"`} onClose={onClose} width={520}
      footer={<button type="button" className="wb-btn" onClick={onClose}>Close</button>}>
      <div className="db-share-row">
        <span>
          <label htmlFor="sh-email" className="wb-sr">Email address</label>
          <input id="sh-email" className="wb-field" type="email" value={email}
            placeholder="Email address"
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && email && !busy) add(); }} />
        </span>
        <select className="wb-field wb-select" value={permission} aria-label="Permission"
          onChange={(e) => setPermission(e.target.value)}>
          {PERMISSIONS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
        <button type="button" className="wb-btn wb-btn-primary" disabled={!email || busy}
          onClick={add}>{busy ? "Adding…" : "Add"}</button>
      </div>
      {error ? <div className="db-error" role="alert">{error}</div> : null}
      {note ? <p className="db-hint" role="status">{note}</p> : null}

      <div className="db-share-list">
        {shared.length ? shared.map(([uid, perm]) => (
          <div key={uid} className="db-share-row">
            <span>{people?.[uid] || uid}</span>
            <select className="wb-field wb-select" value={perm} aria-label="Permission"
              onChange={(e) => onShare(people?.[uid] || uid, e.target.value)}>
              {PERMISSIONS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
            <button type="button" className="wb-icon-btn" aria-label="Remove"
              onClick={() => onUnshare(uid)}>
              <Icon name="x" size={14} />
            </button>
          </div>
        )) : (
          <p className="db-hint">
            Nobody else can open this group. Groups are private; there is no
            link that lets anyone in.
          </p>
        )}
      </div>
    </Modal>
  );
}

export function RenameDialog({ title, value, onClose, onSave }) {
  const [name, setName] = useState(value || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const ok = name.trim().length >= 1;
  // Renaming takes a few seconds. The button used to go grey with no word
  // about why, and a failure left it grey for good with the reason printed on
  // the page behind this dialog.
  const go = async () => {
    setBusy(true);
    setError(null);
    try { await onSave(name.trim()); }
    catch (err) { setError(err?.message || String(err)); setBusy(false); }
  };
  return (
    <Modal title={title} onClose={onClose} width={420}
      footer={
        <>
          <button type="button" className="wb-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="wb-btn wb-btn-primary" disabled={!ok || busy} onClick={go}>
            {busy ? "Saving…" : "Save"}
          </button>
        </>
      }>
      <div className="db-field">
        <label htmlFor="rn-name">Name</label>
        <input id="rn-name" className="wb-field" value={name} maxLength={200}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && ok && !busy) go(); }} />
      </div>
      {error ? <div className="db-error" role="alert">{error}</div> : null}
    </Modal>
  );
}

export function ConfirmDialog({ title, message, confirmLabel, busyLabel, onClose, onConfirm }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try { await onConfirm(); }
    catch (err) { setError(err?.message || String(err)); setBusy(false); }
  };
  return (
    <Modal title={title} onClose={onClose} width={440}
      footer={
        <>
          <button type="button" className="wb-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="wb-btn wb-btn-primary db-btn-danger" disabled={busy}
            onClick={confirm}>
            {busy ? (busyLabel || "Working…") : confirmLabel}
          </button>
        </>
      }>
      <p>{message}</p>
      {error ? <div className="db-error" role="alert">{error}</div> : null}
    </Modal>
  );
}