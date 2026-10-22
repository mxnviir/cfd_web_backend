// The controls the setup panels are built from. Build spec 2.3 and 9.13.
//
// One file, because every panel uses the same eight things and a row that
// looks slightly different in one panel is how a product starts to feel
// hand-made. The units are SI on the way in and out; the dropdown only
// changes what is shown (3.5).
import React, { useEffect, useId, useRef, useState } from "react";
import { Icon } from "../icons";
import { unitsFor, toBase, fromBase, forDisplay } from "../../lib/units";

/**
 * A labelled row in a panel.
 *
 * `label` wraps the control, so the input inside is named by it without every
 * field having to invent an id. It was a `span` before, which looks identical
 * and tells a screen reader nothing: the number fields in Numerics and
 * Simulation control were announced as "edit text, blank".
 *
 * A row whose control is a group rather than a single input (a vector, a
 * segmented control) passes `group`, because a label may name only one field
 * and labelling three at once is worse than labelling none.
 */
export function Row({ label, hint, error, children, indent, group }) {
  const Tag = group ? "div" : "label";
  return (
    <Tag className={"wb-prow" + (indent ? " wb-prow-in" : "")}>
      <span className="wb-plabel">{label}</span>
      <span className="wb-pcontrol">{children}</span>
      {hint ? <span className="wb-phint">{hint}</span> : null}
      {error ? <span className="wb-perror">{error}</span> : null}
    </Tag>
  );
}

/** A collapsible group inside a panel. */
export function Section({ title, children, open: initial = true }) {
  const [open, setOpen] = useState(initial);
  return (
    <div className="wb-psection">
      <button type="button" className="wb-psection-head" aria-expanded={open}
        onClick={() => setOpen((v) => !v)}>
        <span>{title}</span>
        <Icon name={open ? "chevronDown" : "chevronRight"} size={13} />
      </button>
      {open ? <div>{children}</div> : null}
    </div>
  );
}

/**
 * A number, with a unit dropdown where the quantity has more than one unit.
 *
 * The text is held locally while it is being typed. Reflecting the model on
 * every keystroke turns "1e-" into "1" before the "5" arrives, and a field
 * that fights the person typing into it is worse than no field.
 */
export function Num({ value, onChange, quantity, unit, onUnit, disabled, width }) {
  const units = quantity ? unitsFor(quantity) : [];
  const shown = value == null || Number.isNaN(value) ? ""
    : String(quantity ? forDisplay(fromBase(value, quantity, unit)) : value);
  const [text, setText] = useState(shown);
  const mine = useRef(shown);

  useEffect(() => {
    if (shown !== mine.current) { setText(shown); mine.current = shown; }
  }, [shown]);

  const commit = (raw) => {
    if (raw === "") return;
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    onChange(quantity ? toBase(n, quantity, unit) : n);
  };

  return (
    <span className="wb-numfield">
      <input
        className="wb-field" type="text" inputMode="decimal" value={text}
        disabled={disabled} style={width ? { width } : undefined}
        onChange={(e) => { setText(e.target.value); mine.current = e.target.value; }}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") commit(e.currentTarget.value); }}
      />
      {units.length > 1 && onUnit ? (
        <select className="wb-unit" value={unit} aria-label="Unit" disabled={disabled}
          onChange={(e) => onUnit(e.target.value)}>
          {units.map((u) => <option key={u} value={u}>{u}</option>)}
        </select>
      ) : units.length ? (
        <span className="wb-unit wb-unit-fixed">{unit || units[0]}</span>
      ) : null}
    </span>
  );
}

export function Select({ value, onChange, options, disabled }) {
  return (
    <span className="wb-selectwrap">
      <select className="wb-field wb-select" value={value ?? ""} disabled={disabled}
        onChange={(e) => onChange(e.target.value)}>
        {options.map(([id, label, off]) => (
          <option key={id} value={id} disabled={off}>{label}</option>
        ))}
      </select>
      <Icon name="chevronDown" size={13} className="wb-select-chev" />
    </span>
  );
}

export function Toggle({ value, onChange, disabled, label }) {
  return (
    <span className="wb-toggle">
      <input type="checkbox" checked={!!value} disabled={disabled} aria-label={label}
        onChange={(e) => onChange(e.target.checked)} />
      <span className="wb-toggle-track" aria-hidden="true" />
    </span>
  );
}

/** Three numbers in a row with the unit once at the right. Build spec 2.3. */
export function Vec({ value = {}, onChange, quantity, unit, onUnit, disabled, labels }) {
  const names = labels || ["x", "y", "z"];
  /*
   * A unique prefix per Vec on the page.
   *
   * The ids used to be built from the component name alone, so two vectors in
   * one panel (a rotating wall has a point and an axis) produced the same
   * three ids. Duplicate ids are not a lint nicety: `htmlFor` binds to the
   * first match, so clicking the axis row's "x" put the cursor in the point
   * row's "x", and a screen reader read both rows as the same field.
   */
  const uid = useId();
  return (
    <span className="wb-vec">
      {["x", "y", "z"].map((k, i) => (
        <span key={k} className="wb-vec-part">
          <label className="wb-vec-label" htmlFor={`${uid}-${k}`}>{names[i]}</label>
          <input
            id={`${uid}-${k}`} className="wb-field" type="text" inputMode="decimal"
            value={value[k] ?? 0} disabled={disabled}
            onChange={(e) => {
              const n = Number(e.target.value);
              onChange({ ...value, [k]: Number.isFinite(n) ? n : 0 });
            }}
          />
        </span>
      ))}
      {quantity ? (
        onUnit ? (
          <select className="wb-unit" value={unit} aria-label="Unit"
            onChange={(e) => onUnit(e.target.value)}>
            {unitsFor(quantity).map((u) => <option key={u} value={u}>{u}</option>)}
          </select>
        ) : <span className="wb-unit wb-unit-fixed">{unit}</span>
      ) : null}
    </span>
  );
}

/**
 * The assignment box. Build spec 9.13.
 *
 * Clicking in the viewer adds to the draft immediately, which is SimScale's
 * behaviour and surprises people who expect the tick to be needed for that
 * too. The tick is still what saves.
 */
export function Assignment({
  faces, onChange, kind = "face", assigning, onAssigning, faceInfo,
  onHover, savedSelections = [], viewerSelection = [],
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const shown = faces.slice(0, 40);
  const rest = faces.length - shown.length;

  return (
    <div className="wb-assign">
      <div className="wb-assign-head">
        <strong>Assignment ({faces.length} {kind}{faces.length === 1 ? "" : "s"})</strong>
        <Toggle value={assigning} onChange={onAssigning} label="Assignment mode" />
        <button type="button" className="wb-icon-btn wb-tip" data-tip="Clear all"
          aria-label="Clear all" disabled={!faces.length} onClick={() => onChange([])}>
          <Icon name="trash" size={14} />
        </button>
      </div>

      <div className="wb-assign-list wb-scroll">
        {faces.length ? (
          <>
            {shown.map((f) => (
              <div key={f} className="wb-assign-item"
                onMouseEnter={() => onHover?.(f)} onMouseLeave={() => onHover?.(null)}>
                <span>
                  {/*
                    * One-based, like the scene tree.
                    *
                    * This box said "Face 0" for the face the scene tree calls
                    * "Face 1": the same face with two names, one row apart on
                    * screen. The stored value is the zero-based index either
                    * way; only the label counts from one, because people do.
                    */}
                  {faceInfo?.[f]?.type ? `${faceInfo[f].type} ` : ""}Face {f + 1}
                  {faceInfo?.[f]?.area_m2 != null ? (
                    <span className="wb-dim">
                      {" "}{faceInfo[f].area_m2 >= 0.001
                        ? `${faceInfo[f].area_m2.toFixed(3)} m2`
                        : `${faceInfo[f].area_m2.toExponential(1)} m2`}
                    </span>
                  ) : null}
                  {faceInfo?.[f]?.solid != null
                    ? <span className="wb-dim"> Solid {faceInfo[f].solid + 1}</span> : null}
                </span>
                <button type="button" className="wb-icon-btn" aria-label={`Remove face ${f}`}
                  onClick={() => onChange(faces.filter((x) => x !== f))}>
                  <Icon name="x" size={12} />
                </button>
              </div>
            ))}
            {rest > 0 ? <div className="wb-assign-more">and {rest} more</div> : null}
          </>
        ) : (
          <div className="wb-assign-empty">
            {assigning
              ? "Click faces in the viewer. They are added as you click."
              : "Turn assignment on, then click faces in the viewer."}
          </div>
        )}
      </div>

      <div className="wb-assign-foot">
        <button type="button" className="wb-btn" disabled={!viewerSelection.length}
          onClick={() => onChange([...new Set([...faces, ...viewerSelection])])}>
          Add selection from viewer
        </button>
        {savedSelections.length ? (
          <span className="wb-menu-wrap">
            <button type="button" className="wb-btn" aria-expanded={pickerOpen}
              onClick={() => setPickerOpen((v) => !v)}>
              Saved selections <Icon name="chevronDown" size={13} />
            </button>
            {pickerOpen ? (
              <span className="wb-menu wb-menu-right" role="menu">
                {savedSelections.map((s) => (
                  <button key={s.id} type="button" role="menuitem" className="wb-menu-item"
                    onClick={() => {
                      onChange([...new Set([...faces, ...(s.faces || [])])]);
                      setPickerOpen(false);
                    }}>
                    {s.name} ({s.faces?.length || 0})
                  </button>
                ))}
              </span>
            ) : null}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** The note SimScale puts at the top of Numerics. */
export function Note({ children, kind }) {
  return (
    <p className={"wb-pnote" + (kind === "warn" ? " wb-pnote-warn" : "")}>
      {children}
    </p>
  );
}
