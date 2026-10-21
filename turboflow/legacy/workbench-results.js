// The results half of the workbench: the readout card over the viewport, the
// convergence and force panes, and the run-vs-run comparison.
//
// The rule this module exists to keep is that a number never appears without the
// thing that says whether it can be trusted — the reference area a coefficient
// was formed on, the residual that missed its tolerance, the drift still left in
// the force trace it was read off. Drag in newtons off a run that never
// converged is not a result, and a Cd with no stated area cannot be reproduced.
//
// Charting is workbench.html's lineChart, handed in through ctx.helpers, so the
// app has exactly one chart implementation and the panes here cannot drift from
// it.
(function (root) {
  "use strict";

  // Same palette workbench.html draws with. Exported so the host can share it
  // rather than keeping a second copy that can fall out of step.
  // Must stay identical to the palette in workbench.html — the compare table
  // colours columns from here while the chart colours traces from there, so a
  // drift between the two silently mislabels which run is which.
  const SERIES_COLOURS = ["#1d4e89", "#2e7d5b", "#b0651a", "#a8324a", "#5b4b9e", "#17706e"];

  const DASH = "n/a";
  const PARA = 'style="margin:var(--s3) 0 0;font-size:12px"';

  const finite = (v) => v != null && v !== "" && isFinite(+v);

  // Fixed notation is only readable across a couple of decades, and the solver's
  // own numbers run from 1e-8 residuals to 1e5 Pa. Outside 0.01 – 1e4 the value
  // gets an exponent rather than a row of zeros.
  function fmt(v, dp = 3) {
    if (!finite(v)) return DASH;
    const n = +v, a = Math.abs(n);
    return a !== 0 && (a < 0.01 || a > 1e4) ? n.toExponential(2) : n.toFixed(dp);
  }
  const withUnit = (v, u, dp) => (finite(v) ? fmt(v, dp) + " " + u : DASH);

  // Coefficients keep 4 significant figures: Cd 0.2299 and Cd 0.23 are different
  // cars once a lap time is run off them.
  function sig(v, digits = 4) {
    if (!finite(v)) return DASH;
    const n = +v, a = Math.abs(n);
    return a !== 0 && (a < 0.01 || a > 1e4) ? n.toExponential(digits - 1) : n.toPrecision(digits);
  }

  const runLabel = (j) => j?.file_name || (j?.id ? String(j.id).slice(0, 8) : "run");
  const lastFinite = (arr) => {
    for (let i = (arr || []).length - 1; i >= 0; i--) if (finite(arr[i])) return +arr[i];
    return null;
  };

  // How far above its own tolerance a residual finished. A residual that never
  // produced a finite value is worse than any number, hence Infinity.
  const overTol = (s) => (finite(s.final) && s.tolerance ? Math.abs(+s.final) / s.tolerance : Infinity);

  // lineChart colours series by their position in the array it is handed, so a
  // run with no stored trace shifts the colour of every run after it and the
  // legend stops matching the table beside it. The traces go in as picked order
  // minus the runs with nothing to draw, then the colours in the returned markup
  // are rewritten to the colour each run holds in the table. lineChart emits one
  // hex per path followed by one per legend entry, both in series order, which is
  // why one cycling pass lines them up.
  function recolour(html, colours) {
    if (!colours.length) return html;
    let i = 0;
    return html.replace(/#[0-9a-fA-F]{6}\b/g, () => colours[i++ % colours.length]);
  }

  // ── shared fragments ───────────────────────────────────────────────────────

  // A coefficient without its reference area is not reproducible, so the area is
  // stated wherever Cd or Cl is shown, together with how it was arrived at.
  function areaPhrase(derived, setup) {
    const ref = (setup && setup.reference) || {};
    const how = ref.frontalAreaOverride != null
      ? "entered by hand"
      : `${fmt(ref.frontalAreaFactor, 2)} × the ${fmt(derived.W, 4)} × ${fmt(derived.H, 4)} m bounding box`;
    return `A = ${fmt(derived.frontalArea)} m², ${how}`;
  }

  function referenceNote(derived, setup) {
    if (!derived || !finite(derived.frontalArea)) {
      return `<p class="basis">No reference area. This geometry has no bounding box,
        so Cd and Cl cannot be formed.</p>`;
    }
    return `<p class="basis">Cd and Cl on ${areaPhrase(derived, setup)}.</p>`;
  }

  function convergenceLine(ctx) {
    const c = root.CFD.convergence(ctx.job, ctx.setup);
    if (!c || !c.series.length) return "";
    if (c.converged) {
      return `<p class="caveat" style="border-left-color:var(--ok)">Converged. All ${c.series.length} residuals at or below tolerance.</p>`;
    }
    const missed = c.series.filter((s) => !s.met);
    const worst = missed.reduce((a, b) => (overTol(b) > overTol(a) ? b : a), missed[0]);
    const name = ctx.helpers.esc(worst.name);
    if (!finite(worst.final)) {
      return `<p class="caveat bad">Not converged, ${name} never produced a finite residual
        (tolerance ${fmt(worst.tolerance)}).</p>`;
    }
    const r = overTol(worst);
    return `<p class="caveat bad">Not converged, ${name} finished at ${fmt(worst.final)},
      ${fmt(r, r < 10 ? 1 : 0)}× its ${fmt(worst.tolerance)} tolerance.</p>`;
  }

  function steadinessLine(ctx) {
    const s = root.CFD.forceSteadiness(ctx.job);
    if (!s || !finite(s.percent)) return "";
    if (s.percent <= 2) {
      return `<p class="basis">Drag settled, ${fmt(s.percent, 1)}% spread over the last
        fifth of the run.</p>`;
    }
    // Above 2% the trace has not stopped moving, so the reported drag is one
    // sample off a drifting line rather than the answer.
    return `<p class="caveat">Drag still moving ${fmt(s.percent, 1)}% across the last fifth of
      the run. This figure is a point on a drifting trace, not a settled value.</p>`;
  }

  // ── readout ────────────────────────────────────────────────────────────────

  function readout(ctx) {
    const job = ctx.job;
    if (!job) return "";
    const esc = ctx.helpers.esc;
    const coef = root.CFD.coefficients(job, ctx.derived) || {};

    return `
    <div class="card readout">
      <span class="tag t-${esc(job.status)}">${esc(job.status)}</span>
      <dl class="metrics">
        <dt>Drag</dt><dd class="num">${withUnit(job.drag_n, "N")}</dd>
        <dt>Cd</dt><dd class="num">${sig(coef.cd)}</dd>
        <dt>Lift</dt><dd class="num">${withUnit(job.lift_n, "N")}</dd>
        <dt>Cl</dt><dd class="num">${sig(coef.cl)}</dd>
        <dt>Inlet</dt><dd class="num">${withUnit(job.inlet_velocity, "m/s", 1)}</dd>
        <dt>Iterations</dt><dd class="num">${finite(job.iteration_count) ? esc(job.iteration_count) : DASH}</dd>
        <dt>Refinement</dt><dd class="num">${finite(job.refine_level) ? esc(job.refine_level) : DASH}</dd>
        <dt>Cost</dt><dd class="num">${finite(job.cost) ? esc(job.cost) + " cr" : DASH}</dd>
      </dl>
      ${referenceNote(ctx.derived, ctx.setup)}
      ${convergenceLine(ctx)}
      ${steadinessLine(ctx)}
      ${job.paraview_url ? `<a class="btn btn-block" style="margin-top:var(--s4)" target="_blank"
          rel="noopener" href="${esc(job.paraview_url)}">Open in ParaView</a>` : ""}
      ${ctx.refundable === true ? `<button class="btn btn-block" style="margin-top:var(--s2)"
          onclick="wbAction('cancel')">Cancel and refund ${finite(job.cost) ? esc(job.cost) : 0} credits</button>` : ""}
      ${job.error ? `<p class="err">${esc(job.error)}</p>` : ""}
    </div>`;
  }

  // ── convergence ────────────────────────────────────────────────────────────

  function convergencePane(ctx) {
    if (!ctx.job) return `<p class="empty">Select a run.</p>`;
    const res = ctx.job.plots && ctx.job.plots.residuals;
    if (!res || !res.series) return `<p class="empty">No convergence data for this run.</p>`;
    const esc = ctx.helpers.esc;

    // Filter to what is actually drawable on a log axis before charting, so the
    // colour a series gets in the chart is the colour this file assigns it in the
    // table below.
    const xs = res.iterations || [];
    const series = Object.entries(res.series).map(([name, values]) => ({
      name, values: (values || []).slice(0, xs.length),
    })).filter((s) => s.values.some((v) => v != null && isFinite(v) && v > 0));
    const colour = new Map(series.map((s, i) => [s.name, SERIES_COLOURS[i % SERIES_COLOURS.length]]));
    const chart = series.length
      ? ctx.helpers.lineChart(series, xs, { log: true })
      : `<p class="empty">No positive residuals to plot.</p>`;

    // The chart shows the shape; this table is the answer — which residual met
    // the tolerance the solver was actually given, and which did not.
    const c = root.CFD.convergence(ctx.job, ctx.setup);
    const rows = (c ? c.series : []).map((s) => {
      const sw = colour.has(s.name)
        ? `<span class="swatch" style="background:${colour.get(s.name)}"></span>` : "";
      return `<tr>
        <th>${sw}${esc(s.name)}</th>
        <td class="num">${fmt(s.final)}</td>
        <td class="num">${fmt(s.tolerance)}</td>
        <td>${s.met ? `<span class="good">Met</span>` : `<span class="bad">Not met</span>`}</td>
      </tr>`;
    }).join("");

    return `${chart}
      <table class="cmp" style="margin-top:var(--s4)">
        <thead><tr><th></th><th>Final</th><th>Tolerance</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${convergenceLine(ctx)}`;
  }

  // ── forces ─────────────────────────────────────────────────────────────────

  function forcePane(ctx) {
    if (!ctx.job) return `<p class="empty">Select a run.</p>`;
    const f = ctx.job.plots && ctx.job.plots.forces;
    if (!f || !f.drag) return `<p class="empty">No force history for this run.</p>`;

    // lineChart reads xs[k] for the k-th value, so a trace longer than the
    // iteration column would plot points at an undefined x. Cut both to the
    // iterations actually recorded.
    const xs = f.iterations || [];
    const chart = ctx.helpers.lineChart([
      { name: "Drag (X)", values: (f.drag || []).slice(0, xs.length) },
      { name: "Lift (Z)", values: (f.lift || []).slice(0, xs.length) },
    ], xs, { unit: "newtons" });

    const s = root.CFD.forceSteadiness(ctx.job);
    const steady = s ? `
      <dt>Mean, last fifth</dt><dd class="num">${withUnit(s.mean, "N")}</dd>
      <dt>Peak to peak</dt><dd class="num">${withUnit(s.spread, "N")}</dd>
      <dt>Spread</dt><dd class="num">${finite(s.percent) ? fmt(s.percent, 1) + " %" : DASH}</dd>`
      : `<dt>Steadiness</dt><dd class="num">${DASH}</dd>`;

    return `${chart}
      <dl class="metrics" style="max-width:340px;margin-top:var(--s4)">
        <dt>Final drag</dt><dd class="num">${withUnit(lastFinite(f.drag), "N")}</dd>
        <dt>Final lift</dt><dd class="num">${withUnit(lastFinite(f.lift), "N")}</dd>
        ${steady}
      </dl>
      ${s ? steadinessLine(ctx) : `<p class="muted" ${PARA}>Fewer than ten force samples stored,
        too few to say whether the trace had settled.</p>`}`;
  }

  // ── compare ────────────────────────────────────────────────────────────────

  function comparePane(ctx) {
    const picked = ctx.jobs || [];
    if (picked.length < 2) return `<p class="empty">Tick two or more runs to compare them.</p>`;
    const esc = ctx.helpers.esc, delta = ctx.helpers.deltaHtml;
    const base = picked[0];

    // Colour belongs to the run's place in the picked list, not to its place in
    // whatever subset happens to have plot data.
    const colours = picked.map((_, i) => SERIES_COLOURS[i % SERIES_COLOURS.length]);

    // Each run gets its own derived quantities and its own setup: two runs in the
    // same comparison can have been launched at different velocities against
    // different geometry versions, so one shared reference area or one shared
    // tolerance set would put every coefficient in the table on the wrong basis.
    // ctx.derived / ctx.setup are the baseline's, used only where a run has no
    // entry of its own.
    const derivedOf = (j) => (ctx.derivedFor && ctx.derivedFor[j.id]) || ctx.derived;
    const setupOf = (j) => (ctx.setupFor && ctx.setupFor[j.id]) || ctx.setup;
    const coef = picked.map((j) => root.CFD.coefficients(j, derivedOf(j)) || {});
    const conv = picked.map((j) => root.CFD.convergence(j, setupOf(j)));

    // rel: percent deltas belong on the quantities where "10% less" means
    // something physical. An iteration count or a credit price is not that.
    const rel = (get, show) => (j, i) => {
      const v = get(j, i), b = get(base, 0);
      return show(v) + (i > 0 ? delta(v == null ? null : +v, b == null ? null : +b) : "");
    };
    const plain = (get, show) => (j, i) => show(get(j, i));

    const rows = [
      ["Drag (N)", rel((j) => j.drag_n, (v) => fmt(v, 3))],
      ["Cd", rel((j, i) => coef[i].cd, (v) => sig(v))],
      ["Lift (N)", rel((j) => j.lift_n, (v) => fmt(v, 3))],
      ["Cl", rel((j, i) => coef[i].cl, (v) => sig(v))],
      ["Inlet (m/s)", plain((j) => j.inlet_velocity, (v) => fmt(v, 1))],
      ["Refinement", plain((j) => j.refine_level, (v) => fmt(v, 0))],
      ["Iterations", plain((j) => j.iteration_count, (v) => fmt(v, 0))],
      ["Cost (cr)", plain((j) => j.cost, (v) => fmt(v, 0))],
      ["Converged", (j, i) => (!conv[i] ? DASH
        : conv[i].converged ? `<span class="good">Yes</span>` : `<span class="bad">No</span>`)],
    ];

    const head = picked.map((j, i) =>
      `<th><span class="swatch" style="background:${colours[i]}"></span>
        ${esc(runLabel(j))}${i === 0 ? '<span class="muted"> · baseline</span>' : ""}</th>`).join("");
    const body = rows.map(([label, cell]) =>
      `<tr><th>${label}</th>${picked.map((j, i) => `<td class="num">${cell(j, i)}</td>`).join("")}</tr>`
    ).join("");

    const drawable = picked
      .map((j, i) => ({ j, i }))
      .filter((x) => x.j.plots && x.j.plots.forces
        && (x.j.plots.forces.drag || []).some((v) => v != null && isFinite(v)));
    const xs = drawable.length ? (drawable[0].j.plots.forces.iterations || []) : [];
    const chart = drawable.length
      ? recolour(ctx.helpers.lineChart(
          drawable.map((x) => ({
            name: runLabel(x.j) + " drag",
            values: x.j.plots.forces.drag.slice(0, xs.length),
          })), xs, { unit: "newtons" }),
        drawable.map((x) => colours[x.i]))
      : `<p class="empty">No force history stored for these runs.</p>`;

    // The areas are per run too, so the note states the one area they share or
    // names each of them — printing the baseline's and letting it stand for the
    // rest would make three coefficients unreproducible at once.
    const areas = picked.map(derivedOf);
    const known = areas.filter((d) => d && finite(d.frontalArea));
    const note = !known.length
      ? `<p class="muted" ${PARA}>No reference area for these runs. Cd and Cl cannot be formed.</p>`
      : known.length === picked.length && known.every((d) => d.frontalArea === known[0].frontalArea)
        ? `<p class="muted" ${PARA}>Cd and Cl on ${areaPhrase(known[0], setupOf(base))}.</p>`
        : `<p class="muted" ${PARA}>Cd and Cl on each run's own reference area:
            ${picked.map((j, i) => `${esc(runLabel(j))}: ${areas[i] && finite(areas[i].frontalArea)
              ? "A = " + fmt(areas[i].frontalArea) + " m²" : "none"}`).join("; ")}.</p>`;

    return `
      <table class="cmp"><thead><tr><th></th>${head}</tr></thead><tbody>${body}</tbody></table>
      ${note}
      ${chart}`;
  }

  const api = { SERIES_COLOURS, readout, convergencePane, forcePane, comparePane };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.WBResults = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
