// A stand-in for the SimScale API, for development environments.
//
// Point SIMSCALE_API_BASE at <functions url>/simscale-mock/v0 and the
// pipeline runs end to end without a SimScale account: the STEP upload, the
// geometry import, the face map, the simulation, the mesh, the check, the
// run, the results. Each operation reports progress from how long ago it
// started (MOCK_STAGE_SECONDS, default 45), so POLL has something to watch
// and a run takes a few minutes. Never deploy this to production.
//
// The face map is real: the STEP upload is read for its ADVANCED_FACE
// entity numbers, and every one is mapped to a SimScale-style name, so
// resolveSpec meets the same shapes it would against SimScale.
//
// A run whose name contains "[fail-run]" fails while solving.
import postgres from "postgres";
import { CASE_ZIP_B64 } from "./case.ts";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL") ?? "", { prepare: false, max: 2, onnotice: () => {} });
const STAGE_S = Number(Deno.env.get("MOCK_STAGE_SECONDS") ?? 45);
const ITERATIONS = 100;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function put(kind: string, data: Record<string, unknown> = {}, started = false) {
  const id = `${kind}-${crypto.randomUUID().slice(0, 12)}`;
  await sql`insert into dev_mock.objects (id, kind, data, started_at)
            values (${id}, ${kind}, ${sql.json(data as never)}, ${started ? new Date() : null})`;
  return id;
}
async function get(id: string) {
  const [row] = await sql`select * from dev_mock.objects where id = ${id}`;
  return row;
}

/** RUNNING with progress, or FINISHED, from how long ago it started. */
function progressOf(row: any, failed = false) {
  if (!row) return { status: "FAILED", progress: 0 };
  if (row.cancelled) return { status: "CANCELED", progress: 0 };
  if (!row.started_at) return { status: "READY", progress: 0 };
  const p = Math.min(1, (Date.now() - new Date(row.started_at).getTime()) / (STAGE_S * 1000));
  if (failed && p > 0.5) return { status: "FAILED", progress: 0.5 };
  return { status: p >= 1 ? "FINISHED" : "RUNNING", progress: Number(p.toFixed(2)) };
}

function csv(head: string[], row: (i: number) => number[]) {
  const lines = [head.join(",")];
  for (let i = 1; i <= ITERATIONS; i++) lines.push([i, ...row(i)].join(","));
  return lines.join("\n");
}
const decay = (i: number, end: number) => end * (1 + 2 * Math.exp(-i / 15));

const FILES: Record<string, () => Response> = {
  "forces-pressure.csv": () => new Response(csv(
    ["Iteration", "TOTAL_FORCE_X", "TOTAL_FORCE_Y", "TOTAL_FORCE_Z"], (i) => [-decay(i, 0.21), 0.001, decay(i, -0.03)])),
  "forces-viscous.csv": () => new Response(csv(
    ["Iteration", "TOTAL_FORCE_X", "TOTAL_FORCE_Y", "TOTAL_FORCE_Z"], (i) => [-decay(i, 0.04), 0, decay(i, -0.002)])),
  "moments.csv": () => new Response(csv(
    ["Iteration", "TOTAL_MOMENT_X", "TOTAL_MOMENT_Y", "TOTAL_MOMENT_Z"], (i) => [0.0001, decay(i, 0.004), 0])),
  "residuals.csv": () => new Response(csv(
    ["Iteration", "Ux", "Uy", "Uz", "p"], (i) => [1e-1 * Math.exp(-i / 20), 1e-1 * Math.exp(-i / 22), 1e-1 * Math.exp(-i / 25), Math.exp(-i / 18)])),
  "solution.zip": () => new Response(Uint8Array.from(atob(CASE_ZIP_B64), (c) => c.charCodeAt(0)),
    { headers: { "Content-Type": "application/zip" } }),
};

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*\/simscale-mock\/v0/, "");
  const base = `${Deno.env.get("SUPABASE_URL")}/functions/v1/simscale-mock/v0`;
  await sql`insert into dev_mock.calls (method, path) values (${req.method}, ${path})`;
  const m = (re: RegExp) => path.match(re);
  let r: RegExpMatchArray | null;

  if (req.method === "POST" && path === "/storage") {
    const id = await put("storage");
    return json({ storageId: id, url: `${base}/upload/${id}` });
  }
  if (req.method === "PUT" && (r = m(/^\/upload\/([\w-]+)$/))) {
    const text = await req.text();
    const faces = [...text.matchAll(/#(\d+)\s*=\s*ADVANCED_FACE/g)].map((x) => Number(x[1]));
    await sql`update dev_mock.objects set data = ${sql.json({ faces, bytes: text.length } as never)} where id = ${r[1]}`;
    return new Response(null, { status: 200 });
  }
  if (req.method === "GET" && (r = m(/^\/files\/([\w.-]+)$/)) && FILES[r[1]]) return FILES[r[1]]();

  const p = path.replace(/^\/projects\/[^/]+/, "");
  if (req.method === "POST" && p === "/geometryimports") {
    const body = await req.json();
    return json({ geometryImportId: await put("import", { storageId: body?.location?.storageId }, true) });
  }
  if (req.method === "GET" && (r = p.match(/^\/geometryimports\/([\w-]+)$/))) {
    const row = await get(r[1]);
    const pr = progressOf(row);
    return json({ status: pr.status, geometryId: pr.status === "FINISHED" ? `geo-${r[1]}` : null });
  }
  if (req.method === "GET" && (r = p.match(/^\/geometries\/geo-([\w-]+)\/mappings$/))) {
    if (url.searchParams.get("_class") === "region") return json({ _embedded: [{ name: "region0" }] });
    const imp = await get(r[1]);
    const storage = imp ? await get(imp.data.storageId) : null;
    const faces: number[] = storage?.data?.faces ?? [];
    const limit = Number(url.searchParams.get("limit") ?? 100);
    const page = Number(url.searchParams.get("page") ?? 1);
    return json({
      _embedded: faces.slice((page - 1) * limit, page * limit)
        .map((id) => ({ name: `B1_TE${id}`, originateFrom: [{ entity: String(id) }] })),
    });
  }
  if (req.method === "POST" && p === "/simulations") {
    return json({ simulationId: await put("simulation", await req.json(), true) });
  }
  if ((r = p.match(/^\/simulations\/(simulation-[\w-]+)$/))) {
    if (req.method === "PUT") {
      await sql`update dev_mock.objects set data = ${sql.json(await req.json())} where id = ${r[1]}`;
      return json({});
    }
    return json((await get(r[1]))?.data ?? {});
  }
  if (req.method === "POST" && p.match(/^\/simulations\/[\w-]+\/check$/)) return json({ entries: [] });
  if (req.method === "POST" && p === "/meshoperations") {
    return json({ meshOperationId: await put("mesh", await req.json()) });
  }
  if ((r = p.match(/^\/meshoperations\/([\w-]+)(\/start|\/cancel|\/eventlog)?$/))) {
    if (r[2] === "/start") {
      await sql`update dev_mock.objects set started_at = now() where id = ${r[1]}`;
      return new Response(null, { status: 204 });
    }
    if (r[2] === "/cancel") {
      await sql`update dev_mock.objects set cancelled = true where id = ${r[1]}`;
      return new Response(null, { status: 204 });
    }
    if (r[2] === "/eventlog") return json({ entries: [{ severity: "INFO", message: "Meshing finished." }] });
    const pr = progressOf(await get(r[1]));
    return json({ ...pr, meshId: pr.status === "FINISHED" ? `meshid-${r[1]}` : null });
  }
  if (req.method === "GET" && p.match(/^\/meshes\/[\w-]+$/)) {
    return json({ numberOfCells: 222000, numberOfNodes: 61000, name: "Mock mesh" });
  }
  if (req.method === "POST" && (r = p.match(/^\/simulations\/([\w-]+)\/runs$/))) {
    return json({ runId: await put("run", await req.json()) });
  }
  if ((r = p.match(/^\/simulations\/[\w-]+\/runs\/([\w-]+)(\/start|\/cancel|\/eventlog|\/results)?$/))) {
    const row = await get(r[1]);
    if (r[2] === "/start") {
      await sql`update dev_mock.objects set started_at = now() where id = ${r[1]}`;
      return new Response(null, { status: 204 });
    }
    if (r[2] === "/cancel") {
      await sql`update dev_mock.objects set cancelled = true where id = ${r[1]}`;
      return new Response(null, { status: 204 });
    }
    if (r[2] === "/eventlog") return json({ entries: [{ severity: "INFO", message: "Solver finished." }] });
    if (r[2] === "/results") {
      const file = (name: string) => ({ url: `${base}/files/${name}`, format: name.split(".").pop() });
      return json({
        _embedded: [
          { type: "PLOT", category: "FORCE_PLOT", name: "Forces", quantity: "PRESSURE_FORCE", download: file("forces-pressure.csv") },
          { type: "PLOT", category: "FORCE_PLOT", name: "Forces", quantity: "VISCOUS_FORCE", download: file("forces-viscous.csv") },
          { type: "PLOT", category: "MOMENT_PLOT", name: "Moments", download: file("moments.csv") },
          { type: "PLOT", category: "RESIDUALS_PLOT", name: "Residuals", download: file("residuals.csv") },
          { type: "SOLUTION_FIELD", category: "SOLUTION", name: "Solution", download: file("solution.zip") },
        ],
      });
    }
    return json(progressOf(row, String(row?.data?.name ?? "").includes("[fail-run]")));
  }
  return json({ code: "not-found", message: `The mock does not know ${req.method} ${path}` }, 404);
});
