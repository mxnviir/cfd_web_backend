// The floating settings panel. Build spec 5.4.
//
// The draft rule is the whole point of this file, and ground rule 6 calls it
// the single thing builders get wrong most often. Typing does not save. The
// blue tick saves, Enter saves, Escape and the white X discard, and leaving
// the node saves a valid draft and refuses to leave an invalid one.
//
// So the panel holds its own copy of the values and hands it back on commit.
// A field that wrote straight through would send a Firestore write per
// keystroke, would put "3" in the database on the way to typing "30", and
// would make Escape mean nothing.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./icons";
import { unitsFor, toBase, fromBase, forDisplay } from "../lib/units";

/** A labelled row: label left, control right, underline under the control. */
export function Row({ label, hint, error, children }) {
  return (
    <div className="wb-prow">
      <span className="wb-plabel">{label}</span>
      <span className="wb-pcontrol">{children}</span>
      {hint ? <span className="wb-phint">{hint}</span> : null}
      {error ? <span className="wb-perror">{error}</span> : null}
    </div>
  );
}

/**
 * A number with a unit dropdown. Build spec 3.5.
 *
 * The stored value is always SI. The dropdown changes what is shown and
 * nothing else, so a team that works in millimetres and a team that works in
 * inches produce the same numbers in the same database, and a run set up in
 * one can be read by the other.
 */
export function NumberField({ value, onChange, quantity, unit, onUnit, step, min, max, disabled }) {
  const units = unitsFor(quantity);
  // forDisplay, because 0.0254 m shown in inches must read 1 and not
  // 0.9999999999999999.
  const shown = value == null ? "" : String(forDisplay(fromBase(value, quantity, unit)));
  const [text, setText] = useState(shown);
  const last = useRef(shown);

  // Follow the model, but never while the user is mid-type: overwriting the
  // box on every render is what turns "1e-" into "1" before "5" arrives.
  useEffect(() => {
    if (shown !== last.current) { setText(shown); last.current = shown; }
  }, [shown]);

  const commit = (raw) => {
    const n = Number(raw);
    if (raw === "" || Number.isNaN(n)) return;
    onChange(toBase(n, quantity, unit));
  };

  return (
    <span className="wb-numfield">
      <input
        className="wb-field" type="text" inputMode="decimal" value={text}
        disabled={disabled} step={step} min={min} max={max}
        onChange={(e) => { setText(e.target.value); last.current = e.target.value; }}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") commit(e.currentTarget.value); }}
      />
      {units.length > 1 ? (
        <select className="wb-unit" value={unit} onChange={(e) => onUnit(e.target.value)}
          aria-label="Unit" disabled={disabled}>
          {units.map((u) => <option key={u} value={u}>{u}</option>)}
        </select>
      ) : units.length === 1 ? (
        <span className="wb-unit wb-unit-fixed">{units[0]}</span>
      ) : null}
    </span>
  );
}

export function SelectField({ value, onChange, options, disabled }) {
  return (
    <span className="wb-selectwrap">
      <select className="wb-field wb-select" value={value} disabled={disabled}
        onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>
        ))}
      </select>
      <Icon name="chevronDown" size={13} className="wb-select-chev" />
    </span>
  );
}

export function ToggleField({ value, onChange, disabled, label }) {
  return (
    <span className="wb-toggle">
      <input type="checkbox" checked={!!value} disabled={disabled}
        aria-label={label} onChange={(e) => onChange(e.target.checked)} />
      <span className="wb-toggle-track" aria-hidden="true" />
    </span>
  );
}

/**
 * The block every panel that assigns entities shows. Build spec 5.4.
 *
 * The blue toggle is assignment mode: while it is on, a click in the viewer
 * adds to this list rather than changing what is selected. That mode belongs
 * to the panel, not the viewer, which is why it lives here.
 */
export function Assignment({ items, kind = "Face", on, onToggle, onClear, onRemove, nameOf }) {
  return (
    <div className="wb-assign">
      <div className="wb-assign-head">
        <strong>Assignment ({items.length} {kind}{items.length === 1 ? "" : "s"})</strong>
        <span className="wb-toggle">
          <input type="checkbox" checked={!!on} onChange={(e) => onToggle(e.target.checked)}
            aria-label="Assignment mode" />
          <span className="wb-toggle-track" aria-hidden="true" />
        </span>
        <button type="button" className="wb-icon-btn wb-tip" data-tip="Clear all"
          aria-label="Clear all" onClick={onClear} disabled={!items.length}>
          <Icon name="trash" size={14} />
        </button>
      </div>
      <div className="wb-assign-list wb-scroll">
        {items.length ? items.map((it) => (
          <div key={typeof it === "object" ? it.id : it} className="wb-assign-item">
            <span>{nameOf ? nameOf(it) : String(it)}</span>
            <button type="button" className="wb-icon-btn" aria-label="Remove"
              onClick={() => onRemove(it)}>
              <Icon name="x" size={12} />
            </button>
          </div>
        )) : (
          <div className="wb-assign-empty">
            {on ? `Click a ${kind.toLowerCase()} in the viewer to assign it.`
              : `Turn assignment on, then click a ${kind.toLowerCase()} in the viewer.`}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The panel frame: header with the name and the two square buttons, a body,
 * and a thin footer.
 *
 * `value` is what is saved; `onCommit` receives the draft. The draft lives
 * here so that every panel gets the same behaviour without writing it again,
 * and so `dirty` is one comparison rather than a flag each panel maintains.
 */
export default function SettingsPanel({
  title, value, onCommit, onClose, onDelete, validate, renamable, onRename,
  children, footer,
}) {
  const [draft, setDraft] = useState(value);
  const [name, setName] = useState(title);
  const [touched, setTouched] = useState(false);

  useEffect(() => { setDraft(value); setTouched(false); }, [value]);
  useEffect(() => { setName(title); }, [title]);

  const errors = useMemo(() => (validate ? validate(draft) || {} : {}), [validate, draft]);
  const invalid = Object.keys(errors).length > 0;
  const dirty = touched && JSON.stringify(draft) !== JSON.stringify(value);

  const set = (patch) => {
    setTouched(true);
    setDraft((d) => ({ ...d, ...(typeof patch === "function" ? patch(d) : patch) }));
  };

  const commit = () => {
    if (invalid) return;
    if (renamable && name.trim() && name !== title) onRename?.(name.trim());
    onCommit(draft);
    setTouched(false);
  };

  return (
    <section
      className="wb-card wb-panel"
      onKeyDown={(e) => {
        // Enter saves, unless the focus is somewhere Enter already means
        // something, which on a textarea is a new line.
        if (e.key === "Enter" && e.target.tagName !== "TEXTAREA") { e.preventDefault(); commit(); }
        if (e.key === "Escape") { e.preventDefault(); onClose(); }
      }}
      aria-label={`${title} settings`}
    >
      <header className="wb-panel-head">
        {renamable ? (
          <input className="wb-panel-title wb-panel-title-input" value={name}
            onChange={(e) => setName(e.target.value)} aria-label="Name" />
        ) : (
          <h2 className="wb-panel-title">{title}</h2>
        )}
        <button
          type="button" className="wb-sq wb-sq-ok" onClick={commit}
          disabled={invalid} aria-label="Apply"
          title={invalid ? "Fix the errors below first" : "Apply"}
        >
          <Icon name="check" size={16} strokeWidth={2.4} />
        </button>
        <button type="button" className="wb-sq" onClick={onClose} aria-label="Close">
          <Icon name="x" size={16} strokeWidth={2.2} />
        </button>
      </header>

      <div className="wb-panel-body wb-scroll">
        {typeof children === "function" ? children({ draft, set, errors }) : children}
      </div>

      <footer className="wb-panel-foot">
        {onDelete ? (
          <button type="button" className="wb-icon-btn wb-tip" data-tip="Delete"
            aria-label="Delete" onClick={onDelete}>
            <Icon name="trash" size={15} />
          </button>
        ) : <span />}
        {dirty ? <span className="wb-dim">Unsaved changes</span> : null}
        {footer}
      </footer>
    </section>
  );
}
