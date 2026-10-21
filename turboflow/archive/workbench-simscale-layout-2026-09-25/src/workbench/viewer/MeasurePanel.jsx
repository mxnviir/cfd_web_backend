// The measure tool. Build spec 6.6.
//
// One entity gives its own numbers, straight from faces.json, which the
// geometry service computed on the real surface. Two entities need the exact
// distance between two B-rep faces, and that is not something the browser can
// work out from triangles: the shortest distance between two curved surfaces
// is not the shortest distance between two triangle meshes of them. That pair
// goes to the service.
import React, { useEffect, useState } from "react";
import { Icon } from "../icons";

function Value({ label, value, unit, onCopy }) {
  const [copied, setCopied] = useState(false);
  if (value == null) return null;
  const text = typeof value === "number" ? String(value) : value;
  return (
    <div className="wb-measure-row">
      <span className="wb-plabel">{label}</span>
      <span className="wb-measure-val">
        {typeof value === "number" ? value.toPrecision(5) : value}
        {unit ? <span className="wb-dim"> {unit}</span> : null}
      </span>
      <button
        type="button" className="wb-icon-btn wb-tip" data-tip={copied ? "Copied" : "Copy"}
        aria-label={`Copy ${label}`}
        onClick={() => {
          navigator.clipboard?.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
            onCopy?.();
          }).catch(() => {});
        }}
      >
        <Icon name="copy" size={13} />
      </button>
    </div>
  );
}

export default function MeasurePanel({ faces, selected, onClose, onMeasurePair }) {
  const [pair, setPair] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const one = selected.length === 1 ? faces[selected[0]] : null;
  const two = selected.length === 2;

  useEffect(() => {
    if (!two || !onMeasurePair) { setPair(null); return; }
    let stop = false;
    setBusy(true);
    setError(null);
    onMeasurePair(selected[0], selected[1])
      .then((r) => { if (!stop) setPair(r); })
      .catch((e) => { if (!stop) setError(e.message || String(e)); })
      .finally(() => { if (!stop) setBusy(false); });
    return () => { stop = true; };
  }, [two, selected[0], selected[1], onMeasurePair]);

  return (
    <section className="wb-card wb-measure" aria-label="Measure">
      <header className="wb-panel-head">
        <h2 className="wb-panel-title">Measure</h2>
        <button type="button" className="wb-sq" aria-label="Close measure" onClick={onClose}>
          <Icon name="x" size={16} />
        </button>
      </header>
      <div className="wb-panel-body">
        {!selected.length ? (
          <p className="wb-dim">
            Select one entity to see its size, two to see the distance between them.
          </p>
        ) : null}

        {one ? (
          <>
            <Value label="Type" value={one.type} />
            <Value label="Area" value={one.area_m2} unit="m2" />
            <Value label="Centre x" value={one.cx_m} unit="m" />
            <Value label="Centre y" value={one.cy_m} unit="m" />
            <Value label="Centre z" value={one.cz_m} unit="m" />
            {one.radius_m ? <Value label="Radius" value={one.radius_m} unit="m" /> : null}
            {one.axis ? <Value label="Axis" value={one.axis.map((n) => n.toFixed(3)).join(", ")} /> : null}
            {one.bbox ? (
              <Value label="Bounding box"
                value={one.bbox.max.map((m, i) => (m - one.bbox.min[i]).toPrecision(4)).join(" x ")}
                unit="m" />
            ) : null}
          </>
        ) : null}

        {two ? (
          busy ? <p className="wb-dim">Measuring</p>
            : error ? <p className="wb-perror">{error}</p>
              : pair ? (
                <>
                  <Value label="Shortest distance" value={pair.min_distance_m} unit="m" />
                  <Value label="Longest distance" value={pair.max_distance_m} unit="m" />
                  <Value label="Normal distance" value={pair.normal_distance_m} unit="m" />
                  <Value label="Angle" value={pair.angle_deg} unit="deg" />
                </>
              ) : null
        ) : null}

        {selected.length > 2 ? (
          <p className="wb-dim">
            {selected.length} entities selected. Measure works on one or two.
          </p>
        ) : null}
      </div>
    </section>
  );
}
