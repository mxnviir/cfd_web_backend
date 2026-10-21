// The physics behind the workbench's setup panels.
//
// Every default here is the value docker jobs/simscale_job.py actually sends to
// SimScale, so what the panel shows is what the solver runs — not a plausible
// number typed into a form. Where a quantity is derived rather than sent
// (Reynolds number, y+, blockage) it is computed from the same inputs the
// solver gets, and the formula is named in a comment so it can be checked.
//
// Loaded by workbench.html and by tests/test_cfd_setup.mjs, which is why it
// exports through both window and ESM-ish detection.
(function (root) {
  "use strict";

  // ── constants, mirrored from the worker ────────────────────────────────────
  const AIR_DENSITY = 1.2041;      // kg/m³   simscale_job.py AIR_DENSITY
  const AIR_KIN_VISC = 1.516e-5;   // m²/s    simscale_job.py AIR_KIN_VISC
  const C_MU = 0.09;               // k-omega/k-epsilon closure constant
  const SPEED_OF_SOUND = 343.0;    // m/s at 20 °C

  // Simmetrix fineness per refinement level — simscale_job.py _FINENESS
  const FINENESS = { 1: 9.0, 2: 9.2, 3: 9.5, 4: 9.7, 5: 10.0 };

  // Derived from the SAME fineness ladder the worker meshes with, so the
  // estimate shown before running describes the mesh that gets built.
  //
  // This used to interpolate the ladder as 9.0 + (level-1)*0.25, giving 9.25 and
  // 9.75 at levels 2 and 4 where the worker sends 9.2 and 9.7. Small, but it
  // meant three components each held a slightly different idea of the same
  // mesh. on-new-job/index.ts now uses this ladder too.
  function meshCellsM(level, debug) {
    if (debug) return 0.1;
    const l = Math.max(1, Math.min(5, Math.round(level) || 3));
    return ((FINENESS[l] ?? 9.5) - 7.0) * 15.0 / 3.0 + 5.0;
  }

  // The column defaults declared in 0015_workbench_schema.sql. A simulation row
  // read before Postgres has applied them — or written by an older client that
  // did not know a column existed — must price as the server will, not as NaN.
  const COL = { inlet_velocity: 20, refine_level: 3, iteration_count: 1000 };

  // Coerce the way on-new-job/index.ts does: `Number(x) || fallback`, so null,
  // undefined, "" and NaN all land on the documented default instead of
  // poisoning every number downstream. "Run simulation, NaN cr" was a real
  // button.
  const num = (v, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) && n !== 0 ? n : fallback;
  };

  // List price — what on-new-job computes before the account is considered.
  function creditCost(level, iterations, debug) {
    const l = Math.max(1, Math.min(5, Math.round(num(level, COL.refine_level))));
    const i = Math.max(1, Math.min(3000, Math.round(num(iterations, COL.iteration_count))));
    const per1000 = debug === true ? 1 : 100 + (l - 1) * 25;
    return Math.max(1, Math.round(per1000 * i / 1000));
  }

  // What the account will actually be charged.
  //
  // apply_new_job_charge applies two things the list price knows nothing about
  // (0004_new_job_charge.sql):
  //   has_active_unlimited(u) -> 0
  //   otherwise               -> greatest(1, round(list * sponsor_rate(u)))
  // and sponsor_rate is 1 unless `sponsored` is true AND the rate is in (0,1].
  //
  // Quoting the list price to a sponsored team meant the button said 150 cr and
  // the balance moved by 75. In the user's favour, but the workbench told them
  // something untrue about their own money, which is the part that matters.
  function sponsorRate(user) {
    if (!user || user.sponsored !== true) return 1;
    const r = Number(user.sponsor_rate);
    return r > 0 && r <= 1 ? r : 1;
  }
  function hasUnlimited(user, now = new Date()) {
    const until = user && user.unlimited_until;
    return !!until && new Date(until) > now;
  }
  // Mirrors the SQL exactly, including that `greatest(1, ...)` means a sponsored
  // run is never free — only an unlimited pass is.
  function chargeFor(user, level, iterations, debug, now) {
    const list = creditCost(level, iterations, debug);
    if (hasUnlimited(user, now)) return 0;
    return Math.max(1, Math.round(list * sponsorRate(user)));
  }

  // ── default setup document ─────────────────────────────────────────────────
  // Matches build_model() in the worker exactly. Anything the worker leaves to
  // the SimScale SDK default is marked so, because "SDK default" is a real
  // answer and inventing a number to fill the box would not be.
  const DEFAULTS = {
    analysis: { type: "INCOMPRESSIBLE", steady: true, turbulenceModel: "KOMEGASST" },
    material: {
      name: "Air", density: AIR_DENSITY, kinematicViscosity: AIR_KIN_VISC,
    },
    turbulence: {
      // Freestream turbulence for a wind-tunnel-like external case. 1% is the
      // usual low-turbulence tunnel figure; length scale defaults to ~7% of the
      // car height, the standard duct-flow style estimate.
      intensity: 0.01, lengthScale: null,   // null = derive from geometry
    },
    domain: {
      // Wind tunnel extents in car lengths, the conventional external-aero box.
      upstream: 3, downstream: 8, side: 3, top: 3, symmetry: false,
    },
    bcs: {
      inlet: "velocity",        // fixed-value velocity inlet
      outlet: "pressure",       // 0 Pa gauge
      ground: "moving_wall",    // rolling road at inlet speed
      sides: "slip",
      top: "slip",
      car: "no_slip",
      wheels: "rotating_wall",  // omega = U / r
    },
    numerics: {
      // The worker passes RelaxationFactor() and FluidSolvers() with no
      // arguments, i.e. the SimScale defaults for SIMPLE. These are those
      // defaults, shown so the case is legible and editable.
      relaxation: { pressure: 0.3, velocity: 0.7, k: 0.7, omega: 0.7 },
      tolerance: { velocity: 1e-5, pressure: 1e-5, k: 1e-5, omega: 1e-5 },
      pressureReference: 0,     // Pa
      scheme: "SECOND_ORDER",
    },
    control: {
      // Steady-state SIMPLE: SimScale models iterations as end_time seconds
      // with delta_t = 1 s, which is why iteration_count carries unit "s".
      writeInterval: 100, maxRunTimeS: 36000, decompose: "SCOTCH",
    },
    mesh: {
      fineness: null,            // null = derive from refine_level
      surfaceRefinement: 10,     // car + wheel faces, AutomaticMeshSizingSimmetrix
      boundaryLayers: true,      // AutomaticLayerOn()
      targetYPlus: 50,           // wall-function range for k-omega SST
    },
    results: {
      forcesMoments: true,
      centreOfRotation: [0.1, 0.0, 0.014],   // metres, worker's value
      surfaceFields: ["p", "U", "k", "omega", "nut", "wallShearStress"],
    },
    reference: {
      // Force coefficients need a reference area. The bounding box gives an
      // upper bound, never the true projected area, so this is a factor the
      // user owns rather than a number we pretend to know.
      frontalAreaFactor: 0.62, frontalAreaOverride: null,
    },
  };

  const clone = (o) => JSON.parse(JSON.stringify(o));

  // Deep-merge a stored setup over the defaults, so a document written before a
  // key existed still opens with that key populated.
  //
  // The result must share no mutable state with its input. workbench.html holds
  // the return value as an edit draft precisely so a half-typed value never
  // reaches the database and Discard can throw the edits away — aliasing an
  // array or an unrecognised object straight through would write edits back
  // into the saved row and leak them between two calls, quietly defeating both.
  function withDefaults(setup) {
    const out = clone(DEFAULTS);
    (function merge(dst, src) {
      for (const k in src || {}) {
        if (src[k] === undefined) continue;
        if (src[k] && typeof src[k] === "object" && !Array.isArray(src[k]) && dst[k]) merge(dst[k], src[k]);
        else dst[k] = (src[k] && typeof src[k] === "object") ? clone(src[k]) : src[k];
      }
    })(out, setup);
    return out;
  }

  // ── derived quantities ─────────────────────────────────────────────────────
  // sim: {inlet_velocity, refine_level, iteration_count, debug_mesh}
  // geom: {bbox:{size:[x,y,z]}}
  // `user` is optional: without it the quote is the list price, which is what a
  // signed-out or still-loading view should show rather than a guess.
  function derive(sim, geom, setup, user) {
    const s = withDefaults(setup);
    // Falls back to the column default, not to ~0. A missing velocity used to
    // give U = 1e-9, which turned Reynolds into 1.4e-5 and quietly reported a
    // car doing a micrometre per second as laminar.
    const U = Math.max(1e-9, num(sim.inlet_velocity, COL.inlet_velocity));
    // A dimension is only usable if it is a finite positive number. Zero and
    // negative extents reach here from a degenerate or half-imported solid, and
    // letting them through turns Reynolds negative, which makes the flat-plate
    // Cf correlation (Re^-0.2) NaN and poisons wall shear, u_tau and the first
    // cell height with it. Unknown is a better answer than a number that cannot
    // be true.
    const dim = (v) => { const n = +v; return Number.isFinite(n) && n > 0 ? n : null; };
    const size = geom?.bbox?.size;
    const L = size ? dim(size[0]) : null;      // car length, flow direction
    const W = size ? dim(size[1]) : null;      // width
    const H = size ? dim(size[2]) : null;      // height
    const nu = s.material.kinematicViscosity;
    const rho = s.material.density;

    const d = { U, L, W, H, rho, nu };

    // Reynolds number on car length. Above ~5e5 the boundary layer is
    // transitional/turbulent, which is what k-omega SST is for.
    d.reynolds = L ? (U * L) / nu : null;
    d.regime = d.reynolds == null ? null
      : d.reynolds < 5e5 ? "laminar–transitional" : "turbulent";

    // Compressibility check: the solver is incompressible, valid below M ≈ 0.3.
    d.mach = U / SPEED_OF_SOUND;
    d.incompressibleValid = d.mach < 0.3;

    // Reference area for force coefficients. A degenerate bounding box gives an
    // area of zero, which is not a known area — it is an unknown one, and
    // dividing a force by it produces Infinity rather than a coefficient. So
    // anything not strictly positive reports null and every dependent figure
    // says "n/a" instead of a number nobody can defend.
    d.bboxFrontalArea = (W > 0 && H > 0) ? W * H : null;
    const override = s.reference.frontalAreaOverride;
    // The measured shadow of the car, over the width of tunnel actually built.
    // The geometry service rasterises it; the bounding-box factor below is what
    // there was before anyone measured, and it is out by a fifth either way
    // depending on the shape of the car. Prefer the measurement whenever the
    // geometry carries one.
    d.measuredFrontalArea = geom && geom.frontal_area_m2 > 0 ? geom.frontal_area_m2 : null;
    d.frontalArea = override > 0 ? override
      : d.measuredFrontalArea != null ? d.measuredFrontalArea
      : (d.bboxFrontalArea != null ? d.bboxFrontalArea * s.reference.frontalAreaFactor : null);
    if (!(d.frontalArea > 0)) d.frontalArea = null;
    d.frontalAreaSource = override > 0 ? "typed in"
      : d.measuredFrontalArea != null ? "measured from the car"
      : d.bboxFrontalArea != null ? "estimated from the bounding box" : null;
    d.dynamicPressure = 0.5 * rho * U * U;     // q, Pa

    // Inlet turbulence. k = 1.5 (U·I)²; omega = √k / (Cμ^¼ · l)
    const I = s.turbulence.intensity;
    // `H != null` is true when H is 0, and 0.07 * 0 is a length scale of zero,
    // which makes omega infinite. A degenerate or missing height has to fall
    // back to the fixed estimate, not to zero.
    d.turbLengthScale = s.turbulence.lengthScale > 0 ? s.turbulence.lengthScale
                      : (H > 0 ? 0.07 * H : 0.001);
    d.k = 1.5 * Math.pow(U * I, 2);
    d.omega = Math.sqrt(d.k) / (Math.pow(C_MU, 0.25) * d.turbLengthScale);
    d.epsilon = Math.pow(C_MU, 0.75) * Math.pow(d.k, 1.5) / d.turbLengthScale;
    d.nut = d.k / d.omega;
    d.viscosityRatio = d.nut / nu;             // healthy inlet is O(1–100)

    // Wall resolution. Flat-plate correlation Cf = 0.058 Re^-0.2, then
    // u_tau = √(τ_w/ρ) and y = y⁺ν/u_tau — the first-cell height the mesh needs
    // to land in the wall-function range k-omega SST expects.
    if (d.reynolds) {
      d.cf = 0.058 * Math.pow(d.reynolds, -0.2);
      d.wallShear = 0.5 * rho * U * U * d.cf;
      d.uTau = Math.sqrt(d.wallShear / rho);
      d.firstCellHeight = (s.mesh.targetYPlus * nu) / d.uTau;
    }

    // Wind tunnel domain, in metres, from the car-lengths box.
    if (L != null) {
      const dm = s.domain;
      d.domain = {
        length: L * (dm.upstream + 1 + dm.downstream),
        width: (dm.symmetry ? 1 : 2) * (W / 2 + L * dm.side),
        height: H + L * dm.top,
        upstream: L * dm.upstream, downstream: L * dm.downstream,
      };
      d.domain.crossSection = d.domain.width * d.domain.height;
      // Blockage ratio. Above ~5% the tunnel walls start altering the answer.
      d.blockage = d.frontalArea != null ? d.frontalArea / d.domain.crossSection : null;
      d.blockageOk = d.blockage == null || d.blockage < 0.05;
    }

    // Mesh + price.
    d.fineness = s.mesh.fineness ?? (sim.debug_mesh ? 1.0 : (FINENESS[Math.max(1, Math.min(5, sim.refine_level))] ?? 9.5));
    d.meshCellsM = meshCellsM(sim.refine_level, sim.debug_mesh);
    d.listCost = creditCost(sim.refine_level, sim.iteration_count, sim.debug_mesh);
    d.cost = chargeFor(user, sim.refine_level, sim.iteration_count, sim.debug_mesh);
    d.sponsorRate = sponsorRate(user);
    d.unlimited = hasUnlimited(user);
    d.discounted = d.cost !== d.listCost;

    return d;
  }

  // ── force coefficients from a finished run ─────────────────────────────────
  // Cd = 2F / (ρ U² A). Forces come out of the solver negative for a body
  // pointing into the flow, so report magnitude for drag and keep the sign for
  // lift (negative lift = downforce, which is the point).
  function coefficients(job, derived) {
    const A = derived?.frontalArea, U = job.inlet_velocity ?? derived?.U, rho = derived?.rho ?? AIR_DENSITY;
    if (!A || !U) return { cd: null, cl: null };
    const q = 0.5 * rho * U * U * A;
    return {
      cd: job.drag_n == null ? null : Math.abs(job.drag_n) / q,
      cl: job.lift_n == null ? null : job.lift_n / q,
      q,
    };
  }

  // ── convergence verdict ────────────────────────────────────────────────────
  // A run that hit its iteration limit with residuals above tolerance has not
  // converged, whatever its status column says. Saying so is the difference
  // between a result and a number.
  function convergence(job, setup) {
    const s = withDefaults(setup);
    const r = job?.plots?.residuals;
    if (!r?.series) return null;
    const tol = s.numerics.tolerance;
    const map = { Ux: tol.velocity, Uy: tol.velocity, Uz: tol.velocity, p: tol.pressure, k: tol.k, omega: tol.omega };
    const out = [];
    for (const [name, values] of Object.entries(r.series)) {
      // A worker can record the residuals object but leave one channel untracked
      // (p:null, or a missing omega). Spreading that threw "values is not
      // iterable" and blanked the whole readout for the run — the same guard the
      // sibling in workbench-results.js already carries.
      const last = [...(Array.isArray(values) ? values : [])].reverse().find((v) => v != null && isFinite(v));
      const limit = map[name] ?? tol.velocity;
      out.push({ name, final: last ?? null, tolerance: limit, met: last != null && last <= limit });
    }
    const done = out.length > 0 && out.every((x) => x.met);
    return { series: out, converged: done, iterations: r.iterations?.[r.iterations.length - 1] ?? null };
  }

  // Steadiness of the force trace: how much the last fifth of the run still
  // moves. A drag number taken from a trace that is still drifting is not a
  // drag number.
  function forceSteadiness(job) {
    const f = job?.plots?.forces;
    if (!f?.drag?.length) return null;
    const vals = f.drag.filter((v) => v != null && isFinite(v));
    if (vals.length < 10) return null;
    const tail = vals.slice(Math.floor(vals.length * 0.8));
    const mean = tail.reduce((a, b) => a + b, 0) / tail.length;
    const spread = Math.max(...tail) - Math.min(...tail);
    return { mean, spread, percent: mean === 0 ? null : Math.abs(spread / mean) * 100 };
  }

  const api = {
    AIR_DENSITY, AIR_KIN_VISC, C_MU, FINENESS, DEFAULTS,
    withDefaults, derive, coefficients, convergence, forceSteadiness,
    meshCellsM, creditCost, chargeFor, sponsorRate, hasUnlimited, clone,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CFD = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
