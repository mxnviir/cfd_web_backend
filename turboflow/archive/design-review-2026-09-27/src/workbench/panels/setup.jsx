// The setup panels for an Incompressible simulation. Build spec 9.
//
// One component per tree node, in the spec's order, each reading and writing
// the same `spec` document that goes to SimScale. Nothing here invents a
// default: every value comes from the Workbench-created spec in
// docs/simscale/default_incompressible_spec.json, and a field the spec does
// not list is left out rather than guessed (ground rule 2).
import React, { useMemo, useState } from "react";
import { Icon } from "../icons";
import { Row, Section, Num, Select, Toggle, Vec, Assignment, Note } from "./fields";
import { FLUIDS, VISCOSITY_MODELS, fluidSpec } from "../../lib/materials";
import { FINENESS_STEPS as PRICED_FINENESS } from "../../lib/pricing";
import { Modal } from "../../dashboard/dialogs";

const TURBULENCE = [
  ["NONE", "Laminar"], ["KEPSILON", "k-epsilon"], ["REALIZABLEKE", "Realizable k-epsilon"],
  ["KOMEGA", "k-omega"], ["KOMEGASST", "k-omega SST"],
  ["SMAGORINSKY", "LES Smagorinsky"], ["SPALARTALLMARAS", "LES Spalart-Allmaras"],
];

/** Which extra fields a turbulence model brings with it. Build spec 9.3. */
export function turbulenceFields(model) {
  if (model === "KEPSILON" || model === "REALIZABLEKE") return ["k", "epsilon"];
  if (model === "KOMEGA" || model === "KOMEGASST") return ["k", "omega"];
  if (model === "SPALARTALLMARAS") return ["nuTilda"];
  return [];
}

// ── 9.3 global ─────────────────────────────────────────────────────────────
export function GlobalPanel({ draft, set }) {
  const steady = draft.timeDependency?.type !== "TRANSIENT";
  return (
    <>
      <Row label="Analysis">
        <span className="wb-chip-blue">Incompressible</span>
      </Row>
      <Row label="Turbulence model"
        hint="Changing this changes which initial conditions and inlet turbulence fields exist. Values you have already typed are kept.">
        <Select value={draft.turbulenceModel} options={TURBULENCE}
          onChange={(v) => set("turbulenceModel", v)} />
      </Row>
      <Row label="Time dependency">
        <Select
          value={draft.timeDependency?.type ?? "STATIONARY"}
          options={[["STATIONARY", "Steady-state"], ["TRANSIENT", "Transient"]]}
          onChange={(v) => set({
            timeDependency: { ...draft.timeDependency, type: v },
            // SIMPLE cannot march in time and PIMPLE is wasted on a steady
            // run, so the pair move together. SimScale greys the algorithm
            // field for the same reason.
            algorithm: v === "TRANSIENT" ? "PIMPLE" : "SIMPLE",
          })}
        />
      </Row>
      <Row label="Algorithm">
        <Select value={steady ? "SIMPLE" : "PIMPLE"} disabled
          options={[["SIMPLE", "SIMPLE"], ["PIMPLE", "PIMPLE"]]} onChange={() => {}} />
      </Row>
      <Row label="Passive species">
        <Num value={draft.numOfPassiveSpecies ?? 0} width={70}
          onChange={(v) => set("numOfPassiveSpecies", Math.max(0, Math.min(10, Math.round(v))))} />
      </Row>
    </>
  );
}


/**
 * Is this model a closed flow domain rather than a bare car?
 *
 * It matters because "frontal area" is the area of the model's shadow, and a
 * wind tunnel's shadow is the tunnel's cross-section. On the test flow region
 * that is 0.125 m2, which is the inlet face, not the car. Prefilled as a
 * reference area it would divide the drag by the wrong number and hand a team
 * a Cd that is wrong by the ratio of tunnel to car - the one figure they
 * actually compete on.
 *
 * A solid box fills its own bounding box; a car fills about half of it. The
 * test flow region comes out at 98%.
 */
export function isFlowDomain(version) {
  const size = version?.bbox?.size;
  const area = version?.frontal_area_m2;
  if (!Array.isArray(size) || size.length < 3 || !area) return false;
  const section = size[1] * size[2];
  return section > 0 && area / section > 0.9;
}

/** The six walls a wind tunnel should have, in the order air meets them. */
const WALLS = [
  ["inlet", "Inlet"], ["outlet", "Outlet"], ["ground", "Road"],
  ["top", "Roof"], ["side", "Side wall"], ["symmetry", "Symmetry plane"],
  ["car_no_slip", "Car"],
];

/**
 * What the wind tunnel came out as. Build spec 7.2.
 *
 * Shown because the alternative is finding out by paying for a run. Every
 * failure this table catches is one that solves perfectly and reports a
 * meaningless number: a tunnel with no inlet converges to still air and a
 * drag of zero, and one where the car was not recognised puts a no-slip wall
 * on nothing.
 */
function DomainSummary({ version, onRebuild }) {
  const counts = version.label_counts ?? {};
  const missing = version.missing_labels ?? [];
  const wheels = version.wheels ?? [];
  return (
    <Section title="Wind tunnel">
      <Row label="Width">
        <span>{version.symmetry ? "Half, with a symmetry plane" : "Full width"}</span>
      </Row>
      {version.symmetry && version.symmetry_plane_y != null ? (
        <Row label="Symmetry plane"
          hint={version.symmetry_kind === "half"
            ? "Put on the car's own flat cut face, which is where a half model ends."
            : version.symmetry_kind === "ambiguous"
              ? undefined
              : "This car is modelled whole, so it was cut down its own centreline."}>
          <span>y = {(version.symmetry_plane_y * 1000).toFixed(1)} mm</span>
        </Row>
      ) : null}
      {version.symmetry && version.symmetry_kind === "ambiguous" ? (
        <div className="wb-warnbox">
          <Icon name="warn" size={15} />
          Both sides of this car are flat, so there is no way to tell whether it
          is already a half model or a whole one. It was cut down the middle. If
          it was already a half, that has made it a quarter: check the tunnel in
          the viewer, and if the car looks too narrow, rebuild at full width.
        </div>
      ) : null}
      {missing.length ? (
        <div className="wb-warnbox">
          <Icon name="warn" size={15} />
          No {missing.join(", ")} was found on this tunnel. A run without one
          will finish and mean nothing. Rebuild it, or assign those faces by
          hand in Boundary conditions.
        </div>
      ) : null}
      {(version.unresolvable_faces ?? []).length ? (
        <div className="wb-warnbox">
          <Icon name="warn" size={15} />
          {version.unresolvable_faces.length} face
          {version.unresolvable_faces.length === 1 ? "" : "s"} on this tunnel
          could not be tied back to the CAD file. A boundary condition on one
          of them stops the run rather than solving it wrongly. Rebuilding the
          tunnel usually clears it.
        </div>
      ) : null}
      {WALLS.map(([key, label]) => (
        <Row key={key} label={label}>
          <span className={counts[key] ? "" : "wb-dim"}>
            {counts[key] ? `${counts[key]} face${counts[key] === 1 ? "" : "s"}` : "none"}
          </span>
        </Row>
      ))}
      <Row label="Wheels"
        hint={wheels.length ? "Each one turns at road speed." : undefined}>
        <span className={wheels.length ? "" : "wb-dim"}>
          {wheels.length
            ? wheels.map((w) => `${(w.radius_m * 2000).toFixed(1)} mm`).join(", ")
            : "none found"}
        </span>
      </Row>
      {onRebuild ? (
        <button type="button" className="wb-link wb-preset" onClick={onRebuild}>
          Rebuild the wind tunnel
        </button>
      ) : null}
    </Section>
  );
}

// ── 9.4 geometry ───────────────────────────────────────────────────────────
export function GeometryPanel({
  simulation, geometries, geometry, version, onAssign, onRebuild,
}) {
  const newer = geometry && version && geometry.currentVersion > (simulation.geometryVersion ?? geometry.currentVersion);
  const isDomain = version?.kind === "flow_domain";
  return (
    <>
      {/* Only when there is a choice to make. With one car in the project this
          was a dropdown containing one option, above the statistics for the
          thing it was already showing. */}
      {geometries.length > 1 ? (
        <Row label="Car">
          <Select
            value={simulation.geometryId ?? ""}
            options={[["", "Pick a car"], ...geometries.map((g) => [g.id, g.name || g.id])]}
            onChange={onAssign}
          />
        </Row>
      ) : null}
      {isDomain ? <DomainSummary version={version} onRebuild={onRebuild} /> : null}
      {!isDomain && onRebuild ? (
        <div className="wb-warnbox">
          <Icon name="warn" size={15} />
          This is a bare car, not a wind tunnel. Air has to have somewhere to
          flow.
          <button type="button" className="wb-btn" onClick={onRebuild}>
            Build one
          </button>
        </div>
      ) : null}
      {newer ? (
        <div className="wb-warnbox">
          <Icon name="warn" size={15} />
          A newer version of this geometry exists.
          <button type="button" className="wb-btn">Update</button>
        </div>
      ) : null}
      {version ? (
        <Section title="Statistics">
          <Row label="Bodies"><span>{version.solid_count ?? "-"}</span></Row>
          <Row label="Faces"><span>{version.face_count ?? "-"}</span></Row>
          <Row label="Triangles"><span>{(version.triangle_count ?? 0).toLocaleString()}</span></Row>
          <Row label="Frontal area"
            hint={isFlowDomain(version) && version.kind !== "flow_domain"
              ? "This is the shadow of the whole model, and this model is a closed flow domain, so the figure is the tunnel's cross-section and not the car's. Measure the car itself before using it as a reference area."
              : undefined}>
            <span>{version.frontal_area_m2
              ? `${(version.frontal_area_m2 * 1e4).toFixed(2)} cm²` : "-"}</span>
            {isFlowDomain(version) && version.kind !== "flow_domain" ? (
              <span className="wb-row-warn" role="img" aria-label="the domain's cross-section, not the car's">
                <Icon name="warn" size={12} />
              </span>
            ) : null}
          </Row>
          <Row label="Reference length">
            <span>{version.reference_length_m
              ? `${(version.reference_length_m * 1000).toFixed(1)} mm` : "-"}</span>
          </Row>
          <Row label="Unit in the file"><span>{version.unit ?? "-"}</span></Row>
          {version.rotated_deg ? (
            <Row label="Turned into the wind"
              hint="The car was modelled across the flow, so it was rotated to face it.">
              <span>{version.rotated_deg}°</span>
            </Row>
          ) : null}
        </Section>
      ) : <p className="wb-dim">No geometry assigned yet.</p>}
    </>
  );
}

// ── 9.5 model ──────────────────────────────────────────────────────────────
export function ModelPanel({ draft, set }) {
  const steady = draft.timeDependency?.type !== "TRANSIENT";
  return (
    <>
      <Row label="Gravity"
        hint={steady ? "Read-only on a steady-state run, where it has no effect." : null}>
        <Vec value={draft.model?.gravity?.value ?? { x: 0, y: 0, z: 0 }}
          quantity="acceleration" unit="m/s²" disabled={steady}
          onChange={(v) => set("model.gravity", { value: v, unit: "m/s²" })} />
      </Row>
      <Note>No further model settings for this analysis type.</Note>
    </>
  );
}

// ── 9.6 materials ──────────────────────────────────────────────────────────
export function MaterialDialog({ onClose, onApply }) {
  const [picked, setPicked] = useState(FLUIDS[0]);
  return (
    <Modal title="Material" onClose={onClose} width={710}
      footer={
        <>
          <button type="button" className="wb-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="wb-btn wb-btn-primary"
            onClick={() => onApply(fluidSpec(picked))}>Apply</button>
        </>
      }>
      <div className="wb-matdialog">
        <ul className="wb-matlist">
          {FLUIDS.map((f) => (
            <li key={f.id}>
              <button type="button"
                className={"wb-matrow" + (picked.id === f.id ? " wb-matrow-on" : "")}
                onClick={() => setPicked(f)}>
                {f.name}
              </button>
            </li>
          ))}
        </ul>
        <div className="wb-matprops">
          <Row label="Viscosity model"><span>Newtonian</span></Row>
          <Row label="(v) Kinematic viscosity">
            <span>{picked.nu.toExponential(4)} m²/s</span>
          </Row>
          <Row label="(p) Density"><span>{picked.rho} kg/m³</span></Row>
          {!picked.verified ? (
            <p className="wb-pnote">
              These values are standard ones at 20 C rather than measured.
              Air and Water are the two that were checked. Confirm this fluid
              before you rely on the numbers.
            </p>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}

export function MaterialPanel({ material, onChange, assignment }) {
  return (
    <>
      <Row label="Viscosity model">
        <Select value={material.viscosityModel?.type ?? "NEWTONIAN"} options={VISCOSITY_MODELS}
          onChange={(v) => onChange({
            ...material,
            viscosityModel: { ...material.viscosityModel, type: v },
          })} />
      </Row>
      <Row label="(v) Kinematic viscosity">
        <Num value={material.viscosityModel?.kinematicViscosity?.value ?? 0} width={110}
          onChange={(v) => onChange({
            ...material,
            viscosityModel: {
              ...material.viscosityModel,
              kinematicViscosity: { value: v, unit: "m²/s" },
            },
          })} />
        <span className="wb-unit wb-unit-fixed">m²/s</span>
      </Row>
      <Row label="(p) Density">
        <Num value={material.density?.value ?? 0} width={110}
          onChange={(v) => onChange({ ...material, density: { value: v, unit: "kg/m³" } })} />
        <span className="wb-unit wb-unit-fixed">kg/m³</span>
      </Row>
      {assignment}
    </>
  );
}

// ── 9.7 initial conditions ─────────────────────────────────────────────────
export function InitialConditionsPanel({ draft, set }) {
  const has = turbulenceFields(draft.turbulenceModel);
  const ic = draft.initialConditions ?? {};
  return (
    <>
      <Row label="Gauge pressure (p)">
        <Num value={ic.gaugePressure?.global?.value ?? 0} quantity="pressure" unit="Pa"
          onChange={(v) => set("initialConditions.gaugePressure.global", { value: v, unit: "Pa" })} />
      </Row>
      <Row label="Velocity (U)" group>
        <Vec value={ic.velocity?.global?.value ?? { x: 0, y: 0, z: 0 }}
          quantity="speed" unit="m/s"
          onChange={(v) => set("initialConditions.velocity.global", { value: v, unit: "m/s" })} />
      </Row>
      {has.includes("k") ? (
        <Row label="Turb. kinetic energy (k)">
          <Num value={ic.turbulentKineticEnergy?.global?.value ?? 0.00375} width={110}
            onChange={(v) => set("initialConditions.turbulentKineticEnergy.global",
              { value: v, unit: "m²/s²" })} />
          <span className="wb-unit wb-unit-fixed">m²/s²</span>
        </Row>
      ) : null}
      {has.includes("omega") ? (
        <Row label="Specific dissipation rate (ω)">
          <Num value={ic.omegaDissipationRate?.global?.value ?? 3.375} width={110}
            onChange={(v) => set("initialConditions.omegaDissipationRate.global",
              { value: v, unit: "1/s" })} />
          <span className="wb-unit wb-unit-fixed">1/s</span>
        </Row>
      ) : null}
      {has.includes("epsilon") ? (
        <Row label="Dissipation rate (e)">
          <Num value={ic.dissipationRate?.global?.value ?? 0.0225} width={110}
            onChange={(v) => set("initialConditions.dissipationRate.global",
              { value: v, unit: "m²/s³" })} />
          <span className="wb-unit wb-unit-fixed">m²/s³</span>
        </Row>
      ) : null}
      {has.includes("nuTilda") ? (
        <Row label="nuTilda">
          <Num value={ic.nuTilda?.global?.value ?? 0} width={110}
            onChange={(v) => set("initialConditions.nuTilda.global", { value: v, unit: "m²/s" })} />
          <span className="wb-unit wb-unit-fixed">m²/s</span>
        </Row>
      ) : null}
      {!has.length ? <Note>A laminar run has no turbulence quantities to initialise.</Note> : null}
    </>
  );
}

// ── 9.10 numerics ──────────────────────────────────────────────────────────
const SOLVERS = [["PBICGStab", "PBiCGStab"], ["PBICG", "PBiCG"], ["PCG", "PCG"],
  ["GAMG", "GAMG"], ["SMOOTHSOLVER", "smoothSolver"]];
const PRECOND = [["DILU", "DILU"], ["DIC", "DIC"], ["GAMG", "GAMG"], ["NONE", "none"]];
const SMOOTHERS = [["GAUSSSEIDEL", "Gauss-Seidel"], ["SYMGAUSSSEIDEL", "symGauss-Seidel"],
  ["DIC", "DIC"], ["DICGAUSSSEIDEL", "DICGaussSeidel"]];

export function NumericsPanel({ draft, set, onReset }) {
  const n = draft.numerics ?? {};
  const rf = n.relaxationFactor ?? {};
  const num = (label, path, value, step) => (
    <Row label={label}>
      <Num value={value} width={90} onChange={(v) => set(path, v)} step={step} />
    </Row>
  );
  return (
    <>
      <Note>
        In most cases the standard settings are a good choice and should not be
        changed without reason.
      </Note>
      <Section title="Relaxation">
        <Row label="Relaxation type">
          <Select value={n.relaxationType ?? "MANUAL"}
            options={[["MANUAL", "Manual"], ["AUTOMATIC", "Automatic"]]}
            onChange={(v) => set("numerics.relaxationType", v)} />
        </Row>
        {num("Pressure field", "numerics.relaxationFactor.pressureField", rf.pressureField ?? 0.3)}
        {num("Velocity equation", "numerics.relaxationFactor.velocityEquation", rf.velocityEquation ?? 0.7)}
        {num("k equation", "numerics.relaxationFactor.turbulentKineticEnergyEquation",
          rf.turbulentKineticEnergyEquation ?? 0.3)}
        {num("ω equation", "numerics.relaxationFactor.omegaDissipationRateEquation",
          rf.omegaDissipationRateEquation ?? 0.3)}
        {num("Age of fluid equation", "numerics.relaxationFactor.ageOfFluidEquation",
          rf.ageOfFluidEquation ?? 0.8)}
      </Section>
      <Section title="Correctors and reference" open={false}>
        {num("Non-orthogonal correctors", "numerics.numNonOrthogonalCorrectors",
          n.numNonOrthogonalCorrectors ?? 1)}
        {num("Pressure reference cell", "numerics.pressureReferenceCell", n.pressureReferenceCell ?? 0)}
        <Row label="Pressure reference value">
          <Num value={n.pressureReferenceValue?.value ?? 0} quantity="pressure" unit="Pa"
            onChange={(v) => set("numerics.pressureReferenceValue", { value: v, unit: "Pa" })} />
        </Row>
      </Section>
      <Section title="Solvers" open={false}>
        <Row label="Velocity solver">
          <Select value={n.solvers?.velocitySolver?.type ?? "PBICGStab"} options={SOLVERS}
            onChange={(v) => set("numerics.solvers.velocitySolver.type", v)} />
        </Row>
        <Row label="Velocity preconditioner">
          <Select value={n.solvers?.velocitySolver?.preconditioner?.type ?? "DILU"} options={PRECOND}
            onChange={(v) => set("numerics.solvers.velocitySolver.preconditioner.type", v)} />
        </Row>
        <Row label="Pressure solver">
          <Select value={n.solvers?.pressureSolver?.type ?? "GAMG"} options={SOLVERS}
            onChange={(v) => set("numerics.solvers.pressureSolver.type", v)} />
        </Row>
        <Row label="Pressure smoother">
          <Select value={n.solvers?.pressureSolver?.smoother ?? "GAUSSSEIDEL"} options={SMOOTHERS}
            onChange={(v) => set("numerics.solvers.pressureSolver.smoother", v)} />
        </Row>
      </Section>
      <button type="button" className="wb-link wb-preset" onClick={onReset}>
        Reset to default
      </button>
    </>
  );
}

// ── 9.11 simulation control ────────────────────────────────────────────────
const WRITE_CONTROL = [
  ["TIME_STEP", "Time step"], ["CLOCK_TIME", "Clock time"], ["RUNTIME", "Runtime"],
  ["CPU_TIME", "CPU time"], ["ADJUSTABLE_RUNTIME", "Adjustable runtime"],
];
const DECOMPOSE = [["SCOTCH", "Scotch"], ["SIMPLE", "Simple"], ["HIERARCHICAL", "Hierarchical"]];
const PROCESSORS = [["-1", "Automatic"], ["4", "4"], ["8", "8"], ["16", "16"],
  ["32", "32"], ["48", "48"], ["64", "64"], ["96", "96"]];

export function SimulationControlPanel({ draft, set, estimate }) {
  const c = draft.simulationControl ?? {};
  const transient = draft.timeDependency?.type === "TRANSIENT";
  return (
    <>
      <Row label="End time"
        hint={transient ? null : "Number of iterations for a steady-state run."}>
        <Num value={c.endTime?.value ?? 1000} quantity="time" unit="s"
          onChange={(v) => set("simulationControl.endTime", { value: v, unit: "s" })} />
      </Row>
      {estimate != null ? (
        <Row label="Estimated cost"><span>{estimate} credits</span></Row>
      ) : null}
      <Row label="Delta t">
        <Num value={c.deltaT?.value ?? 1} quantity="time" unit="s"
          onChange={(v) => set("simulationControl.deltaT", { value: v, unit: "s" })} />
      </Row>
      <Row label="Write control">
        <Select value={c.writeControl?.type ?? "TIME_STEP"} options={WRITE_CONTROL}
          onChange={(v) => set("simulationControl.writeControl.type", v)} />
      </Row>
      <Row label="Write interval">
        <Num value={c.writeControl?.writeInterval ?? 1000} width={90}
          onChange={(v) => set("simulationControl.writeControl.writeInterval", Math.max(1, Math.round(v)))} />
      </Row>
      <Row label="Number of processors">
        <Select value={String(c.numProcessors ?? -1)} options={PROCESSORS}
          onChange={(v) => set("simulationControl.numProcessors", Number(v))} />
      </Row>
      <Row label="Maximum runtime">
        <Num value={c.maxRunTime?.value ?? 20000} quantity="time" unit="s"
          onChange={(v) => set("simulationControl.maxRunTime", { value: v, unit: "s" })} />
      </Row>
      <Row label="Potential flow initialization">
        <Toggle value={!!c.potentialFoamInitialization} label="Potential flow initialization"
          onChange={(v) => set("simulationControl.potentialFoamInitialization", v)} />
      </Row>
      <Row label="Decompose algorithm">
        <Select value={c.decomposeAlgorithm?.type ?? "SCOTCH"} options={DECOMPOSE}
          onChange={(v) => set("simulationControl.decomposeAlgorithm.type", v)} />
      </Row>
    </>
  );
}

// ── 9.12 result control: force and moment coefficients ─────────────────────
export function ForceCoefficientsPanel({ item, onChange, assignment, prefill }) {
  const v = item ?? {};
  const vec = (label, key, fallback) => (
    <Row label={label}>
      <Vec value={v[key] ?? fallback} onChange={(x) => onChange({ ...v, [key]: x })} />
    </Row>
  );
  return (
    <>
      <Row label="Name">
        <input className="wb-field" value={v.name ?? "Drag and lift"}
          onChange={(e) => onChange({ ...v, name: e.target.value })} />
      </Row>
      <Row label="Centre of rotation" group>
        <Vec value={v.centerOfRotation?.value ?? { x: 0, y: 0, z: 0 }} quantity="length" unit="m"
          onChange={(x) => onChange({ ...v, centerOfRotation: { value: x, unit: "m" } })} />
      </Row>
      {vec("Lift direction", "liftDirection", { x: 0, y: 0, z: 1 })}
      {vec("Drag direction", "dragDirection", prefill?.dragDirection ?? { x: 1, y: 0, z: 0 })}
      {vec("Pitch axis", "pitchAxisDirection", { x: 0, y: 1, z: 0 })}
      <Row label="Freestream velocity"
        hint={prefill?.speed ? "Taken from Velocity inlet 1." : null}>
        <Num value={v.freestreamVelocityMagnitude?.value ?? prefill?.speed ?? 0}
          quantity="speed" unit="m/s"
          onChange={(x) => onChange({ ...v, freestreamVelocityMagnitude: { value: x, unit: "m/s" } })} />
      </Row>
      <Row label="Reference length">
        <Num value={v.referenceLength?.value ?? prefill?.length ?? 0} quantity="length" unit="m"
          onChange={(x) => onChange({ ...v, referenceLength: { value: x, unit: "m" } })} />
      </Row>
      <Row label="Reference area"
        hint={prefill?.area ? "Measured from the car's silhouette by the geometry service." : null}>
        <Num value={v.referenceArea?.value ?? prefill?.area ?? 0} quantity="area" unit="m²"
          onChange={(x) => onChange({ ...v, referenceArea: { value: x, unit: "m²" } })} />
      </Row>
      <Row label="Write interval">
        <Num value={v.writeControl?.writeInterval ?? 1} width={90}
          onChange={(x) => onChange({
            ...v, writeControl: { type: "TIME_STEP", writeInterval: Math.max(1, Math.round(x)) },
          })} />
      </Row>
      {assignment}
    </>
  );
}

export function ForcesMomentsPanel({ item, onChange, assignment }) {
  const v = item ?? {};
  return (
    <>
      <Row label="Name">
        <input className="wb-field" value={v.name ?? "Forces and moments"}
          onChange={(e) => onChange({ ...v, name: e.target.value })} />
      </Row>
      <Row label="Centre of rotation" group>
        <Vec value={v.centerOfRotation?.value ?? { x: 0, y: 0, z: 0 }} quantity="length" unit="m"
          onChange={(x) => onChange({ ...v, centerOfRotation: { value: x, unit: "m" } })} />
      </Row>
      <Row label="Write interval">
        <Num value={v.writeControl?.writeInterval ?? 1} width={90}
          onChange={(x) => onChange({
            ...v, writeControl: { type: "TIME_STEP", writeInterval: Math.max(1, Math.round(x)) },
          })} />
      </Row>
      {assignment}
    </>
  );
}

export { Assignment };

/**
 * The mesh settings panel. Build spec 10.1.
 *
 * This node used to say "Mesh has nothing to set for an Incompressible run on
 * a car", which was not true: fineness is the single biggest lever a team has
 * over both accuracy and price, and the worker has always read these values.
 * The panel was a stub because `saveSimulation` only ever sent `spec`, so
 * there was nowhere for the settings to go. Both halves are fixed now.
 *
 * In queue mode there is no Generate button. SimScale has one; here the mesh
 * is built inside the queued run, so the tick saves and the footer says when
 * the mesh will actually happen.
 */
export function MeshPanel({ mesh, onChange, lastRun }) {
  const set = (patch) => onChange({ ...mesh, ...patch });
  const sizing = mesh?.sizing ?? {};
  const setSizing = (patch) => set({ sizing: { ...sizing, ...patch } });
  const auto = (sizing.type ?? "AUTOMATIC_V9") === "AUTOMATIC_V9";
  const layersOn = (mesh?.automaticLayerSettings?.type ?? "AUTOMATIC_LAYER_ON") === "AUTOMATIC_LAYER_ON";

  // The five rungs the product actually prices and meshes with, from
  // lib/pricing. See FINENESS_STEPS there for why it is not 1 to 9.
  const FINENESS_STEPS = PRICED_FINENESS.map(([v, label]) => [String(v), label]);
  const finenessValue = String(sizing.fineness ?? 5);
  const known = FINENESS_STEPS.some(([v]) => v === finenessValue);

  return (
    <>
      <Row label="Algorithm">
        <Select value={mesh?.type ?? "SIMMETRIX_MESHING_FLUID_V16"}
          onChange={(t) => set({ type: t })}
          options={[
            ["SIMMETRIX_MESHING_FLUID_V16", "Standard"],
            ["HEX_DOMINANT_SNAPPY_V5", "Hex-dominant (not available yet)"],
          ]} />
      </Row>
      <Row label="Sizing">
        <Select value={sizing.type ?? "AUTOMATIC_V9"}
          onChange={(t) => setSizing({ type: t })}
          options={[["AUTOMATIC_V9", "Automatic"], ["MANUAL", "Manual"]]} />
      </Row>

      {auto ? (
        <Row label="Fineness"
          hint="Finer resolves the wake better and costs more. Moderate is the right starting point. If the mesher reports that the mesh is too coarse on a named entity, raise Small feature suppression under Advanced before raising this.">
          <Select value={known ? finenessValue : "custom"}
            onChange={(v) => { if (v !== "custom") setSizing({ fineness: Number(v) }); }}
            options={known ? FINENESS_STEPS : [...FINENESS_STEPS, ["custom", `Custom (${finenessValue})`]]} />
        </Row>
      ) : (
        <>
          <Row label="Max edge length">
            <Num value={sizing.maximumEdgeLength?.value} quantity="length" unit="m"
              onChange={(v) => setSizing({ maximumEdgeLength: { value: v, unit: "m" } })} />
          </Row>
          <Row label="Min edge length">
            <Num value={sizing.minimumEdgeLength?.value} quantity="length" unit="m"
              onChange={(v) => setSizing({ minimumEdgeLength: { value: v, unit: "m" } })} />
          </Row>
        </>
      )}

      <Row label="Curvature">
        <Select value={sizing.curvature?.type ?? "AUTOMATIC_CURVATURE"}
          onChange={(t) => setSizing({ curvature: { type: t } })}
          options={[
            ["AUTOMATIC_CURVATURE", "Automatic"],
            ["RELATIVE_CURVATURE", "Relative"],
          ]} />
      </Row>

      <Section title="Boundary layers">
        <Row label="Automatic layers"
          hint="Thin cells stacked on every wall, so the solver can resolve the boundary layer that makes skin friction.">
          <Toggle value={layersOn}
            onChange={(on) => set({
              automaticLayerSettings: { type: on ? "AUTOMATIC_LAYER_ON" : "AUTOMATIC_LAYER_OFF" },
            })} />
        </Row>
      </Section>

      <Section title="Advanced" open={false}>
        <Row label="Small feature suppression"
          hint="Features smaller than this are ignored by the mesher. A car exported from CAD carries slivers a fraction of a millimetre across, and the mesher fails outright rather than meshing them. 0.5 mm is a safe start.">
          <Num value={mesh?.advancedSimmetrixSettings?.smallFeatureTolerance?.value}
            quantity="length" unit="m"
            onChange={(v) => set({
              advancedSimmetrixSettings: {
                ...(mesh?.advancedSimmetrixSettings ?? {}),
                smallFeatureTolerance: { value: v, unit: "m" },
              },
            })} />
        </Row>
        <Row label="Physics-based meshing"
          hint="Lets the mesher put cells where the flow needs them rather than spreading them evenly.">
          <Toggle value={mesh?.physicsBasedMeshing !== false}
            onChange={(v) => set({ physicsBasedMeshing: v })} />
        </Row>
        <Row label="Hex element core">
          <Toggle value={mesh?.hexCore !== false} onChange={(v) => set({ hexCore: v })} />
        </Row>
        <Row label="Processors"
          hint="Automatic lets the solver choose. Fixing it only helps if you know the plan's limit.">
          <Select value={String(mesh?.numOfProcessors ?? -1)}
            onChange={(v) => set({ numOfProcessors: Number(v) })}
            options={[["-1", "Automatic"], ["4", "4"], ["8", "8"], ["16", "16"], ["32", "32"]]} />
        </Row>
      </Section>

      {lastRun?.mesh?.cell_count ? (
        <Note>
          The last run meshed to {Number(lastRun.mesh.cell_count).toLocaleString()} cells
          and {Number(lastRun.mesh.node_count ?? 0).toLocaleString()} nodes.
        </Note>
      ) : (
        <Note>
          The mesh is built when the run is queued, so the cell count appears
          after the first run.
        </Note>
      )}
    </>
  );
}
