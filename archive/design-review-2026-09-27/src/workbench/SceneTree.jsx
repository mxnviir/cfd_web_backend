// The right-hand card: what is in the scene. Build spec 5.5.
//
//   v GEOMETRY
//      - car(17.3)
//         + Configuration 1        bodies, then faces
//   SAVED SELECTIONS
//   Show faces               (o)
//
// "Show faces" is off by default and that is not a detail. A car has 2219
// faces; listing them all is a scrolling wall that hides the two rows the user
// actually wants, and building those rows costs more than drawing the model.
import React, { useState } from "react";
import { Icon } from "./icons";

function Toggle({ on, onChange, label, id }) {
  return (
    <label className="wb-toggle-row" htmlFor={id}>
      <span>{label}</span>
      <span className="wb-toggle">
        <input id={id} type="checkbox" checked={!!on}
          onChange={(e) => onChange(e.target.checked)} />
        <span className="wb-toggle-track" aria-hidden="true" />
      </span>
    </label>
  );
}

/**
 * Area under which a face is at risk from SimScale's import.
 *
 * The mesher's small-feature tolerance is 0.5 mm, so this is that squared. It
 * is a warning, not a prediction: on the test car it flags twenty faces and
 * the importer actually dropped ten, because the importer weighs more than
 * area alone. So the marker says "may", except for the faces with no area at
 * all, which certainly go.
 *
 * Worth saying at all because the alternative is the run log telling you
 * "10 face(s) were dropped and are not in the run" after the run is paid for.
 */
const MIN_MESHABLE_M2 = 2.5e-7;

/** "plane, 0.125 m2" - what a face is and how big, for picking by eye. */
function faceNote(f) {
  const kind = typeof f.type === "string" ? f.type : null;
  const area = typeof f.area_m2 === "number" ? f.area_m2 : null;
  if (area == null) return kind;
  const size = area >= 0.001
    ? `${area.toFixed(3)} m2`
    : `${area.toExponential(1)} m2`;
  return kind ? `${kind}, ${size}` : size;
}

/** True for a face the solver will not receive, so assigning to it is wasted. */
function tooSmallToMesh(f) {
  return typeof f.area_m2 === "number" && f.area_m2 < MIN_MESHABLE_M2;
}

function Row({ depth, label, sub, warn, icon, selected, onClick, onHide, hidden, menu, twisty, open, onToggle }) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div className={"wb-scene-row" + (selected ? " wb-row-on" : "")}
      style={{ paddingLeft: 8 + depth * 16 }}
      onClick={onClick} role="treeitem" aria-selected={!!selected} tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter") onClick?.(); }}>
      {twisty ? (
        <button type="button" className="wb-twisty wb-twisty-box" aria-label={open ? "Collapse" : "Expand"}
          onClick={(e) => { e.stopPropagation(); onToggle?.(); }}>
          <Icon name={open ? "minus" : "plus"} size={12} />
        </button>
      ) : <span className="wb-twisty-gap" />}
      {icon ? <Icon name={icon} size={14} /> : <span className="wb-dot-gap" />}
      <span className="wb-row-label">
        {label}
        {sub ? <span className="wb-row-sub"> {sub}</span> : null}
        {/* A face the mesher will drop. Said here, where the face is picked,
            rather than in the run log after the run has been paid for. */}
        {warn ? (
          <span className="wb-row-warn wb-tip" data-tip={warn} role="img" aria-label={warn}>
            <Icon name="warn" size={12} />
          </span>
        ) : null}
      </span>
      {onHide ? (
        <button type="button" className="wb-icon-btn wb-scene-eye"
          aria-label={hidden ? "Show" : "Hide"}
          onClick={(e) => { e.stopPropagation(); onHide(); }}>
          <Icon name={hidden ? "eyeOff" : "eye"} size={14} />
        </button>
      ) : null}
      {menu ? (
        <span className="wb-row-menu">
          <button type="button" className="wb-icon-btn wb-row-dots" aria-label="More actions"
            onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}
            onBlur={() => setTimeout(() => setMenuOpen(false), 120)}>
            <Icon name="dots" size={14} />
          </button>
          {menuOpen ? (
            <span className="wb-menu wb-menu-right" role="menu">
              {menu.map((it) => (
                <button key={it.label} type="button" role="menuitem"
                  className={"wb-menu-item" + (it.danger ? " wb-menu-item-bad" : "")}
                  onMouseDown={(e) => { e.preventDefault(); it.onClick(); setMenuOpen(false); }}>
                  {it.label}
                </button>
              ))}
            </span>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

export default function SceneTree({
  geometry, faces, solids, selection, onSelect, hidden, onToggleHidden,
  savedSelections, onSaveSelection, onSelectionAction,
}) {
  const [showFaces, setShowFaces] = useState(false);
  const [openBodies, setOpenBodies] = useState({});
  const [openGeometry, setOpenGeometry] = useState(true);

  const bodies = solids || [];
  const selected = selection || [];

  return (
    <div className="wb-card wb-scene wb-scroll" role="tree" aria-label="Scene">
      <div className="wb-scene-head">
        <button type="button" className="wb-twisty"
          aria-label={openGeometry ? "Collapse geometry" : "Expand geometry"}
          onClick={() => setOpenGeometry((v) => !v)}>
          <Icon name={openGeometry ? "chevronDown" : "chevronRight"} size={14} />
        </button>
        <span>Geometry</span>
      </div>

      {openGeometry ? (
        geometry ? (
          <>
            <Row depth={1} label={geometry.name || "Geometry"} icon="cube" />
            {bodies.length ? bodies.map((body) => {
              const open = !!openBodies[body.id];
              const bodyFaces = showFaces
                ? (faces || []).filter((f) => f.solid === body.id)
                : [];
              return (
                <React.Fragment key={body.id}>
                  <Row
                    depth={2} label={body.name || `Solid ${body.id + 1}`} icon="layers"
                    twisty={showFaces} open={open}
                    onToggle={() => setOpenBodies((s) => ({ ...s, [body.id]: !open }))}
                    hidden={hidden?.bodies?.has(body.id)}
                    onHide={() => onToggleHidden?.("body", body.id)}
                    onClick={() => onSelect?.({ kind: "solid", id: body.id })}
                    selected={selected.some((s) => s.kind === "solid" && s.id === body.id)}
                  />
                  {showFaces && open ? bodyFaces.map((f) => (
                    <Row
                      key={f.index} depth={3} label={`Face ${f.index + 1}`}
                      /*
                       * Shape and size, not just a number.
                       *
                       * These rows are how a user finds the inlet or a wheel
                       * without hunting in the viewer, and "Face 42" helps
                       * nobody do that. The tunnel walls are the large planes,
                       * a wheel is a cylinder, and the slivers the mesher
                       * refuses are the ones measuring a millionth of a square
                       * metre. All of it is already in faces.json.
                       */
                      sub={faceNote(f)}
                      warn={tooSmallToMesh(f)
                        ? (f.area_m2 > 0
                          ? "Smaller than the mesher's tolerance. The import may drop this face, and a boundary condition on a dropped face never reaches the solver."
                          : "This face has no area. The import will drop it, and a boundary condition on it never reaches the solver.")
                        : null}
                      icon="cubeFace"
                      onClick={() => onSelect?.({ kind: "face", id: f.index })}
                      selected={selected.some((s) => s.kind === "face" && s.id === f.index)}
                    />
                  )) : null}
                </React.Fragment>
              );
            }) : (
              <div className="wb-empty wb-empty-s">
                {/* "failed" is not "still preparing". A geometry the service
                    refused used to read "Still preparing this geometry" here
                    for ever, contradicting the word "failed" on its own tree
                    row, with the reason sitting unread on the document. */}
                {geometry.status === "ready" ? "No bodies in this geometry."
                  : geometry.status === "failed"
                    ? (geometry.error || "This geometry could not be read.")
                    : "Still preparing this geometry."}
              </div>
            )}
          </>
        ) : <div className="wb-empty wb-empty-s">No geometry selected.</div>
      ) : null}

      <div className="wb-scene-head">
        <span className="wb-twisty-gap" />
        <span>Saved selections</span>
        {selected.length ? (
          <button type="button" className="wb-add wb-tip wb-tip-below"
            data-tip="Save this selection" aria-label="Save this selection"
            onClick={onSaveSelection}>
            <Icon name="plus" size={13} />
          </button>
        ) : null}
      </div>
      {(savedSelections || []).length ? savedSelections.map((sel) => (
        <Row
          key={sel.id} depth={1} label={`${sel.name} (${sel.faces?.length || 0})`}
          icon="link"
          onClick={() => onSelect?.({ kind: "saved", id: sel.id })}
          menu={[
            { label: "Rename", onClick: () => onSelectionAction?.("rename", sel) },
            { label: "Edit", onClick: () => onSelectionAction?.("edit", sel) },
            { label: "Delete", danger: true, onClick: () => onSelectionAction?.("delete", sel) },
          ]}
        />
      )) : <div className="wb-empty wb-empty-s">Select faces in the viewer, then give them a name.</div>}

      <div className="wb-scene-foot">
        <Toggle id="wb-show-faces" label="Show faces" on={showFaces}
          onChange={setShowFaces} />
      </div>
    </div>
  );
}
