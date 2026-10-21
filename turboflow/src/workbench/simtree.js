// The Incompressible simulation tree: what the nodes are and when each is
// complete. Build spec 9.2.
//
// One list, in the spec's order, rather than the shape being implied by
// whichever components happen to render. The tree, the settings panel, the
// URL and the validation all read this, so a node cannot exist in one of
// them and not the others.
//
// Everything here reads the real `spec` document, the one that goes to
// SimScale. An earlier version of this file invented its own shape
// (setup.bcs, setup.materials) and the result was a tree that showed no
// children for a simulation that had five boundary conditions, with nothing
// anywhere to say why.
/** Node ids double as URL path segments; see route.js. */
export const NODES = [
  // "Wind tunnel", not "Model": there is already a node called Model below,
  // which is the physics one - turbulence and gravity - and two rows with the
  // same name three apart is worse than the "Geometry" this replaced. Its
  // panel is the tunnel that was built, the walls it found and the statistics
  // of the car, so the tunnel is what it is named after.
  // Geometry primitives, local coordinate systems, advanced concepts and
  // three result controls (surface data, probe points, field calculations)
  // were rows here that opened "Not available in TurboFlow yet". Removed on
  // 24 Sep 2026: the tree lists what TurboFlow does, and each comes back when
  // it is built.
  { id: "geometry", label: "Wind tunnel", kind: "geometry" },
  { id: "model", label: "Model", status: "auto" },
  { id: "materials", label: "Materials", adds: "material", status: "materials" },
  { id: "initial", label: "Initial conditions", status: "auto" },
  { id: "bc", label: "Boundary conditions", adds: "bc", status: "bcs" },
  { id: "numerics", label: "Numerics", status: "auto" },
  { id: "control", label: "Simulation control", status: "auto" },
  {
    id: "results", label: "Result control", expandable: true, status: "none",
    children: [
      { id: "results/forces", label: "Forces and moments", adds: "force" },
    ],
  },
  { id: "mesh", label: "Mesh", expandable: true, status: "mesh" },
  // SimScale labels the plus "New simulation run". TurboFlow charges credits
  // for one, so the button says Queue and the dialog says what it costs.
  { id: "runs", label: "Simulation runs", adds: "run", addLabel: "Queue", status: "runs" },
];

/** Flattened, so a node path from the URL can be looked up directly. */
export const NODE_BY_ID = (() => {
  const out = {};
  for (const n of NODES) {
    out[n.id] = n;
    for (const c of n.children || []) out[c.id] = { ...c, parent: n.id };
  }
  return out;
})();

const INLETS = ["VELOCITY_INLET_V3", "PRESSURE_INLET_V31"];
const OUTLETS = ["VELOCITY_OUTLET_V7", "PRESSURE_OUTLET_V30"];

/** Where each node's children live inside the spec. */
export function listFor(nodeId, spec = {}) {
  switch (nodeId) {
    case "materials": return spec.materials?.fluids ?? [];
    case "bc": return spec.boundaryConditions ?? [];
    case "results/forces": return spec.resultControl?.forcesMoments ?? [];
    default: return [];
  }
}

/**
 * The status icon for one node.
 *
 * "auto" nodes ship with a working default and are therefore complete the
 * moment the simulation exists. That is not laziness: k-omega SST with the
 * SIMPLE algorithm and SimScale's own relaxation factors is a valid setup,
 * and marking Numerics incomplete would tell a school team to change
 * something they have no reason to change.
 *
 * The rules here mirror the server's validateSetup. Where the server says a
 * setup cannot run, the tree must show a red ring on the node responsible,
 * or a user is left hunting for what the queue dialog is complaining about.
 */
export function nodeStatus(node, ctx) {
  const { spec = {}, geometry, runs = [], mesh, validation } = ctx;

  // A server error naming this node wins over anything worked out here.
  const owns = errorsFor(node.id, validation);
  if (owns.length) return "error";

  switch (node.status) {
    case "none":
      return null;
    case "optional":
      return "optional";
    case "auto":
      return "complete";
    case "materials":
      return (spec.materials?.fluids ?? []).length ? "complete" : "incomplete";
    case "bcs": {
      // Stricter than SimScale's, on purpose: a run with no inlet finishes
      // cleanly and reports a drag of zero, and the team has paid by then.
      const bcs = spec.boundaryConditions ?? [];
      const hasIn = bcs.some((b) => INLETS.includes(b?.type));
      const hasOut = bcs.some((b) => OUTLETS.includes(b?.type));
      const allAssigned = bcs.every((b) => (b?.topologicalReference?.faces ?? []).length);
      return hasIn && hasOut && allAssigned ? "complete" : "incomplete";
    }
    case "mesh":
      return mesh?.status === "finished" ? "complete"
        : mesh?.status === "failed" ? "error" : "optional";
    case "runs": {
      if (runs.some((r) => r.status === "failed")) return "error";
      if (runs.length) return "complete";
      return "incomplete";
    }
    default:
      if (node.kind === "geometry") return geometry ? "complete" : "incomplete";
      return null;
  }
}

/** Which of the server's errors belong to which node, for the red ring. */
function errorsFor(nodeId, validation) {
  const errors = validation?.errors ?? [];
  if (!errors.length) return [];
  const mine = {
    geometry: (e) => e.includes("No geometry"),
    materials: (e) => e.includes("No material"),
    bc: (e) => e.includes("inlet") || e.includes("outlet") || e.includes("Face ")
      || e.includes("no faces assigned"),
    mesh: (e) => e.includes("fineness"),
    control: (e) => e.includes("End time"),
  }[nodeId];
  return mine ? errors.filter(mine) : [];
}

/** How many children a node currently has, for the "Contacts (6)" style count. */
export function nodeCount(node, ctx) {
  if (node.id === "runs") return (ctx.runs ?? []).length;
  const list = listFor(node.id, ctx.spec ?? {});
  return list.length || null;
}

/** The rows a node expands into: its own children plus anything the user added. */
export function nodeChildren(node, ctx) {
  const { spec = {}, runs = [] } = ctx;
  if (node.children) return node.children.map((c) => ({ ...c, static: true }));
  if (node.id === "runs") {
    return runs.map((r, i) => ({
      id: `runs/run/${r.id}`,
      label: r.name || `Run ${i + 1}`,
      item: r,
      // A run is not "optional"; it is finished, failed, stopped, or still
      // going. Using the optional dot for all three of the last ones made a
      // cancelled run read as "Optional" to a screen reader.
      status: r.status === "finished" ? "complete"
        : r.status === "failed" ? "error"
        : r.status === "cancelled" ? "cancelled" : "running",
    }));
  }
  return listFor(node.id, spec).map((x, i) => ({
    id: `${node.id}/${x.id ?? i}`,
    label: x.name || `${node.label} ${i + 1}`,
    item: x,
    // A boundary condition with nothing assigned is the one the user forgot,
    // so the ring says so on the child rather than only on the parent.
    status: node.id === "bc" && !(x.topologicalReference?.faces ?? []).length
      ? "incomplete" : "complete",
  }));
}
