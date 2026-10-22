// The workbench's simulation tree and the panel behind each node.
//
// The tree is shaped like SimScale's own tree for an incompressible external
// aero case, because that is the tree a team will see if they ever open the
// project on simscale.com — a different shape here would teach them the wrong
// map. Every number shown comes from cfd-setup.js (defaults mirrored from
// docker jobs/simscale_job.py, quantities derived from the same inputs the
// solver gets), so a panel cannot drift from the run.
(function (win) {
  "use strict";

  // cfd-setup.js exports onto globalThis. Read it from there rather than off
  // the export target, so the two agree even when this file is loaded under a
  // shim that hands us something other than the real window.
  const cfd = () => (typeof globalThis !== "undefined" && globalThis.CFD) || win.CFD || {};

  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // Fixed notation is easier to compare down a column, but 1.5e-5 written fixed
  // is 0.000 — a lie — and 36000 fixed is noise. So: exponential outside
  // [0.01, 1e4), fixed inside it, and an em dash for anything absent. Nothing
  // in a panel is allowed to read "undefined".
  function n(v, unit, dp) {
    if (v == null || typeof v === "object" || v === "" || !isFinite(+v)) return "n/a";
    const x = +v, a = Math.abs(x);
    const s = a !== 0 && (a < 0.01 || a >= 1e4)
      ? x.toExponential(2)
      : x.toFixed(dp == null ? 3 : dp);
    return unit ? s + " " + unit : s;
  }

  function int(v, unit) {
    if (v == null || typeof v === "object" || v === "" || !isFinite(+v)) return "n/a";
    const s = Math.round(+v).toLocaleString("en-US");
    return unit ? s + " " + unit : s;
  }

  const pct = (v, dp) => (v == null || !isFinite(+v)) ? "n/a" : n(+v * 100, "%", dp == null ? 2 : dp);

  // Raw value for an input's value attribute: never a formatted string, because
  // the user edits this and a rounded value would be saved back as the truth.
  const val = (v) => (v == null || (typeof v === "number" && !isFinite(v))) ? "" : esc(v);

  const verdict = (ok, yes, no) =>
    ok == null ? "n/a" : `<span class="${ok ? "good" : "bad"}">${esc(ok ? yes : no)}</span>`;

  // ── markup helpers, using only the classes workbench.html already defines ──
  function dl(pairs) {
    const body = pairs.filter(Boolean)
      .map(([k, v]) => `<dt>${esc(k)}</dt><dd class="num">${(v == null || v === "") ? "n/a" : v}</dd>`)
      .join("");
    return `<dl class="metrics">${body}</dl>`;
  }

  const head = (t) =>
    `<div class="pane-head" style="padding-left:0;padding-right:0"><span class="eyebrow">${esc(t)}</span></div>`;

  const note = (html) =>
    `<p class="muted" style="margin:var(--s2) 0 var(--s4);font-size:11px">${html}</p>`;

  // cast is 'number' | 'text' | 'bool' — the host's wbSet does the coercion and
  // the clamping, so nothing here has to guess what a valid value is.
  function field(label, path, value, attrs, cast) {
    return `<label class="field"><span class="eyebrow">${esc(label)}</span>` +
      `<input type="number" ${attrs || ""} value="${val(value)}"` +
      ` oninput="wbSet('${path}', this.value, '${cast || "number"}')"></label>`;
  }

  function textField(label, path, value) {
    return `<label class="field"><span class="eyebrow">${esc(label)}</span>` +
      `<input value="${val(value)}" oninput="wbSet('${path}', this.value, 'text')"></label>`;
  }

  function check(label, path, on) {
    return `<label class="check"><input type="checkbox" ${on ? "checked" : ""}` +
      ` oninput="wbSet('${path}', this.checked, 'bool')"><span class="muted">${esc(label)}</span></label>`;
  }

  const grid = (fields) => `<div class="edit-grid">${fields.join("")}</div>`;

  const setupOf = (ctx) => {
    const f = cfd().withDefaults;
    return (f ? f(ctx.setup) : ctx.setup) || {};
  };

  // ── tree ───────────────────────────────────────────────────────────────────
  function tree(ctx) {
    ctx = ctx || {};
    const s = setupOf(ctx);
    const d = ctx.derived || {};
    const sim = ctx.sim || null;
    const geom = ctx.geometry || null;
    const runs = ctx.runs || [];
    const out = [];
    const push = (id, label, depth, kind, badge, state) => {
      const node = { id, label, depth, kind };
      if (badge != null && badge !== "") node.badge = badge;
      if (state) node.state = state;
      out.push(node);
    };

    // No geometry is not a warning, it is a case that cannot run at all.
    push("geometry", "Geometry", 0, "node",
      "v" + (ctx.version == null ? "n/a" : int(ctx.version)),
      !geom ? "bad" : (d.blockageOk === false ? "warn" : "ok"));

    push("setup", "Simulation setup", 0, "header");
    push("analysis", "Analysis type", 1, "node",
      d.mach == null ? null : "M " + n(d.mach, "", 2),
      d.mach == null ? null : (d.incompressibleValid ? "ok" : "bad"));
    push("material", "Materials", 1, "node", s.material?.name || null);

    push("bcs", "Boundary conditions", 1, "header");
    // A healthy inlet turbulent viscosity ratio is order 1–100; outside that the
    // inlet is either laminar to the point of being unphysical or is seeding the
    // domain with turbulence the car did not make.
    const vr = d.viscosityRatio;
    push("bc:inlet", "Inlet", 2, "node",
      d.U == null ? null : n(d.U, "m/s", 1),
      vr == null ? null : (vr >= 1 && vr <= 100 ? "ok" : "warn"));
    push("bc:outlet", "Outlet", 2, "node", "0 Pa");
    push("bc:ground", "Ground", 2, "node", "moving");
    push("bc:top", "Top", 2, "node", "slip");
    push("bc:sides", "Sides", 2, "node", "slip");
    if (s.domain?.symmetry) push("bc:symmetry", "Symmetry", 2, "node", "plane");
    push("bc:car", "Car", 2, "node", "no-slip");
    // Wheel faces only exist if entity_labels.csv carried a radius for them.
    push("bc:wheels", "Wheels", 2, "node",
      geom?.label_path ? "U / r" : "no labels",
      geom && !geom.label_path ? "warn" : null);

    push("numerics", "Numerics", 1, "node", "SIMPLE");
    push("control", "Simulation control", 1, "node",
      sim?.iteration_count == null ? null : int(sim.iteration_count) + " it");
    push("results", "Result control", 1, "node", s.results?.forcesMoments ? "forces" : "off");

    push("mesh", "Mesh", 0, "node",
      d.fineness == null ? null : n(d.fineness, "", 1),
      sim?.debug_mesh ? "warn" : null);

    const done = runs.filter((j) => j.status === "complete" || j.status === "completed").length;
    const failed = runs.filter((j) => j.status === "failed").length;
    push("runs", "Simulation runs", 0, "node", String(runs.length),
      done ? "ok" : (failed ? "bad" : null));

    return out;
  }

  // ── panels ─────────────────────────────────────────────────────────────────
  const PANELS = {};

  PANELS.geometry = function (ctx, s, d) {
    const g = ctx.geometry;
    const dom = d.domain || {};
    const blockage = d.blockage == null ? "n/a"
      : `${pct(d.blockage, 2)} ${verdict(d.blockageOk, "under 5%", "over 5%")}`;

    return {
      title: g?.name ? String(g.name) : "Geometry",
      subtitle: g ? `Version ${ctx.version == null ? "?" : ctx.version}` : "No geometry on this simulation",
      html: (!g ? note("This simulation has no geometry, so there is nothing to mesh and nothing to run. Upload a STEP file first.") : "") +
        dl([
          ["Name", esc(g?.name) || "n/a"],
          ["Version", g ? "v" + int(ctx.version) : "n/a"],
          ["Lineage", g ? (g.derived_from ? "edited from an earlier version" : "original upload") : "n/a"],
          ["Versions stored", int((ctx.geometries || []).length)],
          ["Solids", int(g?.solid_count)],
          ["Faces", int(g?.face_count)],
          ["Triangles", int(g?.triangle_count)],
          ["STEP size", g?.size_bytes == null ? "n/a" : n(g.size_bytes / 1e6, "MB", 2)],
          ["Face labels", g?.label_path ? "entity_labels.csv" : "none"],
        ]) +
        head("Bounding box") +
        dl([
          ["Length X", n(d.L, "m", 4)],
          ["Width Y", n(d.W, "m", 4)],
          ["Height Z", n(d.H, "m", 4)],
          ["Box W × H", n(d.bboxFrontalArea, "m²", 5)],
          ["Reference area", n(d.frontalArea, "m²", 5)],
        ]) +
        field("Frontal area factor", "reference.frontalAreaFactor", s.reference?.frontalAreaFactor,
          'step="0.01" min="0.05" max="1"') +
        note("The bounding box is an upper bound on frontal area, never the projected area. " +
          "The factor scales it; measure it in CAD if the coefficients need to be defensible.") +
        head("Wind tunnel domain") +
        grid([
          field("Upstream, car lengths", "domain.upstream", s.domain?.upstream, 'step="0.5" min="0.5"'),
          field("Downstream", "domain.downstream", s.domain?.downstream, 'step="0.5" min="1"'),
          field("Side", "domain.side", s.domain?.side, 'step="0.5" min="0.5"'),
          field("Top", "domain.top", s.domain?.top, 'step="0.5" min="0.5"'),
        ]) +
        check("Half model on the centre plane", "domain.symmetry", !!s.domain?.symmetry) +
        dl([
          ["Domain length", n(dom.length, "m", 3)],
          ["Domain width", n(dom.width, "m", 3)],
          ["Domain height", n(dom.height, "m", 3)],
          ["Cross-section", n(dom.crossSection, "m²", 4)],
          ["Inlet distance", n(dom.upstream, "m", 3)],
          ["Outlet distance", n(dom.downstream, "m", 3)],
          ["Blockage ratio", blockage],
        ]) +
        note("Blockage is reference area over tunnel cross-section. Above about 5% the tunnel " +
          "walls accelerate the flow past the car and the drag comes back high, that is the " +
          "domain being too small, not the car being worse."),
    };
  };

  PANELS.setup = function (ctx, s, d) {
    const sim = ctx.sim;
    return {
      title: "Simulation setup",
      subtitle: sim?.name ? String(sim.name) : "No simulation selected",
      html: dl([
        ["Analysis", "Incompressible, steady"],
        ["Turbulence", "k-ω SST"],
        ["Inlet velocity", n(d.U, "m/s", 1)],
        ["Reynolds (length)", n(d.reynolds, "", 0)],
        ["Mach", n(d.mach, "", 3)],
        ["Cell budget", d.meshCellsM == null ? "n/a" : n(d.meshCellsM, "M cells", 1)],
        ["Iterations", int(sim?.iteration_count)],
        ["Cost", d.cost == null ? "n/a" : int(d.cost, "credits")],
      ]) +
        note("Every value below is what docker jobs/simscale_job.py sends to SimScale. " +
          "Saving rewrites the simulation; it does not touch a run that has already started.") +
        `<button class="btn btn-block" style="margin-bottom:var(--s2)" onclick="wbAction('save')">Save setup</button>` +
        `<button class="btn btn-primary btn-block" onclick="wbAction('run')">Run simulation</button>`,
    };
  };

  PANELS.analysis = function (ctx, s, d) {
    return {
      title: "Analysis type",
      subtitle: "Incompressible · steady-state · k-ω SST",
      html: dl([
        ["Analysis", "INCOMPRESSIBLE"],
        ["Time dependency", "Steady-state (SIMPLE)"],
        ["Turbulence model", "k-ω SST"],
        ["Wall treatment", "Wall functions"],
        ["Fluid", esc(s.material?.name) || "Air"],
      ]) +
        field("Inlet velocity, m/s", "sim.inlet_velocity", ctx.sim?.inlet_velocity,
          'step="0.5" min="1" max="100"') +
        dl([
          ["Speed of sound", n(343, "m/s", 0)],
          ["Mach number", n(d.mach, "", 4)],
          ["Incompressible assumption",
            d.mach == null ? "n/a" : verdict(d.incompressibleValid, "holds, M < 0.3", "broken, M ≥ 0.3")],
        ]) +
        note("Below M ≈ 0.3 density changes are under about 5% and solving the incompressible " +
          "equations costs nothing in accuracy. Above it this solver is the wrong solver, the " +
          "answer will still be a number, it just will not be the drag.") +
        note("Analysis type and turbulence model are fixed by the worker's build_model() and are " +
          "shown here rather than edited. k-ω SST is the usual external-aero choice: k-ω near the " +
          "wall where separation is decided, k-ε in the freestream where k-ω is sensitive to the " +
          "inlet values."),
    };
  };

  PANELS.material = function (ctx, s, d) {
    const rho = d.rho ?? s.material?.density ?? null;
    const nu = d.nu ?? s.material?.kinematicViscosity ?? null;
    const mu = (rho != null && nu != null) ? rho * nu : null;
    return {
      title: "Materials",
      subtitle: (s.material?.name ? String(s.material.name) : "Air") + ", Newtonian",
      html: textField("Name", "material.name", s.material?.name) +
        field("Density ρ, kg/m³", "material.density", s.material?.density, 'step="0.0001" min="0.0001"') +
        field("Kinematic viscosity ν, m²/s", "material.kinematicViscosity",
          s.material?.kinematicViscosity, 'step="any" min="0"') +
        dl([
          ["Dynamic viscosity μ", n(mu, "Pa·s", 3)],
          ["Reynolds (car length)", n(d.reynolds, "", 0)],
          ["Regime", esc(d.regime) || "n/a"],
          ["Dynamic pressure q", n(d.dynamicPressure, "Pa", 2)],
        ]) +
        note("μ = ρν, and Re = UL/ν on the bounding-box length in the flow direction. " +
          "The defaults are air at 20 °C, the same constants the worker uses " +
          "(AIR_DENSITY 1.2041, AIR_KIN_VISC 1.516e-5)."),
    };
  };

  PANELS.bcs = function (ctx, s, d) {
    const g = ctx.geometry;
    const list = [
      ["Inlet", "fixed velocity (−U, 0, 0)"],
      ["Outlet", "fixed 0 Pa gauge"],
      ["Ground", "moving wall at −U"],
      ["Top", "slip"],
      ["Sides", "slip"],
      s.domain?.symmetry ? ["Symmetry", "symmetry plane"] : null,
      ["Car", "no-slip"],
      ["Wheels", "rotating wall, ω = U / r"],
    ].filter(Boolean);
    return {
      title: "Boundary conditions",
      subtitle: list.length + " conditions",
      html: dl(list) +
        note("Faces are assigned by label, not by position: entity_labels.csv maps each STEP " +
          "entity id to one of inlet, outlet, ground, top, side, symmetry, car_no_slip or " +
          "rotating_wall. A face with no label gets no boundary condition, and the worker skips " +
          "any condition whose label matched nothing.") +
        (g && !g.label_path
          ? note("<span class=\"bad\">This geometry has no entity_labels.csv.</span> Without it the " +
            "worker finds no labelled faces, so no boundary conditions are created at all.")
          : ""),
    };
  };

  PANELS["bc:inlet"] = function (ctx, s, d) {
    const vr = d.viscosityRatio;
    const vrOk = vr == null ? null : (vr >= 1 && vr <= 100);
    const U = d.U;
    return {
      title: "Inlet",
      subtitle: "Velocity inlet, fixed value",
      html: dl([
        ["Condition", "Fixed value velocity"],
        ["Velocity x", U == null ? "n/a" : n(-U, "m/s", 3)],
        ["Velocity y", n(0, "m/s", 3)],
        ["Velocity z", n(0, "m/s", 3)],
      ]) +
        note("The worker sends x = −U, so the freestream runs in the −x direction and the car has " +
          "to be oriented with its nose toward −x. Get that backwards and the run finishes " +
          "cleanly with the wake on the wrong end.") +
        head("Freestream turbulence") +
        field("Intensity I, fraction of U", "turbulence.intensity", s.turbulence?.intensity,
          'step="0.005" min="0" max="1"') +
        field("Length scale l, m (blank = 7% of car height)", "turbulence.lengthScale",
          s.turbulence?.lengthScale, 'step="any" min="0" placeholder="' + esc(n(d.turbLengthScale, "", 5)) + '"') +
        dl([
          ["Intensity", s.turbulence?.intensity == null ? "n/a" : pct(s.turbulence.intensity, 2)],
          ["Length scale used", n(d.turbLengthScale, "m", 5)],
          ["k", n(d.k, "m²/s²", 5)],
          ["ω", n(d.omega, "1/s", 2)],
          ["ε", n(d.epsilon, "m²/s³", 3)],
          ["ν_t", n(d.nut, "m²/s", 6)],
          ["ν_t / ν", vr == null ? "n/a" : `${n(vr, "", 1)} ${verdict(vrOk, "healthy", "check this")}`],
        ]) +
        note("k = 1.5 (U·I)², ω = √k / (C<sub>μ</sub>^¼ · l) with C<sub>μ</sub> = 0.09. A healthy inlet " +
          "turbulent viscosity ratio is order 1–100: much below and the inlet is effectively " +
          "laminar, much above and the freestream is carrying turbulence the car never made, " +
          "which shows up as drag."),
    };
  };

  PANELS["bc:outlet"] = function (ctx, s, d) {
    return {
      title: "Outlet",
      subtitle: "Pressure outlet, 0 Pa gauge",
      html: dl([
        ["Condition", "Fixed value gauge pressure"],
        ["Gauge pressure", n(0, "Pa", 1)],
        ["Velocity", "zero gradient"],
        ["Distance behind car", n(d.domain?.downstream, "m", 3)],
        ["Reference pressure", n(s.numerics?.pressureReference, "Pa", 1)],
      ]) +
        note("An incompressible solver only ever sees pressure differences, so one face has to pin " +
          "the level and 0 Pa gauge is that pin. The outlet has to sit far enough downstream that " +
          "the wake has closed before it arrives. A recirculation touching a fixed-pressure face " +
          "is a classic source of a run that will not converge.") +
        note("The gauge pressure is hard-coded in the worker's build_model(); the distance is set " +
          "on the Geometry panel as domain downstream length."),
    };
  };

  PANELS["bc:ground"] = function (ctx, s, d) {
    const U = d.U;
    return {
      title: "Ground",
      subtitle: "Moving wall, rolling road",
      html: dl([
        ["Condition", "Wall, moving wall velocity"],
        ["Wall velocity x", U == null ? "n/a" : n(-U, "m/s", 3)],
        ["Wall velocity y", n(0, "m/s", 3)],
        ["Wall velocity z", n(0, "m/s", 3)],
        ["Relative to freestream", n(0, "m/s", 3)],
      ]) +
        note("The floor moves at exactly the inlet speed, which is what actually happens on a " +
          "track: the road is not standing still relative to the car. A stationary floor grows a " +
          "boundary layer that thickens all the way down the tunnel, starves the underbody and " +
          "quietly changes both the drag and the downforce."),
    };
  };

  PANELS["bc:top"] = function (ctx, s, d) {
    return {
      title: "Top",
      subtitle: "Slip wall",
      html: dl([
        ["Condition", "Wall, slip velocity"],
        ["Normal velocity", n(0, "m/s", 3)],
        ["Wall shear", n(0, "Pa", 3)],
        ["Height above car", n(d.L == null ? null : d.L * (s.domain?.top ?? 0), "m", 3)],
        ["Worker label", "top"],
      ]) +
        note("Slip means the flow cannot cross the roof but feels no friction from it, so the " +
          "tunnel roof does not grow a boundary layer of its own. It is the cheap stand-in for " +
          "open air; it only behaves like open air if the roof is far enough away, which is what " +
          "the blockage check on the Geometry panel is testing."),
    };
  };

  PANELS["bc:sides"] = function (ctx, s, d) {
    return {
      title: "Sides",
      subtitle: "Slip walls",
      html: dl([
        ["Condition", "Wall, slip velocity"],
        ["Normal velocity", n(0, "m/s", 3)],
        ["Wall shear", n(0, "Pa", 3)],
        ["Offset each side", n(d.L == null ? null : d.L * (s.domain?.side ?? 0), "m", 3)],
        ["Worker label", "side"],
      ]) +
        note("One label, \"side\", covers both walls. The worker creates a single Side condition " +
          "from every face carrying it. Same reasoning as the roof: no friction, no boundary " +
          "layer, valid only while the walls are far enough out."),
    };
  };

  PANELS["bc:symmetry"] = function (ctx, s, d) {
    return {
      title: "Symmetry",
      subtitle: "Symmetry plane, half model",
      html: dl([
        ["Condition", "Symmetry"],
        ["Normal velocity", n(0, "m/s", 3)],
        ["Normal gradients", "zero"],
        ["Domain width", n(d.domain?.width, "m", 3)],
      ]) +
        note("Half the domain, so roughly half the cells and half the run time. Two things to " +
          "hold on to: the forces that come back are for half a car and have to be doubled, and " +
          "the plane forbids any asymmetric wake, so a car that sheds vortices off one side " +
          "alternately cannot be modelled this way."),
    };
  };

  PANELS["bc:car"] = function (ctx, s, d) {
    const yPlus = s.mesh?.targetYPlus;
    const inRange = yPlus == null ? null : (yPlus >= 30 && yPlus <= 300);
    return {
      title: "Car",
      subtitle: "No-slip wall",
      html: dl([
        ["Condition", "Wall, no-slip"],
        ["Wall velocity", n(0, "m/s", 3)],
        ["Wall treatment", "Wall functions"],
        ["Worker label", "car_no_slip"],
        ["Target y⁺", yPlus == null ? "n/a" : `${n(yPlus, "", 0)} ${verdict(inRange, "in range", "outside 30–300")}`],
        ["First cell height", n(d.firstCellHeight, "m", 6)],
        ["First cell height", d.firstCellHeight == null ? "n/a" : n(d.firstCellHeight * 1000, "mm", 4)],
        ["Wall shear τ_w", n(d.wallShear, "Pa", 3)],
      ]) +
        note("No-slip is where the drag comes from: the fluid sticks to the surface and the " +
          "velocity gradient there is the skin friction. Everything the car does to the flow " +
          "downstream is decided in this layer, which is why the first cell height matters " +
          "more than the total cell count.") +
        note("k-ω SST switches between wall functions and resolving the sublayer depending on " +
          "the y⁺ the mesh actually achieves. 30–300 is the wall-function band; between 5 and 30 " +
          "is the buffer layer, where neither treatment is right."),
    };
  };

  PANELS["bc:wheels"] = function (ctx, s, d) {
    const U = d.U;
    const radii = [0.010, 0.015, 0.020, 0.025];
    const table = U == null ? [] : radii.map((r) =>
      [n(r * 1000, "mm", 0) + " radius", n(U / r, "rad/s", 1)]);
    return {
      title: "Wheels",
      subtitle: "Rotating wall, ω = U / r",
      html: dl([
        ["Condition", "Rotating wall velocity"],
        ["Angular velocity", "ω = U / r"],
        ["Rotation axis", "(0, 1, 0)"],
        ["Rotation centre", "cx_m, cy_m, cz_m from entity_labels.csv"],
        ["Worker label", "rotating_wall"],
        ["Inlet velocity U", n(U, "m/s", 1)],
      ]) +
        note("The radius is not measured from the geometry. It is read from the radius_m column " +
          "of entity_labels.csv, along with the wheel centre. Each distinct centre becomes its " +
          "own wheel (Wheel_1, Wheel_2, …) so four wheels get four different rotation centres. " +
          "A wheel with no radius in the CSV stays a plain no-slip wall and will not spin.") +
        (table.length ? head("ω for a given radius") + dl(table) : "") +
        note("Reference values only, at the current inlet speed. A spinning wheel drags air " +
          "around with it and changes the wake behind the car; a stationary one under-predicts " +
          "wheel drag, which on an F1-in-Schools body is a large fraction of the total.") +
        (ctx.geometry && !ctx.geometry.label_path
          ? note("<span class=\"bad\">No entity_labels.csv on this geometry</span>, no wheel faces " +
            "can be found, so no rotating walls are created.")
          : ""),
    };
  };

  PANELS.numerics = function (ctx, s, d) {
    const r = s.numerics?.relaxation || {};
    const t = s.numerics?.tolerance || {};
    return {
      title: "Numerics",
      subtitle: "SIMPLE, segregated pressure-velocity coupling",
      html: head("Relaxation factors") +
        grid([
          field("Pressure", "numerics.relaxation.pressure", r.pressure, 'step="0.05" min="0.01" max="1"'),
          field("Velocity", "numerics.relaxation.velocity", r.velocity, 'step="0.05" min="0.01" max="1"'),
          field("k", "numerics.relaxation.k", r.k, 'step="0.05" min="0.01" max="1"'),
          field("ω", "numerics.relaxation.omega", r.omega, 'step="0.05" min="0.01" max="1"'),
        ]) +
        note("SIMPLE solves momentum and pressure in turn rather than together, so each pressure " +
          "correction overshoots and only a fraction of it is applied. Pressure is the low one " +
          "for that reason. Lower values converge more slowly but survive worse meshes; if a run " +
          "diverges in the first hundred iterations, this is the first thing to drop.") +
        head("Residual tolerances") +
        grid([
          field("Velocity", "numerics.tolerance.velocity", t.velocity, 'step="any" min="0"'),
          field("Pressure", "numerics.tolerance.pressure", t.pressure, 'step="any" min="0"'),
          field("k", "numerics.tolerance.k", t.k, 'step="any" min="0"'),
          field("ω", "numerics.tolerance.omega", t.omega, 'step="any" min="0"'),
        ]) +
        field("Reference pressure, Pa", "numerics.pressureReference", s.numerics?.pressureReference, 'step="1"') +
        dl([
          ["Scheme", esc(s.numerics?.scheme) || "n/a"],
          ["Gradient", "SimScale default"],
          ["Divergence", "SimScale default"],
          ["Laplacian", "SimScale default"],
          ["Linear solvers", "SimScale default"],
        ]) +
        note("The residual is how much the discretised equation fails to balance on the current " +
          "field. Reaching 1e-5 stops the run early; hitting the iteration limit above it means " +
          "the run ended, not that it converged. The Convergence tab shows which is which.") +
        `<button class="btn btn-block" onclick="wbAction('resetSection','numerics')">Reset numerics to defaults</button>`,
    };
  };

  PANELS.control = function (ctx, s, d) {
    const sim = ctx.sim;
    const iters = sim?.iteration_count;
    const wi = s.control?.writeInterval;
    const writes = (iters != null && wi) ? Math.floor(iters / wi) : null;
    const perThousand = (d.cost != null && iters) ? (d.cost * 1000) / iters : null;
    return {
      title: "Simulation control",
      subtitle: "Steady-state, iterations run as seconds",
      html: field("Iterations, max 3000", "sim.iteration_count", iters, 'step="100" min="1" max="3000"') +
        dl([
          ["End time", iters == null ? "n/a" : int(iters, "s")],
          ["Time step Δt", n(1, "s", 0)],
          ["Iterations", int(iters)],
        ]) +
        note("SimScale has no separate iteration count for a steady case: the worker sets " +
          "end_time to the iteration count in seconds with Δt = 1 s, so one second of " +
          "\"simulated time\" is one SIMPLE iteration. The seconds are bookkeeping, not physics.") +
        grid([
          field("Write interval, iterations", "control.writeInterval", wi, 'step="10" min="1"'),
          field("Max run time, s", "control.maxRunTimeS", s.control?.maxRunTimeS, 'step="600" min="60"'),
        ]) +
        dl([
          ["Result writes", int(writes)],
          ["Max run time", s.control?.maxRunTimeS == null ? "n/a" : n(s.control.maxRunTimeS / 3600, "h", 2)],
          ["Decomposition", esc(s.control?.decompose) || "n/a"],
          ["Cost", d.cost == null ? "n/a" : int(d.cost, "credits")],
          ["Cost per 1000 it", perThousand == null ? "n/a" : int(perThousand, "credits")],
        ]) +
        note("Cost is charged server-side by on-new-job from the same formula, so this is the " +
          "price, not an estimate. Max run time is a wall-clock guillotine: the run stops there " +
          "whatever the residuals are doing."),
    };
  };

  PANELS.results = function (ctx, s, d) {
    const cor = s.results?.centreOfRotation || [];
    const fields = (s.results?.surfaceFields || []).map((f) => esc(f)).join(", ");
    const forceScale = (d.dynamicPressure != null && d.frontalArea != null)
      ? d.dynamicPressure * d.frontalArea : null;
    return {
      title: "Result control",
      subtitle: "Forces & moments",
      html: check("Write forces and moments", "results.forcesMoments", !!s.results?.forcesMoments) +
        head("Centre of rotation") +
        grid([
          field("X, m", "results.centreOfRotation.0", cor[0], 'step="0.001"'),
          field("Y, m", "results.centreOfRotation.1", cor[1], 'step="0.001"'),
          field("Z, m", "results.centreOfRotation.2", cor[2], 'step="0.001"'),
        ]) +
        note("Forces do not depend on this point but moments do. It is the point they are taken " +
          "about, so a pitching moment quoted against the wrong centre is not comparable between " +
          "two cars.") +
        dl([
          ["Applied to", "car faces + every wheel face"],
          ["Write interval", int(s.control?.writeInterval, "it")],
          ["Surface fields", fields || "n/a"],
          ["Dynamic pressure q", n(d.dynamicPressure, "Pa", 2)],
          ["Reference area A", n(d.frontalArea, "m²", 5)],
          ["Force scale qA", n(forceScale, "N", 4)],
        ]) +
        note("Cd = drag / qA and Cl = lift / qA with q = ½ρU². Drag is reported as a magnitude " +
          "because the solver returns a negative x force for a body pointing into the flow; lift " +
          "keeps its sign, so a negative lift is downforce.") +
        note("The surface fields are what the worker pulls out of the solution package for the " +
          "3D viewer, the full volume result stays in SimScale and is reachable through the " +
          "ParaView link on a finished run."),
    };
  };

  PANELS.mesh = function (ctx, s, d) {
    const sim = ctx.sim;
    return {
      title: "Mesh",
      subtitle: "Simmetrix, physics-based, automatic layers",
      html: grid([
        field("Refinement level, 1 to 5", "sim.refine_level", sim?.refine_level, 'step="1" min="1" max="5"'),
        field("Surface refinement fineness", "mesh.surfaceRefinement", s.mesh?.surfaceRefinement,
          'step="0.1" min="1" max="10"'),
      ]) +
        check("Debug mesh, coarse and cheap", "sim.debug_mesh", !!sim?.debug_mesh) +
        check("Boundary layers on car and wheels", "mesh.boundaryLayers", !!s.mesh?.boundaryLayers) +
        dl([
          ["Fineness", n(d.fineness, "", 1)],
          ["Cell budget", d.meshCellsM == null ? "n/a" : n(d.meshCellsM, "M cells", 2)],
        ]) +
        note("Fineness is a Simmetrix scale, not a cell size, and SimScale requires it to be a " +
          "multiple of 0.1. Levels 1–5 map to 9.0, 9.2, 9.5, 9.7, 10.0. Debug mesh drops to 1.0 " +
          "and about 0.1M cells: enough to prove the pipeline works end to end, nowhere near " +
          "enough for a drag number.") +
        head("Wall resolution") +
        field("Target y⁺", "mesh.targetYPlus", s.mesh?.targetYPlus, 'step="5" min="1" max="300"') +
        dl([
          ["Skin friction Cf", n(d.cf, "", 5)],
          ["Wall shear τ_w", n(d.wallShear, "Pa", 3)],
          ["Friction velocity u_τ", n(d.uTau, "m/s", 4)],
          ["First cell height", n(d.firstCellHeight, "m", 6)],
          ["First cell height", d.firstCellHeight == null ? "n/a" : n(d.firstCellHeight * 1000, "mm", 4)],
        ]) +
        note("From the flat-plate correlation Cf = 0.058 Re<sup>−0.2</sup>, then u_τ = √(τ_w/ρ) and " +
          "y = y⁺ν/u_τ. Metres alone are unreadable at this scale, hence the millimetres.") +
        note("This height is a target to check the finished mesh against, not a value that is " +
          "sent: the worker uses Simmetrix automatic layer settings, which choose the layer " +
          "thickness themselves from the surface sizing."),
    };
  };

  PANELS.runs = function (ctx, s, d) {
    const runs = (ctx.runs || []).slice();
    const isDone = (j) => j.status === "complete" || j.status === "completed";
    const done = runs.filter(isDone);
    const failed = runs.filter((j) => j.status === "failed");
    const live = runs.filter((j) => !isDone(j) && j.status !== "failed" && j.status !== "cancelled");

    // Best = smallest drag magnitude among finished runs. Sign convention is the
    // solver's, so compare magnitudes (see deltaHtml in workbench.html).
    let best = null;
    for (const j of done) {
      if (j.drag_n == null || !isFinite(+j.drag_n)) continue;
      if (!best || Math.abs(+j.drag_n) < Math.abs(+best.drag_n)) best = j;
    }
    const coef = (best && cfd().coefficients) ? cfd().coefficients(best, d) : null;
    const spent = runs.reduce((a, j) => a + (+j.cost || 0), 0);

    const recent = runs.slice(0, 5).map((j) => [
      String(j.file_name || j.name || String(j.id || "").slice(0, 8) || "run"),
      `<span class="tag t-${esc(j.status)}">${esc(j.status)}</span> ` +
      (j.drag_n == null ? "n/a" : n(j.drag_n, "N", 3)),
    ]);

    return {
      title: "Simulation runs",
      subtitle: runs.length === 1 ? "1 run" : runs.length + " runs",
      html: dl([
        ["Runs", int(runs.length)],
        ["Completed", int(done.length)],
        ["Failed", int(failed.length)],
        ["In progress", int(live.length)],
        ["Best drag", best ? n(Math.abs(+best.drag_n), "N", 3) : "n/a"],
        ["Best drag run", best ? esc(best.file_name || best.name || String(best.id || "").slice(0, 8)) : "n/a"],
        ["Cd of that run", coef && coef.cd != null ? n(coef.cd, "", 3) : "n/a"],
        ["Credits spent", int(spent)],
      ]) +
        (recent.length ? head("Most recent") + dl(recent) : "") +
        note("Drag is compared as a magnitude, so the best run is the smallest force whichever " +
          "sign the solver returned. A Cd here is only as good as the reference area on the " +
          "Geometry panel."),
    };
  };

  function inspector(nodeId, ctx) {
    ctx = ctx || {};
    const build = PANELS[nodeId];
    if (!build) {
      return {
        title: "n/a",
        subtitle: "",
        html: `<p class="muted">Nothing to show for this node.</p>`,
      };
    }
    return build(ctx, setupOf(ctx), ctx.derived || {});
  }

  win.WBPanels = { tree, inspector };
})(typeof window !== "undefined" ? window : globalThis);
