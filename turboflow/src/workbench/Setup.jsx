// Getting from a car to a run, one step at a time.
//
// What this replaces was SimScale's tree: fourteen nodes - Geometry
// primitives, Local coordinate systems, Advanced concepts, Numerics - in
// SimScale's order, most of them empty, because the Workbench was built by
// copying their screen. A team running their first simulation had to know
// which of the fourteen mattered, and the answer was four.
//
// So there are four steps, in the order the work actually happens: which
// wheels are wheels, how big the tunnel is, how fine the mesh is, how long to
// solve for. Each one is a heading you can open; opening a later one does not
// close an earlier one off, because changing your mind about the tunnel after
// seeing the mesh price is the normal way round, not a mistake.
//
// Quick setup does all four from saved defaults. It is not a different code
// path - it fills the same form and presses the same buttons - so there is no
// way for the quick answer and the slow one to drift apart.
import React, { useEffect, useMemo, useState } from "react";
import { Icon, StatusDot } from "./icons";
import { Row, Num, Select, Toggle, Note } from "./panels/fields";
import { clampRunParams, listPrice, levelForFineness, FINENESS_STEPS } from "../lib/pricing";

const FINENESS_OPTIONS = FINENESS_STEPS.map(([v, label]) => [String(v), label]);

/** What a first-time user gets, and what Reset goes back to. */
export const FACTORY_DEFAULTS = {
  symmetry: true,
  speed: 20,
  iterations: 1000,
  fineness: 9.5,
  upstream_m: 1.5,
  downstream_m: 0.5,
  side_m: 0.3,
  top_m: 0.3,
  wheel_radius_m: 0.014125,
  rear_wheel_radius_m: null,
  wheel_tolerance: 0.08,
  rotate_wheels: true,
  // Which of them, by name. Null is "all of them", and it stays null unless
  // somebody unticks one: a saved list of names would go stale the moment the
  // search radius changed and a different set of wheels was found.
  spin_wheels: null,
  moving_ground: true,
};

/** Only the keys above, and only of the right type.
 *
 * spin_wheels is deliberately not one of them. It names wheels on one
 * particular car, so carrying it into the next car as a default would silence
 * wheels nobody chose to silence.
 */
export function cleanDefaults(saved) {
  const out = {};
  if (!saved || typeof saved !== "object") return out;
  for (const [key, fallback] of Object.entries(FACTORY_DEFAULTS)) {
    const v = saved[key];
    if (typeof fallback === "boolean" && typeof v === "boolean") out[key] = v;
    if (typeof fallback === "number" && Number.isFinite(v)) out[key] = v;
  }
  return out;
}

const mm = (m) => (m > 0 ? `${(m * 1000).toFixed(1)} mm` : "-");
const cm2 = (m2) => (m2 > 0 ? `${(m2 * 1e4).toFixed(2)} cm²` : "-");

/**
 * Rename and Download for the car.
 *
 * These lived on the tree's row menu, and deleting the tree deleted their only
 * caller - so both went dead while the dialog that renames and the handler
 * that downloads sat there still wired to nothing. Menu items fire on
 * mousedown, not click, because the trigger loses focus first and a click
 * never lands.
 */
function CarMenu({ items }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return undefined;
    const key = (e) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } };
    addEventListener("keydown", key, true);
    return () => removeEventListener("keydown", key, true);
  }, [open]);
  return (
    <span className="wb-row-menu">
      <button type="button" className="wb-icon-btn" aria-label="More actions for this car"
        aria-expanded={open} onClick={() => setOpen((v) => !v)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}>
        <Icon name="dots" size={14} />
      </button>
      {open ? (
        <span className="wb-menu wb-menu-right" role="menu">
          {items.map((it) => (
            <button key={it.label} type="button" role="menuitem" className="wb-menu-item"
              onMouseDown={(e) => { e.preventDefault(); it.onClick(); setOpen(false); }}>
              {it.label}
            </button>
          ))}
        </span>
      ) : null}
    </span>
  );
}

/** One step: a heading that opens, with a state dot and a one-line summary. */
function Step({ n, title, state, summary, open, onToggle, children }) {
  return (
    <section className={"su-step" + (open ? " su-step-open" : "")}>
      <button type="button" className="su-head" onClick={onToggle} aria-expanded={open}>
        <span className={"su-n su-n-" + state}>{state === "done" ? <Icon name="check" size={12} strokeWidth={3} /> : n}</span>
        <span className="su-title">{title}</span>
        {summary && !open ? <span className="su-summary">{summary}</span> : null}
        <Icon name={open ? "chevronDown" : "chevronRight"} size={14} className="su-chev" />
      </button>
      {open ? <div className="su-body">{children}</div> : null}
    </section>
  );
}

export default function Setup({
  geometry, geometries = [], carVersion, tunnelVersion, simulation, runs = [],
  defaults, busy, error, progress, onBuild, onSaveSimulation, onQueue, onSaveDefaults,
  onExportStep,
  onHighlight, onImport, onPickCar, onCarAction, credits,
  sims = [], simStatus = {}, onPickSim, onNewSim,
}) {
  const [form, setForm] = useState(() => ({ ...FACTORY_DEFAULTS, ...cleanDefaults(defaults) }));
  const [touched, setTouched] = useState(false);
  const [open, setOpen] = useState(1);

  useEffect(() => {
    if (!touched) setForm({ ...FACTORY_DEFAULTS, ...cleanDefaults(defaults) });
  }, [defaults, touched]);
  const set = (patch) => { setTouched(true); setForm((f) => ({ ...f, ...patch })); };

  // What the car itself says, measured at import.
  const slivers = carVersion?.slivers ?? tunnelVersion?.slivers ?? null;
  // Which wheels there are to choose between.
  //
  // Before a tunnel exists there is only what the import found, and the import
  // ran before anyone had been asked what size the wheels are - so it used the
  // default 14.1 mm, and a car with larger wheels at the back shows two.
  //
  // Once a tunnel exists, it was cut using the sizes actually typed in, and
  // this is that search: the wheels on the *car*, so hovering one lights up
  // the right faces, narrowed to the ones that ended up in the tunnel. A half
  // tunnel holds one side of the car, and the other side is its reflection.
  const inTunnel = new Set((tunnelVersion?.wheels ?? []).map((w) => w.name));
  const wheels = tunnelVersion?.car_wheels?.length
    ? tunnelVersion.car_wheels.filter((w) => inTunnel.has(w.name))
    : (carVersion?.wheels ?? []);
  const length = Number(carVersion?.bbox?.size?.[0]) || 0;
  const area = form.symmetry
    ? (carVersion?.frontal_area_half_m2 ?? 0)
    : (carVersion?.frontal_area_m2 ?? 0);

  // Which wheels turn. No list at all means all of them, so a car nobody has
  // fiddled with sends nothing and every wheel found spins.
  const spinning = (w) => !Array.isArray(form.spin_wheels)
    || form.spin_wheels.includes(w.name);
  const spinCount = wheels.filter(spinning).length;
  const toggleWheel = (w, on) => {
    const names = wheels.map((one) => one.name);
    const now = new Set(Array.isArray(form.spin_wheels) ? form.spin_wheels : names);
    if (on) now.add(w.name);
    else now.delete(w.name);
    const picked = names.filter((n) => now.has(n));
    // Back to null the moment they are all ticked again, so the setting does
    // not quietly become a list of today's wheel names.
    set({ spin_wheels: picked.length === names.length ? null : picked });
  };

  const built = !!tunnelVersion;
  const preparing = geometry?.domainStatus === "preparing";
  // The build runs in the background and records its own failure on the
  // geometry. Only "preparing" was ever read, so a failed build looked like
  // "Setting up" followed by nothing: the button came back and the message
  // the backend had written was never shown.
  const buildFailed = geometry?.domainStatus === "failed" ? geometry.domainError : null;
  const ready = geometry?.status === "ready" && !!carVersion;

  const price = useMemo(() => {
    try {
      return listPrice(clampRunParams({
        iteration_count: form.iterations,
        refine_level: levelForFineness(form.fineness),
      }));
    } catch { return null; }
  }, [form.iterations, form.fineness]);

  // A step is done when the thing it decides has actually been decided.
  const state = {
    1: wheels.length ? "done" : "todo",
    2: built ? "done" : "todo",
    3: built ? "done" : "todo",
    4: runs.length ? "done" : built ? "todo" : "todo",
  };

  const saveSim = (patch) => {
    if (!simulation) return;
    onSaveSimulation?.(patch);
  };

  // Nothing imported yet. The steps are all about a car, so showing four of
  // them greyed out over an empty viewport says less than one button does.
  if (!geometry) {
    return (
      <div className="wb-card su wb-scroll">
        <div className="su-empty">
          <Icon name="cube" size={26} />
          <p className="su-empty-title">No car yet</p>
          <p className="su-empty-note">
            Import a STEP file. TurboFlow builds the wind tunnel
            around it and fills in the setup.
          </p>
          <button type="button" className="wb-btn wb-btn-primary su-quick" onClick={onImport}>
            Import a car
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="wb-card su wb-scroll">
      {/* Every simulation in this group, with what its last run did.
          A group holds as many as you want, so this is the list you work
          from - and knowing which ones have finished is most of why you
          would open it. */}
      {sims.length ? (
        <div className="su-sims">
          <div className="su-sims-head">
            <span>Simulations</span>
            <button type="button" className="wb-icon-btn wb-tip wb-tip-below"
              data-tip="New simulation" aria-label="New simulation" onClick={onNewSim}>
              <Icon name="plus" size={14} />
            </button>
          </div>
          {sims.map((sim) => {
            const st = simStatus[sim.id] || {};
            return (
              <button key={sim.id} type="button"
                className={"su-sim" + (sim.id === simulation?.id ? " su-sim-on" : "")}
                aria-current={sim.id === simulation?.id}
                onClick={() => onPickSim?.(sim.id)}>
                <StatusDot state={st.dot || "optional"} />
                <span className="su-sim-name">{sim.name || "Simulation"}</span>
                <span className="su-sim-val">{st.label || "not run"}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="su-top">
        <div className="su-car">
          <Icon name="cube" size={15} />
          {geometries.length > 1 ? (
            <select className="wb-field su-car-pick" value={geometry.id}
              aria-label="Car" onChange={(e) => onPickCar?.(e.target.value)}>
              {geometries.map((g) => (
                <option key={g.id} value={g.id}>{g.name || "Car"}</option>
              ))}
            </select>
          ) : (
            <span className="su-car-name">{geometry.name || "Car"}</span>
          )}
          {preparing ? <span className="su-tag">building</span> : null}
          <button type="button" className="wb-icon-btn su-import wb-tip wb-tip-below"
            data-tip="Import another car" aria-label="Import another car"
            onClick={onImport}>
            <Icon name="plus" size={14} />
          </button>
          <CarMenu items={[
            { label: "Rename", onClick: () => onCarAction?.("rename") },
            { label: "Download the original file", onClick: () => onCarAction?.("download") },
          ]} />
        </div>
        <p className="su-car-sub">
          {mm(length)} long
          {wheels.length ? ` · ${wheels.length} wheel${wheels.length === 1 ? "" : "s"}` : ""}
          {carVersion?.rotated_deg ? ` · turned ${carVersion.rotated_deg}°` : ""}
        </p>
        {/* Fragments, said here rather than by a mesh that runs for ten
            minutes and is then refused one fragment at a time. */}
        {/* 5, not 20. On 27 Sep 2026 a car with 12 such faces was refused by
            the mesher at fineness 9.5 and again at 8, on the same entity both
            times, and nothing here had said a word before either run. */}
        {slivers?.count >= 5 ? (
          <Note kind="warn">
            {slivers.count} of this car&rsquo;s {slivers.of} faces are smaller
            than half a millimetre square
            {slivers.worst_band_m
              ? `, ${slivers.worst_band_count} of them between `
                + `${Math.round(slivers.worst_band_m[0] * 1000)} and `
                + `${Math.round(slivers.worst_band_m[1] * 1000)} mm along the car`
              : ""}
            . The mesher often refuses a surface broken up like that, and a
            coarser mesh does not always get round it. Re-exporting the body
            from your CAD tool as one solid, with small features removed, is
            the reliable fix. If the mesh does fail, the run&rsquo;s credits
            come back.
          </Note>
        ) : null}
        <button type="button" className="wb-btn wb-btn-primary su-quick"
          disabled={!ready || busy || preparing}
          onClick={() => onBuild(form)}>
          {preparing ? "Setting up" : built ? "Rebuild with these settings" : "Quick setup"}
        </button>
        <p className="su-quick-note">
          {built
            ? "Or open a step below to change something first."
            : "Uses your saved defaults. Or work through the steps below."}
        </p>
      </div>

      {progress ? (
        <div className="wb-upprog">
          <div className="wb-upbar"><span style={{ width: `${Math.round((progress.fraction ?? 0) * 100)}%` }} /></div>
          <span className="wb-muted">{progress.text || `${Math.round((progress.fraction ?? 0) * 100)}%`}</span>
        </div>
      ) : null}

      {error || buildFailed
        ? <p className="wb-perror su-error" role="alert">{error || `The wind tunnel was not built. ${buildFailed}`}</p>
        : null}

      <Step n={1} title="Wheels" state={state[1]} open={open === 1}
        onToggle={() => setOpen(open === 1 ? 0 : 1)}
        summary={wheels.length ? `${wheels.length} found` : "none found"}>
        <Note>
          Wheels are found by looking for cylinders of about the right size, and
          named for where they sit: the front of the car is the end that meets
          the air. A ticked wheel turns at road speed, the right way round, so
          its contact patch keeps up with the ground. Untick one to leave it
          standing still.
        </Note>
        {built && tunnelVersion?.symmetry ? (
          <Note>
            This is a half tunnel, so these are the wheels on the side that was
            solved. The other side is their mirror image and does whatever they
            do.
          </Note>
        ) : null}
        {wheels.length ? (
          <ul className="su-wheels">
            {wheels.map((w, i) => (
              <li key={w.name || i}
                onMouseEnter={() => onHighlight?.(w.face_indices ?? [])}
                onMouseLeave={() => onHighlight?.([])}>
                <label className="su-wheel">
                  <input type="checkbox" checked={spinning(w)}
                    disabled={!form.rotate_wheels}
                    onChange={(e) => toggleWheel(w, e.target.checked)} />
                  <Icon name="rotateCw" size={13} />
                  <span>{w.name || `Wheel ${i + 1}`}</span>
                  <span className="wb-dim">{(w.radius_m * 2000).toFixed(1)} mm across</span>
                </label>
              </li>
            ))}
          </ul>
        ) : (
          <div className="wb-warnbox">
            <Icon name="warn" size={15} />
            None found. Nothing will be set to spin. Widen the search below and
            set up again.
          </div>
        )}
        <Row label="Front wheel radius"
          hint="A STEM Racing wheel is 28.25 mm across, so 14.1 mm radius.">
          <Num value={form.wheel_radius_m} quantity="length" unit="m" width={90}
            onChange={(v) => set({ wheel_radius_m: v })} />
        </Row>
        {/* Empty means "the same as the front". One radius and one tolerance
            cannot cover two wheel sizes at once: widen the tolerance far
            enough to catch both and the axle starts matching too. */}
        <Row label="Rear wheel radius"
          hint="Set to 0 if the rear wheels are the same size as the front.">
          <Num value={form.rear_wheel_radius_m ?? 0} quantity="length" unit="m"
            width={90}
            onChange={(v) => set({ rear_wheel_radius_m: v > 0 ? v : null })} />
        </Row>
        <Row label="Tolerance" hint="A fraction: 0.08 accepts anything within eight per cent.">
          <Num value={form.wheel_tolerance} width={90}
            onChange={(v) => set({ wheel_tolerance: Math.max(0, Math.min(0.5, v)) })} />
        </Row>
        <Row label="Spin the wheels"
          hint={form.rotate_wheels && wheels.length
            ? `${spinCount} of ${wheels.length} will turn; the rest stay walls.`
            : "Off holds every wheel still, which is not what a moving car does."}>
          <Toggle value={form.rotate_wheels} label="Spin the wheels"
            onChange={(v) => set({ rotate_wheels: v })} />
        </Row>
      </Step>

      <Step n={2} title="Wind tunnel" state={state[2]} open={open === 2}
        onToggle={() => setOpen(open === 2 ? 0 : 2)}
        summary={built ? (tunnelVersion.symmetry ? "half width" : "full width") : "not built"}>
        <Row label="Width"
          hint={form.symmetry
            ? "Half the car against a mirror down its centreline: a quarter of the cells for the same answer."
            : "The whole car. Needed if it is not symmetric."}>
          <Select value={form.symmetry ? "half" : "full"}
            options={[["half", "Half (symmetry)"], ["full", "Full width"]]}
            onChange={(v) => set({ symmetry: v === "half" })} />
        </Row>
        <Row label="Air speed" hint="A STEM Racing car is timed near 20 m/s.">
          <Num value={form.speed} quantity="speed" unit="m/s" width={90}
            onChange={(v) => set({ speed: Math.max(1, Math.min(100, v)) })} />
        </Row>
        <Row label="Reference area"
          hint="The car's shadow over this width. Drag is divided by it to give Cd.">
          <span>{cm2(area)}</span>
        </Row>
        <Row label="Road moves with the air">
          <Toggle value={form.moving_ground} label="Moving road"
            onChange={(v) => set({ moving_ground: v })} />
        </Row>
        <details className="su-more">
          <summary>Tunnel size</summary>
          <Row label="Upstream">
            <Num value={form.upstream_m} quantity="length" unit="m" width={80}
              onChange={(v) => set({ upstream_m: v })} />
          </Row>
          <Row label="Downstream">
            <Num value={form.downstream_m} quantity="length" unit="m" width={80}
              onChange={(v) => set({ downstream_m: v })} />
          </Row>
          <Row label="To the side">
            <Num value={form.side_m} quantity="length" unit="m" width={80}
              onChange={(v) => set({ side_m: v })} />
          </Row>
          <Row label="Above">
            <Num value={form.top_m} quantity="length" unit="m" width={80}
              onChange={(v) => set({ top_m: v })} />
          </Row>
        </details>
        <button type="button" className="wb-btn wb-btn-primary su-go"
          disabled={!ready || busy || preparing} onClick={() => onBuild(form)}>
          {built ? "Rebuild the tunnel" : "Build the tunnel"}
        </button>
      </Step>

      <Step n={3} title="Mesh" state={state[3]} open={open === 3}
        onToggle={() => setOpen(open === 3 ? 0 : 3)}
        summary={FINENESS_OPTIONS.find(([v]) => Number(v) === form.fineness)?.[1]}>
        <Note>
          This sets the tunnel. The car and the wheels are meshed half a step
          finer, so coarsening here coarsens them too. Finer resolves the wake
          better and costs more.
        </Note>
        <Row label="Fineness">
          <Select value={String(form.fineness)}
            options={FINENESS_OPTIONS.some(([v]) => Number(v) === form.fineness)
              ? FINENESS_OPTIONS
              : [...FINENESS_OPTIONS, [String(form.fineness), `Custom (${form.fineness})`]]}
            onChange={(v) => { set({ fineness: Number(v) }); saveSim({ fineness: Number(v) }); }} />
        </Row>
        {simulation?.mesh?.cell_count ? (
          <Note>
            The last run meshed to {Number(simulation.mesh.cell_count).toLocaleString()} cells.
          </Note>
        ) : null}
        {built ? (
          <div className="su-export">
            {/* Temporary: the flow region as a STEP file, for taking the
                tunnel somewhere else until the solver path is final. */}
            <button type="button" className="wb-btn su-export-btn"
              disabled={!tunnelVersion?.step_path || busy} onClick={onExportStep}>
              Export the flow region (STEP)
            </button>
            <Note>
              The tunnel exactly as it was built, with the car cut out. A half
              tunnel exports half a tunnel - build full width first if you
              need the whole thing.
            </Note>
          </div>
        ) : null}
      </Step>

      <Step n={4} title="Simulation" state={state[4]} open={open === 4}
        onToggle={() => setOpen(open === 4 ? 0 : 4)}
        summary={`${form.iterations} iterations`}>
        <Row label="Iterations"
          hint="1000 is enough for a car this size. Below about 400 the forces are still moving.">
          <Num value={form.iterations} width={90}
            onChange={(v) => {
              const n = Math.max(100, Math.min(3000, Math.round(v)));
              set({ iterations: n });
              saveSim({ iterations: n });
            }} />
        </Row>
        {price != null ? (
          <Row label="This run costs">
            <span>
              {price} credits
              {credits != null ? <span className="wb-dim"> · you have {credits}</span> : null}
            </span>
          </Row>
        ) : null}
        <button type="button" className="wb-btn wb-btn-primary su-go"
          disabled={!built || !simulation || busy} onClick={onQueue}>
          Queue a run
        </button>
        {!built ? <Note>Build the tunnel first.</Note> : null}
      </Step>

      <div className="su-foot">
        <button type="button" className="wb-linkbtn" onClick={() => onSaveDefaults?.(form)}>
          Save these as my defaults
        </button>
      </div>

      {runs.length ? (
        <div className="su-runs">
          <p className="su-runs-head">Runs</p>
          {runs.map((r, i) => (
            <button key={r.id} type="button" className="su-run"
              onClick={() => onQueue?.(r)}>
              <StatusDot state={r.status === "finished" ? "complete"
                : r.status === "failed" ? "error"
                  : r.status === "cancelled" ? "cancelled" : "running"} />
              <span>{r.name || `Run ${i + 1}`}</span>
              <span className="wb-dim">
                {r.summary?.drag != null ? `${r.summary.drag.toFixed(3)} N` : r.stageText || r.status}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
