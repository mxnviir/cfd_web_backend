// Reading a geometry document, shared by the dashboard and the Workbench.

/**
 * The version the viewer should be drawing, as the geometry service wrote it.
 *
 * Snake case on purpose. src/lib/backend.js converts top level keys and
 * deliberately leaves nested maps alone, because the shape inside one belongs
 * to whoever wrote it. `versions` is written by processGeometry and is one of
 * those, so `glb_path` stays `glb_path` here. Reading `glbPath` gets
 * undefined and the viewport stays empty with nothing in the console, which
 * is exactly what happened the first time.
 */
/**
 * The version that is the car, not a tunnel built around it.
 *
 * Once a wind tunnel exists it becomes the current version, because that is
 * what a run has to be queued against. Everything that wants the car itself -
 * the measured shadow of it, the STEP to build the next tunnel from - has to
 * ask for this instead, and two things were asking for the current one.
 *
 * The setup panel showed a reference area of "-", because a flow domain
 * carries one shadow and not the pair a half tunnel needs. And rebuilding the
 * tunnel would have built one around the previous tunnel: a box around a box,
 * with the car sealed somewhere inside it.
 */
export function rawVersion(geometry) {
  const versions = geometry?.versions ?? {};
  const raw = Object.entries(versions)
    .map(([n, v]) => [Number(n), v])
    .filter(([n, v]) => Number.isFinite(n) && v && v.kind !== "flow_domain")
    .sort((a, b) => b[0] - a[0])[0];
  return raw ? { number: raw[0], version: raw[1] } : null;
}

export function currentVersion(geometry) {
  if (!geometry) return null;
  return geometry.versions?.[geometry.currentVersion]
    ?? geometry.versions?.[String(geometry.currentVersion)]
    ?? null;
}
