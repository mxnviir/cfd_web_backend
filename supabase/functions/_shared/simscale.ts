// SimScale over REST, ported from services/simscale-job (simscale_job.py's
// spec path and spec_mode.py). The payloads, versions and query parameters
// are the worker's, unchanged; each one is there because a run once failed
// without it, and the reasons are kept beside them.

const env = (name: string): string => Deno.env.get(name) ?? "";

const PLACEHOLDERS = new Set(["", "unset", "UNSET", "REPLACE_ME", "changeme"]);

export function simscaleConfig() {
  const base = env("SIMSCALE_API_BASE") || "https://api.simscale.com/v0";
  const key = env("SIMSCALE_API_KEY");
  const project = env("SIMSCALE_PROJECT_ID");
  const missing = [
    PLACEHOLDERS.has(key.trim()) ? "SIMSCALE_API_KEY" : "",
    PLACEHOLDERS.has(project.trim()) ? "SIMSCALE_PROJECT_ID" : "",
  ].filter(Boolean);
  return { base, key, project, missing };
}

export class SpecError extends Error {}

export interface Api {
  get(path: string): Promise<Response>;
  post(path: string, body: unknown, params?: Record<string, string>): Promise<Response>;
  put(path: string, body: unknown): Promise<Response>;
  /** A path outside the project, such as /storage. */
  raw(method: string, url: string, init?: RequestInit): Promise<Response>;
}

export function api(): Api {
  const { base, key, project } = simscaleConfig();
  const headers = { "X-API-KEY": key, "Content-Type": "application/json" };
  const url = (path: string, params?: Record<string, string>) =>
    `${base}/projects/${project}/${path}${params ? `?${new URLSearchParams(params)}` : ""}`;
  return {
    get: (path) => fetch(url(path), { headers }),
    // `params` is the query string, and it matters: starting a mesh
    // operation takes its simulationId there, and sending it as JSON left
    // the operation in READY forever.
    post: (path, body, params) =>
      fetch(url(path, params), { method: "POST", headers, body: body == null ? undefined : JSON.stringify(body) }),
    put: (path, body) => fetch(url(path), { method: "PUT", headers, body: JSON.stringify(body) }),
    raw: (method, u, init = {}) =>
      fetch(u.startsWith("http") ? u : `${base}${u}`, {
        ...init, method, headers: { "X-API-KEY": key, ...(init.headers ?? {}) },
      }),
  };
}

/** SimScale's error JSON as a sentence a person can act on (spec_mode.readable_api_error). */
export function readableApiError(text: string, fallback = "The solver refused the request."): string {
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    return (text || fallback).trim().slice(0, 300);
  }
  const first = (node: any): string | null => {
    if (node && typeof node === "object" && !Array.isArray(node)) {
      for (const k of ["message", "cause", "detail"]) {
        if (typeof node[k] === "string" && node[k].trim()) return node[k].trim();
      }
      for (const v of Object.values(node)) {
        const f = first(v);
        if (f) return f;
      }
    } else if (Array.isArray(node)) {
      for (const v of node) {
        const f = first(v);
        if (f) return f;
      }
    }
    return null;
  };
  const message = first(data);
  const code = data && typeof data === "object" ? data.code : null;
  if (message && code) return `${message} (${code})`.slice(0, 300);
  if (message) return message.slice(0, 300);
  if (code) return `The solver refused the request: ${code}.`;
  return fallback;
}

/**
 * Put back the COMPONENT tags SimScale's discriminated unions need, on any
 * vector of three functions that lacks one (spec_mode.add_missing_discriminators).
 */
export function addMissingDiscriminators(node: any): any {
  if (node && typeof node === "object" && !Array.isArray(node)) {
    const keys = Object.keys(node);
    if (["x", "y", "z"].every((k) => keys.includes(k)) && !keys.includes("type")
      && ["x", "y", "z"].every((k) => node[k] && typeof node[k] === "object" && "type" in node[k])) {
      node.type = "COMPONENT";
    }
    for (const v of Object.values(node)) addMissingDiscriminators(v);
  } else if (Array.isArray(node)) {
    for (const v of node) addMissingDiscriminators(v);
  }
  return node;
}

/** {STEP entity number: [SimScale face names]} for an imported geometry. */
export async function stepIdToNames(a: Api, geometryId: string): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>();
  for (let page = 1; ; page += 1) {
    const resp = await a.get(`geometries/${geometryId}/mappings?_class=face&limit=100&page=${page}`);
    if (!resp.ok) throw new Error(`could not read the face map: ${resp.status}`);
    const batch = ((await resp.json())._embedded ?? []) as any[];
    for (const entry of batch) {
      const origins = entry.originateFrom ?? entry.originate_from ?? [];
      const stepId = Number(origins[0]?.entity ?? 0);
      if (!origins.length || !Number.isFinite(stepId)) continue;
      out.set(stepId, [...(out.get(stepId) ?? []), entry.name]);
    }
    if (batch.length < 100) break;
  }
  return out;
}

export async function regionNames(a: Api, geometryId: string): Promise<string[]> {
  const resp = await a.get(`geometries/${geometryId}/mappings?_class=region&limit=100&page=1`);
  if (!resp.ok) return [];
  return (((await resp.json())._embedded ?? []) as any[]).map((e) => String(e.name ?? ""));
}

/**
 * Every face reference in the spec, rewritten into SimScale face names
 * (spec_mode.resolve_spec). Browser index -> STEP entity number via
 * faces.json -> the names SimScale gave it. A face SimScale's importer
 * dropped is skipped; a boundary condition left with no faces is fatal.
 */
export function resolveSpec(
  spec: any, facesJson: any, map: Map<number, string[]>, regions: string[],
): any {
  const faces: any[] = facesJson?.faces ?? [];
  const missingIds: number[] = [];
  const dropped: number[] = [];
  const emptied: string[] = [];

  const namesFor = (index: number): string[] => {
    if (!(index >= 0 && index < faces.length)) { missingIds.push(index); return []; }
    const stepId = faces[index]?.step_id;
    if (stepId == null) { missingIds.push(index); return []; }
    const found = map.get(Number(stepId));
    if (!found?.length) { dropped.push(index); return []; }
    return found;
  };

  const walk = (node: any) => {
    if (node && typeof node === "object" && !Array.isArray(node)) {
      const ref = node.topologicalReference;
      if (ref && typeof ref === "object" && Array.isArray(ref.faces)) {
        const names: string[] = [];
        for (const i of ref.faces) names.push(...namesFor(Number(i)));
        if (ref.faces.length && !names.length) {
          emptied.push(String(node.name ?? node.type ?? "a boundary condition"));
        }
        // Exactly SimScale's two keys: its parser refuses unknown ones.
        node.topologicalReference = { entities: [...new Set(names)].sort(), sets: ref.sets ?? [] };
      }
      for (const v of Object.values(node)) walk(v);
    } else if (Array.isArray(node)) {
      for (const v of node) walk(v);
    }
  };

  walk(spec);
  addMissingDiscriminators(spec);
  for (const fluid of spec?.materials?.fluids ?? []) {
    fluid.topologicalReference ??= {};
    if (!fluid.topologicalReference.entities?.length) fluid.topologicalReference.entities = [...regions];
  }

  if (missingIds.length) {
    throw new SpecError("These faces have no STEP entity id, so they cannot be sent to the solver: "
      + [...new Set(missingIds)].sort((x, y) => x - y).slice(0, 10).join(", ") + ". Re-upload the geometry.");
  }
  if (emptied.length) {
    throw new SpecError(`Nothing is left assigned to ${[...new Set(emptied)].sort().slice(0, 3).join(", ")}: `
      + "every face it used was removed by the solver's geometry import. "
      + "Open that panel and assign the faces again.");
  }
  if (dropped.length) console.warn(`${dropped.length} face(s) were dropped by SimScale's import`);
  return spec;
}

/** Why SimScale refused a geometry, as a sentence (geometry_import_error). */
export function geometryImportError(body: any): string {
  const reason = body?.failureReason ?? body?.failure_reason ?? {};
  const code = String(reason?.code ?? "").trim();
  const faults: any[] = Array.isArray(reason?.details?.faults) ? reason.details.faults : [];
  const counts = new Map<string, number>();
  for (const f of faults) counts.set(String(f?.code ?? "fault"), (counts.get(String(f?.code ?? "fault")) ?? 0) + 1);
  const parts: string[] = [];
  if (code) parts.push(code.replaceAll("-", " "));
  if (counts.size) {
    parts.push([...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([c, n]) => `${n} x ${c.replaceAll("-", " ")}`).join(", "));
  }
  const pos = faults.find((f) => f?.position)?.position;
  if (pos) {
    const g = (v: unknown) => Number(Number(v ?? 0).toPrecision(4));
    parts.push(`near (${g(pos.X)}, ${g(pos.Y)}, ${g(pos.Z)}) m`);
  }
  return parts.length
    ? `The solver refused this geometry: ${parts.join("; ")}.`
    : "The solver could not read this geometry. Check that it is a closed solid with no self-intersecting faces.";
}

/** The first ERROR in an operation's event log, as a sentence. */
export async function firstErrorInEventLog(a: Api, path: string): Promise<string | null> {
  try {
    const resp = await a.get(path);
    if (!resp.ok) return null;
    const data = await resp.json();
    const entries: any[] = data.entries ?? data.events ?? [];
    const pick = entries.find((e) => ["ERROR", "CRITICAL"].includes(String(e?.severity ?? "").toUpperCase()))
      ?? entries.find((e) => String(e?.message ?? "").trim());
    return pick ? String(pick.message ?? "").trim() || null : null;
  } catch {
    return null;
  }
}

/** SimScale's own setup check. Errors become a SpecError. */
export async function checkSetup(a: Api, simulationId: string): Promise<void> {
  const resp = await a.post(`simulations/${simulationId}/check`, {});
  if (!resp.ok) throw new SpecError(`The solver could not check this setup: ${(await resp.text()).slice(0, 300)}`);
  const body = await resp.json().catch(() => ({}));
  const errors = ((body.entries ?? []) as any[])
    .filter((e) => ["ERROR", "CRITICAL"].includes(String(e?.severity ?? "").toUpperCase()))
    .map((e) => e.message ?? JSON.stringify(e));
  if (errors.length) throw new SpecError(errors.slice(0, 6).join("; "));
}

/** Put the finished mesh on the simulation (spec_mode.attach_mesh). */
export async function attachMesh(a: Api, simulationId: string, meshId: string): Promise<void> {
  const got = await a.get(`simulations/${simulationId}`);
  if (!got.ok) {
    throw new SpecError("Could not read the simulation back to attach the mesh. " + readableApiError(await got.text()));
  }
  const spec = await got.json();
  spec.meshId = meshId;
  const put = await a.put(`simulations/${simulationId}`, spec);
  if (!put.ok) throw new SpecError("Could not attach the mesh to the simulation. " + readableApiError(await put.text()));
}

export const downloadUrlOf = (item: any): string | null => item?.download?.url ?? null;

// ── plots ────────────────────────────────────────────────────────────────────
// Force, moment, residual and coefficient traces are CSVs of a few KB, read
// whole here (simscale_job.export_plots). The solution field is not: that
// is streamed, never read, by RESULTS-STREAM.
const PLOT_POINTS = 250;

const num = (v: unknown): number | null => {
  const n = Number(String(v ?? "").trim().replace(/^"|"$/g, ""));
  return Number.isFinite(n) && String(v ?? "").trim() !== "" ? n : null;
};

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const split = (l: string) => l.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
  const head = split(lines[0]);
  return lines.slice(1).map((l) => Object.fromEntries(split(l).map((v, i) => [head[i], v])));
}

function downsample<T>(rows: T[], n = PLOT_POINTS): T[] {
  if (rows.length <= n) return rows;
  const step = rows.length / n;
  return Array.from({ length: n }, (_, i) => rows[Math.min(Math.floor(i * step), rows.length - 1)]);
}

/** The unit vector the wind blows along, from the first velocity inlet. */
export function flowDirection(spec: any): [number, number, number] {
  for (const bc of spec?.boundaryConditions ?? []) {
    if (bc?.type !== "VELOCITY_INLET_V3") continue;
    const v = bc?.velocity?.value?.value ?? {};
    const c = ["x", "y", "z"].map((ax) => Number(v?.[ax]?.value ?? 0));
    if (c.some((x) => !Number.isFinite(x))) continue;
    const mag = Math.hypot(...c);
    if (mag > 1e-9) return [c[0] / mag, c[1] / mag, c[2] / mag];
  }
  return [-1, 0, 0];
}

/** 2 for a half model against a symmetry plane, else 1. */
export function symmetryFactor(spec: any): number {
  for (const bc of spec?.boundaryConditions ?? []) {
    if (bc?.type !== "SYMMETRY") continue;
    const ref = bc.topologicalReference ?? {};
    if (ref.faces?.length || ref.entities?.length || ref.sets?.length) return 2;
  }
  return 1;
}

const DOUBLES: Record<string, string[]> = { forces: ["drag", "lift"], moments: ["pitch"] };
const CANCELS: Record<string, string[]> = { forces: ["side"], moments: ["roll", "yaw"] };

/** The whole car's forces from the half that was solved. */
export function wholeCar(plots: any, factor: number): any {
  if (!plots || factor === 1) return plots;
  const scale = (xs: (number | null)[]) => xs.map((v) => (v == null ? null : v * factor));
  for (const [group, keys] of Object.entries(DOUBLES)) {
    const block = plots[group] ?? {};
    for (const k of keys) if (block[k]?.length) block[k] = scale(block[k]);
    for (const part of Object.values(block.split ?? {}) as any[]) {
      for (const k of keys) if (part[k]?.length) part[k] = scale(part[k]);
    }
  }
  for (const [group, keys] of Object.entries(CANCELS)) {
    const block = plots[group] ?? {};
    for (const k of keys) if (block[k]?.length) block[k] = block[k].map(() => 0);
  }
  plots.whole_car = { factor, cancels: Object.values(CANCELS).flat().sort() };
  return plots;
}

/** The last number in each trace: the answer a team wants. */
export function summarise(plots: any): Record<string, number> {
  const last = (xs: unknown[] | undefined) => {
    for (const v of [...(xs ?? [])].reverse()) if (typeof v === "number") return v;
    return null;
  };
  const out: Record<string, number> = {};
  for (const [group, keys] of [["forces", ["drag", "lift", "side"]], ["moments", ["roll", "pitch", "yaw"]],
    ["coefficients", ["cd", "cl", "cm"]]] as const) {
    for (const k of keys) {
      const v = last(plots?.[group]?.[k]);
      if (v != null) out[k] = v;
    }
  }
  return out;
}

/** Residuals, forces, moments and coefficients from a run's result list. */
export async function exportPlots(a: Api, items: any[], flowDir: [number, number, number]): Promise<any> {
  const out: any = {};
  const rowsOf = async (item: any) => {
    const u = downloadUrlOf(item);
    if (!u) return [];
    const resp = await a.raw("GET", u);
    return resp.ok ? downsample(parseCsv(await resp.text())) : [];
  };
  const series = (rows: Record<string, string>[], col: string) => rows.map((r) => num(r[col]));
  const add = (acc: (number | null)[], xs: (number | null)[]) =>
    acc.length ? acc.map((a0, i) => (a0 ?? 0) + (xs[i] ?? 0)) : [...xs];

  const res = items.find((i) => i.category === "RESIDUALS_PLOT");
  if (res) {
    const rows = await rowsOf(res);
    if (rows.length) {
      const cols = Object.keys(rows[0]).filter((c) => c && !c.toLowerCase().startsWith("time"));
      const it = Object.keys(rows[0])[0];
      out.residuals = {
        iterations: series(rows, it),
        series: Object.fromEntries(cols.map((c) => [c, series(rows, c)])),
      };
    }
  }

  const [ux, uy] = flowDir;
  const [sx, sy] = [-uy, ux];
  let drag: (number | null)[] = [];
  let lift: (number | null)[] = [];
  let side: (number | null)[] = [];
  let iters: (number | null)[] = [];
  const split: Record<string, any> = {};
  for (const item of items.filter((i) => i.category === "FORCE_PLOT")) {
    const rows = await rowsOf(item);
    if (!rows.length) continue;
    const head = Object.keys(rows[0]);
    const col = (ax: string) => head.find((c) => c && c.toUpperCase().startsWith("TOTAL_FORCE_" + ax));
    const [cx, cy, cz] = [col("X"), col("Y"), col("Z")];
    if (!cx || !cz) continue;
    iters = series(rows, head[0]);
    const fx = series(rows, cx);
    const fy = cy ? series(rows, cy) : fx.map(() => 0);
    const xs = fx.map((a0, i) => (a0 == null ? null : a0 * ux + (fy[i] ?? 0) * uy));
    drag = add(drag, xs);
    lift = add(lift, series(rows, cz));
    side = add(side, fx.map((a0, i) => (a0 == null ? null : a0 * sx + (fy[i] ?? 0) * sy)));
    const what = String(item.quantity ?? item.name ?? "").toLowerCase();
    const key = what.includes("pressure") ? "pressure"
      : (what.includes("viscous") || what.includes("friction")) ? "viscous" : null;
    if (key) split[key] = { drag: xs, lift: series(rows, cz) };
  }
  if (iters.length) {
    out.forces = { iterations: iters, drag, lift };
    if (side.length) out.forces.side = side;
    if (Object.keys(split).length) out.forces.split = split;
  }

  let roll: (number | null)[] = [];
  let pitch: (number | null)[] = [];
  let yaw: (number | null)[] = [];
  let mIters: (number | null)[] = [];
  for (const item of items.filter((i) => i.category === "MOMENT_PLOT")) {
    const rows = await rowsOf(item);
    if (!rows.length) continue;
    const head = Object.keys(rows[0]);
    const col = (ax: string) => head.find((c) => c && c.toUpperCase().startsWith("TOTAL_MOMENT_" + ax));
    if (!col("X") && !col("Y") && !col("Z")) continue;
    mIters = series(rows, head[0]);
    if (col("X")) roll = add(roll, series(rows, col("X")!));
    if (col("Y")) pitch = add(pitch, series(rows, col("Y")!));
    if (col("Z")) yaw = add(yaw, series(rows, col("Z")!));
  }
  if (mIters.length && (roll.length || pitch.length || yaw.length)) {
    out.moments = { iterations: mIters, roll, pitch, yaw };
  }

  for (const item of items.filter((i) => ["FORCE_COEFFICIENTS_PLOT", "COEFFICIENTS_PLOT"].includes(i.category)
    || String(i.name ?? "").toLowerCase().includes("coeff"))) {
    const rows = await rowsOf(item);
    if (!rows.length) continue;
    const head = Object.keys(rows[0]);
    const pick = (...starts: string[]) => head.find((c) => c && starts.some((t) => c.toUpperCase().startsWith(t)));
    const got: any = {};
    const cd = pick("TOTAL_DRAG_COEFF", "DRAG_COEFF", "CD");
    const cl = pick("TOTAL_LIFT_COEFF", "LIFT_COEFF", "CL");
    const cm = pick("TOTAL_MOMENT_COEFF", "PITCHING_MOMENT_COEFF", "CM");
    if (cd) got.cd = series(rows, cd);
    if (cl) got.cl = series(rows, cl);
    if (cm) got.cm = series(rows, cm);
    if (Object.keys(got).length) {
      got.iterations = series(rows, head[0]);
      out.coefficients = got;
      break;
    }
  }
  return Object.keys(out).length ? out : null;
}
