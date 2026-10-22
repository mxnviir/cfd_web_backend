// What is still wrong with a setup. Build spec 14.5.
//
// This runs on every write, costs nothing, and is the difference between a
// team finding out now and finding out after they have paid for a run. A CFD
// job with no inlet does not fail: it converges to still air in a box and
// reports a drag of zero, which looks like an answer.
//
// Errors block a run. Warnings do not, because a warning is about judgement
// and the team may be right.
import { INLET_TYPES, OUTLET_TYPES } from "./spec";

export interface Validation {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

interface Context {
  geometryId?: string | null;
  /** Every face id the pinned geometry version actually has. */
  faceIds?: Set<number> | null;
  faceCount?: number | null;
  /**
   * Faces under a square micrometre.
   *
   * A CAD export carries slivers this small, and SimScale's mesher does not
   * skip them: it fails, naming an entity id the user has no way to look up
   * ("MSG_MESH_TOO_COARSE ... entities B1_TE495"). Two real runs died that
   * way. Saying it here, while they are still assigning faces, costs nothing.
   */
  sliverFaces?: Set<number> | null;
  /** metres, from advancedSimmetrixSettings. Null means the default is unset. */
  smallFeatureTolerance?: number | null;
  meshFineness?: number | null;
}

export function validateSetup(spec: any, ctx: Context = {}): Validation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!spec || typeof spec !== "object") {
    return { ok: false, errors: ["This simulation has no setup yet."], warnings: [] };
  }

  if (!ctx.geometryId) {
    errors.push("No geometry is assigned. Pick one in the Geometry panel.");
  }

  const fluids = spec.materials?.fluids ?? [];
  if (!fluids.length) {
    errors.push("No material. Add one in the Materials panel; Air is the usual choice.");
  }

  // Fields that belong to a solver we do not run.
  //
  // SimScale shares one schema across its solvers and rejects, at spec
  // validation, any field that is conditional on an analysis type other than
  // the one being run. Two of ours were: orientationReference on a moving wall
  // and fractionFromEnd on a forces-and-moments control, both Pacefish only.
  // The run was accepted, queued, and failed three minutes later having taken
  // 30 credits, saying only "Unprocessable entity (spec-validation-error)".
  // The schemas here use passthrough, so nothing else would stop an old saved
  // setup carrying them straight back to the same failure.
  for (const [i, b] of (Array.isArray(spec.boundaryConditions)
    ? spec.boundaryConditions : []).entries()) {
    if (b?.velocity && "orientationReference" in b.velocity) {
      errors.push(`"${b?.name || `Boundary condition ${i + 1}`}" carries an `
        + "orientation reference, which only exists on SimScale's Pacefish "
        + "solver. Remove it, or rebuild the setup.");
    }
  }
  for (const c of (spec.resultControl?.forcesMoments ?? [])) {
    for (const key of ["fractionFromEnd", "exportStatistics"]) {
      if (c && key in c) {
        errors.push(`"${c?.name || "A forces and moments control"}" carries `
          + `${key === "exportStatistics" ? "export statistics" : "a fraction from end"}, `
          + "which only exists on SimScale's Pacefish and Wind Comfort "
          + "solvers. Remove it, or rebuild the setup.");
      }
    }
  }

  const bcs: any[] = Array.isArray(spec.boundaryConditions) ? spec.boundaryConditions : [];
  const named = (b: any, i: number) => b?.name || `Boundary condition ${i + 1}`;

  if (!bcs.some((b) => INLET_TYPES.includes(b?.type))) {
    errors.push("No inlet. Air has to come in somewhere: add a velocity inlet or a pressure inlet.");
  }
  if (!bcs.some((b) => OUTLET_TYPES.includes(b?.type))) {
    errors.push("No outlet. Air has to leave somewhere: add a pressure outlet or a velocity outlet.");
  }

  // A face in two boundary conditions is the mistake that produces a result
  // rather than an error: the solver takes one of them and the other silently
  // does nothing.
  const owner = new Map<number, string>();
  bcs.forEach((b, i) => {
    const faces: number[] = b?.topologicalReference?.faces ?? [];
    if (!faces.length) {
      errors.push(`"${named(b, i)}" has no faces assigned to it.`);
    }
    for (const f of faces) {
      const already = owner.get(f);
      if (already) {
        errors.push(
          `Face ${f} is assigned to both "${already}" and "${named(b, i)}". A face can belong to one boundary condition.`,
        );
      } else {
        owner.set(f, named(b, i));
      }
      if (ctx.faceIds && !ctx.faceIds.has(f)) {
        errors.push(
          `"${named(b, i)}" uses face ${f}, which this version of the geometry does not have. Reassign it.`,
        );
      }
    }
  });

  // Fineness is a slider on SimScale's side and only lands on tenths. A value
  // between two steps is accepted by the API and then rounded, so the mesh
  // the team gets is not the one the panel showed them.
  const fineness = ctx.meshFineness;
  if (fineness != null) {
    const tenths = Math.round(fineness * 10);
    if (Math.abs(tenths / 10 - fineness) > 1e-9) {
      errors.push(`Mesh fineness ${fineness} is not a multiple of 0.1.`);
    }
  }

  const endTime = spec.simulationControl?.endTime?.value;
  if (!(endTime > 0)) {
    errors.push("End time must be greater than zero.");
  }

  // ── warnings ─────────────────────────────────────────────────────────────
  const forces = spec.resultControl?.forcesMoments ?? [];
  if (!forces.length) {
    warnings.push(
      "No forces and moments result control. Without one the run finishes with no drag or lift numbers.",
    );
  }

  const maxRunTime = spec.simulationControl?.maxRunTime?.value;
  if (endTime > 0 && maxRunTime > 0 && maxRunTime < endTime * 2) {
    warnings.push(
      `Maximum run time is ${maxRunTime} s for ${endTime} iterations. That often stops a run before it converges; twice the end time is the usual floor.`,
    );
  }

  for (const b of bcs) {
    if (!INLET_TYPES.includes(b?.type)) continue;
    const v = b?.velocity?.value?.value;
    if (!v) continue;
    const speed = Math.hypot(v.x?.value ?? 0, v.y?.value ?? 0, v.z?.value ?? 0);
    if (speed > 100) {
      warnings.push(
        `Inlet speed is ${speed.toFixed(1)} m/s on "${b.name}". A STEM Racing car is tested near 20 m/s, so check the units.`,
      );
    }
  }

  // ── slivers the mesher will refuse ──────────────────────────────────────
  if (ctx.sliverFaces?.size) {
    const used = new Set<number>();
    for (const b of bcs) {
      for (const f of b?.topologicalReference?.faces ?? []) {
        if (ctx.sliverFaces.has(f)) used.add(f);
      }
    }
    if (used.size && !ctx.smallFeatureTolerance) {
      warnings.push(
        `${used.size} assigned face${used.size === 1 ? " is" : "s are"} smaller than a square ` +
        "millimetre. The mesher fails on features that small rather than ignoring them. " +
        "Set Small feature suppression under Mesh > Advanced, 0.5 mm is a safe start.",
      );
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}
