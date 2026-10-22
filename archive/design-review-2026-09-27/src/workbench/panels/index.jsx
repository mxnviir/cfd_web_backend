// Which panel a tree node opens, and how its edits reach the database.
// Build spec 9.
//
// One component rather than a lookup table of components, because every
// panel shares the same three things: the draft, the frame with the blue
// tick, and the assignment box wired to the viewer. A table would mean each
// panel wiring those itself, and the first one that wired them differently
// would be the one that saved on every keystroke.
import React, { useCallback, useEffect, useMemo, useState } from "react";
import SettingsPanel from "../SettingsPanel";
import useDraft, { at, setAt } from "./useDraft";
import { Assignment, Row, Note } from "./fields";
import {
  GlobalPanel, GeometryPanel, ModelPanel, InitialConditionsPanel, NumericsPanel,
  SimulationControlPanel, MaterialPanel, MaterialDialog, ForceCoefficientsPanel,
  ForcesMomentsPanel, MeshPanel, isFlowDomain,
} from "./setup";
import BoundaryConditionPanel, { BC_TYPES, newBoundaryCondition } from "./boundary";
import RunPanel, { previousRun } from "../runs/RunPanel";
import { NODE_BY_ID } from "../simtree";
import { clampRunParams, listPrice, FINENESS } from "../../lib/pricing";

/** The node a path opens, and the index of the child it names. */
export function parseNode(node) {
  if (!node) return { id: null, child: null };
  const parts = node.split("/");
  if (parts[0] === "results") return { id: parts.slice(0, 2).join("/"), child: parts[2] ?? null };
  // A run's node id is "runs/run/{id}", three parts, and the generic rule
  // below took only the second one. The child came out as the literal word
  // "run", no run matched it, and every run in the tree opened a panel saying
  // "That run is gone" while sitting in the tree next to it. Found 11 Sep 2026.
  if (parts[0] === "runs") return { id: "runs", child: parts.slice(1).join("/") || null };
  if (parts.length > 1) return { id: parts[0], child: parts[1] };
  return { id: parts[0], child: null };
}

const TITLES = {
  geometry: "Wind tunnel",
  model: "Model", materials: "Materials", initial: "Initial conditions",
  bc: "Boundary conditions", numerics: "Numerics",
  control: "Simulation control", mesh: "Mesh", runs: "Simulation runs",
  results: "Result control",
  "results/forces": "Forces and moments",
};

/**
 * Where a boundary condition's faces live inside the spec, and everything
 * else that needs one function rather than a branch in three places.
 */
function bcAt(spec, index) {
  return (spec.boundaryConditions ?? [])[index] ?? null;
}

export default function SetupPanel({
  simulation, node, spec, meshSpec, geometries, geometry, version, faces,
  selection, onSave, onClose, onAssignGeometry, savedSelections, leaveRef, onDirtyChange,
  runs = [], onQueue, onCancelRun, onPostProcess, onRebuildDomain,
}) {
  const { id, child } = parseNode(node);
  const [dialog, setDialog] = useState(null);

  const draft = useDraft(spec, onSave);
  const { set } = draft;
  const s = draft.draft ?? {};

  /**
   * Append a child and save in the same gesture.
   *
   * The tree draws the saved simulation, not this panel's draft, so appending
   * to the draft alone put the new boundary condition nowhere the user could
   * see: they clicked "Velocity inlet" and nothing on screen changed. Adding
   * is a structural act rather than an edit to a value, and SimScale creates
   * the node on the click as well, so this commits straight away.
   *
   * The next spec is computed here rather than read back from state, because
   * state updates on the next render and the save would send the old one.
   */
  const addChild = useCallback((path, item) => {
    const list = at(s, path) ?? [];
    const next = setAt(s, path, [...list, item]);
    draft.set(path, [...list, item]);
    return onSave(next);
  }, [s, draft, onSave]);

  // The mesh settings are a separate field on the document, so they get their
  // own draft. Same rules: typing changes the draft, the tick saves it.
  const saveMesh = useCallback((next) => onSave(undefined, next), [onSave]);
  const meshDraft = useDraft(meshSpec, saveMesh);

  // While a panel with an assignment box is open, clicks in the viewer go
  // into that box rather than changing the selection. Build spec 5.4.
  const [assigning, setAssigning] = useState(false);


  const faceInfo = useMemo(() => {
    const out = {};
    (faces ?? []).forEach((f, i) => { out[i] = f; });
    return out;
  }, [faces]);

  const bcIndex = id === "bc" && child != null
    ? (s.boundaryConditions ?? []).findIndex((b, i) => String(b.id ?? i) === String(child))
    : -1;
  const bc = bcIndex >= 0 ? bcAt(s, bcIndex) : null;
  /*
   * Reset it whenever the open node changes, and start on for a panel that
   * has a box.
   *
   * On, because that is what SimScale does and because a user who opens a
   * boundary condition is there to assign faces to it. Reset, because the
   * panel does not remount between nodes: leaving it alone meant the toggle
   * carried over, and the next panel's first click turned assignment off
   * instead of adding a face. Two of three boundary conditions came out
   * empty that way, with the box cheerfully reporting zero.
   */
  useEffect(() => { setAssigning(bcIndex >= 0); }, [bcIndex, node]);

  // Memoised: `?? []` makes a new array every render, and this feeds an
  // effect that writes state.
  const assignedFaces = useMemo(
    () => bc?.topologicalReference?.faces ?? [],
    [bc?.topologicalReference?.faces],
  );

  const setAssigned = useCallback((next) => {
    if (bcIndex < 0) return;
    set("boundaryConditions", (list = []) => {
      const copy = [...list];
      const current = copy[bcIndex];
      if (!current) return list;
      const faces = typeof next === "function"
        ? next(current.topologicalReference?.faces ?? [])
        : next;
      copy[bcIndex] = {
        ...current,
        topologicalReference: { ...current.topologicalReference, faces },
      };
      return copy;
    });
  }, [bcIndex, set]);

  // Hand the viewer a sink for its clicks while assignment mode is on, and
  // paint what is already assigned blue.
  const installSink = selection?.setAssigning;
  useEffect(() => {
    if (!installSink) return undefined;
    if (!assigning || bcIndex < 0) { installSink(null); return undefined; }
    // The sink adds to whatever is there at the moment of the click, so it
    // survives several clicks between renders and does not have to be
    // reinstalled every time the list changes.
    installSink((clicked) => {
      setAssigned((prev) => [...new Set([...prev, ...clicked])]);
    });
    return () => installSink(null);
  }, [assigning, bcIndex, installSink, setAssigned]);

  const setAssignedInViewer = selection?.setAssignedFaces;
  useEffect(() => {
    setAssignedInViewer?.(assignedFaces);
  }, [assignedFaces, setAssignedInViewer]);

  const assignmentBox = bcIndex >= 0 ? (
    <Assignment
      faces={assignedFaces} onChange={setAssigned} faceInfo={faceInfo}
      assigning={assigning} onAssigning={setAssigning}
      onHover={(f) => selection?.hoverFace(f)}
      viewerSelection={selection?.ids ?? []}
      savedSelections={savedSelections ?? []}
    />
  ) : null;

  /** The wheel button inside a rotating wall. Build spec 9.8. */
  const wheel = useMemo(() => {
    if (!bc || bc.velocity?.type !== "ROTATING_WALL_VELOCITY") return null;
    const cyl = assignedFaces.map((f) => faceInfo[f]).filter((f) => f?.type === "cylinder" && f.radius_m > 0);
    const inlet = (s.boundaryConditions ?? []).find((b) => b.type === "VELOCITY_INLET_V3");
    const v = inlet?.velocity?.value?.value;
    const speed = v ? Math.hypot(v.x?.value ?? 0, v.y?.value ?? 0, v.z?.value ?? 0) : 0;
    const radius = cyl.length ? cyl.reduce((a, f) => a + f.radius_m, 0) / cyl.length : 0;
    return {
      ready: radius > 0 && speed > 0,
      radius, speed,
      onFill: () => {
        const first = cyl[0];
        const list = [...(s.boundaryConditions ?? [])];
        list[bcIndex] = {
          ...bc,
          velocity: {
            ...bc.velocity,
            rotation: {
              rotationCenter: {
                value: { x: first.axis_x_m ?? 0, y: first.axis_y_m ?? 0, z: first.axis_z_m ?? 0 },
                unit: "m",
              },
              rotationAxis: {
                x: first.axis?.[0] ?? 0, y: first.axis?.[1] ?? 1, z: first.axis?.[2] ?? 0,
              },
              angularVelocity: {
                value: { type: "CONSTANT", value: speed / radius }, unit: "rad/s",
              },
            },
          },
        };
        set("boundaryConditions", list);
      },
    };
  }, [bc, bcIndex, assignedFaces, faceInfo, s.boundaryConditions, set]);

  /**
   * What this run will cost, live under the End time field. Build spec 9.11.
   *
   * Through the same clampRunParams and listPrice the server charges with,
   * not a second copy of the sum. A price on screen that the invoice then
   * disagrees with is worse than no price, and tests/test_pricing.mjs binds
   * this file to the server's copy for exactly that reason.
   */
  const estimate = useMemo(() => {
    const fineness = meshSpec?.sizing?.fineness ?? 5;
    // The panel speaks SimScale's 0 to 10 fineness; pricing speaks the 1 to 5
    // refine level the worker uses. This is the same table, read backwards.
    const level = Number(Object.keys(FINENESS).find((k) => FINENESS[k] >= fineness) ?? 5);
    try {
      return listPrice(clampRunParams({
        iteration_count: s.simulationControl?.endTime?.value ?? 1000,
        refine_level: level,
      }));
    } catch { return null; }
  }, [s.simulationControl?.endTime?.value, meshSpec?.sizing?.fineness]);

  /*
   * Leaving a node saves a valid draft and refuses to leave an invalid one.
   * Build spec 5.4.
   *
   * The tree cannot ask the panel this without a way in, so the panel puts
   * the answer in a ref the shell holds. Without it, clicking another node
   * throws away whatever was typed, silently, which is the behaviour people
   * report as "it did not save" and cannot reproduce.
   */
  useEffect(() => {
    if (!leaveRef) return undefined;
    // Whichever draft this node edits. On the Mesh node that is the mesh one,
    // and handing the tree the spec draft there would let unsaved mesh edits
    // be walked away from without the panel ever objecting.
    const leave = id === "mesh" ? meshDraft.leave : draft.leave;
    leaveRef.current = leave;
    return () => { if (leaveRef.current === leave) leaveRef.current = null; };
  }, [leaveRef, draft.leave, meshDraft.leave, id]);

  // The top bar cannot see a draft, so the panel tells it. Without this the
  // bar reads "All changes saved" over the top of edits nobody has committed.
  const dirtyNow = id === "mesh" ? meshDraft.dirty : draft.dirty;
  useEffect(() => {
    onDirtyChange?.(dirtyNow);
    return () => onDirtyChange?.(false);
  }, [dirtyNow, onDirtyChange]);

  const title = child != null && bc ? bc.name : (TITLES[id] ?? simulation?.name ?? "Settings");

  /**
   * Delete and rename for the child a panel is showing. Build spec 5.3.
   *
   * Both work on the list the child came from, so one pair of functions
   * covers boundary conditions, materials and result controls rather than
   * three copies that drift.
   */
  const childList = child != null ? {
    bc: ["boundaryConditions", s.boundaryConditions ?? []],
    materials: ["materials.fluids", s.materials?.fluids ?? []],
    "results/forces": ["resultControl.forcesMoments", s.resultControl?.forcesMoments ?? []],
  }[id] : null;

  const childIndex = childList
    ? childList[1].findIndex((x, i) => String(x.id ?? i) === String(child))
    : -1;

  const onDeleteChild = childIndex >= 0 ? () => {
    const next = childList[1].filter((_, i) => i !== childIndex);
    set(childList[0], next);
    onClose();
  } : undefined;

  const onRenameChild = childIndex >= 0 ? (name) => {
    const next = [...childList[1]];
    next[childIndex] = { ...next[childIndex], name };
    set(childList[0], next);
  } : undefined;

  // A run is not a draft. It is a record of something that already
  // happened, so it gets the panel frame without the tick.
  if (id === "runs" && child != null) {
    const run = runs.find((r) => r.id === String(child).replace(/^run\//, ""));
    return (
      <SettingsPanel
        title={run?.name || "Run"} value={null} onCommit={() => {}}
        onClose={onClose}
      >
        {run ? (
          <RunPanel
            run={run}
            previous={previousRun(runs, run)}
            onCancel={() => onCancelRun?.(run)}
            onPostProcess={() => onPostProcess?.(run)}
            onLog={() => onPostProcess?.(run, "log")}
          />
        ) : <Note>That run is gone.</Note>}
      </SettingsPanel>
    );
  }

  let body = null;
  if (!id) {
    body = <GlobalPanel draft={s} set={set} />;
  } else if (id === "geometry") {
    body = (
      <GeometryPanel simulation={simulation} geometries={geometries}
        geometry={geometry} version={version} onAssign={onAssignGeometry}
        onRebuild={onRebuildDomain} />
    );
  } else if (id === "model") {
    body = <ModelPanel draft={s} set={set} />;
  } else if (id === "initial") {
    body = <InitialConditionsPanel draft={s} set={set} />;
  } else if (id === "numerics") {
    body = <NumericsPanel draft={s} set={set} onReset={() => set("numerics", spec.numerics)} />;
  } else if (id === "control") {
    body = <SimulationControlPanel draft={s} set={set} estimate={estimate} />;
  } else if (id === "materials" && child == null) {
    body = (
      <>
        <Note>Add the fluid the car runs in. For a wind tunnel that is Air.</Note>
        <button type="button" className="wb-btn wb-btn-primary"
          onClick={() => setDialog("material")}>
          Add a material
        </button>
        {(s.materials?.fluids ?? []).map((f, i) => (
          <Row key={i} label={f.name}>
            <span className="wb-dim">{f.density?.value} kg/m³</span>
          </Row>
        ))}
      </>
    );
  } else if (id === "materials") {
    const i = Number(child);
    const m = (s.materials?.fluids ?? [])[i];
    body = m ? (
      <MaterialPanel material={m}
        onChange={(next) => {
          const list = [...(s.materials?.fluids ?? [])];
          list[i] = next;
          set("materials.fluids", list);
        }} />
    ) : <Note>That material is gone.</Note>;
  } else if (id === "bc" && bc) {
    body = (
      <BoundaryConditionPanel
        bc={bc} wheel={wheel} assignment={assignmentBox}
        onChange={(next) => {
          const list = [...(s.boundaryConditions ?? [])];
          list[bcIndex] = next;
          set("boundaryConditions", list);
        }}
      />
    );
  } else if (id === "runs") {
    body = (
      <>
        <Note>
          Queueing a run spends credits. The dialog says how many before
          anything is charged.
        </Note>
        <button type="button" className="wb-btn wb-btn-primary" onClick={onQueue}>
          Queue a run
        </button>
      </>
    );
  } else if (id === "bc") {
    body = (
      <>
        <Note>
          Air has to come in somewhere and leave somewhere. A car in a tunnel
          needs at least a velocity inlet, a pressure outlet, and a wall for
          the car itself.
        </Note>
        <div className="wb-bclist">
          {BC_TYPES.map(([type, label]) => (
            <button key={type} type="button" className="wb-btn"
              onClick={() => {
                const list = s.boundaryConditions ?? [];
                const n = list.filter((b) => b.type === type).length + 1;
                addChild("boundaryConditions", {
                  ...newBoundaryCondition(type, `${label} ${n}`), id: `bc${Date.now()}`,
                });
              }}>
              {label}
            </button>
          ))}
        </div>
      </>
    );
  } else if (id === "results/forces" && child == null) {
    body = (
      <>
        <Note>
          Without one of these a run finishes with no drag and no lift, which
          is the whole reason for running it.
        </Note>
        <div className="wb-bclist">
          <button type="button" className="wb-btn wb-btn-primary"
            onClick={() => addChild("resultControl.forcesMoments", {
              type: "FORCE_AND_MOMENT_COEFFICIENTS", id: `f${Date.now()}`,
              name: "Drag and lift", topologicalReference: { faces: [] },
            })}>
            Force and moment coefficients
          </button>
          <button type="button" className="wb-btn"
            onClick={() => addChild("resultControl.forcesMoments", {
              type: "FORCES_AND_MOMENTS", id: `f${Date.now()}`,
              name: "Forces and moments", topologicalReference: { faces: [] },
            })}>
            Forces and moments
          </button>
        </div>
      </>
    );
  } else if (id === "results/forces") {
    const list = s.resultControl?.forcesMoments ?? [];
    const i = list.findIndex((f, k) => String(f.id ?? k) === String(child));
    const item = list[i];
    const inlet = (s.boundaryConditions ?? []).find((b) => b.type === "VELOCITY_INLET_V3");
    const v = inlet?.velocity?.value?.value;
    const speed = v ? Math.hypot(v.x?.value ?? 0, v.y?.value ?? 0, v.z?.value ?? 0) : 0;
    const prefill = {
      speed,
      // Not prefilled when the model is a closed flow domain: "frontal area"
      // is the shadow of the whole model, and a tunnel's shadow is the
      // tunnel's cross-section. Handing that over as a reference area gives a
      // Cd wrong by the ratio of tunnel to car, which is the single number a
      // STEM Racing team is judged on. Better an empty box they have to fill.
      area: isFlowDomain(version) ? 0 : (version?.frontal_area_m2 ?? 0),
      areaIsDomain: isFlowDomain(version),
      length: version?.reference_length_m ?? 0,
      // The worker drives the flow in -x, so a car facing the wind has its
      // drag direction pointing that way too. Getting this backwards gives a
      // negative drag coefficient, which reads as a mistake in the car.
      dragDirection: (v?.x?.value ?? 0) < 0 ? { x: -1, y: 0, z: 0 } : { x: 1, y: 0, z: 0 },
    };
    const onChange = (next) => {
      const copy = [...list];
      copy[i] = next;
      set("resultControl.forcesMoments", copy);
    };
    body = item
      ? (item.type === "FORCES_AND_MOMENTS"
        ? <ForcesMomentsPanel item={item} onChange={onChange} />
        : <ForceCoefficientsPanel item={item} onChange={onChange} prefill={prefill} />)
      : <Note>That result control is gone.</Note>;
  } else if (id === "mesh") {
    body = (
      <MeshPanel mesh={meshDraft.draft ?? {}} onChange={(m) => meshDraft.set(() => m)}
        lastRun={runs.find((r) => r.mesh?.cell_count) ?? null} />
    );
  } else if (id === "results") {
    /*
     * A parent node, not an empty one.
     *
     * This fell through to the catch-all below and announced that "Result
     * control has nothing to set", which is the opposite of true: everything
     * a run records is configured under it, and without a forces result
     * control a run finishes with no drag and no lift at all.
     */
    body = (
      <Note>
        What the solver records while it runs. Open <b>Forces and moments</b>
        {" "}for drag and lift. Pressure and air speed on the car are recorded
        on every run and appear under the run when it finishes.
      </Note>
    );
  } else {
    const label = TITLES[id] ?? id;
    body = (
      <Note>{`${label} has nothing to set for an Incompressible run on a car.`}</Note>
    );
  }

  return (
    <>
      <SettingsPanel
        title={title}
        value={draft.draft}
        renamable={childIndex >= 0}
        onRename={onRenameChild}
        onDelete={onDeleteChild}
        onCommit={() => (id === "mesh" ? meshDraft.commit() : draft.commit())}
        onClose={() => { (id === "mesh" ? meshDraft : draft).discard(); onClose(); }}
        footer={(id === "mesh" ? meshDraft.error : draft.error)
          ? <span className="wb-perror">{id === "mesh" ? meshDraft.error : draft.error}</span>
          : null}
      >
        {body}
      </SettingsPanel>

      {dialog === "material" ? (
        <MaterialDialog onClose={() => setDialog(null)}
          onApply={(fluid) => {
            set("materials.fluids", [...(s.materials?.fluids ?? []), fluid]);
            setDialog(null);
          }} />
      ) : null}
    </>
  );
}

export { NODE_BY_ID };
