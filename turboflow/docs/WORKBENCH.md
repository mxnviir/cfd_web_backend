# How the Workbench works

Written by reading the code, not the older docs, which disagree with it in
places. Line numbers are against the files as they stand today.

The one-sentence version: the Workbench is a CAD-style front end over four
Firestore collections, and it cannot yet start a run from a car. It can only
start one from a wind-tunnel flow region that the Fusion 360 add-in has already
built.

## Files and what each owns

| File | Lines | Owns |
|---|---|---|
| `public/workbench.html` | 2756 | Markup, all styles, the three.js viewer, and the whole application script |
| `public/cfd-setup.js` | 328 | `CFD.DEFAULTS`, `withDefaults`, `derive`, `coefficients`, `convergence`, `forceSteadiness`, pricing |
| `public/workbench-panels.js` | 698 | `WBPanels.tree(ctx)` and `WBPanels.inspector(nodeId, ctx)`: the setup tree and all 18 panels |
| `public/workbench-results.js` | 314 | `WBResults.readout / convergencePane / forcePane / comparePane` |
| `public/wb-viewcube.js` | 236 | The orientation gizmo, an ES module imported at `workbench.html:810` |
| `public/workbench-adapter.js` | ~380 | `window.sb`, a Supabase-shaped facade over Firestore, Storage, Auth and the callables |

The panels are **pure functions that return HTML strings**. They cannot close
over state, so every control in them calls one of two globals, `wbSet` or
`wbAction` (`workbench.html:1384-1430`). That is why the panel files have no
imports from the host page and can be tested on plain objects.

## State and the render loop

`state` (`workbench.html:1341-1359`) holds `projects, sims, geoms, jobs`, the
selection (`selSim`, `selJob`, `selNode`, `tab`, `compare`), viewer state
(`fields`, `fieldValues`, `pins`, `inspecting`), the `account` row, and the edit
`draft` with `draftSim`.

`refresh()` (`1515-1549`) loads all four collections plus the user row in one
`Promise.all`. The adapter scopes each query to the signed-in user, because the
Firestore rules only permit a list that is provably restricted to the caller.
It then auto-selects the most recent simulation that has a result, so the
viewport is never empty on arrival.

`live()` (`1558+`) subscribes once per collection and calls `refresh()` on any
change. Subscribing is guarded because auth state fires on every hourly token
refresh, and an unguarded subscribe stacks a new listener each time.

Edits are held in `state.draft` and written only on Save. A half-typed velocity
never reaches the database, and Discard throws the edits away.

`panelCtx()` (`1367-1381`) assembles what every panel reads: the simulation, its
geometry, the merged setup, `CFD.derive(...)`, and that simulation's runs.

## Starting a run

`autoCfd()` (`2586-2700`):

1. Asks for a **STEP file**, which must already be a flow region: a box with the
   car subtracted from it.
2. Asks for **`entity_labels.csv`**, which names which face is the inlet, the
   outlet, the ground, and each wheel. Declining offers to derive one from
   `TESSELLATE_URL + "/infer_labels"`.
3. Uploads to `users/{uid}/geometries/{geomId}/geometry.step` and
   `.../entity_labels.csv`. The uid in the path is the ownership check.
4. Inserts `projects`, `geometries`, `simulations`, then a `jobs` row with
   `status: "pending"`. That status is what charges credits and dispatches the
   worker, so nothing before it costs anything.
5. Calls `tessellate(geomId, stepPath)` for the 3D preview, best effort.

`runSim(id)` (`2545-2563`) is the same without the upload: another `jobs` row
against the existing geometry, carrying `setup_snapshot: setupOf(s)` so a later
setup edit cannot relabel an old result.

## The setup document

`CFD.DEFAULTS` (`cfd-setup.js:90-145`) mirrors the worker's `build_model()`:
`analysis`, `material`, `turbulence`, `domain`, `bcs`, `numerics`, `control`,
`mesh`, `results`, `reference`. Anything the worker leaves to the SimScale SDK
default is marked as such rather than given an invented number.

`derive()` (`174-265`) computes Reynolds and the flow regime, Mach and whether
the incompressible assumption holds, the reference area and dynamic pressure,
the inlet `k`, `omega` and `epsilon`, the `y+` first-cell height from the
flat-plate correlation, the wind-tunnel extents from `domain` **in car lengths**,
the blockage ratio, the mesh fineness, and the credit price.

Four values live as **columns on the simulation row**, not in the setup blob:
`inlet_velocity`, `refine_level`, `iteration_count`, `debug_mesh`. Those four
are the only ones the worker reads.

## The viewer

`desiredModel()` (`1875-1882`) chooses `job.results_glb_path` when the selected
run has results, otherwise `geometry.glb_path`, so the viewport shows the raw
geometry while a run is still going.

`showModel()` (`1884-1916`) is a reconciler rather than an action. A single loop
re-reads the current selection each time round and stops when what is drawn
matches what is selected. That is deliberate: `render()` runs many times in the
first few hundred milliseconds, and any scheme that cancels overlapping calls
ends up cancelling the last one too, leaving an empty viewport with nothing
logged.

`loadField()` (`1918-1940`) fetches a field `.bin`, reads it as a
`Float32Array` of one value per vertex, and hands it to
`window.applyField(values, min, max)`. The ribbon adds a cut plane, a legend,
statistics, wireframe, and click-to-pin point inspection. Pins are cleared when
the field changes, because a pin records the value of the field it was taken
with and leaving it up would relabel a pressure reading as a velocity.

## What the worker produces for the viewer

From `services/simscale-job/simscale_job.py`:

- `{prefix}/results.glb`: geometry only, decimated to `MAX_VIEWER_TRIANGLES`
  (default 300000), exported with `process=False` so the vertex order still
  matches the field binaries.
- `{prefix}/fields/{name}.bin`: raw float32, native endianness, no header,
  exactly `vertexCount * 4` bytes. **Per-vertex only**, and vectors are
  collapsed to magnitude, so the components of `U` are not recoverable.
- `{prefix}/fields.json`:
  `{jobId, vertexCount, triangleCount, glb, fields:{name:{label,path,min,max}}}`.
- On the job document: `results_glb_path`, `results_fields`, `plots`, `drag_n`,
  `lift_n`, `paraview_url`, `run_id`, `mesh_id`, `simulation_id`.

`prefix` is the **parent directory of the STEP**, so a second run against the
same geometry overwrites the first run's results while both job rows still point
at them.

## Starting a run from a raw car

The Workbench no longer needs the Fusion add-in. `startPrepare()` uploads the
car itself to `raw.step`, calls the geometry service's `/inspect`, and puts the
car on screen inside a draggable wind tunnel. Nothing is charged until the job
row goes in at the end, so a tunnel that comes out wrong costs nothing.

`/inspect` tessellates the car one B-rep face at a time and keeps each face's
triangles together, so a triangle index in the glTF resolves back to a STEP
face. It also emits a per-vertex `_FACEID`, which is what the viewer has always
looked for and never been given. Every face comes back with its surface type,
area and centre, and a cylinder brings its radius and axis too. That is what
turns a click into a wheel without asking anyone to measure one.

Wheels can be found two ways, as SimScale and the add-in respectively do it:

- **Detected.** `detectWheels()` in the page runs the add-in's rule, cylinders
  about Y within 8% of a stated radius, grouped by proximity. It runs on the
  face list already in the browser, so changing the radius re-detects instantly.
- **Picked.** Click faces on the car. The wheel's radius and centre are
  recomputed from whatever faces it now holds. Picked wheels replace detection
  entirely rather than adding to it, because detection is wrong on a car whose
  wheels are trimmed surfaces or whose body has a cylinder of its own.

The tunnel walls drag. `alongAxis()` projects the pointer onto a plane through
the wall's axis, fixed when the wall is grabbed. Taking the nearest point on the
axis line instead is the obvious reading of an axis-constrained drag and it is
wrong: the wall runs out, turns around and comes back while the pointer keeps
going. The floor does not drag, because it is pinned 30 mm under the lowest
wheel and moving it would put the road through them. The +y wall does not drag
while symmetry is on, because it is the symmetry plane.

`/prepare` then builds the flow region and the labels CSV, and the counts are
shown before anything is charged. `geometries.prepared_by` records which route
built it, set at create and absent from the update list so it cannot be
rewritten later.

## Faults

Real, found by reading. Several explain behaviour that currently looks
intentional. Numbers 1, 2, 3, 5 and 7 have since been fixed; they are kept
because each explains something that still looks deliberate in the git history.

1. **`/infer_labels` does not exist.** `services/tessellate/main.py` exposes
   `/health`, `/tessellate` and `/transform`, nothing else. The "Try anyway"
   path in `autoCfd()` calls an endpoint that returns 404. Automatic labelling
   has never worked, for a different reason than the older docs record.
2. **Every `/tessellate` call would be refused.** The service gates paths to
   `jobs/{uid}/` (`main.py:146, 221`), but the Workbench writes to
   `users/{uid}/geometries/{gid}/`. The result is 403.
3. **The service is still Supabase-only**: `SUPABASE_URL`,
   `SUPABASE_SERVICE_ROLE_KEY`, and auth by `GET /auth/v1/user`.
4. **The domain panel does nothing.** `setup.domain` feeds only the blockage
   readout. The worker never reads `setup`, and the flow region is already baked
   into the uploaded STEP. Changing upstream or downstream changes a number on
   screen and nothing else.
5. **Face picking cannot work.** `/tessellate` exports STL and reloads it through
   trimesh, which discards per-face grouping, so `face_groups` is never returned
   and the check at `workbench.html:2186` is always falsy.
6. **The wrong iteration is displayed.** The worker picks a VTK entry from the
   result package **by file size** (`simscale_job.py:801`), not by time index.
   The writes are near-identical in size, so it lands on whichever the archive
   orders first, usually an early one rather than the converged final write.
7. **Wheel radius is not settable anywhere.** It arrives only in
   `entity_labels.csv`. `omega = U / r` is computed in the worker
   (`simscale_job.py:308`), and the rotation axis is hardcoded to global +Y.
8. **A malformed wheel row silently loses its boundary condition.** On a bad
   `radius_m` the label falls back to bare `rotating_wall`, which `build_model`
   never looks up, so those faces get no boundary condition at all rather than
   being demoted to a plain wall.

### Since fixed

1, 2, 3: the service was ported to Firebase, the path guard moved to
`users/{uid}/`, and `/infer_labels` was replaced by `/inspect` and `/prepare`.

5: face picking works. `/inspect` emits per-face triangle ranges and a
per-vertex `_FACEID`; the old `to_glb` went through STL, which welds everything
into one anonymous mesh.

7: wheel radius is set per wheel in the prepare panel, and `omega = U / r` is
shown live against the wind speed.

8: `/prepare` refuses a wheel whose radius is unusable rather than writing a row
that loses its boundary condition further down.

Two faults found while testing rather than reading:

- **The boolean cut could silently do nothing.** OCC's fuse does not raise on an
  invalid body: on one real car it returned two of ten bodies and the cut
  removed nothing, giving a bare box that passed every label check. The cut is
  done one body at a time now, and a result that removed less than 5% of the
  car's own volume is refused.
- **The storage bucket had no CORS rules**, so no model could ever load in the
  browser. The download returns 200 with no `Access-Control-Allow-Origin` and
  the fetch is blocked before any application code runs, which is why nothing
  was ever logged. See `storage-cors.json` and SETUP.md step 6b.

Still open:

6: the worker still picks the VTK entry by file size rather than time index, so
the iteration on screen is usually an early write, not the converged one.
