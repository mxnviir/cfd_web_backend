# TurboFlow Cloud Workbench: build spec for a SimScale-identical Workbench

Written 10 September 2026 for the agent that will build the Workbench. It is meant to be
followed without thinking. Every screen, panel, button, field, default value, mouse action and
backend call is written down. Where a value could not be confirmed against the live SimScale
UI it is marked **[verify]** and the builder must confirm it against a screenshot before
shipping, not guess.

Sources used, in order of authority:

1. The SimScale REST API, read live with the account API key (OpenAPI 3.0.3, 75 endpoints,
   2102 schemas). Every JSON shape, enum and default in Part B comes from there.
2. A real simulation spec created through the SimScale Workbench on 14 Aug 2026 in project
   `fggdrh` (`6603370901628841967`). This is what a fresh "Incompressible" simulation looks like
   when the Workbench creates it, so it is the source of every default in Part A section 9.
3. SimScale's documentation (docs.simscale.com: platform, dashboard, simulation setup, meshing,
   boundary conditions, numerics, simulation control, result control, CAD Edit, post-processor,
   collaboration) and knowledge base (selection tips, mesh clip, convergence, custom camera,
   vectors, continue run, core hours).
4. The existing TurboFlow code in this repo (`public/workbench.html`, `services/tessellate`,
   `services/simscale-job`, `functions/src`, `firestore.rules`, `storage.rules`). The new
   Workbench replaces `public/workbench.html` but keeps the backend contracts described in
   Part B unless this document says otherwise.
5. Screenshots Shashank took of the live SimScale UI on 10 Sep 2026: the dashboard, the
   Workbench with a Static simulation open, and the Create Simulation dialog. Sections 4, 5
   and 9.1 were rewritten from them.
6. Working memory of the live SimScale Workbench 2.0 UI. Items that come only from here are
   marked **[verify]**.

Naming: the product is **TurboFlow Cloud**. The test site is `https://turboflow-test.web.app/`.
The Firebase project behind it is `turboflow-test`; production is `turboflow-7b3ca`. Code and
collection names in the repo still say "turboflow" and must keep doing so; only user-facing
text says TurboFlow.

The document has two parts. **Part A** is the front end (sections 1 to 12). **Part B** is the
backend on Firebase (sections 13 to 16), with a build prompt for every feature.

## 0.1 How the whole thing works, in one page

**In plain words.** A student draws a car in any CAD program and saves it as a STEP, IGES
or STL file. They open TurboFlow, make a project, and drop the file in. TurboFlow shows the
car in 3D in the browser. They click faces to say "this is the inlet", "this is the road",
"these are the wheels", pick the air speed, and choose how fine the mesh should be, in
panels that look and behave exactly like SimScale's. Nothing has gone to SimScale yet and
nothing has been charged. When they press **Queue**, TurboFlow takes credits, packs the car
and every setting they made into the exact file and JSON that SimScale expects, sends it to
SimScale under TurboFlow's own account, and lets SimScale mesh and solve it. While it runs,
the student sees the same progress they would see in SimScale. When it finishes, TurboFlow
downloads the results, converts them for the browser, and shows pressure, velocity,
streamlines and drag in the same post-processor layout SimScale has. The student never
needs a SimScale account, a SimScale key, or SimScale's website.

**Technically.** The browser holds a `spec` JSON shaped like SimScale's `SimulationSpec.model`
(section 9 and Appendix B), except that faces are identified by STEP face ids from our own
geometry service. Queue writes a `jobs` document; the worker uploads the version's STEP to
SimScale, reads SimScale's face-name mapping, rewrites every face id to its SimScale name,
creates the simulation with `POST /simulations`, runs SimScale's own `check`, creates and
starts the mesh operation from the saved mesh settings, attaches the mesh, creates and starts
the run, polls, downloads the solution and plots, and converts them into a GLB plus raw
float32 field files that the three.js viewer colours. Every SimScale option the user touched
in our panels is carried across one to one, because our panels write the same JSON keys
SimScale's panels write. That is why the panels must match SimScale field for field: the
JSON is the contract, the UI is a faithful editor for it.

**What is uploaded to SimScale.** Always a STEP file. IGES and STL uploads are converted to
STEP by the geometry service at upload time (`v{n}/geometry.step`), so face ids stay stable
between what the user clicked and what SimScale receives. CAD edits (delete body, wind
tunnel) produce a new STEP version, and a simulation is pinned to one version.

**What comes back.** The solution fields (VTU inside a ZIP64 PVD package), the force,
coefficient, surface-data and probe plots (CSV), the residual and convergence plots, and
the three event logs (import, mesh, run). All of it is stored under `results/{jobId}/` and
listed on the `runs` document. Post-processing filters that need the full volume are
computed by our own VTK service on the downloaded VTU, so the browser never needs the
whole mesh.


## 0.2 The pipeline step by step, with code

This is the same story as 0.1, told once per step with the actual data and code involved.
Read it before Part B. File paths are where the code lives in this repo.

### Step 1. The user uploads a CAD file (browser)

**Plain words.** The file goes from the student's computer straight into our storage bucket,
with a progress bar. Nothing is charged.

**Code.** The browser first asks the backend for the one path it may upload to, then uploads
with the resumable API:

```js
// src/workbench/geometry/upload.js
import { getStorage, ref, uploadBytesResumable } from "firebase/storage";
import { functions } from "../../lib/firebase";

export async function uploadGeometry(projectId, file, unit, onProgress) {
  const ext = file.name.split(".").pop().toLowerCase();          // step | stp | iges | igs | stl
  const intent = await functions.httpsCallable("createUploadIntent")({
    kind: "raw", ext, name: file.name.replace(/\.[^.]+$/, ""),
    project_id: projectId, size_bytes: file.size, input_unit: unit,
    import_options: { facet_split: ext === "stl", sewing: true, improve: true },
  });
  const { geometry_id, path } = intent.data;                      // users/{uid}/geometries/{gid}/raw.step
  const task = uploadBytesResumable(ref(getStorage(), path), file, { contentType: "application/octet-stream" });
  task.on("state_changed", (s) => onProgress(s.bytesTransferred / s.totalBytes));
  await task;
  return geometry_id;                                             // the tree row now listens to geometries/{gid}
}
```

The storage rule only allows this exact path, once, under 60 MB (`storage.rules`).

### Step 2. The file becomes a 3D model the browser can draw (geometry service)

**Plain words.** A server reads the CAD file, turns every face into triangles, remembers
which triangles belong to which face, and saves a small 3D file plus a list of faces. IGES
and STL are also saved as STEP, because STEP is what SimScale will get later.

**Code.** The Storage trigger enqueues one task; the task calls the geometry service:

```ts
// functions/src/geometry/onGeometryUploaded.ts
export const onGeometryUploaded = onObjectFinalized(
  { bucket: BUCKET, region: REGION },
  async (event) => {
    const m = event.data.name.match(/^users\/([^/]+)\/geometries\/([^/]+)\/raw\.(step|stp|iges|igs|stl)$/);
    if (!m) return;
    const [, uid, gid] = m;
    await db.collection("geometries").doc(gid).update({ status: "queued" });
    await enqueueTask("processGeometry", { uid, geometry_id: gid, version: 1 });   // Cloud Tasks, 9 min timeout
  });
```

```python
# services/tessellate/main.py  (/inspect, the part that matters)
shape = read_any(raw_path, fmt, unit)          # STEP via OCP STEPControl_Reader, IGES via IGESControl_Reader,
                                               # STL via trimesh -> faceted solid
write_step(shape, f"{prefix}/geometry.step")   # ALWAYS write STEP: this is the file SimScale receives later
faces = []
for face_id, face in enumerate_faces(shape):   # face_id = the STEP entity id, read back from the STEP text
    tris = triangulate(face, deflection)
    faces.append({"id": face_id, "solid": solid_of(face), "type": surface_type(face),
                  "area": area(face), "centre": centre(face), "normal": normal(face),
                  "radius": radius_if_cylinder(face), "axis": axis_if_cylinder(face),
                  "start": vertex_offset, "count": 3 * len(tris)})
    append_vertices(tris, face_id)             # vertices stay face-contiguous; each carries _FACEID = face_id
export_glb(f"{prefix}/model.glb", extras={"faces": faces, "adjacency": adjacency(shape)})
json.dump(faces, open(f"{prefix}/faces.json", "w"))
```

The important trick: the STEP entity id we give each face is the same number SimScale will
report for that face later (`originateFrom[0].entity` in its mappings), because both read
the same STEP file. That is the bridge between a click in our viewer and a boundary
condition in SimScale.

### Step 3. The user builds the simulation in our panels (browser + Firestore)

**Plain words.** Every panel edits one JSON document that has the same shape SimScale uses.
Faces are stored as our numbers. Saving is free.

**Code.** What a saved velocity inlet looks like in Firestore (`simulations/{id}.spec`):

```json
{
  "type": "INCOMPRESSIBLE",
  "turbulenceModel": "KOMEGASST",
  "timeDependency": { "type": "STATIONARY" },
  "materials": { "fluids": [ {
    "type": "INCOMPRESSIBLE", "name": "Air",
    "viscosityModel": { "type": "NEWTONIAN", "kinematicViscosity": { "value": 1.529e-5, "unit": "m²/s" } },
    "density": { "value": 1.196, "unit": "kg/m³" },
    "topologicalReference": { "entities": [], "sets": [] }
  } ] },
  "boundaryConditions": [
    { "type": "VELOCITY_INLET_V3", "name": "Velocity inlet 1",
      "velocity": { "type": "FIXED_VALUE", "value": { "value": {
        "x": { "type": "CONSTANT", "value": -20 }, "y": { "type": "CONSTANT", "value": 0 }, "z": { "type": "CONSTANT", "value": 0 } },
        "unit": "m/s" } },
      "topologicalReference": { "entities": [ 2234 ], "sets": [] } },
    { "type": "PRESSURE_OUTLET_V30", "name": "Pressure outlet 1",
      "gaugePressure": { "type": "FIXED_VALUE", "value": { "value": { "type": "CONSTANT", "value": 0 }, "unit": "Pa" } },
      "topologicalReference": { "entities": [ 2235 ], "sets": [] } },
    { "type": "WALL_V34", "name": "Car",
      "velocity": { "type": "NO_SLIP", "turbulenceWall": "WALL_FUNCTION" },
      "topologicalReference": { "entities": [ 2240, 2241, 2242 ], "sets": [] } }
  ],
  "simulationControl": { "endTime": { "value": 1000, "unit": "s" }, "deltaT": { "value": 1, "unit": "s" },
    "writeControl": { "type": "TIME_STEP", "writeInterval": 1000 }, "numProcessors": -1,
    "maxRunTime": { "value": 20000, "unit": "s" }, "potentialFoamInitialization": false,
    "decomposeAlgorithm": { "type": "SCOTCH" } }
}
```

`entities` holds STEP ids (2234...) at this stage. The rest of the document is exactly what
SimScale accepts, so no translation is needed for anything except the face ids.

The panel writes it through a draft (Part C, C1) and the callable validates it:

```ts
// functions/src/simulations/saveSimulation.ts (core)
export const saveSimulation = onCall(async (req) => {
  const { uid, data } = await guard(req, "saveSimulation", saveSimulationSchema);   // zod: Incompressible shape
  const sim = await loadOwned("simulations", data.simulation_id, uid);
  const faces = await readJson(`users/${uid}/geometries/${sim.geometry_id}/v${sim.geometry_version}/faces.json`);
  const validation = validateSetup(data.spec, data.mesh_spec, new Set(faces.map(f => f.id)));
  await db.collection("simulations").doc(sim.id).update({
    spec: data.spec, mesh_spec: data.mesh_spec, primitives: data.primitives ?? [],
    validation, updated_at: FieldValue.serverTimestamp(),
  });
  return validation;                                   // {ok, errors:[{node,message}], warnings:[]}
});
```

### Step 4. The user presses Queue (the only step that costs credits)

**Plain words.** A job record is written. The existing money code sees it, takes the
credits once, and starts the worker.

**Code.**

```ts
// functions/src/jobs/queueRun.ts
export const queueRun = onCall(async (req) => {
  const { uid, data } = await guard(req, "queueRun", z.object({ simulation_id: docId, name: z.string().max(200) }));
  const sim = await loadOwned("simulations", data.simulation_id, uid);
  if (!sim.validation?.ok) throw new HttpsError("failed-precondition", sim.validation.errors.map(e => e.message).join("; "));
  const geom = await loadOwned("geometries", sim.geometry_id, uid);
  const version = geom.versions[String(sim.geometry_version)];
  const inlet = sim.spec.boundaryConditions.find(b => b.type === "VELOCITY_INLET_V3");
  const runRef = db.collection("runs").doc();
  const jobRef = db.collection("jobs").doc();
  const batch = db.batch();
  batch.set(runRef, { user_id: uid, project_id: sim.project_id, simulation_id: sim.id, name: data.name,
    job_id: jobRef.id, status: "queued", stage_text: "Queued", progress: 0,
    spec_snapshot: sim.spec, mesh_snapshot: sim.mesh_spec, simscale: {}, created_at: FieldValue.serverTimestamp() });
  batch.set(jobRef, { user_id: uid, status: "pending", source: "workbench", spec_mode: true, run_ref: runRef.id,
    simulation_ref: sim.id, project_id: sim.project_id, geometry_id: geom.id,
    step_path: version.step_path,                                         // users/{uid}/geometries/{gid}/v{n}/geometry.step
    iteration_count: sim.spec.simulationControl.endTime.value,
    refine_level: levelFromFineness(sim.mesh_spec.sizing.fineness),
    inlet_velocity: inlet ? magnitude(inlet.velocity) : 20,
    debug_mesh: false, created_at: FieldValue.serverTimestamp() });
  await batch.commit();                                                   // -> onJobPending charges and dispatches
  return { run_id: runRef.id, job_id: jobRef.id };
});
```

`onJobPending` (exists, `functions/src/jobs/onJobPending.ts`) does the charge in a
transaction with the ledger, then `dispatchWorker()` starts the Cloud Run Job with
`JOB_ID`, `RUN_ID` and `SPEC_MODE=1`.

### Step 5. The worker sends everything to SimScale (Cloud Run Job)

**Plain words.** Upload the STEP, let SimScale read it, learn SimScale's names for our faces,
swap our numbers for those names, send the setup, run SimScale's check, mesh, solve.

**Code.** The new path in `services/simscale-job/simscale_job.py`:

```python
def run_spec_mode(job_id, job, run_id):
    api = build_clients()
    run = db.collection("runs").document(run_id)
    spec = job_snapshot(run, "spec_snapshot")
    mesh_spec = job_snapshot(run, "mesh_snapshot")

    stage(run, job_id, "uploading", "Uploading to solver")
    local = download_file(job["step_path"])                       # owned_path() check as today
    geometry_id = upload_geometry(api, local, f"tf-{job_id}", job_id,
                                  input_unit=job["input_unit"], options=job["import_options"])

    stage(run, job_id, "importing", "Importing geometry")
    step_to_name = fetch_step_id_map(api, geometry_id)            # {2234: "A1_I1_B10_TE12", ...} from GET .../mappings?class=face
    regions = get_region_names(api, geometry_id)                  # ["Flow region"]

    def resolve(node):
        if isinstance(node, dict):
            if "topologicalReference" in node:
                tr = node["topologicalReference"]
                ents = tr.get("entities") or []
                if ents and isinstance(ents[0], int):
                    try:
                        tr["entities"] = [step_to_name[e] for e in ents]
                    except KeyError as e:
                        raise RuntimeError(f"Face {e.args[0]} is not in the imported geometry")
            return {k: resolve(v) for k, v in node.items()}
        if isinstance(node, list):
            return [resolve(v) for v in node]
        return node

    spec = resolve(spec); mesh_spec = resolve(mesh_spec)
    for fluid in spec["materials"]["fluids"]:
        if not fluid["topologicalReference"]["entities"]:
            fluid["topologicalReference"]["entities"] = regions      # one region: assign it automatically

    stage(run, job_id, "checking", "Checking setup")
    sim_id = post_json(f"/projects/{P}/simulations",
                       {"name": f"tf-{job_id}", "geometryId": geometry_id, "model": spec, "version": "34.0"})["simulationId"]
    check = post_json(f"/projects/{P}/simulations/{sim_id}/check", {})
    if check.get("errors"):
        raise RuntimeError("SimScale rejected the setup: " + "; ".join(e["message"] for e in check["errors"]))
        # no mesh_id yet -> onJobPending reverses the charge

    stage(run, job_id, "meshing", "Meshing")
    mesh_id = create_mesh_from_spec(api, sim_id, geometry_id, mesh_spec, job_id, run)   # polls, writes "Meshing 43%"
    attach_mesh(api, sim_id, mesh_id)

    stage(run, job_id, "running", "Running")
    run_sid = start_run(api, sim_id, job_id, run)                 # polls, writes "Running 12%", cancels on 'cancelling'

    stage(run, job_id, "downloading", "Downloading results")
    export_results(api, sim_id, run_sid, job_id, run)             # step 6
    stage(run, job_id, "finished", "Finished")
```

The three SimScale calls that do the actual sending, written plainly:

```python
def upload_geometry(api, path, name, job_id, input_unit="m", options=None):
    storage = api["storage"].create_storage()                     # POST /storage -> url + storageId
    with open(path, "rb") as f:
        api["client"].rest_client.PUT(url=storage.url, headers={"Content-Type": "application/octet-stream"}, body=f.read())
    imp = api["geo_imp"].import_geometry(P, GeometryImportRequest(
        name=name, location=GeometryImportRequestLocation(storage_id=storage.storage_id),
        format="STEP", input_unit=input_unit,
        options=GeometryImportRequestOptions(facet_split=options["facet_split"], sewing=options["sewing"],
                                             improve=options["improve"], optimize_for_lbm_solver=False)))
    return wait_for(lambda: api["geo_imp"].get_geometry_import(P, imp.geometry_import_id), job_id).geometry_id

def fetch_step_id_map(api, geometry_id):
    out, page = {}, 1
    while True:
        res = api["geometry"].get_geometry_mappings(P, geometry_id, _class="face", limit=100, page=page)
        for e in res.embedded or []:
            d = e.to_dict(); orig = d.get("originate_from") or []
            if orig: out[int(orig[0]["entity"])] = d["name"]
        if len(res.embedded or []) < 100: return out
        page += 1
```

### Step 6. Results come back and are converted for the browser (worker)

**Plain words.** SimScale gives us a zip of the whole 3D result. We keep it for the
post-processing service, and make a small surface model plus one number per point for
each field, which the browser colours instantly.

**Code.**

```python
def export_results(api, sim_id, run_sid, job_id, run):
    results = api["runs"].get_simulation_run_results(P, sim_id, run_sid, _type="SOLUTION_FIELD")
    sol = next(r for r in results.embedded if r.category in ("STATISTICAL_SURFACE_SOLUTION", "TRANSIENT_SOLUTION"))
    zip_path = download_url(sol.download.url, f"/tmp/{job_id}/solution.zip")
    upload_blob(zip_path, f"results/{job_id}/raw/solution.zip")             # for the postprocess service
    unzip(zip_path, f"/tmp/{job_id}/sol")
    pvd = parse_pvd(find(f"/tmp/{job_id}/sol", "*.pvd"))                    # [(timestep, file), ...]
    last = max(pvd, key=lambda t: t[0])[1]                                   # by TIME INDEX, never by size
    grid = pyvista.read(last)
    surf = grid.extract_surface()                                            # boundary faces only
    surf = decimate_to(surf, MAX_VIEWER_TRIANGLES)
    mesh = trimesh.Trimesh(surf.points, surf.faces.reshape(-1, 4)[:, 1:], process=False)   # keep vertex order
    mesh.export(f"/tmp/{job_id}/results.glb")
    fields = {}
    for name in ("p", "U", "k", "omega", "nut"):
        if name not in surf.point_data: continue
        arr = surf.point_data[name]
        if arr.ndim == 2:                                                    # vector: magnitude + components
            write_bin(job_id, name, np.linalg.norm(arr, axis=1)); fields[name] = minmax(np.linalg.norm(arr, axis=1))
            for i, c in enumerate("xyz"): write_bin(job_id, f"{name}_{c}", arr[:, i])
        else:
            write_bin(job_id, name, arr); fields[name] = minmax(arr)
    upload_blob(f"/tmp/{job_id}/results.glb", f"results/{job_id}/results.glb")
    upload_json({"jobId": job_id, "vertexCount": len(surf.points), "fields": fields}, f"results/{job_id}/fields.json")
    plots = download_plots(api, sim_id, run_sid, job_id)                    # ?type=PLOT and ?type=CONVERGENCE_PLOT -> CSV
    run.update({"results": {...paths...}, "plots": downsample(plots, 2000), "summary": summary_from(plots)})

def write_bin(job_id, name, values):
    np.asarray(values, dtype="<f4").tofile(f"/tmp/{job_id}/{name}.bin")     # raw float32, no header
    upload_blob(f"/tmp/{job_id}/{name}.bin", f"results/{job_id}/fields/{name}.bin")
```

And the browser reads it:

```js
// src/workbench/post/fields.js
export async function loadField(run, name) {
  const buf = await (await fetch(await signedUrl(run.results.fields[name].path))).arrayBuffer();
  const values = new Float32Array(buf);                 // one value per vertex of results.glb, same order
  if (values.length !== run.results.vertex_count) throw new Error("field/vertex count mismatch");
  viewer.applyField(values, run.results.fields[name].min, run.results.fields[name].max);
}
```

### Step 7. Post-processing filters (postprocess service)

**Plain words.** Cutting planes and streamlines need the full 3D result. The browser asks
our server for just the slice; the server computes it with VTK and returns a small model.

```python
# services/postprocess/main.py (cutting plane)
@app.post("/filter")
def filter_():
    body = request.get_json(); job = body["job_id"]
    grid = load_cached_grid(job)                                             # unzips raw/solution.zip once per instance
    if body["type"] == "cutting_plane":
        p = body["params"]
        cut = grid.slice(normal=p["normal"], origin=p["origin"])
        out = cut.extract_surface()
    elif body["type"] == "particle_trace":
        p = body["params"]
        seeds = seed_grid(p["seed_origin"], p["seed_u"], p["seed_v"], p["nx"], p["ny"])
        out = grid.streamlines_from_source(seeds, vectors="U", max_time=p.get("max_length", 5.0),
                                           integration_direction="both" if p["both_directions"] else "forward").tube(radius=p["size"])
    key = sha256(canonical(body)).hexdigest()
    return jsonify(write_glb_and_field(out, body["field"], f"results/{job}/post/{key}/"))
```

### Step 8. Cancel, at any stage

The browser sets nothing directly; it calls `cancelJob`, which writes `jobs.status =
"cancelling"`. The worker checks that flag in every poll loop (exists:
`is_cancelling()`), calls SimScale's cancel endpoint for whatever is running, and writes
`cancelled`. If nothing had been meshed yet, `onJobPending` reverses the charge.

## 0.3 The whole-project backend map

Everything the backend of TurboFlow consists of, existing and new, in one table. "Exists"
means it is in the repo today and stays.

| Piece | Kind | Status | Purpose |
|---|---|---|---|
| Firebase Auth (Google only, decided 24 Sep 2026) | Auth | Exists | Sign-in. Keyless for users: no SimScale account needed. |
| `onUserCreate` | Auth trigger | Exists | Creates `users/{uid}` with the signup credits. |
| `createPayPalOrder`, `capturePayPalOrder`, `paypalWebhook`, `applyPurchase` | Callables + HTTP | Exist | Buying credits and the unlimited pass. |
| `createFusionToken`, `revokeFusionToken`, `exchangeFusionToken` | Callables + HTTP | Exist | The Fusion 360 add-in's API key flow. |
| `submitJob`, `startJob`, `refundJob` | Callables | Exist | The Fusion add-in and old web path. Unchanged. |
| `onJobPending` | Firestore trigger | Exists | The only place credits are charged and the worker is dispatched. Extend the dispatch with `SPEC_MODE`, `RUN_ID`. |
| `createUploadIntent` | Callable | Exists, extend | Mints the geometry id and the one allowed upload path (kind `raw`). |
| `onGeometryUploaded` | Storage trigger | New | Marks the geometry queued and enqueues processing. |
| `processGeometry` | HTTP (Cloud Tasks) | New | Calls the tessellate service, stores version files. |
| `applyCadOperation` | Callable | New | Delete body, scale, translate, rotate, external flow volume; new geometry version. |
| `createProject`, `updateProject`, `deleteProject`, `copyProject`, `shareProject`, `unshareProject`, `createFolder`, `moveToFolder` | Callables | New | Dashboard. |
| `createSimulation`, `saveSimulation`, `onSimulationWritten` | Callables + trigger | New | Setup document and validation. |
| `queueRun`, `cancelJob`, `getEventLog` | Callables | New | Queue, cancel, logs. |
| `onJobFinished` | Firestore trigger | New | Notifications, mirror status to `runs`. |
| `postprocessFilter`, `saveView`, `createScreenshotUrl` | Callables | New | Post-processor. |
| `services/tessellate` | Cloud Run service | Exists, extend | `/inspect` (+IGES, STL, adjacency, STEP export), `/prepare`, `/transform`, new `/measure`. |
| `services/simscale-job` | Cloud Run Job | Exists, extend | The worker: legacy label mode plus new `SPEC_MODE`. |
| `services/postprocess` | Cloud Run service | New | `/filter`, `/statistics`, `/probe`, `/plot-over-path`, `/mesh-clip`, `/gif`. |
| Firestore `users`, `users/*/transactions`, `jobs`, `projects`, `geometries`, `simulations`, `config`, `fusion_tokens`, `paypal_orders`, `rate` | Collections | Exist | Keep. `geometries` and `simulations` gain fields (13.3). |
| Firestore `folders`, `runs`, `runs/*/post_states`, `geometries/*/selections` | Collections | New | Dashboard folders, run tracking, saved views, saved selections. |
| Storage `users/{uid}/geometries/{gid}/...`, `results/{jobId}/...`, `jobs/{jobId}/...` | Buckets paths | Exist, extend | Raw uploads, version files, results, logs, post cache. |
| `firestore.rules`, `storage.rules` | Rules | Exist, extend | Money server-only; owner-scoped everything else; shared_with read. |
| Secret Manager `SIMSCALE_API_KEY`, `PAYPAL_*`, `DISCORD_WEBHOOK_URL` | Secrets | Exist | The SimScale key is the account's; never sent to browsers. |
| `tests/test_security.mjs` (+ new pricing and rules tests) | Tests | Exist, extend | Emulator tests that run in `npm test`. |

Order of building is in section 15; each piece's build prompt is in section 14.


---

## 0. Ground rules for the builder

1. **Copy SimScale's layout and behaviour exactly.** Same panels in the same places, same
   labels, same order of fields, same defaults, same mouse controls. Where this document and
   your own taste disagree, this document wins. Where this document and a SimScale screenshot
   disagree, the screenshot wins; update this document.
2. **Do not invent numbers.** Every default in this document is either from the SimScale API
   or from a Workbench-created spec. If a field is not listed, leave it at the API default
   (do not send it) rather than making a value up.
3. **The browser never talks to SimScale.** Every SimScale call goes through Firebase
   (Cloud Functions or Cloud Run). The API key lives in Secret Manager only. Sending it to the
   browser, logging it, or committing it is a bug that ends the project.
4. **Firestore is snake_case.** The app may use camelCase internally, but the one conversion
   happens in `src/lib/firebase.js` (already exists). Do not add a second conversion.
5. **Money is server-only.** Clients never write `cost`, `credits`, or `charged_at`. The
   existing rules already deny this. Do not weaken them.
6. **Every panel edit is a draft until the user clicks the blue checkmark or presses Enter.**
   Esc or the X discards. Navigating to another tree node auto-saves. This is SimScale's
   behaviour and the single most common thing a builder gets wrong (they save on every
   keystroke).
7. **No Tailwind, no component libraries.** Plain CSS with custom properties, as
   `DESIGN_RULES.md` at the workspace root demands. That file bans several things SimScale
   itself does (Inter-like font, rounded cards). For the Workbench, matching SimScale wins over
   `DESIGN_RULES.md`; for the marketing pages, `DESIGN_RULES.md` wins. Say so in a comment at
   the top of the Workbench stylesheet.
8. **Match `DESIGN_RULES.md` copy rules everywhere**: no em dashes in UI text, no emojis, no
   "seamless"/"effortless" words, no lorem ipsum.
9. **Ship with loading states that have the shape of the content**, not a lone spinner.
10. **Keyboard and mouse must work exactly as in section 6.4.** Test them with a real mouse.

---

# PART A: FRONT END

## 1. Scope

### 1.1 What is cloned

| SimScale area | Cloned | Notes |
|---|---|---|
| Dashboard (projects, folders, search, new project dialog, sharing) | Yes | Section 4 |
| Workbench shell (top bar, tree, viewer, settings panel, scene tree, job status, orientation cube) | Yes | Sections 5 and 6 |
| Geometry upload and import | Yes | Section 7 |
| CAD Edit mode | Yes, subset | Section 8. Every operation is listed; the backend supports the ones the geometry service can do today, the rest show "Not available yet" |
| Simulation tree and every settings panel for **Incompressible** flow | Yes, complete | Section 9 |
| Other analysis types (compressible, CHT, FEA, LBM, PWC, EM) | Listed in the analysis library, greyed out, tooltip "Not available in TurboFlow yet" | Section 9.1 |
| Meshing (Standard mesher, refinements, mesh clip, mesh log, quality) | Yes | Section 10 |
| Simulation runs (start, estimate, cancel, continue, event log, live plots) | Yes | Section 11 |
| Integrated post-processor (filters, legend, statistics, screenshot, compare, animation) | Yes | Section 12 |
| Team spaces, org admin, analytics, public project library | No | Single-user private projects plus share-by-email. Decided 10 Sep 2026: no public library. |
| Support chat | Replaced with a Help popover | Section 5.8 |

### 1.2 Routes

| Route | Screen |
|---|---|
| `/dashboard` | Dashboard (exists today as a different page; it becomes the SimScale-style dashboard) |
| `/workbench/{projectId}` | Workbench, nothing selected |
| `/workbench/{projectId}/geometry/{geometryId}` | Geometry selected |
| `/workbench/{projectId}/geometry/{geometryId}/cad` | CAD Edit mode |
| `/workbench/{projectId}/sim/{simulationId}` | Simulation selected, global settings panel |
| `/workbench/{projectId}/sim/{simulationId}/{nodePath}` | A tree node selected, e.g. `bc/{bcId}`, `mesh`, `run/{runId}` |
| `/workbench/{projectId}/sim/{simulationId}/run/{runId}/post` | Post-processor |

The URL is the source of truth for what is selected. Reloading must restore the same panel.
Browser back must go to the previous node. Firebase Hosting needs a rewrite of
`/workbench/**` to `/workbench.html` (today `rewrites` is empty in `firebase.json`).

---

## 2. Visual language

SimScale's Workbench 2.0 is an all-white UI: white top bar, white cards, white viewer ground. Values below are what the builder
starts from. Sample the exact colours from a screenshot of the real product and correct them
**[verify]**; the structure and sizes are what matter.

### 2.1 Tokens (CSS custom properties, put in `src/workbench/tokens.css`)

```css
:root {
  /* chrome */
  --wb-topbar-bg: #ffffff;        /* white top bar with a 1px bottom rule (verified from screenshot) */
  --wb-topbar-ink: #1f2933;
  --wb-topbar-h: 72px;
  --wb-panel-bg: #ffffff;         /* tree, settings panel, scene tree */
  --wb-panel-2: #f5f7fa;          /* section headers, hover rows */
  --wb-rule: #e1e5eb;             /* 1px borders */
  --wb-ink: #1f2933;              /* primary text */
  --wb-ink-2: #52606d;            /* secondary text, labels */
  --wb-ink-3: #9aa5b1;            /* hints, disabled */
  --wb-accent: #0a6cff;           /* SimScale blue: primary buttons, checkmark, selected row [verify] */
  --wb-accent-wash: rgba(10,108,255,0.10);
  --wb-ok: #2e9e5b;               /* green complete tick */
  --wb-warn: #e8a317;             /* yellow optional / cancelled */
  --wb-bad: #d64545;              /* red incomplete / error */
  /* viewer */
  --wb-viewer-bg: #ffffff;        /* plain white viewer ground (verified from screenshot; no gradient) */
  --wb-model-default: #b9bfc7;    /* untextured grey when CAD has no colour */
  --wb-hover: #7fb3ff;            /* hover highlight in viewer */
  --wb-selected: #ff5f5f;         /* selection highlight (SimScale docs: red) */
  --wb-assigned: #2f7cf6;         /* faces already assigned to the open panel (blue) */
  --wb-assigned-other: #f06ab8;   /* pink: secondary assignment (contact slave) */
  /* layout */
  --wb-tree-w: 300px;
  --wb-settings-w: 360px;
  --wb-scene-w: 280px;
  --wb-jobs-h: 220px;
  /* type */
  --wb-font: "IBM Plex Sans", "Segoe UI", system-ui, sans-serif;  /* Inter is banned by DESIGN_RULES.md */
  --wb-mono: "IBM Plex Mono", ui-monospace, monospace;
  --wb-fs: 13px;                  /* base font size */
  --wb-fs-s: 12px;
  --wb-fs-l: 15px;
  --wb-radius: 3px;               /* small radius everywhere, no pills */
}
```

### 2.2 Icon set

SimScale uses a custom line icon set at 16px and 20px. Use a single consistent set (Lucide
or Tabler, one only, imported as inline SVG, one colour). Never emoji. Every icon-only button
has `aria-label` and a tooltip that appears after 500 ms hover, below the button, dark
background, white 12px text.

### 2.3 Controls

| Control | Spec |
|---|---|
| Primary button | Filled `--wb-accent`, white text, 32px high, 12px horizontal padding, radius 3px. Disabled: 40% opacity. |
| Secondary button | White, 1px `--wb-rule` border, ink text. |
| Text field | 28px high, 1px border `--wb-rule`, focus border `--wb-accent`. Units shown as a right-aligned grey suffix inside the field ("m/s"). Number fields accept `1e-5` notation. |
| Dropdown | Same box as text field, chevron right. Opens a list below, max 8 rows visible, scroll after. |
| Toggle | 32×18px switch, blue when on. Label on the left. |
| Slider | Blue track, round thumb, value shown in a number box to the right. Left/right arrow keys move it by one step while hovered (SimScale behaviour). |
| Checkbox | 16px square, blue tick. |
| Section header inside a panel | 12px uppercase grey text, collapsible with a chevron on the right. |
| Status icons in tree | 14px circle: red filled = incomplete/required, red with cross = error, blue = optional, green tick = complete. |
| Vector field | Three number boxes in one row labelled x, y, z with the unit once at the right. |

---

## 3. Application shell and global behaviour

### 3.1 Authentication

Firebase Auth, Google only. This section used to ask for email + password sign-in and
sign-up with a verification email, because school teams do not all have Google accounts;
the owner decided on 24 Sep 2026 that TurboFlow signs in with Google and nothing else, and
`onUserCreate` refuses any other provider. The Workbench route
redirects to `/dashboard?next=...` when signed out. The Dashboard shows the sign-in modal
when signed out.

### 3.2 Saving indicator

Top bar, right of the project name: text "All changes saved" in `--wb-ink-3`, changes to
"Saving..." during a write and "Could not save. Retry" (red, clickable) on failure. Every panel
save goes through one function so this indicator is always right.

### 3.3 Concurrency

One user edits one project at a time. If the same project is open in two tabs, the second tab
sees a banner "This project is open in another tab. Changes here may overwrite changes there."
Implement by writing a `lock` field on the project document with the tab id and a 30 s
heartbeat.

### 3.4 Errors

Network errors show a red bar at the top of the viewer: message plus "Retry". Validation
errors show inline under the field in red 12px text. The tree node gets the red-cross icon.
Never use `alert()`.

### 3.5 Units

Storage is SI. The project's unit system (SI or Imperial) only changes what the fields show.
Every numeric field has a unit dropdown to its right where SimScale has one (lengths: m, cm,
mm, in, ft; speeds: m/s, km/h, mph; pressure: Pa, kPa, bar, psi; angles: rad, deg). Conversion
happens in the field component. The stored value is always the SI base unit.

---

## 4. Dashboard

Verified against a screenshot of the real SimScale dashboard on 10 Sep 2026
(`simscale.com/dashboard/my-projects`, account "Yendapa").

### 4.1 Layout

```
+------------------------------------------------------------------------------------------+
| (logo) SimScale                     [Search projects or users...  Q]  Forum ↗  Help v  Yendapa (Y) v |  72px white top bar, 1px bottom rule
+------------------+------------------------------------------------------------+------------+
| v PROJECTS       |  My Projects                    [+ New Project] [+ New Folder] |  My Projects |
|   RECENT PROJECTS|  ---------------------------------------------------------  |  (grey icon) |
|   MY PROJECTS    |  My Projects        [^] [Last Modified v] [grid][list][(i)] |              |
|   SPACES         |                                                            |  Select a    |
|   SHARED WITH ME |  +-----------------+ +--------+ +--------+ +--------+       |  folder or   |
| v COMPONENTS     |  | + Create a Folder| | thumb  | | thumb  | | thumb  |       |  project to  |
|   COMPONENTS     |  +-----------------+ | name   | | name   | | name   |       |  see details |
| v YENDAPA (org)  |                      | by X   | | by X   | | by X   |       |              |
|   MANAGE SPACES  |                      | Last m.| | Last m.| | Last m.|       |              |
|   MANAGE USERS   |                      | Stats  | | Stats  | | Stats  |       |              |
|   MANAGE INVIT.  |                      +--------+ +--------+ +--------+       |              |
|   SETTINGS       |                                                            |              |
|   USAGE OVERVIEW |                                                            |              |
| |< Collapse sidebar                                                            |    (chat)    |
+------------------+------------------------------------------------------------+------------+
```

Widths at 1456px: sidebar 250px, right info panel 265px, centre fluid. Everything is on a
white ground with `#f5f7fa`-style light grey behind the cards **[verify exact hex]**. Text
is dark grey, headers in the sidebar are 12px uppercase letter-spaced grey.

### 4.2 Top bar (white, 72px)

| Element | Behaviour |
|---|---|
| Logo + wordmark | Left. Click goes to `/dashboard`. TurboFlow shows its own logo and the word TurboFlow. |
| Search box | Right side, 190px, placeholder "Search projects or users...", magnifier icon at its right. Filters the current list as you type. |
| Forum ↗ | External link. TurboFlow: link to the Setup guide instead. |
| Help v | Dropdown with two items: **Tutorials**, **Documentation**. |
| User name + avatar + chevron | "Yendapa" text, a green circle with the initial, chevron. Menu: Account settings, Usage and billing, API key, Sign out. |

### 4.3 Left sidebar (250px)

Three collapsible groups with a chevron and a 12px uppercase header, then items in 13px
uppercase with a line icon each:

- **PROJECTS**: Recent, My projects (active: light blue background), Shared with me.
  SimScale also has "Spaces" (an organisation feature) and "Public projects ↗"; TurboFlow
  has neither, so both are left out rather than shown dead.

  Folders are **not** a sidebar tree. SimScale puts them in the grid as tiles, with a
  dashed "+ Create a Folder" tile first, and TurboFlow does the same. (An earlier draft of
  this section, written before the screenshot, described a FOLDERS section in the sidebar.
  It was wrong.)
- **COMPONENTS**: Components. TurboFlow does not have component libraries; hide this group.
- **{Organisation name}**: Manage spaces, Manage users, Manage invitations, Settings.
  TurboFlow shows a **TEAM** group instead with one item, Team settings (team name, region,
  contact email, which already exist on the user document).
- **Usage overview**: a single item under a rule. TurboFlow points it at `/billing`.
- Bottom: "|< Collapse sidebar" link, which collapses the sidebar to a 48px icon strip.

An older docs figure of the same dashboard shows two usage boxes at the top of the sidebar,
"Computing hours usage (CPU): 8319 of 10000000 hours" and "(GPU)", and a TEAMS entry; the
live screenshot has moved usage to "Usage overview". TurboFlow puts its credit balance in
those top-of-sidebar boxes ("Credits: 1,240" with "+ Add credits"), which is the older
SimScale position. The credit balance is otherwise **not** in the sidebar on SimScale (core hours live under Usage
overview). TurboFlow keeps its credit balance in the same place it has today, the top of
the right info panel, as a small "Credits: 1,240  + Add credits" line, so users see it.

### 4.4 Project list

Header row: page title "My Projects" (28px), and at the right two buttons: **+ New
Project** (filled dark, white text) and **+ New Folder** (white, 1px border).

Toolbar row inside the list card: breadcrumb "My Projects" on the left (folder path when
inside a folder); on the right an ascending/descending arrow button, a **Last Modified**
dropdown (Last Modified, Name, Created), a grid/list segmented toggle, and an (i) button
that shows or hides the right info panel.

First tile of the grid is always a dashed **+ Create a Folder** tile (290×60px). Then
project cards (290px wide): thumbnail 290×220 (last viewer screenshot; grey "No preview
available" text on a light gradient when none), name (15px), "by {owner}" (italic 13px),
"Last modified: Aug 14 2026" (13px grey), then a footer row: "Statistics" with a bar icon,
and four icon+count pairs: geometries, meshes, simulations, runs.

Click selects (info panel fills), double-click opens the Workbench, "..." on hover and
right-click open the context menu: **Open**, **Copy**, **Rename**, **Move to folder...**,
**Share...**, **Delete** (confirm: "Delete project 'X'? This removes all geometries,
simulations and results. This cannot be undone.").

Empty state: the Create a Folder tile plus the text "No projects yet. Create one and upload
a CAD model to start." Loading: six grey card outlines.

### 4.5 Info panel (right)

When a project is selected: thumbnail, name (editable inline on pencil click), description
(editable), category, tags, visibility, created, modified, owner, counts (geometries,
simulations, runs), and a button **Open in Workbench**. When a folder is selected: name,
count of projects, created. When nothing is selected: "Select a project to see details."

### 4.6 New project dialog

Modal 560px wide, title "New project".

| Field | Type | Rules |
|---|---|---|
| Project title | text, required | 1 to 200 chars. Hint: "Describe the car and the method, e.g. 'Car v3, k-omega SST'" |
| Description | textarea | up to 2000 chars |
| Category | dropdown | Aerospace, Automotive, Architecture, Consumer products, Education, Energy, Industrial, Marine, Medical, Other. Default Education. |
| Tags | tag input | up to 12 tags, 3 to 50 chars each |
| Advanced settings (collapsed) | | |
| Unit system | radio: SI / Imperial | Default SI. Only affects display; storage is always SI. |
| Allow API access | toggle | Default off. Shows the project id when on. |

Every TurboFlow project is private; there is no Public/Private choice (SimScale has one). Buttons: Cancel, **Create project** (primary, disabled until title is valid). On create:
write the project document, then navigate to `/workbench/{projectId}` and open the geometry
upload dialog automatically.

### 4.7 Share dialog

Modal, title "Share 'project name'". Field "Email address" with a permission dropdown:
Can view, Can copy (default), Can edit. Button Add. List of current collaborators with their
permission dropdown and a remove X. No "anyone with the link" option: projects are private and only listed collaborators can open them. Close button.

### 4.8 API key page (Account menu)

Shows the user's TurboFlow API key (not the SimScale key) with Copy and Regenerate. This is the
key the Fusion 360 add-in already uses (`createFusionToken`). Keep that flow; only the UI moves.

---

## 5. Workbench shell

Verified against a screenshot of the real Workbench on 10 Sep 2026 (project "3e3e",
geometry "car(17.3)", a Static simulation; the Incompressible tree differs only in its
nodes, see 9.2).

### 5.1 Layout (screenshot at 1920×904)

```
+------------------------------------------------------------------------------------------------+
| (logo) 3e3e | Share | [copy] [gear]                   [Support] [AI Agent] Help v  Yendapa (Y) v | 72px white
+----------------------+-------------------------------------------------------+-----------------+
| v GEOMETRIES      +  |             [cube v][solid][face][edge][node][hide][box][isolate][clip] |  v GEOMETRY     |
|     car(17.3)        |                     (toolbar centred at the top of the viewer)          |    - car(17.3)  |
| v SIMULATIONS     +  |                                                       |      + Configuration 1 |
|  - Static            |                                                       |  SAVED SELECTIONS |
|      Geometry        |                                                       |  Show faces  (o) |
|      Geometry prim + |                                                       +-----------------+
|      o Local coord + |                  3D VIEW (white ground)                                 |
|      v Contacts (6)+ |                                                                         |
|      v Connectors +  |                                                                         |
|      v Element tech  |                                                                         |
|      v Model         |                                                                         |
|      o Materials  +  |                                                                         |
|      o Boundary c +  |                                                                         |
|      v Numerics      |                                                                         |
|      v Simulation c. |                                                                         |
|      + Result control|                                                                         |
|      + Mesh          |                                                                         |
|      o Simulation r+ |                                                  y  ^                  |
| UPLOADED FILES (0)   |                                                  |  <[TOP]>  (home)     |
+----------------------+                                                  z---x  v   rotate icons |
| Job status           |                                     ---- v ----  (collapsed bottom bar) |
+----------------------+-----------------------------------------------------------------------+
```

Measured from the screenshot:

- Top bar: white, 72px tall, 1px grey bottom rule. No dark bar. (Earlier drafts said dark
  navy; that was wrong.)
- Left panel: a white card 310px wide with 10px margin from the window edge and from the
  top bar, rounded 4px, light shadow. It holds the GEOMETRIES and SIMULATIONS sections. A
  second white card directly under it holds **UPLOADED FILES (0)**, and a third holds **Job
  status**. Between the left panel and the viewer there is a thin vertical drag handle.
- Right panel: a white card 295px wide, same margins, holding GEOMETRY, SAVED SELECTIONS
  and the Show faces toggle. It is only as tall as its content.
- Viewer: fills the rest, **plain white background** (no gradient), no grid.
- Viewer toolbar: a row of 32px icon buttons **centred horizontally at the top of the
  viewer**, 24px below the top bar, on a very light grey strip. Not top-left.
- Orientation widget: bottom-right, an axes triad (y up in green, x right in red, z toward
  the viewer in blue), a square button labelled with the current view ("TOP"), four chevrons
  around it (up, left, right, down), two circular-arrow buttons under it (roll left, roll
  right), and a home icon above-right of it.
- A thin collapsed bar at the bottom centre of the viewer with a "v" chevron (the results
  and plots dock; it expands upward).

### 5.2 Top bar

| Element | Behaviour |
|---|---|
| Logo | Round icon, left. Click goes to `/dashboard`. |
| Project name | "3e3e", 20px, next to the logo. Click to rename inline (Enter saves, Esc cancels). |
| Share | Outlined button. Opens the share dialog from 4.7. |
| Copy icon | "Copy project" (icon button with tooltip). |
| Gear icon | Project settings dialog: name, description, unit system, delete project. |
| Support | Outlined button with a chat icon, right side. TurboFlow: opens the Help popover from 5.8. |
| AI Agent | Outlined accent button. TurboFlow does not have this; leave it out. |
| Help v | Dropdown: Tutorials, Documentation, Keyboard shortcuts. |
| Name + avatar + chevron | "Yendapa", green circle "Y". Menu as on the dashboard. |

The save indicator from 3.2 is not visible on SimScale; TurboFlow puts it as small grey text
right of the gear icon.

### 5.3 Navigation tree (left card, 310px)

Section headers are 15px uppercase with an icon at the left and a round `+` button at the
right: **GEOMETRIES +**, **SIMULATIONS +**. Each header has a collapse chevron at the far
left. Under GEOMETRIES each geometry is a row with a small geometry icon and its name
("car(17.3)"), connected to the header by a thin grey tree line.

Under SIMULATIONS each simulation is a row with a collapse box (`-`/`+`) and an analysis
icon, and the selected row has a light blue background. Its children are indented 28px,
each 35px tall, 15px text, with a status icon at the left:

| Icon | Meaning |
|---|---|
| Green circle with a white tick | Complete |
| Red hollow circle | Required and incomplete |
| Blue hollow circle | Optional |
| Node icon with a small green tick overlay (Geometry) | Assigned |
| Mesh icon with a small blue dot overlay (Mesh) | Not generated yet |
| Red circle with a cross | Error |

Rows that can hold children show a small `+` box at the far left (Contacts, Result
control, Mesh) and rows that can create children show a round `+` button at the right
(Geometry primitives, Local coordinate systems, Contacts, Connectors, Materials, Boundary
conditions, Simulation runs). Counts appear in brackets ("Contacts (6)").

A separate card under the tree: **UPLOADED FILES (0)**, listing CSV tables and other
uploads used by the setup (probe point tables, tabular boundary values).

Row menus (hover "..." or right-click): geometry: Rename, Edit in CAD mode, Download,
Duplicate, Delete. Simulation: Rename, Duplicate, Delete. Child items: Rename, Duplicate,
Delete.

### 5.4 Settings panel (floating). Verified from SimScale docs figures, 10 Sep 2026

A white card floating over the left of the viewer, 350px wide, 12px from the tree, rounded
4px, light shadow. Header 48px: the node name at the left (editable inline for renamable
nodes; the material panel shows it as a text field), then at the right a **square blue ✓
button** (32×32, white tick) and a **square white ✕ button** with a grey border. Not round.

Body: rows 38px tall, label at the left in 14px dark grey, control at the right, a 1px grey
underline under each value field (SimScale's fields are underlined inputs, not boxed). Units
sit right of the value as small grey text with a chevron ("m/s ⌄") that opens a unit
dropdown. Dropdown controls show the value and a chevron. Toggles are 32×18 blue switches.

Rows that accept a table or formula show a second row with two small icon buttons at the
right: a chart icon ("Define as table or formula") and a reset arrow ("Reset to constant").
Velocity vectors then show three rows Ux, Uy, Uz.

**Assignment block** (every panel that assigns entities): a bold row "Assignment (1 Face)"
or "Assignment (1 Volume)" with a blue toggle at the right (assignment mode on: clicks in
the viewer add entities) and a trash icon (clear all). Under it a light-blue box, 120px
tall, listing each assigned item on its own row with an x at the right; saved selections
appear by their name ("Inlet"), single faces by their SimScale name. Older panels show the
same as "Assigned Faces (88)" with a "Clear list" link on the right and the list box below.
The panel footer is a thin bar with a trash icon (delete this item) and, for materials, an
"add from library" icon.

Draft semantics: edits stay in the panel until ✓ or Enter; ✕ or Esc discards; leaving the
node saves a valid draft and refuses to leave an invalid one. Pressing ✓ keeps the panel
open.

### 5.5 Scene tree (right card, 295px)

Exactly as in the screenshot:

```
v GEOMETRY
   - car(17.3)
      + Configuration 1          (the CAD assembly/configuration; expands to bodies, then faces)
SAVED SELECTIONS                 (header; a + appears at the right when something is selected in the viewer)
Show faces                 (o)   (toggle, off by default)
```

When Show faces is on, every body expands to list its faces by SimScale name. Clicking a
row selects it in the viewer; the eye icon appears on hover to hide it. Saved selections
list below their header with a bookmark icon, count, and a "..." menu (Rename, Edit,
Delete). Geometry primitives and mesh clips appear as further headers (GEOMETRY PRIMITIVES,
MESH) when they exist.

### 5.6 Viewer toolbar (centred, top of viewer)

Nine 32px buttons in the screenshot, left to right, with a tiny corner mark on the ones
that open a dropdown:

| # | Button | Dropdown | Behaviour |
|---|---|---|---|
| 1 | Render mode (cube, grey) | Surfaces, Surfaces with edges (default in the screenshot), Wireframe, Translucent | Changes the model drawing |
| 2 | Select solids (orange cube) | | Selection mode Solid |
| 3 | Select faces (cube with a highlighted face; active = light grey background) | | Selection mode Face (active by default) |
| 4 | Select edges/nodes (cube with dots) | Edges, Nodes | Only enabled with a mesh |
| 5 | Select volumes/cell zones (cube, blue) | | Mesh regions |
| 6 | Hide selection (eye with slash) | Hide selection, Show all, Isolate | |
| 7 | Box select (dashed square with cursor) | | Toggle |
| 8 | Fit / view (cube outline) | Fit to view, Set home view | |
| 9 | Clip / section (plane icon) | Mesh clip, Section view | |

Tooltips appear under each. The exact icons are not important; the order, the grouping and
the dropdown corner marks are.

### 5.7 Job status panel

Collapsed: a 32px bar at the bottom-left of the viewer, text "Job status" plus a summary
chip: "1 running", "2 finished", or nothing. Chevron expands it to a 220px tall table:

| Column | Content |
|---|---|
| Name | "Mesh 1" or "Run 1" with the simulation name in grey below |
| Type | Mesh / Simulation |
| Status | Queued, Running (with a progress bar and %), Finished (green tick), Failed (red cross), Cancelled (yellow) |
| Runtime | live "12 min 04 s" |
| Cost | credits charged (TurboFlow) where SimScale shows core hours |
| Actions | Cancel (while queued/running, asks to confirm), View (selects the node), Log (opens the event log dialog) |

Rows are ordered newest first. Finished rows stay for the session. The panel is per project.
Status comes from a Firestore listener on the `runs` collection (Part B); never poll from the
browser.

### 5.8 Help and support button

Bottom-right, above the orientation cube: a round "?" button. SimScale opens a support chat;
TurboFlow opens a popover with: "Read the docs", "Watch the setup guide", "Email support"
(mailto with project id), and a toggle "Share this project with support" that adds the
support account to the share list.

### 5.9 Orientation cube

96×96px cube drawn in its own overlay scene with its own orthographic camera, synced to the
main camera's rotation every frame. Faces are labelled Front, Back, Left, Right, Top, Bottom
and the axes X (red), Y (green), Z (blue) are drawn as a small triad at the cube's corner.

Interactions: click a face = animate the camera to look at that face (300 ms ease). Click an
edge or corner = isometric view between those faces. Drag the cube = rotate the main camera.
Around the cube: four small arrow buttons (rotate 90° about the screen axes) and a
clockwise/anticlockwise pair (roll 90°). A home icon to the left of the cube = fit to view.
Right-click the cube: menu "Set as home view", "Perspective/Orthographic".

The existing `public/wb-viewcube.js` (236 lines) does most of this and can be kept.

---

## 6. Viewer

### 6.1 Rendering stack

three.js r160+ (pinned, bundled by Vite, not loaded from a CDN). One `WebGLRenderer` with
`antialias: true`, `preserveDrawingBuffer: true` (needed for screenshots),
`powerPreference: "high-performance"`. Pixel ratio capped at 2. Background: plain white
(`renderer.setClearColor(0xffffff)`), no gradient, no grid. Lighting: one hemisphere light (sky white,
ground grey) plus one directional light attached to the camera so the model is never in
shadow; no shadows.

Model: loaded from a GLB produced by the geometry service (7.4). Mesh material:
`MeshStandardMaterial` with `vertexColors` on, `flatShading` off, metalness 0.1, roughness
0.8. Faces without CAD colour get `--wb-model-default`.

Edges (for "Surfaces with edges"): `EdgesGeometry` at 30° threshold, `LineSegments`, colour
`#3a3f45`, drawn in a second pass. Wireframe mode: same lines but the surfaces are hidden.
Translucent: material opacity 0.35, `depthWrite: false`, sorted back to front.

Mesh display (10.4): a second GLB of the mesh surface with wireframe overlay.

### 6.2 Picking

Every vertex carries a `_FACEID` attribute (the STEP face id) and every face belongs to a
solid; the glTF also carries `extras.faces` (id, solid id, area, centre, surface type,
triangle start and count) and `extras.solids`. Picking uses `three-mesh-bvh` for raycasting
(a plain raycast over 300k triangles is about 100 ms per move and unusable). On pointer move
(throttled to 16 ms), the hit triangle's `_FACEID` is looked up; the hover target is the
face, the solid, or nothing, depending on the selection mode.

Highlighting is done with a per-vertex `aSelect` float attribute (0 = none, 1 = hover,
2 = selected, 3 = assigned, 4 = assigned-other, -1 = hidden) that a small `onBeforeCompile`
shader chunk maps to the token colours (and discards -1). Updating a face means writing its
vertex range (from `extras.faces[i].start/count`) and setting `needsUpdate` on that attribute
only. Never rebuild geometry to highlight or hide.

### 6.3 Selection model

`selection = { mode: 'solid'|'face'|'edge'|'node', ids: Set<string> }`. Click selects one and
clears the rest. Ctrl+click (Cmd on Mac) toggles. Shift+click adds. Click on empty
background clears. Box select as in 5.6. Selection persists across camera moves and across
panel opens; opening a panel with an assignment box switches to that box's entity mode and
shows already-assigned entities in blue.

Right-click in the viewer opens a context menu:
Hide selection, Show all, Isolate selection, Invert selection, Clear selection, Select other
(submenu listing the entities behind the cursor, nearest first, up to 8, hover highlights
each), Expand selection (submenu: Tangent faces, Same area, Same fillet radius), Add to saved
selection..., Fit to selection, Set rotation centre here.

"Expand selection" rules: Tangent faces = flood-fill across edges whose dihedral angle is
under 5° (needs face adjacency from `extras.adjacency`). Same area = faces whose area is
within 0.5% of the selected one. Same fillet radius = cylindrical/toroidal faces whose radius
is within 0.5%.

### 6.4 Camera controls

| Action | Input |
|---|---|
| Rotate | Left-drag |
| Rotate about one axis only | Hold X, Y or Z while left-dragging |
| Pan | Middle-drag, or Ctrl + left-drag |
| Zoom | Scroll wheel (zoom towards cursor), or right-drag, or Alt + left-drag |
| Set rotation centre | Double-click on the model (the point becomes the orbit centre; a small crosshair shows for 1 s) |
| Fit to view | A key, or the home button |
| Box select | B key toggles the mode |
| Hide selection | H key |
| Save panel | Enter |
| Discard panel | Esc |
| Views | Number keys 1..6 = Front, Back, Left, Right, Top, Bottom; 0 = isometric |

Turntable rotation about the up axis (viewer setting, default +Y; use +Z when the geometry
extras say the STEP was Z-up). Damping 0.1. Zoom speed proportional to the distance to the
rotation centre so small models are not overshot. Near/far planes recomputed on every fit
from the bounding sphere (near = r/1000, far = r*100) or far-away parts vanish.

### 6.5 Hidden entities and visibility

Hidden faces/solids are removed from rendering with `aSelect = -1` (6.2). The scene tree eye
icons reflect the same state. "Show all" resets. Hidden state is per session, not saved,
except in the post-processor where it is part of the saved view.

### 6.6 Measure tool

Panel (floating, right of the toolbar): "Measure". Instructions: "Select one entity to see its
size, two to see the distance between them." With one face: area, centre of mass, and for a
cylinder its radius and axis; with one solid: volume, surface area, bounding box, centre of
mass; with one edge: length. With two entities: shortest distance, longest distance, normal
distance, and angle between planar faces. Each value has a copy button. Hovering a value
highlights it in the viewer as a dashed line or point. The tool leaves selection mode
unchanged. Close with X or Esc. Values come from `extras.faces` for single entities and from
a `/measure` call to the geometry service for pairs (exact B-rep distance, not triangle
distance).

### 6.7 Keyboard shortcut sheet

Opened from Help > Keyboard shortcuts, a modal listing every key above in two columns.

### 6.8 Performance rules

- Everything above 300k triangles must be decimated server-side before it reaches the
  browser (the geometry service already caps at `MAX_VIEWER_TRIANGLES = 300000`).
- Never allocate in the render loop. Never call `setFromObject` per frame.
- Render on demand: render only after a camera change, selection change or animation tick;
  not on a `requestAnimationFrame` loop while idle.
- Dispose geometries and textures when a model is swapped or the page unloads.
- Load the GLB with `DRACOLoader` off (Draco breaks the vertex order that the field
  binaries depend on, see 12.9).

---
## 7. Geometry

### 7.1 Upload dialog

Opened by Geometries `+`, by the New project flow, and by an empty-project prompt in the
viewer ("Upload a CAD model to start" with a button). Modal 640px, title "Import geometry".

Tabs across the top: **Upload from computer** (default), **From Onshape** (disabled, tooltip
"Not available in TurboFlow"), **From sample library** (TurboFlow's own samples: two example
cars and one flow region; each is a card with a thumbnail and "Import").

Upload tab: a drop zone (dashed border, "Drag a CAD file here or click to browse") accepting
**only `.step .stp .iges .igs .stl`** (decided 10 Sep 2026; SimScale accepts many more, and the
dialog says "STEP, IGES or STL, up to 50 MB" under the drop zone). Any other extension shows
"TurboFlow accepts STEP, IGES and STL files. Export your model as STEP." and does not upload.
Max 3 GB in SimScale; **TurboFlow max is 50 MB** (the geometry service limit; the storage rule
allows 60 MB). Multiple files are refused ("One file at a time.").

After a file is picked, fields appear:

| Field | Type | Default | Notes |
|---|---|---|---|
| Name | text | file name without extension | 1 to 200 chars |
| Unit | dropdown m, cm, mm, ft, in, yd | m; for `.stl` the user must pick because STL has no unit (SimScale asks the same) | Sent as `inputUnit` |
| Facet-split on import | toggle | off | Splits an STL into faces by angle |
| Automatic sewing | toggle | on | Sews adjacent sheets into solids |
| Improve data on import | toggle | on | Tolerance repair |
| Optimize for LBM/PWC | toggle | off | Always off in TurboFlow, keep the control for parity |

Buttons: Cancel, **Import** (primary). Progress: the dialog closes and a row appears in
Geometries with a spinner icon and the text "Uploading 34%", then "Importing...". The Job
status panel shows the import too. On failure the row shows a red cross and clicking it
shows the error ("Could not read the STEP file: ...") with a Retry and a Delete button.

Rules the builder will get wrong:
- Upload goes straight to Firebase Storage with the resumable upload API, path
  `users/{uid}/geometries/{geometryId}/raw.step` (or the original extension). The Firestore
  geometry document is written **after** the bytes land (the rules expect that order).
- The progress bar must be driven by `uploadTask.on('state_changed')`, not faked.
- SimScale is not contacted at upload time (queue mode, Part B). The preview comes from our
  own geometry service, so it appears within a minute or two of the upload finishing.

### 7.2 Import stages (what the row and job panel show)

`uploading` (client) → `queued` → `tessellating` (geometry service) → `ready` | `failed`.
Row text: "Uploading 34%", "Preparing preview", then the plain name. SimScale sees the file
only when a run is queued (Part B, 14.7). Faces are identified by STEP face id everywhere in
the Workbench; the worker translates them to SimScale names at queue time.

### 7.3 Geometry panel. Verified from a docs figure

Title = geometry name (text field). Body: a grey note box "Generic CAD format: Please note
that SimScale is optimized for models in the Parasolid format..." (TurboFlow replaces this
with "STEP, IGES or STL. Faces are numbered from the STEP file, so keep the same file for
CAD edits."), then a collapsible **Geometry Info** section (format, size, unit, solids,
faces, bounding box), and a footer bar with a download icon, a trash icon, and at the right
a filled blue **Create Simulation** button.

### 7.4 What the geometry service produces (contract the viewer depends on)

For each geometry version: `model.glb` (surfaces, per-face triangle ranges, `_FACEID`,
vertex colours, `extras`), `faces.json` (id, solidId, type, area, centre, normal, radius,
axis, bbox, adjacency), `solids.json` (id, name from the CAD, volume, bbox, faces[]),
`edges.glb` (feature lines, optional), and `thumb.png`. All under
`users/{uid}/geometries/{gid}/v{n}/`. The browser fetches them through signed download URLs
from the Firestore document, never by guessing the path.

---

## 8. CAD Edit mode

Entered from the geometry "..." menu or the Geometry panel. The route becomes `/cad`. The
navigation tree is replaced by two things: a **CAD operations toolbar** (a vertical panel of
buttons grouped by category) and below it the **Feature list** (history). The scene tree
stays on the right. A top banner in the viewer says "CAD mode: car v3" with a button
**Exit CAD mode** on the right. Every operation is saved automatically as a feature; exiting
creates a new geometry version (v2, v3...) if anything changed and asks "Name this version"
with a default "car v3 (edited)".

### 8.1 Feature list

Rows in order of application: number, operation name, summary ("Delete body: 2 bodies"),
status tick or red cross with the error. Click a row to see its settings (read-only, with an
Edit button that rolls back later features, SimScale-style with a warning "Features after
this one will be recomputed"). "..." per row: Edit, Delete (removes it and recomputes the
later ones), Suppress.

### 8.2 Operations toolbar

Grouped headers and buttons exactly as SimScale:

**FACE**: Delete face, Move, Extrude
**BODY**: Delete body, Close sheet, Facet split, Imprint, Scale, Split, Boolean (Union,
Intersect, Subtract), Transform (Translate, Rotate), Simplify, Wrap surface
**CREATE**: Flow volume (External, Internal, Internal caps), Box, Cylinder
**TOOLS**: Interferences check, Gaps detection
**MODEL**: Fix interferences, Add CAD

Each button opens a settings panel (same floating panel component as 5.4) with an
assignment box and **Apply** as the footer button. The panel's fields:

| Operation | Fields | Backend today |
|---|---|---|
| Delete face | Faces (assign); Healing method: Heal (default), Cap, Leave open | Not available (button shows the panel with a "Not available yet" banner and Apply disabled) |
| Move (face) | Faces; Method: Distance (number, m) or Up to entity (one face); direction flip toggle | Not available |
| Extrude | Faces; Method: Add new / Merge / Remove; Distance or Up to entity | Not available |
| Delete body | Bodies (assign) | **Available** (`/transform` op `delete_bodies`) |
| Close sheet | Sheet bodies; Method: Cap (default), Grow | Not available |
| Facet split | Max split angle 0 to 180°, default 30° | Not available |
| Imprint | Bodies | Not available |
| Scale | Bodies; Factor (slider 0.001 to 1000 and number, default 1) | **Available** (`/transform` op `scale`) |
| Split | Plane origin (x,y,z) and normal (x,y,z); Keep both sides toggle (off) | Not available |
| Boolean union | Bodies (2+) | Not available |
| Boolean intersect | Bodies (2+) | Not available |
| Boolean subtract | Target body; Tool bodies; Keep tools toggle (off) | Not available |
| Translate | Bodies; Method: X,Y,Z distances (m) or Up to entity | **Available** (`/transform` op `translate`) |
| Rotate | Bodies; Axis origin and direction; Angle (deg); Inverse button | **Available** (`/transform` op `rotate`) |
| Simplify | Bodies; Replace with: Box / Cylinder; Wrap individually toggle | Not available |
| Wrap surface | Bodies to wrap: Whole model / Selected; Wrap type: Fit to surface / Snap to edges; Resolution 1 to 10 (default 5); Allow tunnels; Cap tunnels; Tunnel detection Automatic/Manual + diameter; Wrap individually | Not available |
| External flow volume | Min x,y,z; Max x,y,z (defaults from the bounding box: SimScale prefills the box; TurboFlow prefills upstream 3 L, downstream 8 L, side 3 L, top 3 L, floor at the lowest wheel minus 30 mm); Seed face (optional); Excluded parts | **Available** (`/prepare`, which also writes the labels file) |
| Internal flow volume | Seed face; Boundary faces | Not available |
| Internal caps | none | Not available |
| Box | Method: Custom (min/max x,y,z) or From faces (faces + scale factor 1.1) | Not available |
| Cylinder | Method: Custom (centre, axis, radius, height) or From faces (faces + clearance 1.1) | Not available |
| Interferences check | none; result list "No interferences found" or rows with the two bodies (click highlights) | Not available |
| Gaps detection | Maximum distance (m) | Not available |
| Fix interferences | none | Not available |
| Add CAD | Geometry (dropdown of the project's geometries) | Not available |

The "Not available" state is a real requirement: the toolbar must list every operation so
the UI matches SimScale, and the disabled ones must say so plainly. Do not hide them.

### 8.3 Wind tunnel handles (TurboFlow addition inside External flow volume)

The existing Workbench draws the tunnel box with draggable walls (`alongAxis()` logic in
`public/workbench.html`; keep that algorithm: project the pointer onto a plane through the
wall's axis fixed at grab time, never onto the axis line). The floor does not drag. The
symmetry-side wall does not drag while Symmetry is on. Keep this inside the External flow
volume panel as a "Drag walls in the viewer" hint plus the numeric fields; both stay in sync.

---

## 9. Simulation setup

### 9.1 Create simulation dialog (verified from a screenshot, 10 Sep 2026)

Opened by SIMULATIONS `+` or the Geometry panel button. Modal about 1170×780, title **Create
Simulation** (20px, top-left), close X top-right.

Three columns:

- Left (290px): a vertical nav with two entries, **Analysis Type** (active, blue text, light
  blue background) and **Workflow Type**.
- Middle (320px, scrollable): a flat list with grey uppercase group headers and one row per
  analysis, each with a line icon and the name; a lock icon at the right of rows the plan
  does not include. Groups and rows, in order:
  - **FLOW**: Incompressible, Incompressible (LBM), Multi-purpose (lock), Pedestrian Wind
    Comfort, Compressible, Convective Heat Transfer, Conjugate Heat Transfer, Conjugate Heat
    Transfer (IBM), Multiphase
  - **STRUCTURAL**: Static, Dynamic, Heat Transfer, Thermomechanical, Harmonic, Frequency
    Analysis, Nonlinear Mechanical (Marc) (lock)
  - **ELECTROMAGNETIC**: Electromagnetics (lock)
- Right (rest): before a choice, centred italic grey "Nothing selected" with the line
  "Please select a Simulation type or use the filters if you are not sure which option to
  choose." After a choice: the analysis name, a paragraph describing it, a picture, and a
  **Create Simulation** button.
- Footer bar: bold "Need Help?" and "Click here if you are not sure about which option
  better suits your simulation needs." (a link).

TurboFlow shows the same list. Only **Incompressible** is enabled; every other row shows the
lock icon and the tooltip "Not available in TurboFlow yet". Workflow Type is left out.

On create: the simulation is named after the analysis ("Incompressible", then
"Incompressible 1"). If the project has exactly one geometry it is assigned; otherwise the
Geometry panel opens with a dropdown. The tree expands and the global settings panel opens.

### 9.2 Simulation tree (exact order and status rules)

The screenshot shows a **Static** (structural) tree; the Incompressible tree has the same
frame without Contacts, Connectors and Element technology, and with Initial conditions and
Advanced concepts added. Order for Incompressible:

```
- (icon) Incompressible                 selected row: light blue; menu: Rename, Duplicate, Delete
      Geometry                           node icon with a green tick overlay when assigned
      Geometry primitives          +     no status icon
      o  Local coordinate systems  +     blue hollow = optional
      v  Model                           green tick
      o  Materials                 +     red hollow until every region has a material
      v  Initial conditions              green tick
      o  Boundary conditions       +     red hollow until an inlet and an outlet exist (TurboFlow rule; SimScale shows blue)
      o  Advanced concepts         +     blue hollow
      v  Numerics                        green tick
      v  Simulation control              green tick
   +  Result control                     expandable, no icon; children: Forces and moments +, Surface data +, Probe points +, Field calculations +
   +  Mesh                               mesh icon with a blue dot until settings are saved, green tick after
      o  Simulation runs           +     red hollow until a run exists; TurboFlow labels the + "Queue"
```

Children created under a node (a material, a boundary condition, a refinement, a run)
appear as further indented rows with their own status icon and a "..." menu (Rename,
Duplicate, Delete). Runs expand to: Convergence plots, Residuals, Result control (one row
per item), Solution fields.

Global settings are opened by clicking the simulation row itself.

### 9.3 Global settings panel (click the simulation row)

Title: simulation name. Fields (from the real Workbench-created spec):

| Field | Control | Default | JSON |
|---|---|---|---|
| Turbulence model | dropdown: Laminar, k-epsilon, Realizable k-epsilon, k-omega, k-omega SST, LES Smagorinsky, LES Spalart-Allmaras | k-omega SST | `turbulenceModel`: NONE, KEPSILON, REALIZABLEKE, KOMEGA, KOMEGASST, SMAGORINSKY, SPALARTALLMARAS |
| Time dependency | dropdown: Steady-state, Transient | Steady-state | `timeDependency.type`: STATIONARY / TRANSIENT |
| Algorithm | greyed dropdown showing SIMPLE for steady, PIMPLE for transient (verified from a docs figure; the first row of the panel is "Analysis" with a blue chip "Incompressible") | SIMPLE | `algorithm` |
| Passive species | number 0 to 10 | 0 | `numOfPassiveSpecies` |
| Adjoint optimization | toggle, disabled in TurboFlow | off | `enableAdjointOptimization` |

Changing the turbulence model changes which initial-condition, numerics and inlet
turbulence fields exist (k and omega for k-omega family; k and epsilon for k-epsilon; nuTilda
for Spalart-Allmaras; none for Laminar). The panel keeps values of hidden fields (SimScale
2.0 keeps setup when switching).

### 9.4 Geometry panel (under the simulation)

Dropdown "Geometry" listing the project's geometries. Below: the same statistics as 7.3. If
the assigned geometry has a newer version, a yellow warning "A newer version of this
geometry exists" with an **Update** button; on update, the backend remaps every assignment by
STEP face id and reports "Mapped 411 of 412 faces. 1 face could not be mapped: Wall 1."

### 9.5 Model panel

For Incompressible: "Gravity" vector x, y, z in m/s² default 0, 0, 0 (`model.gravity`;
SimScale shows this only when a gravity-dependent option is on; TurboFlow shows it always,
read-only unless Transient) **[verify]**. The rest of the panel is a note "No further model
settings for this analysis type."

### 9.6 Materials. Verified from docs figures

`+` opens the **Material** dialog (710×680): title "Material"; left column a list of fluids,
one per row with a rule between rows, the selected row light blue: Air, Argon, Carbon
dioxide, Crude oil, Gaseous R-134a, Gasoline, Hydrogen, Liquid R-134a, Lubricating oil SAE
30 120C, Lubricating oil SAE 30 20C, Nitrogen, Seawater 3.5 pc saline, Sulphur dioxide,
Water. Right column shows the selected fluid's read-only properties: Viscosity model
Newtonian, (ν) Kinematic viscosity, (ρ) Density. Footer: **Apply** (blue) and Cancel.
TurboFlow ships the same list; the property values for every fluid are copied from
SimScale's library into `src/lib/materials.js` (Air: 1.529e-5 m²/s, 1.196 kg/m³; Water:
1e-6 m²/s, 997 kg/m³ **[verify the other twelve against the dialog before shipping]**).

Material panel (title is a text field with the material name, default "Air"):

| Field | Control | Air default (verified) | JSON |
|---|---|---|---|
| Viscosity model | dropdown: Newtonian, Power law, Cross power law, Bird-Carreau, Herschel-Bulkley | Newtonian | `viscosityModel.type` |
| (ν) Kinematic viscosity | number, unit dropdown m²/s | 1.529e-5 | `viscosityModel.kinematicViscosity {value, unit:"m²/s"}` |
| (ρ) Density | number, unit dropdown kg/m³ | 1.196 | `density {value, unit:"kg/m³"}` |
| Assignment (1 Volume) | toggle + trash, list box with "Flow region" | the single flow region is auto-assigned | `topologicalReference.entities` = region names |

Footer: "add from library" icon and trash icon.

### 9.7 Initial conditions panel

Sections, each with a "Global" value and a "Subdomains +" list:

| Section | Field | Default (Workbench-created spec) | Unit |
|---|---|---|---|
| Gauge pressure (p) | number | 0 | Pa |
| Velocity (U) | vector | 0, 0, 0 | m/s |
| Turb. kinetic energy (k) | number | 0.00375 | m²/s² |
| Specific dissipation rate (ω) | number | 3.375 | 1/s |
| Dissipation rate (ε) | number (k-epsilon only) | 0.0225 **[verify]** | m²/s³ |
| nuTilda | number (Spalart-Allmaras only) | 0 **[verify]** | m²/s |

Subdomain row: name, value, assignment (volumes or geometry primitives). JSON:
`initialConditions.gaugePressure.global.value` etc., `subdomains: [{name, value, topologicalReference, geometryPrimitiveUuids}]`.

### 9.8 Boundary conditions

`+` opens a dropdown menu (not a dialog): **Velocity inlet**, **Velocity outlet**,
**Pressure inlet**, **Pressure outlet**, **Wall**, **Symmetry**, **Custom**, **Fan**,
**Periodic**, **Empty 2D**, **Wedge**. Picking one creates a node "Velocity inlet 1" (numbered
per type) and opens its panel. A face may belong to only one boundary condition: assigning
an already-used face shows "This face is assigned to 'Wall 1'. Move it here?" with Move /
Cancel.

Every BC panel (verified from docs figures) has these rows in this order: **Boundary
conditions** (a dropdown that shows the type and lets the user switch it in place: Velocity
inlet, Velocity outlet, Pressure inlet, Pressure outlet, Wall, Symmetry, Custom, Fan,
Periodic, Empty 2D, Wedge), then the type-specific rows, then the **Assignment** block from
5.4. The tree node is named after the type ("Velocity inlet 1") until renamed in the title.
Verified examples: Wall > No-slip shows "(U) Velocity: No-slip" and "Turbulence wall: Wall
function"; Wall > Moving wall shows "(U) Velocity: Moving wall", a table/reset icon row,
Ux 0, Uy 10, Uz 0 m/s, then "Turbulence wall: Wall function"; Velocity inlet shows "(U)
Velocity: Fixed value", the icon row, Ux, Uy, Uz; Pressure outlet shows "Pressure type: Fixed
value", "(P) Gauge pressure" with the icon row and "0 Pa".

**Velocity inlet** (`VELOCITY_INLET_V3`)

| Field | Control | Default | JSON |
|---|---|---|---|
| (U) Velocity | dropdown: Fixed value, Fixed magnitude (no expression), Mean value, Volumetric flow rate, Mass flow rate, Freestream | Fixed value | `velocity.type`: FIXED_VALUE, FIXED_VALUE_NO_EXPRESSION, FIXED_MEAN, FLOW_RATE_INLET_VELOCITY (+`flowRate.type` VOLUMETRIC/MASS), FLOW_RATE_MEAN_INLET_VELOCITY, FREESTREAM |
| Ux, Uy, Uz | vector, m/s, each with a small "f(x)" button that switches the component to a table/formula input | 0, 0, 0 | `velocity.value.value.{x,y,z}` as `{type:"CONSTANT", value}` (SimScale's `DimensionalVectorFunction_Speed`), `unit:"m/s"` |
| Flow rate | number m³/s or kg/s (when a flow rate type is chosen) | 0 | `velocity.flowRate.value` |
| Turbulence | dropdown: Automatic (default), Intensity and length scale, Fixed values | Automatic | `turbulence.type`: AUTOMATIC_TURBULENCE, TURBULENT_INTENSITY_AND_REFERENCE_LENGTH_TURBULENCE, FIXED_VALUE_TURBULENCE |
| Turbulence intensity | number, fraction (0.05 = 5%) | 0.05 **[verify]** | `turbulence.turbulenceIntensity` |
| Reference length | number, m | 0.1 **[verify]** | `turbulence.referenceLength` |
| k, ω (Fixed values) | numbers | 0.00375, 3.375 | `turbulence.turbulentKineticEnergy`, `turbulence.omegaDissipationRate` |

**Velocity outlet** (`VELOCITY_OUTLET_V7`): (U) Velocity dropdown: Fixed value, Mean value,
Volumetric flow rate, Mass flow rate, Stable flow rate; vector or number field.

**Pressure inlet** (`PRESSURE_INLET_V31`): Pressure dropdown: Total pressure (default),
Fixed value, Mean value; value in Pa, default 0; Turbulence as for velocity inlet.

**Pressure outlet** (`PRESSURE_OUTLET_V30`)

| Field | Control | Default | JSON |
|---|---|---|---|
| (P) Pressure | dropdown: Fixed value, Mean value | Fixed value | `gaugePressure.type`: FIXED_VALUE / FIXED_MEAN |
| Value | number, Pa, with f(x) | 0 | `gaugePressure.value {value:{type:"CONSTANT",value:0}, unit:"Pa"}` |

**Wall** (`WALL_V34`)

| Field | Control | Default | JSON |
|---|---|---|---|
| (U) Velocity | dropdown: No-slip, Slip, Moving wall, Rotating wall | No-slip | `velocity.type`: NO_SLIP, SLIP, MOVING_WALL_VELOCITY, ROTATING_WALL_VELOCITY |
| Wall treatment (No-slip, Moving, Rotating) | dropdown: Wall function, Full resolution | Wall function | `velocity.turbulenceWall`: WALL_FUNCTION / FULL_RESOLUTION |
| Surface roughness (No-slip) | toggle + number m | off, 0 | `velocity.enableSurfaceRoughness`, `velocity.surfaceRoughness` |
| Velocity vector (Moving wall) | vector m/s | 0,0,0 | `velocity.value {value:{x,y,z}, unit:"m/s"}` (plain vector, no CONSTANT wrapper) |
| Orientation reference (Moving wall) | dropdown: Flow domain, Geometry | Flow domain | `velocity.orientationReference` |
| Point on axis (Rotating) | vector m | 0,0,0 | `velocity.rotation.rotationCenter` |
| Rotation axis (Rotating) | vector | 0,1,0 | `velocity.rotation.rotationAxis` |
| Rotational velocity (Rotating) | number, unit dropdown rad/s or °/s, f(x) | 0 | `velocity.rotation.angularVelocity {value:{type:"CONSTANT",value}, unit:"rad/s"}` |

TurboFlow addition inside Wall > Rotating wall: a button **Fill from wheel** that takes the
assigned cylindrical faces, computes centre and radius from `faces.json`, sets the axis to
the cylinder axis and the angular velocity to U_inlet / r (U_inlet read from Velocity inlet
1). This is what `/prepare` does today; it moves into the UI.

**Symmetry** (`SYMMETRY`): assignment only.

**Custom** (`CUSTOM_V37`): per-variable dropdowns (U, p, k, ω): Fixed value, Zero gradient,
Inlet-outlet, Fixed gradient etc. Ship the panel with the API's option list and mark
**[verify]** on the visible labels.

**Fan** (`FAN`), **Periodic** (`PERIODIC`), **Empty 2D** (`EMPTY_2D`), **Wedge** (`WEDGE`):
present in the menu; panels show the API fields; rarely used, mark **[verify]**.

### 9.9 Advanced concepts

Four sub-nodes each with `+`: Rotating zones (MRF / AMI: name, rotation axis origin and
direction, rotational velocity rad/s, assignment = a cylinder geometry primitive or a cell
zone), Momentum sources (Average velocity or Fan model), Porous media (Darcy-Forchheimer:
d and f vectors, coordinate system, assignment = cartesian box primitive), Passive scalar
sources. TurboFlow ships the panels with API field names; marks them **[verify]**; a school
car never needs them but the tree must show them.

### 9.10 Numerics panel

Header note (SimScale's own): "In most cases the standard settings are a good choice and
should not be changed without reason." Bottom-left link **Reset to default**.

| Section | Field | Default (Workbench spec) | JSON |
|---|---|---|---|
| Relaxation | Relaxation type | Manual | `relaxationType` MANUAL / AUTOMATIC |
| | Pressure field | 0.3 | `relaxationFactor.pressureField` |
| | Velocity equation | 0.7 | `relaxationFactor.velocityEquation` |
| | k equation | 0.3 | `relaxationFactor.turbulentKineticEnergyEquation` |
| | ω equation | 0.3 | `relaxationFactor.omegaDissipationRateEquation` |
| | Age of fluid equation | 0.8 | `relaxationFactor.ageOfFluidEquation` |
| Correctors | Non-orthogonal correctors | 1 | `numNonOrthogonalCorrectors` |
| Pressure reference | Reference cell | 0 | `pressureReferenceCell` |
| | Reference value | 0 Pa | `pressureReferenceValue` |
| Residual controls | U, p, k, ω absolute tolerance | 1e-6 each | `residualControls.velocity.absoluteTolerance` etc. |
| Solvers > Velocity | Type | PBiCGStab | `solvers.velocitySolver.type` |
| | Absolute tol. / Relative tol. | 1e-8 / 0.01 | |
| | Preconditioner | DILU | `preconditioner.type` |
| Solvers > Pressure | Type | GAMG | |
| | Abs / Rel | 1e-6 / 0.001 | |
| | Smoother | Gauss-Seidel | `smoother` GAUSSSEIDEL |
| | Pre / post sweeps | 2 / 1 | `numPreSweeps`, `numPostSweeps` |
| | Cache agglomeration | on | `cacheAgglomerationOn` |
| | Cells on coarsest level | 100 | `numCellsCoarsestLevel` |
| | Merge levels | 1 | `numMergeLevels` |
| Solvers > k, ω | same as velocity | PBiCGStab, 1e-8, 0.01, DILU | |
| Schemes | Time differentiation | Steady state | `schemes.timeDifferentiation.forDefault.type` STEADYSTATE (EULER, BACKWARD, CRANK_NICOLSON for transient) |
| | Gradient (default, p, U) | Cell limited least squares, coeff 1 | `CELLLIMITED_LEASTSQUARES`, `limiterCoefficient` |
| | Divergence default | Gauss linear | `GAUSS_LINEAR` |
| | Divergence U | Gauss linear upwind V grad(U) | `GAUSS_LINEARUPWINDV_GRAD_U_` |
| | Divergence k, ω | Bounded Gauss upwind | `BOUNDED_GAUSS_UPWIND` |
| | Laplacian | Gauss linear limited corrected 0.5 | `GAUSS_LINEAR_LIMITED_CORRECTED`, 0.5 |
| | Interpolation | Linear | `LINEAR` |
| | Surface normal gradient | Limited 0.5 | `LIMITED`, 0.5 |

Solver type options per equation: PBiCGStab, PBiCG, PCG (pressure), GAMG, smoothSolver.
Preconditioners: DILU, DIC, GAMG, none. Smoothers: Gauss-Seidel, symGauss-Seidel, DIC,
DICGaussSeidel. Send the exact enum strings from the API (`PBICGStab`, `GAMG`,
`GAUSSSEIDEL`).

### 9.11 Simulation control panel (verified from a docs figure: End time 1000 s, Delta t 1 s, Write control Time step, Write interval 1000, Number of processors with a PRO badge = Automatic, Maximum runtime 1e+4 s, Potential flow initialization toggle, Decompose algorithm Scotch)

| Field | Control | Default (Workbench spec) | JSON |
|---|---|---|---|
| End time | number, s (label says "End time" and the hint says "Number of iterations for steady-state") | 1000 | `endTime {value, unit:"s"}` |
| Delta t | number, s | 1 | `deltaT` |
| Adjustable time step (transient only) | toggle + Max Courant number (0.7) + Max Δt | off | `adjustableTimestep` |
| Write control | dropdown: Time step, Clock time, Runtime, CPU time, Adjustable runtime | Time step | `writeControl.type` TIME_STEP, CLOCK_TIME, RUNTIME, CPU_TIME, ADJUSTABLE_RUNTIME |
| Write interval | number | 1000 | `writeControl.writeInterval` |
| Number of processors | dropdown: Automatic, 4, 8, 16, 32, 48, 64, 96 | Automatic | `numProcessors`: -1 for Automatic |
| Maximum runtime | number, s | 20000 | `maxRunTime {value, unit:"s"}` |
| Potential flow initialization | toggle | off | `potentialFoamInitialization` |
| Decompose algorithm | dropdown: Scotch, Simple, Hierarchical | Scotch | `decomposeAlgorithm.type` |

TurboFlow rule: the credit price shown on the Start dialog (11.2) is computed from End time
and the mesh fineness exactly as `functions/src/lib/pricing.ts` does. Show it live under the
End time field: "Estimated cost: 125 credits".

### 9.12 Result control

Sub-nodes with `+`:

**Forces and moments** `+` menu: Forces and moments, Force and moment coefficients.

Forces and moments panel: Name; Centre of rotation (vector, m, default 0,0,0); Write control
(Time step); Write interval (default 1); Export statistics (toggle, on); Fraction from end
(0.2); Assignment (faces). JSON `FORCES_AND_MOMENTS`.

Force and moment coefficients panel: Name; Centre of rotation; Lift direction (vector,
default 0,0,1); Drag direction (default 1,0,0; TurboFlow prefills -1,0,0 when the inlet
velocity is negative x, as the worker does); Pitch axis (0,1,0); Freestream velocity
magnitude (m/s, prefilled from Velocity inlet 1); Reference length (m); Reference area (m²,
prefilled from the geometry service's measured frontal area when available); Write
interval; Assignment. JSON `FORCE_AND_MOMENT_COEFFICIENTS`.

**Surface data** `+`: Area average, Area integral. Panel: Name; Write control; Write
interval; Assignment (faces). Fields to plot are chosen by the solver (p, U components).

**Probe points** `+`: Panel: Name; a table of points (x, y, z in m) with Add row / Delete
row and "Pick in viewer" (click on the model adds a row); Write interval. JSON
`PROBE_POINTS` with `probeLocations {type:"TABULAR", tableId}` (the table is uploaded with
`POST /projects/{id}/tableimports`; Part B).

**Field calculations** `+`: Pressure (Pressure coefficient / Total pressure, needs
freestream velocity and reference pressure), Turbulence (y+ RAS, Reynolds stress),
Velocity (Vorticity), Friction velocity (wall shear stress, y+), Surface normals, Wall
fluxes, Mean age of fluid. Each is a small panel of one or two dropdowns. Keys:
`PRESSURE`, `TURBULENCE`, `VELOCITY`, `FRICTION_VELOCITY_U_TAU`, `SURFACE_NORMALS`,
`WALL_FLUXES`, `AGE_OF_FLUID`.

### 9.13 The Assignment box (used by every panel that assigns entities)

```
ASSIGNMENT                                   [Faces v]   (entity type dropdown where SimScale allows a choice)
+------------------------------------------------------------+
| Select faces in the viewer, or pick a saved selection.      |  (hint, grey)
| ● Inlet (saved selection)                            [x]   |
| ● A1_I1_B10_TE12                                     [x]   |
| ● A1_I1_B10_TE3                                      [x]   |
|   ... 409 more                                              |
+------------------------------------------------------------+
[Add selection from viewer]  [Saved selections v]  [Clear all]     [+ Create geometry primitive] (only where primitives are allowed)
```

Behaviour:
- Opening the panel switches the viewer selection mode to the box's entity type and paints
  already-assigned entities blue.
- Clicking entities in the viewer adds them immediately to the draft (SimScale does this
  live; the ✓ still has to be pressed to save).
- **Add selection from viewer** adds the current viewer selection (for people who selected
  first and opened the panel after).
- **Saved selections** dropdown lists the geometry's saved selections; picking one adds it as
  a set reference (JSON `topologicalReference.sets`), shown as one row with a bookmark icon.
- The x removes one row. **Clear all** empties the box.
- Row hover highlights the entity in the viewer. Rows show SimScale's face name (from the
  mappings) with the CAD solid name in grey.
- Counts are shown in the panel header: "Assignment (412 faces)".

---
## 10. Meshing

### 10.1 Mesh panel (click the Mesh node). Verified from docs figures

Title "Mesh" (renamable; the tutorial renames it "Hexahedral Mesh"). The panel starts with
a **Mesh selection** section: a row with a mesh icon, the mesh name and a chevron
(dropdown of existing meshes for this geometry), and under it grey text "Estimate |
1.6M - 2.5M cells, 2M - 3M nodes" once an estimate exists. TurboFlow has no separate
estimate call in queue mode; show "Estimate appears after the first run" until a run exists,
then the last run's real cell and node counts.

| Field | Control | Default | JSON (`SimmetrixMeshingFluid`, type `SIMMETRIX_MESHING_FLUID_V16`) |
|---|---|---|---|
| Algorithm | dropdown: Standard (default), Hex-dominant, Hex-dominant parametric | Standard | Standard = `SIMMETRIX_MESHING_FLUID_V16`; the two hex options are listed and disabled in TurboFlow ("Not available yet") |
| Sizing | dropdown: Automatic mesh sizing, Manual | Automatic mesh sizing | `sizing.type` AUTOMATIC_V9 / MANUAL |
| Fineness | dropdown of words for the automatic sizing: Very coarse, Coarse, Moderate (default), Fine, Very fine, plus a "Custom" entry that reveals a slider 1 to 10 step 0.1 | Moderate = 5.0 | `sizing.fineness` (multiple of 0.1: Very coarse 1, Coarse 3, Moderate 5, Fine 7, Very fine 9) |
| Max edge length, Min edge length (Manual) | numbers, m | from bbox | `sizing.maximumEdgeLength`, `minimumEdgeLength` |
| Curvature | dropdown: Automatic, Relative (+ nodes per circle) | Automatic | `sizing.curvature.type` |
| Automatic boundary layers | toggle | on | `automaticLayerSettings.type` AUTOMATIC_LAYER_ON / OFF |
| Physics-based meshing | toggle | on | `physicsBasedMeshing` |
| Hex element core | toggle | on | `hexCore` |
| Number of processors | dropdown with a "PRO" badge on the label: Automatic, 4, 8, 16, 32, 48, 64, 96 | Automatic | `numOfProcessors` -1 |
| Maximum meshing runtime | number, s | 3600 **[verify]** | `maxMeshingRunTime` |
| Advanced settings (collapsed) | Small feature suppression (0 m), Gap refinement factor (0.05), Global gradation rate (1.22) | | `advancedSimmetrixSettings` |

Footer (SimScale): an upload icon at the left, grey text "Estimation 14 - 21 min | 0.94 -
1.42 core hours" in the middle, and a **Generate** button at the right. Footer (TurboFlow,
queue mode): the grey text "The mesh is built when the run is queued" and no Generate
button; ✓ saves the settings and the tree node turns green. After a run exists the panel
gains **Mesh log** and **Mesh quality** links and a "Show mesh from run" dropdown.

Mesh node children (verified): **Refinements +**, **Refinement regions +** (geometry
primitives used by refinements), **Meshing Log**, **Mesh quality**, **Meshing Job Info**.
In TurboFlow the last three read from the most recent finished run.

### 10.2 Refinements

`+` on the Refinements node opens a menu (verified from a docs figure): **Surface custom
sizing**, **Volume custom sizing**, **Inflate boundary layer**, **Extrusion mesh
refinement** (Local element size, Swept mesh and Thin section appear for solid meshes only).
Each creates a node "Surface custom sizing 1" and opens its panel. Verified panels: Region
refinement: "Refinements: Region refinement", "Refinement mode: Inside", "Maximum edge
length 0.01 m", "Assigned Volumes (0) Clear list", "No Volumes assigned", "Geometry
primitives +". Inflate boundary layer: "Layer gradation control: Specify growth rate",
"Number of layers 3", "Overall relative thickness 0.4", "Growth rate 1.5", "Assigned Faces
(0)". Cartesian box primitive: "Geometry primitives: Cartesian box", Minimum x y z (with a
pick icon), Maximum x y z, unit m each.

| Refinement | Fields | JSON type |
|---|---|---|
| Surface refinement | Sizing: Automatic (fineness slider 1 to 10, default 5) or Custom (Default size m, Min size m, Curvature); Assignment (faces) | `SURFACE_CUSTOM_SIZING`, `sizing.type` AUTOMATIC_V9 / CUSTOM |
| Region refinement | Mode: Inside (Default size, Min size) or Distance (table of Distance / Size rows); Assignment (volumes or geometry primitives via `+ Create geometry primitive`) | `VOLUME_CUSTOM_SIZING`, `customSizingModes.type` INSIDE_CUSTOM_SIZING / DISTANCE_CUSTOM_SIZING; primitives via `geometryPrimitiveUuids` |
| Inflate boundary layer | Layer type dropdown: Fractional height, Geometric growth, First layer growth; Number of layers (3); Overall relative thickness (0.4); Growth rate (1.5); Assignment (faces) | `SIMMETRIX_BOUNDARY_LAYER_V13` |
| Local element size | Max edge length m; Assignment (faces/edges) | `SIMMETRIX_LOCAL_SIZING_V10` |
| Swept mesh | Sizing: Number of elements or Element thickness; Surface element type; Start face; End face; Assignment (volumes) | `SIMMETRIX_SWEPT_MESH_REFINEMENT` |
| Thin section | Distance type; Sizing; Assignment | `SIMMETRIX_THIN_SECTION_MESH_REFINEMENT` |
| Extrusion | Sizing type; Surface element type; Assignment | `SIMMETRIX_EXTRUSION_MESH_REFINEMENT` |

Defaults marked with numbers here are SimScale's visible defaults **[verify]** except where
the API has a default (fineness 5.0).

### 10.3 Mesh log and Mesh quality

**Mesh log** opens a dialog with a monospace text area: the SimScale mesh operation event log
(Part B, 14.7) plus a summary table: cells, nodes, faces, edges, prisms, tets, hexes, pyramids.

**Mesh quality** opens a dialog with a table: metric (Aspect ratio, Non-orthogonality, Volume
ratio, Skewness, Tet edge ratio), min, max, average, standard deviation, 99.9th percentile,
and an overall quality score. Below: "Show in viewer" buttons per metric that colour the mesh
surface by that metric (needs the mesh surface with per-cell metrics; Part B, 14.8).
Thresholds shown in grey: "CFD non-orthogonality should stay below 88."

### 10.4 Mesh display

When the Mesh node or a refinement is selected and a finished run exists for this
simulation, the viewer can show that run's mesh surface (wireframe over surfaces) instead of
the CAD, chosen with the "Show mesh from run" dropdown in the Mesh panel. A toggle in the viewer toolbar area
"Show mesh" appears; default on. The Edge and Node selection modes become enabled.

### 10.5 Mesh clip panel. Verified from a docs figure

The clip button in the viewer toolbar (last icon) opens a floating panel titled **Cutting
Plane** with an X at the right. Sections: **Reference point** with three sliders X, Y, Z
(each spanning the model's extent, value shown under the slider, e.g. 0.0738), and
**Normal** with three sliders X, Y, Z from -1 to 1 (value under each, e.g. -1, 0, 0). Footer:
a **Switch Normal** button (flip) at the left and a blue **Generate Mesh Clip** button at
the right. The plane is drawn in the viewer as a translucent grey rectangle while editing.
The generated clip is listed in the right panel under a new **MESH CLIPS** header as "Mesh
Clip 1" (selected row light blue), under the **MESH** header ("Mesh 1") and the
**TOPOLOGICAL ENTITY SETS** header. Several clips can exist; each has an eye icon.

---

## 11. Simulation runs

### 11.1 Queue a run (SimScale calls this Start; TurboFlow calls it Queue)

`+` on Simulation runs is enabled only when: geometry assigned, at least one material, an
inlet and an outlet with faces, mesh settings saved (validation.ok is true). Otherwise its tooltip lists what is missing
("Missing: mesh, Velocity inlet 1 has no faces").

Clicking `+` runs TurboFlow's own validation (Part B, 14.5; SimScale's own check happens
inside the worker after queueing) and shows a dialog:

Title "Queue simulation run". Fields: **Name** (default "Run 1", numbered), a read-only
summary: mesh name and cell count, end time, number of processors, and the TurboFlow price
line "This run costs 125 credits. You have 1,240." Warnings from validation are listed with a
yellow icon; errors with red and the Queue button disabled. Buttons: Cancel, **Queue**
(primary). SimScale shows an estimated core-hour range here; TurboFlow shows the credit price.

On Queue: the run node appears under Simulation runs with a spinner, the job status panel
shows it, and the run panel opens. The run panel then shows the worker's stage text in order:
Queued, Uploading to solver, Importing geometry, Checking setup, Meshing 43%, Running 12%,
Downloading results, Finished.

### 11.2 Run panel. Verified from a docs figure

Title = run name ("Run 1") with ✓ and ✕. Rows: **Creation time** (e.g. "Oct 22, 2020 3:27
PM"), **End time** (finish time), then a collapsible **Event log** section (timestamped
lines with severity). Footer bar: a list icon (solver log), a download icon (results
download menu), a status block in the middle ("Finished" in green with "14 min - 2.0 core
hours" under it; TurboFlow shows "14 min - 125 credits"), a **>>** button with tooltip
"Continue the run" (SimScale only; TurboFlow hides it because the API has no continue), and
a filled blue **Post-process results** button at the right. While running, the status block
shows the stage text and a percentage and the footer has a **Cancel** button instead.

SimScale's continue dialog (for reference only): End time 1000 s, Maximum runtime 10000 s,
Continue / Cancel.

Under the run panel, the summary table with drag (N), lift (N), side (N), Cd, Cl appears
when force result controls existed (TurboFlow addition).

### 11.3 Plots under a run. Verified from docs figures

Tree under a finished run, in this order: **Settings** (expandable, read-only copy of the
setup), **Convergence plots** (expandable: Domain, Inlets, Outlets, Walls, Residuals),
**Solution Fields** (click opens the post-processor), **Solver Log**, **Simulation Job
Info** (expandable), **Meshing Job Info** (expandable). Result-control plots (forces,
coefficients, area averages, probes) are listed under **Result control** inside the run.

Plot panel: SimScale renders with Highcharts. Draw the same: a line chart 560px wide, x
axis "Time (s)" (iterations for steady runs), y axis label "Residual" with a log scale for
residuals (1e-8 to 100 gridlines) and a linear 0 to 1.25 scale for the four convergence
plots (each variable normalised), series Ux, Uy, Uz, p, k, omega in distinct colours with
a marker legend centred under the chart, hover crosshair with values. The four convergence
plots are shown as a 2×2 grid (Domain, Walls, Inlets, Outlets) each with its own legend.
Buttons above the chart: Log scale toggle, Download CSV, Download PNG, Expand. Plots refresh
every 30 s while the run is running.

### 11.4 Run statuses and colours

Queued (grey), Running (blue with progress), Finished (green), Cancelled (yellow), Failed
(red, with the first error line under the name). These map to SimScale's `Status` enum:
READY, QUEUED, RUNNING, FINISHED, CANCELED, FAILED.

---

## 12. Post-processor

Opened by the run panel button, or by clicking **Solution fields** under a run. The route
gets `/post`. The whole Workbench stays (top bar, tree), but:

- the settings panel is replaced by the **Filters panel** on the left of the viewer,
- the scene tree on the right is replaced by the **Parts panel** (parts list with eyes and a
  colour dropdown),
- a **ribbon** of icons appears top-right of the viewer,
- a **legend** appears at the left of the viewer when a field is chosen,
- a **frame bar** appears at the bottom for transient results or animations,
- the **Parts color** dropdown sits at the top of the Parts panel.

### 12.1 Layout. Verified from docs figures

Opening Solution fields keeps the top bar, the left tree card and the Job status card, and
adds:

- A **ribbon** across the full width directly under the top bar, 56px tall, white, grouped
  with small grey group labels at the left of each group and icon+caption buttons:
  - **FILTERS**: Cutting Plane, Particle Trace, Iso Surface, Iso Volume, Rotational,
    Displacement, Animation, Field Calculator (BETA badge)
  - **VIEW**: Filters, Legend, Statistics, Inspect point, Toggle UI, Save view, Manage views
  - **COMPARE**: Compare (and Sync views once compare is on)
  - **CAPTURE**: Screenshot, Record (BETA badge)
  - **RESULT**: Reset, Import view (also seen as "Apply state"), Download, Share
  Active buttons have a light blue background. Buttons that do not apply to the result type
  (Rotational, Displacement for CFD) are greyed.
- The **Filters panel**: a floating card 360px wide over the top-left of the viewer, header
  "Filters" with ✓ and ✕ (some versions show only an X), a grey line "Your changes are saved
  automatically.", then one row per filter: chevron, icon, name, and at the right a ≡ menu
  icon, a trash icon and an on/off toggle. **Parts Color** is always the first row. Clicking
  a row expands its settings inline.
- The right panel becomes two cards: **MESH** (lists the flow region) and **ITERATIONS**
  with four buttons (first, previous, next, last), the current step in a number box (e.g.
  1000) and a slider from 0 to the last step.
- The viewer toolbar shrinks to four buttons: render mode, a second cube (fit/view), select
  solids, select faces.
- The **legend** sits at the bottom centre of the viewer: field name in bold with a ≡ icon
  (options menu), a unit dropdown ("Pa ⌄"), then a horizontal colour bar about 380px wide
  with tick labels above it (e.g. -197.1, -143.4, -89.8, -36.2, 17.5, 71.11) and a black
  triangle at each end that can be dragged to change the range. The min and max labels are
  editable boxes.
- The orientation widget gains a camera icon (saved views) at its top-left.
- A round support bubble sits above the orientation widget (TurboFlow: the Help popover).

### 12.2 Ribbon buttons. Verified

| Button | Behaviour |
|---|---|
| Filters | Shows or hides the Filters panel. |
| Legend | Shows or hides the legend. |
| Statistics | Then click a face or a plane: a card appears at the right of the viewer, 290px wide: "Faces: 1", the field name, then rows Surface Area, Maximum (red), Average, Minimum (blue), a **Highlight in Model** toggle (draws Min and Max labels on the model), Integral, Volumetric Flow Rate, each with a copy icon, and the footnote "*Statistics are based on interpolated data. Learn more". |
| Inspect point | Click the model: a white label appears at the point with "Velocity Magnitude [m/s]" and the value. Pins clear when the field changes. |
| Toggle UI | Hides all panels for a clean screenshot. |
| Save view | Dialog "Save view": View name (default "{simulation} - {run}"), View description (default "View 1"), Cancel, Save. |
| Manage views | Dialog listing saved views with rename and delete icons and an Apply button. |
| Compare | Splits the viewer in two; a dropdown at the top of each half names its run ("Static - Mesh 1 ⌄"); the left dropdown is the current run. Sync views toggles camera sync. |
| Screenshot | Blue capture frame, "Take screenshot", then a name and description dialog. |
| Record | Renders the animation to a GIF. |
| Reset | "Reset the post-processor to defaults?" |
| Import view / Apply state | Copies the post-processing state from another run. |
| Download | Downloads the solution fields package. |
| Share | Copies a link to the current view. |

### 12.3 Filters panel

Top: a toolbox of buttons, one per filter type, each "+ Name". Below: the list of created
filters. Each row: name (renamable), ON/OFF toggle, duplicate icon, delete (trash). Clicking
a row opens its settings inline (accordion) with ✓ and ✕ at the bottom. Filters combine.

**Parts color** (top of the Parts panel): dropdown listing Solid color (default), then every
field: Pressure, Velocity magnitude, Velocity x/y/z, Turbulent kinetic energy, Specific
dissipation rate, Turbulent viscosity, plus any field calculation (Pressure coefficient,
Wall shear stress, y+, Vorticity). Choosing a field colours the surfaces and shows the legend.

**Cutting plane** (verified): rows in order: **Position** (a slider along the normal plus a
crosshair "pick in viewer" icon; expanding shows x, y, z boxes), **Orientation** (a
three-button segmented control X / Y / Z and a flip icon; a Custom normal is entered by
expanding), **Coloring** (field dropdown; default the current Parts Color field), then a
collapsible **Vectors** section with a toggle: **Vector field** (Velocity), **Coloring**
(Solid color with a colour swatch, or a field), **Scale factor** (slider + box, 0.05),
**Grid spacing** (slider + box, 0.02), then **Clamping** (two-thumb slider) and
**Filtering** (two-thumb slider). Opacity and "Show mesh" toggles appear at the bottom
**[verify]**.

**Particle trace** (verified): **Pick Position** (crosshair icon; click a face to seed),
**# Seeds horizontally** (slider + box, 50), **# Seeds vertically** (8), **Spacing** (1e-2),
**Coloring** (Velocity Magnitude), **Representation** (Cylinders, Comets, Spheres), **Size**
(1e-3), **Trace both directions** (toggle), then a collapsible **Massed particles** section
with its own toggle (particle mass, diameter, density for inertial tracking).

**Iso surface**: Iso scalar (field dropdown), Iso value (number with the field's unit; a
slider spanning the field range), Coloring, Opacity, Render mode (Surface / Wireframe).

**Iso volume**: Iso scalar, Minimum, Maximum (two-thumb slider plus boxes), Coloring,
Opacity.

**Particle trace**: Seed: Pick position (click a face in the viewer; the seed face is shown
as a small rectangle handle you can drag and resize), #Seeds horizontally (50), #Seeds
vertically (8), Spacing (1e-2 m), Coloring (Velocity magnitude), Representation
(Cylinders / Comets / Spheres), Size (1e-3), Trace both directions (off), Num pulses (for
comets), Relative comet length.

**Plot over path**: Pick points (click in the viewer, list of points with x,y,z), Number of
subdivisions (100), Field variable, **Generate plot** (opens a plot panel like 11.3 with
distance on x), Download CSV / PNG.

**Displacement**: not applicable to fluid runs; listed disabled with tooltip "Structural
results only".

**Animation**: Animation type (Particle trace / Transient), Steps (frame count, 50),
Play/Pause, speed dropdown (0.5×, 1×, 2×), **Record** (see ribbon).

**Field calculator**: Name, Formula (text with autocomplete of field names and operators
`+ - * / ^ sqrt abs mag`), **Compute formula**; the result appears in the field dropdowns.
Example in the placeholder: `p + 0.5 * 1.196 * mag(U)^2`.

### 12.4 Legend. Verified from a docs figure

Horizontal bar at the bottom centre of the viewer. Parts, left to right and top to bottom:
the field name in bold ("Velocity Magnitude") with a ≡ icon that opens the options menu
(colour scheme, number of divisions, scale to full range, reverse), a unit dropdown
("m/s ⌄"), then the bar: an editable min box at the left end ("0"), tick labels along the
top ("4.887e-1, 9.775e-1, 1.47, 1.95"), an editable max box at the right end ("2.444"), the
colour bar itself divided into 20 bands by default, and a black triangle under each end that
can be dragged to narrow the range. Editing min or max persists per field per project.

### 12.5 Parts panel and colouring. Verified

**Parts Color** is the first row of the Filters panel. Expanded it shows **Coloring** (a
dropdown: Solid color, Pressure, Velocity Magnitude, Velocity x/y/z, Turbulent Kinetic
Energy, Specific Dissipation Rate, Turbulent Viscosity, plus any field calculation) and
**Opacity** (a slider). Right-click on the model: Hide selection, Show all, Edit color
(palette, hex, RGBA), Reset color, Reset all, Select volume / Select face.

### 12.6 Frame bar

Only for transient results or when an animation filter exists: first, previous, play, next,
last buttons; a slider; "Time step 12 of 12 (t = 1000)". For steady runs it shows only the
final step and is hidden unless an animation filter exists.

### 12.7 What the viewer needs from the backend for post-processing

Surface data per run: `results.glb` (boundary surfaces, vertex order preserved) plus
`fields/{name}.bin` (float32 per vertex, magnitude for vectors, plus `_x/_y/_z` files for
vectors so the component view works) and `fields.json` with min/max per field. This is what
the existing worker produces, extended with per-component vector files.

Volume filters (cutting plane, iso surface, iso volume, particle trace, plot over path,
statistics on planes) need cell data. Two options; TurboFlow uses the **server-side** one:
the browser sends the filter definition to a Cloud Run "postprocess" service that holds the
run's VTU on disk, computes the filter with VTK Python (`vtkCutter`, `vtkContourFilter`,
`vtkThreshold`, `vtkStreamTracer`, `vtkProbeFilter`) and returns a small GLB (geometry plus
per-vertex field). Results are cached in Storage under the run keyed by a hash of the filter
definition, so re-opening a saved view is instant. Client-side vtk.js over the full volume
is not used because a 5 million cell mesh does not fit in a browser tab.

Vectors on a cutting plane are computed server-side too (points + vectors in a small binary)
and drawn client-side with an `InstancedMesh` of arrows.

### 12.8 Save semantics

Every filter change is applied to the viewer immediately (SimScale behaves this way in the
post-processor: no ✓ needed to preview). The ✓ at the bottom of a filter's accordion commits
the settings to the post-processing state document; ✕ reverts. The state document (filters,
colouring, camera, visibility, legend ranges) is saved per run, so reopening a run restores
the view. "Reset" clears it.

### 12.9 Mistakes to avoid in the post-processor

- Do not decode field binaries with a header. They are raw float32, `vertexCount * 4` bytes,
  native endianness (little endian in practice).
- The GLB is exported with `process=False` so vertex order matches the binaries; any
  re-processing (Draco, mesh optimisation, `mergeVertices`) breaks colouring silently.
- Clear pins when the field changes.
- When the legend range is edited, do not re-request data; only the colour mapping changes.
- Iso value sliders must use the field's true min/max from `fields.json`, not the visible
  surface's.
- The final time step must be selected by time index, not by file size (an open bug in the
  worker, `simscale_job.py` near line 801; Part B fixes it).

---
# PART B: BACKEND (FIREBASE), QUEUE MODE

Decided by Shashank on 10 Sep 2026: the Workbench is **not** a live front end over
SimScale. A person uploads a model, sets the simulation up in our UI, and presses
**Queue**. Only then does one backend job send the file to SimScale, mesh it, run it,
download the results and convert them for the viewer. Nothing touches SimScale before
Queue. Every project is private. Only STEP, IGES and STL files are accepted.

Every feature below is written twice: **In plain words** (what it does and why, for anyone)
and **Technical detail** (exactly what to build, for the agent). Then a **BUILD PROMPT**
block you can paste as-is, and a **Check** that proves it works.

## 13. Architecture

### 13.1 The picture

```
Browser (Vite + React + three.js)
   | Firebase Auth ID token on every call
   | Firestore listeners (read)            Firestore writes (only the fields the rules allow)
   | Storage resumable upload (raw CAD)    Storage signed-URL downloads (GLB, fields, plots)
   | Cloud Functions callables (anything that costs money or starts work)
   v
Cloud Functions v2, TypeScript, functions/src/
   callables:  createProject, updateProject, deleteProject, copyProject, shareProject,
               createFolder, moveToFolder, createUploadIntent (exists, extended),
               applyCadOperation, createSimulation, saveSimulation, queueRun, cancelJob,
               postprocessFilter, saveView, createScreenshotUrl
   triggers:   onGeometryUploaded (Storage finalize), onJobPending (exists, Firestore),
               onJobFinished (new, Firestore), onUserCreate (exists, Auth)
   v
Cloud Run (Python, private, called with the functions service account)
   tessellate    exists: /inspect /prepare /transform /tessellate  (+ new /measure)
   simscale-job  exists: one Cloud Run Job per queued run, now with SPEC_MODE
   postprocess   new:    /filter /statistics /probe /plot-over-path /mesh-clip /gif
   v
SimScale REST API v0 (api.simscale.com/v0, header X-API-KEY)   one account key, Secret Manager
Firebase Storage (users/{uid}/geometries/..., results/{jobId}/...)
```

**In plain words.** The browser never talks to SimScale. It talks to our Firebase project.
When a user presses Queue, a document is written that says "run this". A function sees that
document, takes the credits, and starts a worker. The worker does all the SimScale steps
in order and writes progress back to the same document. The browser just watches the
document and draws what it says.

**Technical detail.** One SimScale project holds every run (today's
`SIMSCALE_PROJECT_ID`). Runs are named `tf-{jobId}` so they can be found again. The
worker owns every SimScale call and every poll. No scheduled function. Cloud Functions are
short (under 60 s) and never wait on SimScale.

### 13.2 Secrets and config

| Name | Where | Value |
|---|---|---|
| `SIMSCALE_API_KEY` | Secret Manager (`defineSecret`) and the Cloud Run Job env | The key given on 10 Sep 2026. Rotate it if it was ever pasted anywhere public. |
| `SIMSCALE_PROJECT_ID` | env | The one SimScale project all runs go into (today: `5616012877102652879`, "turbo") |
| `SIMSCALE_API_BASE` | env | `https://api.simscale.com/v0` |
| `TESSELLATE_URL`, `POSTPROCESS_URL` | env | Cloud Run URLs, IAM-restricted to the functions service account |
| `STORAGE_BUCKET` | env | `turboflow-test.firebasestorage.app` on test, `turboflow-7b3ca.firebasestorage.app` on prod |

### 13.3 Firestore collections

All snake_case, all top-level, all carry `user_id`, `created_at`, `updated_at`. Existing
collections keep their fields; new fields are added.

**projects/{projectId}** (exists)
```
name, description, category, tags[], unit_system ("SI"|"IMPERIAL"), folder_id,
thumbnail_path, shared_with: { "{uid}": "view"|"copy"|"edit" },
counts: { geometries, simulations, runs }, lock: { tab_id, at }
```

**folders/{folderId}** (new): `name, parent_id`.

**geometries/{geometryId}** (exists, extended)
```
project_id, name, format ("STEP"|"IGES"|"STL"), input_unit ("m"|"cm"|"mm"|"in"|"ft"|"yd"),
import_options { facet_split, sewing, improve },
raw_path (users/{uid}/geometries/{gid}/raw.step), size_bytes,
status ("uploading"|"queued"|"tessellating"|"ready"|"failed"), error,
current_version (int),
versions: { "1": { glb_path, faces_path, solids_path, thumb_path,
                   bbox {min:[x,y,z], max:[x,y,z]}, solid_count, face_count, triangle_count,
                   step_path (the STEP for this version), features: [ {op, params, at} ],
                   frontal_area_m2, reference_length_m } },
prepared_by ("workbench"|"fusion"), step_path, label_path    (legacy fields the Fusion path uses)
```
Face lists never live in the document (1 MiB limit). They live in `faces.json` in Storage.

**geometries/{geometryId}/selections/{selectionId}** (new): `name, entity_type
("face"|"solid"), step_ids: [int]` (max 5000).

**simulations/{simulationId}** (exists, extended)
```
project_id, geometry_id, geometry_version, name, analysis_type ("INCOMPRESSIBLE"),
spec: { ...the SimScale model JSON with STEP face ids in topologicalReference.entities... },
mesh_spec: { ...the SimmetrixMeshingFluid JSON, STEP ids... },
primitives: [ {id, type, name, ...params} ],
validation: { ok, errors: [ {node, message} ], warnings: [] },
ui: { tree_expanded: [...], last_node }
```

**runs/{runId}** (new; what the tree and the job status panel read)
```
project_id, simulation_id, name, job_id,
status ("queued"|"uploading"|"importing"|"checking"|"meshing"|"running"|"downloading"|"finished"|"cancelled"|"failed"),
stage_text ("Meshing 43%"), progress (0..1), started_at, finished_at, duration_s, error,
spec_snapshot, mesh_snapshot,
simscale: { geometry_id, simulation_id, mesh_operation_id, mesh_id, run_id },
mesh: { cell_count, node_count, log_path, quality_path, surface_glb_path },
plots: { residuals, forces, moments, coefficients, convergence, surface_data, probes },  (each downsampled to 2000 points; full CSV in Storage)
results: { glb_path, fields_json_path, fields: {name: {label, path, min, max, unit}}, raw_zip_path, logs: {import, mesh, run} },
summary: { drag_n, lift_n, side_n, cd, cl }
```

**runs/{runId}/post_states/{stateId}** (new): `name, filters[], coloring, camera, hidden[],
legend_ranges, filter_cache: { "{hash}": path }`.

**jobs/{jobId}** (exists): unchanged contract. It is the money document. `onJobPending`
charges on the transition into `pending` and dispatches the worker. New fields:
`spec_mode: true`, `run_ref: runId`. The worker mirrors its status into `runs/{runId}`.

**users/{uid}** (exists): add `notifications: [ {type, text, run_id, at, read} ]` (last 50).

### 13.4 Storage paths

```
users/{uid}/geometries/{gid}/raw.step | raw.iges | raw.stl    client upload, write-once, < 60 MB
users/{uid}/geometries/{gid}/v{n}/model.glb                  tessellate service
users/{uid}/geometries/{gid}/v{n}/faces.json                 id, solid, type, area, centre, normal, radius, axis, bbox, adjacency, start, count
users/{uid}/geometries/{gid}/v{n}/solids.json
users/{uid}/geometries/{gid}/v{n}/thumb.png
users/{uid}/geometries/{gid}/v{n}/geometry.step              the STEP the worker uploads to SimScale for this version
results/{jobId}/results.glb                                  worker
results/{jobId}/fields.json
results/{jobId}/fields/{name}.bin  (+ {name}_x.bin, _y, _z for vectors)
results/{jobId}/raw/solution.zip                             the SimScale download, kept 30 days (lifecycle rule)
results/{jobId}/mesh/surface.glb, mesh/log.txt, mesh/quality.json
results/{jobId}/logs/import.json, mesh.json, run.json        SimScale event logs
results/{jobId}/plots/{name}.csv
results/{jobId}/post/{hash}/...                              filter cache
results/{jobId}/post/screenshots/{id}.png, post/animations/{id}.gif
```

Storage rules: extend `users/{uid}/geometries/{geometryId}/{fileName}` to accept
`raw.step`, `raw.stp`, `raw.iges`, `raw.igs`, `raw.stl` (write-once, under 60 MB). Everything
under `v{n}/` and `results/` is written by services with admin credentials. Keep
`storage-cors.json` applied.

### 13.5 Firestore rules additions

- `folders`: owner CRUD, name up to 200 chars.
- `geometries`: `status`, `versions`, `current_version`, `error` are server-only (deny in the
  client `update` rule with `!changed().hasAny([...])`).
- `simulations`: `spec`, `mesh_spec`, `primitives`, `ui` are client-writable through the
  existing owner rule with `mapOk(spec, 30)`; `validation` is server-only.
- `runs`: owner read; create, update, delete denied to clients. `post_states`: owner
  read and write.
- `projects`: read allowed to the owner and to any uid listed in `shared_with`; write only
  by the owner (and by "edit" collaborators for `simulations` and `geometries` of that
  project, checked with a `get()` on the project).

### 13.6 SimScale API calls the worker makes, in order

| Step | Call |
|---|---|
| 1 Upload | `POST /storage` → `{url, storageId}`; `PUT {url}` with the STEP bytes, `Content-Type: application/octet-stream` |
| 2 Import | `POST /projects/{p}/geometryimports` `{name, location:{storageId}, format:"STEP", inputUnit, options:{facetSplit, sewing, improve, optimizeForLBMSolver:false}}`; poll `GET .../geometryimports/{id}` every 15 s until `FINISHED`; on `FAILED` fetch `GET .../eventlog` |
| 3 Names | `GET /projects/{p}/geometries/{g}/mappings?class=face&limit=100&page=n` until a page is short; same with `class=region`. Build `{stepId → name}` from `originateFrom[0].entity`. |
| 4 Resolve | Replace every STEP id in the spec's `topologicalReference.entities` with its name. Any id with no name = fail the job with "Face {id} is not in the imported geometry". |
| 5 Primitives | `POST /projects/{p}/geometryprimitives` per primitive; put the returned ids in `geometryPrimitiveUuids` |
| 6 Tables | `POST /projects/{p}/tableimports` for probe points (CSV with x,y,z) |
| 7 Simulation | `POST /projects/{p}/simulations` `{name:"tf-{jobId}", geometryId, model, version:"34.0"}` |
| 8 Check | `POST .../simulations/{s}/check`; if `errors` is not empty, fail the job with them (the charge is reversed by `onJobPending`'s existing rule because no mesh_id exists yet) |
| 9 Mesh | `POST /projects/{p}/meshoperations` `{name:"tf-{jobId} mesh", geometryId, model: mesh_spec resolved}`; `POST .../start?simulationId={s}`; poll `GET .../meshoperations/{m}` every 15 s (`status`, `progress`, `meshId`); on finish `GET /projects/{p}/meshes/{meshId}` for counts and `GET .../eventlog` |
| 10 Attach | `GET simulation`, set `meshId`, `PUT simulation` |
| 11 Run | `POST .../simulations/{s}/runs` `{name}`; `POST .../runs/{r}/start`; poll `GET .../runs/{r}` every 15 s |
| 12 Results | `GET .../runs/{r}/results?type=SOLUTION_FIELD` (download url, ZIP64), `?type=PLOT`, `?type=CONVERGENCE_PLOT`; download each `download.url` |
| Cancel | `POST .../meshoperations/{m}/cancel` or `POST .../runs/{r}/cancel` when the job document says `cancelling` |

Status enum: `READY, QUEUED, RUNNING, FINISHED, CANCELED, FAILED` (American spelling).

## 14. Feature by feature

### 14.1 Projects and folders

**In plain words.** A project is a folder for one car: its CAD files, its simulation
setups and its runs. This feature is just database records. Nothing runs, nothing is
charged, SimScale is not involved.

**Technical detail.** Six callables in `functions/src/projects/`. `deleteProject` must
delete every child document and every Storage prefix, in that order, in batches of 400
writes. `copyProject` copies documents and Storage objects (server-side copy, not
download-upload). `shareProject` resolves an email to a uid with `auth.getUserByEmail`
and writes `shared_with.{uid}`. Rate limits go in `lib/ratelimit.ts` (`createProject` 30
per hour, `shareProject` 60 per hour).

```
BUILD PROMPT 14.1
In functions/src/projects/ add createProject, updateProject, deleteProject, copyProject,
shareProject, createFolder, moveToFolder as onCall v2 functions using guard() from
lib/guard.ts and zod schemas in lib/schema.ts (name 1..200, description ..2000, tags max 12
of 3..50 chars, category from the fixed list, unit_system SI|IMPERIAL). Write the documents
from 13.3. deleteProject: query geometries, simulations, runs (and runs/*/post_states) by
project_id, delete in batched writes of 400, then delete Storage prefixes
users/{uid}/geometries/{gid}/ and results/{jobId}/ with bucket.deleteFiles({prefix}), then
the project. Refuse deletion while any run is queued or running ("Cancel running jobs
first"). copyProject: new ids for everything, bucket.file().copy() for Storage objects,
rewrite path fields, counts recomputed. shareProject: getUserByEmail; not-found returns the
message "No TurboFlow account with that email."; write shared_with.{uid} = permission;
unshareProject removes it. Export all from functions/src/index.ts. Add the folders rule and
the shared_with read rule to firestore.rules. Extend tests/test_security.mjs: a collaborator
with "view" can read the project and its simulations, cannot write; a stranger cannot read.
Check: npm test passes; create, rename, copy, share to a second emulator user, delete;
gsutil ls shows no leftover objects.
```

### 14.2 Geometry upload

**In plain words.** The user picks a STEP, IGES or STL file. It goes straight from the
browser into our Storage bucket with a progress bar. When it lands, a record says
"uploaded, waiting to be prepared".

**Technical detail.** Reuse `createUploadIntent` to mint the geometry id and the one
allowed path before the bytes move, then the browser uploads with the resumable API. A
Storage trigger notices the finished object and flips the status. Nothing else happens
here; the preview is 14.3.

```
BUILD PROMPT 14.2
Extend functions/src/geometry/createUploadIntent.ts: accept kind "raw" with ext in
[step, stp, iges, igs, stl], name, input_unit, import_options {facet_split, sewing,
improve}, project_id, size_bytes (<= 60*1024*1024). Path users/{uid}/geometries/{gid}/raw.{ext}.
Write geometries/{gid} with status "uploading", format from ext (step/stp -> STEP,
iges/igs -> IGES, stl -> STL), current_version 0. Extend storage.rules so fileName may be
raw.step|raw.stp|raw.iges|raw.igs|raw.stl, create only when resource == null, under 60 MB.
Add functions/src/geometry/onGeometryUploaded.ts: onObjectFinalized for
users/{uid}/geometries/{gid}/raw.*; set status "queued" and enqueue a Cloud Tasks task that
calls the processGeometry HTTP function (14.3) with {uid, gid, version: current_version+1}.
Browser: uploadBytesResumable, show state_changed progress in the tree row.
Check: upload a 40 MB STEP; the row shows a real percentage; the document goes uploading ->
queued within 5 s of completion; a second upload to the same path returns 403.
```

### 14.3 Geometry preview (tessellate)

**In plain words.** The file is turned into a lightweight 3D model the browser can draw,
plus a list of every face with its size, centre and shape, so a click on the screen can be
turned into "that face". SimScale is still not involved.

**Technical detail.** The tessellate service's `/inspect` already does this and emits
`_FACEID` per vertex and per-face triangle ranges. Extend it to also write `adjacency`
(face pairs sharing an edge, with the dihedral angle) and per-face vertex `start`/`count`,
which the viewer's highlight code needs. Store outputs under `v{n}/`. Runs as an HTTP
function invoked by Cloud Tasks with a 9 minute timeout, which is enough because the
service itself does the work.

```
BUILD PROMPT 14.3
Add functions/src/geometry/processGeometry.ts (onRequest, only callable by the Cloud Tasks
service account; 540 s timeout). It sets status "tessellating", POSTs {TESSELLATE_URL}/inspect
with {uid, geometry_id, version, raw_path, format, input_unit} and an identity token, waits
for the JSON reply {solid_count, face_count, triangle_count, bbox, frontal_area_m2,
reference_length_m, paths}, writes versions.{n} and current_version = n, status "ready".
On any error: status "failed", error = first 300 chars of the message. In
services/tessellate/main.py: /inspect must accept IGES and STL as well as STEP (cadquery
importers.importStep / importers.importShape for IGES via OCP IGESControl_Reader; STL via
trimesh straight to GLB with one face per connected region when facet_split is on,
otherwise one face), write v{n}/model.glb with per-face contiguous unwelded vertices, a
float32 _FACEID attribute, extras.faces[i] = {id, solid, type, area, centre, normal, radius,
axis, bbox, start, count} and extras.adjacency = [[faceA, faceB, dihedralDeg]], plus
faces.json, solids.json, thumb.png (offscreen render with trimesh/pyrender or a fixed
isometric projection). Always also write v{n}/geometry.step: for STEP it is the raw file;
for IGES and STL it is the OCC re-export as STEP, so the worker always uploads STEP.
Check: upload the sample car; status "ready" within 3 minutes; model.glb loads in the
viewer; clicking a wheel face returns a face whose type is "cylinder" with a radius close
to the real wheel; faces.json entries have start/count that sum to the vertex count.
```

### 14.4 CAD Edit operations

**In plain words.** Simple edits to the model without leaving the browser: delete a body,
move, rotate, scale, and build the wind tunnel box around the car. Every edit makes a new
version of the geometry. Edits are free.

**Technical detail.** `/transform` replays a feature list on the B-rep and writes a new
version; `/prepare` builds the flow region and measures the frontal area. Every other CAD
operation in the SimScale toolbar is shown in the UI but disabled with "Not available
yet".

```
BUILD PROMPT 14.4
Callable applyCadOperation {geometry_id, op, params}. Allowed ops: delete_bodies {solid_ids},
scale {factor, solid_ids}, translate {dx, dy, dz, solid_ids}, rotate {origin, axis, angle_deg,
solid_ids}, external_flow_volume {min:[x,y,z], max:[x,y,z], symmetry:bool, wheels:[{face_ids,
radius_m}], excluded_solid_ids}. Anything else: failed-precondition "Not available yet".
Append {op, params, at} to versions.{n}.features, POST /transform or /prepare with the
feature list, write versions.{n+1} from the reply, set current_version. /prepare also
returns frontal_area_m2 and reference_length_m; store them on the version. Rate limit 60
per hour. No credits are charged.
Check: delete two bodies then build a flow volume; v3 has one solid; the Geometry panel
lists "v3: Delete body, External flow volume"; frontal_area_m2 is within 5% of the value
the Fusion add-in reports for the same car.
```

### 14.5 Simulation setup, save and validate

**In plain words.** Everything the user types into the panels is saved to our database as
one JSON document shaped exactly like what SimScale will want later. Saving is instant and
free. A checker tells the user what is still missing (no inlet, a face used twice, a
material without a region) so they find out now, not after paying.

**Technical detail.** The spec keeps STEP face ids; names are resolved at queue time. The
zod schema is generated from the SimScale OpenAPI document and narrowed to Incompressible.
`saveSimulation` is the validated path; a direct Firestore write is also allowed (rules)
so autosave keeps working, and `validation` is recomputed by a Firestore trigger on write.

```
BUILD PROMPT 14.5
Add functions/src/simulations/: createSimulation {project_id, geometry_id} writes the document
with spec = docs/simscale/default_incompressible_spec.json (model), mesh_spec = {type:
"SIMMETRIX_MESHING_FLUID_V16", sizing:{type:"AUTOMATIC_V9", fineness:5.0, curvature:{type:
"AUTOMATIC_CURVATURE"}}, refinements:[], automaticLayerSettings:{type:"AUTOMATIC_LAYER_ON"},
physicsBasedMeshing:true, hexCore:true, numOfProcessors:-1}, name "Incompressible" (then
"Incompressible 1", ...). saveSimulation {simulation_id, spec, mesh_spec, primitives}
validates with zod (generate types from https://api.simscale.com/v0/openapi.json with
openapi-typescript at build time; hand-write zod for Incompressible with a discriminated
union on boundaryConditions[].type over VELOCITY_INLET_V3, VELOCITY_OUTLET_V7,
PRESSURE_INLET_V31, PRESSURE_OUTLET_V30, WALL_V34, SYMMETRY, CUSTOM_V37, FAN, PERIODIC,
WEDGE, EMPTY_2D; materials.fluids[]; initialConditions; numerics; simulationControl;
resultControl), then runs validateSetup(): errors when geometry missing, no material, no
velocity or pressure inlet, no outlet, a boundary condition with no entities, a face id in
two boundary conditions, a face id not present in faces.json for the pinned geometry
version, fineness not a multiple of 0.1, endTime <= 0; warnings when no force result
control, when maxRunTime < endTime * 2 s, when the inlet velocity exceeds 100 m/s. Store
validation {ok, errors, warnings}. Add onSimulationWritten (Firestore trigger) that reruns
validateSetup on any client write so direct autosaves are validated too. Unit strings are
exact unicode: "m²/s", "kg/m³", "m²/s²", "1/s", "m/s", "Pa", "s", "m", "m²" (one UNITS
constant in functions/src/lib/units.ts, shared with the browser via src/lib/units.js).
Check: save a setup with an inlet, an outlet, a wall and Air; validation.ok is true; remove
the outlet; validation.errors names it; assign one face to two walls; errors names both.
```

### 14.6 Queue a run (the money step)

**In plain words.** Pressing Queue makes a job record. The moment the job becomes
"pending", credits are taken and a worker starts. If the setup fails SimScale's own check
before any meshing happened, the credits come back automatically.

**Technical detail.** `queueRun` does not charge. It writes `runs/{id}` (queued) and
`jobs/{id}` (pending, spec_mode). `onJobPending` (exists) charges and dispatches. The
price is `chargeFor()` in `lib/pricing.ts` from iterations and fineness level. The
existing reversal rule (failed with no `mesh_id`) already refunds a check failure.

```
BUILD PROMPT 14.6
Callable queueRun {simulation_id, name}. Load the simulation; refuse if validation.ok is
false (failed-precondition with the errors). Create runs/{runId} {status:"queued",
stage_text:"Queued", spec_snapshot: spec, mesh_snapshot: mesh_spec, simscale:{}}. Create
jobs/{jobId} {user_id, status:"pending", source:"workbench", spec_mode:true, run_ref: runId,
simulation_ref, project_id, geometry_id, step_path: versions[v].step_path, iteration_count:
spec.simulationControl.endTime.value, refine_level: level from fineness via the FINENESS
ladder in lib/pricing.ts (inverse map; 5.0 -> 3), inlet_velocity: magnitude of the first
VELOCITY_INLET_V3 fixed value, debug_mesh:false}. Write runs.job_id. Return {run_id,
job_id, price}. Rate limit 20 per hour. Extend JOB_STATUS in lib/types.ts with "checking"
and "downloading_results". Extend onJobPending's dispatch (jobs/dispatch.ts) to pass
SPEC_MODE=1 and RUN_ID to the Cloud Run Job. The Queue dialog in the browser shows
chargeFor() computed client-side from the same inputs (src/lib/pricing.js mirrors
lib/pricing.ts; keep them identical, there is a test for that in tests/).
Check: queue a run; the ledger has exactly one simulation_charge; runs/{id} shows queued
then the worker's stages; queue with a broken setup: refused before any write.
```

### 14.7 The worker in SPEC_MODE

**In plain words.** One program does the whole SimScale trip: upload the file, wait for
SimScale to read it, translate our face numbers into SimScale's face names, send the setup,
ask SimScale to check it, build the mesh, run the solver, wait, download, and convert the
results into files the browser can draw. It writes a short status line at every step so the
user sees "Meshing 43%" instead of a spinner. If the user presses Cancel, it stops the
SimScale job and marks itself cancelled.

**Technical detail.** `services/simscale-job/simscale_job.py` gets a second main path.
The existing helpers (`build_clients`, `upload_geometry`, `fetch_label_to_names`,
`create_mesh`, `start_run`, cancellation, deadline, status writing, GLB export) are reused.
`build_model()` is skipped; the spec from `runs.spec_snapshot` is sent raw.

```
BUILD PROMPT 14.7
In services/simscale-job/simscale_job.py add run_spec_mode(job, run_id):
1. set_stage(run_id, "uploading", "Uploading to solver"); download versions[v].step_path from
   Storage (owned_path check as today); upload_geometry() with the geometry's input_unit and
   import_options; poll; on FAILED fetch the import event log to results/{jobId}/logs/import.json
   and fail with its first ERROR line.
2. set_stage("importing", "Importing geometry"); fetch face and region mappings
   (fetch_label_to_names logic, but building {step_id: name}); write the map to
   results/{jobId}/simscale_map.json.
3. resolve(spec): walk the spec; every topologicalReference.entities list of ints becomes the
   list of names; unknown id -> fail "Face {id} is not in the imported geometry". Materials
   with empty entities get all region names. Create primitives (POST geometryprimitives) and
   replace local ids in geometryPrimitiveUuids. Upload probe tables (POST tableimports).
4. set_stage("checking", "Checking setup"); POST simulations with {name:"tf-"+job_id,
   geometryId, model, version:"34.0"}; POST .../check; if errors: fail with "; ".join(errors)
   (no mesh_id yet, so onJobPending reverses the charge).
5. set_stage("meshing", "Meshing"); create the mesh operation from mesh_spec resolved the same
   way; start with simulationId; poll every 15 s writing progress and "Meshing {pct}%"; cancel
   on 'cancelling'; on finish GET meshes/{id} for counts, GET eventlog -> results/{jobId}/logs/mesh.json
   and mesh/log.txt; attach the mesh to the simulation; write runs.mesh and jobs.mesh_id.
6. set_stage("running", "Running"); create run named the run's name; start; poll every 15 s
   with progress; write jobs.run_id; cancel on 'cancelling' (POST cancel, then status
   "cancelled").
7. set_stage("downloading", "Downloading results"); list results; download SOLUTION_FIELD
   (ZIP64) to results/{jobId}/raw/solution.zip and unzip; parse the .pvd to find the LAST
   timestep by its timestep attribute (never by file size); load that VTU with meshio or
   pyvista; extract boundary surfaces; export results.glb with trimesh process=False after
   decimation to MAX_VIEWER_TRIANGLES; write fields/{p,U,U_x,U_y,U_z,k,omega,nut}.bin as raw
   float32 per vertex plus any fieldCalculations outputs present; fields.json with min/max
   and units; download every PLOT and CONVERGENCE_PLOT result as CSV to results/{jobId}/plots/
   and write downsampled series (max 2000 points) to runs.plots; fill runs.summary from the
   last row of the forces and coefficients plots; GET the run eventlog -> logs/run.json.
8. set_stage("finished", "Finished"), jobs.status "complete", results paths on both documents.
Every stage writes runs.status, runs.stage_text, runs.progress, jobs.status. MAX_RUN_SECONDS
stays below the Cloud Run task timeout. Keep the legacy main() for jobs without spec_mode.
Check: queue the sample car at fineness 5, 300 iterations; the run panel shows every stage
text in order; results.glb colours by pressure in the viewer; plots.residuals has 300
points; summary.cd is a finite number; cancel a second run during meshing: status
"cancelled" within 30 s and the SimScale mesh operation shows CANCELED.
```

### 14.8 Job finished: notifications, thumbnails, cleanup

**In plain words.** When a run ends, the user gets a bell notification, the project card
gets a picture, and old raw downloads are cleaned up after a month.

```
BUILD PROMPT 14.8
Add functions/src/jobs/onJobFinished.ts (onDocumentWritten on jobs/{jobId}; acts when status
becomes complete, failed or cancelled). Append {type, text, run_id, at, read:false} to
users/{uid}.notifications capped at 50 (arrayUnion then trim in a transaction). Mirror the
final status to runs/{run_ref} if the worker did not (defensive). Add a bucket lifecycle
rule (deploy with gsutil lifecycle set) deleting results/*/raw/ after 30 days. Callable
createScreenshotUrl {project_id} returns a v4 signed upload URL for
projects/{id}/thumb.png (5 MB, image/png); the browser's screenshot button uses it; the
Dashboard shows thumbnail_path.
Check: finish a run; the bell shows 1 unread; take a screenshot; the dashboard card shows it.
```

### 14.9 Cancel and logs

```
BUILD PROMPT 14.9
Callable cancelJob {run_id}: owner check; if jobs.status in (pending) set "cancelled" directly
and let onJobPending's ledger logic reverse the charge (no mesh_id); otherwise set
"cancelling" and let the worker do the SimScale cancel. Callable getEventLog {run_id, kind:
"import"|"mesh"|"run"} returns the stored JSON from results/{jobId}/logs/{kind}.json (no
SimScale call). The run panel's Event log dialog renders it with a severity filter.
Check: cancel a queued run: refund is full; cancel a running run: charge stands; the event
log dialog lists timestamped lines.
```

### 14.10 Post-processing service

**In plain words.** Cutting planes, streamlines, iso-surfaces and statistics need the whole
3D result, which is far too big for a browser. So a server keeps the result on disk and
answers small questions: "cut here, colour by velocity" and sends back only the slice.
Answers are cached, so opening a saved view is instant.

**Technical detail.** New Cloud Run service `services/postprocess/` (Python, VTK 9, trimesh,
Flask), 4 GB memory, min instances 0, concurrency 1. It downloads `raw/solution.zip` once
per job into `/tmp` and keeps it while the instance lives. Every endpoint is fronted by the
callable `postprocessFilter`, which checks ownership and rate limits (300 per hour).

```
BUILD PROMPT 14.10
Create services/postprocess/{Dockerfile, requirements.txt, main.py} (non-root user like
simscale-job). Endpoints (POST JSON, identity-token check that the caller is the functions
service account):
/filter {job_id, type, params, field} for type in cutting_plane (origin, normal, vectors
  {spacing, scale}), iso_surface (field, value), iso_volume (field, min, max), particle_trace
  (seed_origin, seed_u, seed_v, nx, ny, both_directions, max_length): vtkCutter /
  vtkContourFilter / vtkThreshold / vtkStreamTracer(+vtkTubeFilter); output GLB with
  per-vertex field .bin(s); vectors as float32 [x,y,z,vx,vy,vz]*N; write to
  results/{job_id}/post/{sha256 of canonical json}/ and return signed URLs. Return cached
  URLs immediately when the prefix exists.
/statistics {job_id, faces:[names] | plane} -> min, max, mean, integral, area, flow_rate
  (vtkIntegrateAttributes on the extracted surface).
/probe {job_id, points:[[x,y,z]]} -> every field at each point (vtkProbeFilter).
/plot-over-path {job_id, points, subdivisions, field} -> CSV.
/mesh-clip {job_id, origin, normal} -> GLB of clipped cells with edges (vtkClipDataSet), plus
  mesh quality arrays on request (vtkMeshQuality: aspect ratio, non-orthogonality via
  vtkCellQuality, skewness) written to results/{job_id}/mesh/quality.json on first call.
/gif {job_id, frames:[{camera, filter_state}], fps} -> offscreen EGL render to
  results/{job_id}/post/animations/{id}.gif.
Callable postprocessFilter {run_id, endpoint, body} in functions/src/post/ resolves job_id,
checks ownership, forwards, returns the reply. Callable saveView {run_id, name, state}
writes post_states.
Check: cutting plane at the car mid-plane by velocity: under 10 s cold, under 1 s cached;
outlet-face statistics flow rate within 2% of inlet speed times inlet area.
```

### 14.11 Security pass

```
BUILD PROMPT 14.11
setGlobalOptions cors: ["https://turboflow.cloud", "https://turboflow-test.web.app"]. Add every
new callable to RATE in lib/ratelimit.ts. Cloud Run services: remove allUsers invoker, grant
roles/run.invoker to the functions service account only. firebase.json: add
Content-Security-Policy (script-src 'self' www.gstatic.com www.paypal.com; connect-src self,
*.googleapis.com, *.firebaseio.com, *.cloudfunctions.net, *.run.app, api.paypal.com;
img-src self data: blob: *.googleapis.com; frame-src www.paypal.com; font-src self) and
Permissions-Policy (camera=(), microphone=(), geolocation=()). Apply storage-cors.json.
Extend tests/test_security.mjs for every new rule. npm audit clean in root and functions.
Check: npm test green; a curl to the tessellate URL without a token returns 403; the CSP
does not break PayPal on /billing.
```

## 15. Step-by-step plan against this repo

This is the order to finish the product, written against the folders that exist today in
`C:\Users\shash\Desktop\cfd_web_backend\turboflow`. Each step names the files and the check
that ends it. Do not start a step before the previous check passes.

| # | Step | Files | Done when |
|---|---|---|---|
| 0 | Housekeeping | `vite.config.js` (sourcemap false), `firebase.json` (rewrite `/workbench/**` → `/workbench.html`), delete `supabase/` from git history, rotate the leaked webhook secret named in `CHANGES.md` | `npm run build` works, `git log -p` no longer shows the secret |
| 1 | Shared constants | new `src/lib/units.js`, `src/lib/pricing.js` (copy of `functions/src/lib/pricing.ts` maths), `tests/test_pricing.mjs` comparing both | test green |
| 2 | Backend 14.1 projects and folders | `functions/src/projects/*.ts`, `firestore.rules`, `tests/test_security.mjs` | `npm test` green |
| 3 | Backend 14.2 and 14.3 upload and preview | `functions/src/geometry/createUploadIntent.ts`, new `onGeometryUploaded.ts`, `processGeometry.ts`, `storage.rules`, `services/tessellate/main.py` | sample car reaches "ready" on the emulator with a real tessellate container |
| 4 | Front end shell | new `src/workbench/` (App, tokens.css, TopBar, Tree, Viewer, SettingsPanel, SceneTree, JobStatus, ViewCube from `public/wb-viewcube.js`), `workbench.html` entry, `src/entries/workbench.jsx` | screenshot side by side with SimScale at 1440×900 matches sections 4 and 5 |
| 5 | Dashboard page | `src/views/DashboardView.jsx` replacing the current dashboard content, `src/entries/dashboard.jsx` | section 4 matches; create, rename, share, delete work |
| 6 | Viewer picking and selection | `src/workbench/viewer/` (GLB load, BVH, aSelect shader, box select, context menu, measure) | click 50 faces, hover under 16 ms, box select both directions |
| 7 | Backend 14.5 simulation save and validate | `functions/src/simulations/*.ts`, zod schema, `onSimulationWritten` | validation errors appear in the tree |
| 8 | Setup panels | `src/workbench/panels/` one file per node from section 9, `useDraft.js` | full Incompressible setup saved with validation.ok true |
| 9 | Backend 14.6 and 14.7 queue and worker | `functions/src/jobs/queueRun.ts`, `dispatch.ts`, `lib/types.ts`, `services/simscale-job/simscale_job.py` SPEC_MODE | one real run on SimScale finishes and results.glb loads |
| 10 | Runs UI | `src/workbench/runs/` (Queue dialog, run panel, plots with uPlot, event log dialog), job status panel wired to `runs` | stages show live; plots render |
| 11 | Backend 14.10 postprocess service | `services/postprocess/` | cutting plane under 10 s |
| 12 | Post-processor UI | `src/workbench/post/` (filters panel, legend, parts panel, ribbon, frame bar, compare) | section 12 matches |
| 13 | CAD Edit UI + 14.4 | `src/workbench/cad/`, `functions/src/geometry/applyCadOperation.ts` | delete body, tunnel, v2 |
| 14 | 14.8, 14.9, 14.11 | notifications, cancel, logs, security | `npm test` green, CSP live |
| 15 | Retire the old Workbench | delete `public/workbench.html`, `workbench-panels.js`, `workbench-results.js`, `workbench-adapter.js`, keep `cfd-setup.js` maths in `src/lib/` | no page links to the old file; Fusion path still works |
| 16 | Deploy | `firebase deploy --project test`, run one real car end to end, then `--project prod` with `public/firebase-config.js` swapped and canonical URLs changed (see `CHANGES.md` section 0) | turboflow.cloud serves the new build |

## 16. Still open

1. **Which SimScale plan the API key is on.** Sets the processor cap (16, 32 or 192) and how
   many jobs may run at once. Until answered, the processor dropdown offers Automatic only
   and the queue runs one job at a time.
2. **Screenshots still wanted**: a boundary condition panel open, the Mesh panel, a finished
   run with plots, and the post-processor with a cutting plane. They close the remaining
   `[verify]` marks in sections 5.4, 9, 10 and 12.

---

# PART C: WHERE THE BUILDER WILL MAKE MISTAKES

Each item names the mistake, why it happens, and the code that avoids it. Read this list
twice before starting and once more before each step in section 15.

### C1. Saving on every keystroke instead of on ✓

The panel must hold a draft. Saving on `onChange` writes half-typed numbers ("1e" becomes
NaN) and floods Firestore.

```js
// src/workbench/panel/useDraft.js
export function useDraft(saved, save) {
  const [draft, setDraft] = useState(() => structuredClone(saved));
  const [errors, setErrors] = useState({});
  const dirty = !deepEqual(draft, saved);
  const set = (path, value) => setDraft(d => setIn(d, path, value));   // immutable setIn
  const commit = async () => {
    const errs = validate(draft);
    setErrors(errs);
    if (Object.keys(errs).length) return false;
    await save(draft);            // one write, through the save indicator
    return true;
  };
  const discard = () => { setDraft(structuredClone(saved)); setErrors({}); };
  return { draft, set, commit, discard, dirty, errors };
}
// Tree navigation: if (dirty) { const ok = await commit(); if (!ok) return; } then navigate.
```

Also: `useEffect` must re-seed the draft only when the node id changes, not when `saved`
changes from a live listener (or a background write wipes what the user is typing).

### C2. Rebuilding geometry to highlight a face

Rebuilding a 300k-triangle `BufferGeometry` on hover is 50 to 200 ms. Use one float
attribute and a shader chunk.

```js
geometry.setAttribute('aSelect', new THREE.BufferAttribute(new Float32Array(vertexCount), 1));
material.onBeforeCompile = (shader) => {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute float aSelect; varying float vSelect;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSelect = aSelect;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying float vSelect; uniform vec3 uHover, uSel, uAssigned, uAssignedOther;')
    .replace('#include <color_fragment>', `#include <color_fragment>
      if (vSelect < -0.5) discard;
      if (vSelect > 3.5) diffuseColor.rgb = mix(diffuseColor.rgb, uAssignedOther, 0.85);
      else if (vSelect > 2.5) diffuseColor.rgb = mix(diffuseColor.rgb, uAssigned, 0.85);
      else if (vSelect > 1.5) diffuseColor.rgb = mix(diffuseColor.rgb, uSel, 0.85);
      else if (vSelect > 0.5) diffuseColor.rgb = mix(diffuseColor.rgb, uHover, 0.6);`);
  shader.uniforms.uHover = { value: new THREE.Color(tokens.hover) }; /* etc */
  material.userData.shader = shader;
};
function paintFace(faceId, code) {
  const { start, count } = faces[faceId];          // vertex range from extras.faces
  aSelect.array.fill(code, start, start + count);
  aSelect.addUpdateRange(start, count); aSelect.needsUpdate = true;
}
```

`extras.faces[i].start/count` must be **vertex** ranges, not triangle ranges. The geometry
service must write vertices face-contiguous and unwelded (it does: `/inspect` keeps each
face's triangles together).

### C3. Raycasting without a BVH

```js
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;
geometry.computeBoundsTree();
raycaster.firstHitOnly = true;
```

Throttle pointermove to one raycast per animation frame. Hidden faces (`aSelect = -1`) must
be skipped: after the first hit, if its face is hidden, raycast again with `firstHitOnly =
false` and take the first visible hit.

### C4. Breaking vertex order and then wondering why colours are wrong

The field binaries are indexed by vertex. `GLTFLoader` keeps order. `DRACOLoader`,
`mergeVertices`, `BufferGeometryUtils.mergeGeometries` and `geometry.toNonIndexed()` do
not. Never call them on results.glb. The worker exports with `trimesh ... export(process=False)`
for the same reason. Test: colour by a field, then compare three known vertices against
values read straight from the VTU.

### C5. Sending STEP face ids to SimScale

SimScale wants its own face names (`A1_I1_B10_TE12`), not STEP entity ids (`2234`). The map
between them comes from `GET .../mappings` (`originateFrom[0].entity` is the STEP id). Resolve
in `saveSimulation`, never in the browser:

```ts
const map = await readJson(`users/${uid}/geometries/${gid}/v${v}/simscale_map.json`);
const resolve = (ref) => ({
  entities: (ref.entities ?? []).map(id => {
    const name = map.faces[String(id)];
    if (!name) throw new HttpsError('failed-precondition', `Face ${id} has no SimScale name (geometry version mismatch)`);
    return name;
  }),
  sets: ref.sets ?? [],
});
```

Every geometry **version** has its own map. A simulation pinned to v2 must use v2's map.

### C6. Wrong wrapper for vectors

Velocity inlet fixed value is a **function** vector; moving wall is a **plain** vector. The
worker already shows both (`vel_func` and `vel_plain`). Getting them swapped gives a 400 with
an unhelpful message.

```json
"velocity": { "type": "FIXED_VALUE",
  "value": { "value": { "x": {"type":"CONSTANT","value": -20}, "y": {"type":"CONSTANT","value": 0}, "z": {"type":"CONSTANT","value": 0} }, "unit": "m/s" } }
```
```json
"velocity": { "type": "MOVING_WALL_VELOCITY", "value": { "value": { "x": -20, "y": 0, "z": 0 }, "unit": "m/s" } }
```

Pressure outlet: `{ "type":"FIXED_VALUE", "value": { "value": {"type":"CONSTANT","value":0}, "unit":"Pa" } }`.
Rotating wall angular velocity: `{ "value": {"type":"CONSTANT","value": 120.5}, "unit":"rad/s" }`.

### C7. Unit strings

`"m²/s"`, `"kg/m³"`, `"m²/s²"`, `"m²"` are unicode. ASCII `m^2/s` or `m2/s` fails. Keep a
single `UNITS` constant in the shared package and never type a unit string inline.

### C8. Fineness not a multiple of 0.1

`fineness: 9.25` is rejected. Round to one decimal server-side:
`Math.round(f * 10) / 10`. The slider steps by 0.1 already; the guard is for API callers.

### C9. `numProcessors` and `-1`

`-1` means Automatic for both the mesh and the run. A dropdown that sends `0` or `null`
fails the check. Keep the enum `[-1, 4, 8, 16, 32, 48, 64, 96]` verbatim.

### C10. Spelling of statuses

The API says `CANCELED`; the app's own status is `cancelled`. Normalise once in the poller:

```ts
const STATUS = { READY:'queued', QUEUED:'queued', RUNNING:'running', FINISHED:'finished', CANCELED:'cancelled', FAILED:'failed' };
```

### C11. Polling inside a callable

Callables die at 60 s. Anything that waits on SimScale goes to the scheduled poller or the
Cloud Run job. A callable only creates, starts, cancels, or reads.

### C12. Writing the Firestore document before the bytes

The storage rule accepts `create` only when `resource == null` and the path is under the
caller's uid, so the upload can go first; the geometry document is written after the upload
task resolves. If you write the document first with `status: "uploading"` (allowed, the
rules do not forbid it), make sure a failed upload marks it `failed` so no ghost rows remain.

### C13. Stacking Firestore listeners

`onAuthStateChanged` fires on every hourly token refresh. Guard subscriptions:

```js
let unsub = null;
onAuthStateChanged(auth, (u) => {
  if (unsub) { unsub(); unsub = null; }
  if (!u) return;
  unsub = subscribeProject(projectId, u.uid);   // returns a combined unsubscribe
});
```

The old Workbench had exactly this bug (documented in `docs/WORKBENCH.md`).

### C14. CORS on the bucket

Without `storage-cors.json` applied (`gsutil cors set storage-cors.json gs://bucket`), the
GLB fetch fails with no console error from application code. Add a startup check in dev:
fetch one known object and show a banner "Storage CORS is not configured" if the fetch
throws.

### C15. Orientation cube out of sync

Render the cube in a second scene with its own orthographic camera; each frame set
`cubeCamera.quaternion.copy(mainCamera.quaternion)` and position the cube camera at
`direction * 5`. Never share the main camera. Clicking a cube face animates the **main**
camera's position to `target + faceNormal * distance`, keeping `distance`.

### C16. Near and far planes

After every fit: `const r = sphere.radius; camera.near = r / 1000; camera.far = r * 100;
camera.updateProjectionMatrix();`. A fixed `far = 1000` hides a 20 m wind tunnel; a fixed
`near = 0.1` clips a 20 mm wheel when zoomed in.

### C17. Box select direction

Compute the drag direction from the raw screen coordinates at pointerdown and pointerup, not
from the normalised rectangle: `const enclosed = up.x >= down.x;`. Enclosed = every vertex
of the face inside the rectangle (test the face's bounding box corners projected to screen,
then confirm with all vertices only for candidates). Touched = any projected vertex inside.

### C18. URL as the only source of selection

Do not keep `selectedNode` in React state and also in the URL. Read it from the router; the
tree click calls `navigate()`. Deep links and reloads then work for free.

### C19. Firestore 1 MiB document limit

Face lists, plot series longer than 5000 points, and filter caches do not go in documents.
Plots: downsample to 2000 points for the document and keep the full CSV in Storage.

### C20. Charging twice

`onJobPending` already handles retries with the ledger. Do not add a second charging path in
`startRun`. `startRun` writes `status: "pending"` and nothing else money-related.

### C21. Legend range edits triggering data reloads

The colour map is a `DataTexture` (256×1) sampled by a `vFieldValue` varying; editing the
range changes two uniforms (`uMin`, `uMax`). No fetch, no attribute write.

### C22. Post-processor filter hash

Cache key = SHA-256 of the canonical JSON of `{type, params, field, timeStep}` with keys
sorted and numbers rounded to 6 significant digits. Without rounding, dragging a plane by a
float epsilon creates a new cache entry each time.

### C23. Auto-save when leaving an invalid panel

SimScale refuses to leave. The builder will silently drop the draft. The rule: block
navigation, scroll the first error into view, focus its field.

### C24. Mesh clip and mesh display before a run

A bare mesh operation may not offer a downloadable mesh through the API (see 14.10). Do not promise "Show mesh" before that is confirmed; wire the button
to a `mesh.surface_glb_path` that may be null and show "Mesh preview appears after the first
run" when it is.

### C25. Selecting faces behind the settings panel

The floating panel overlays the viewer. Pointer events on the panel must not reach the
viewer (`pointer-events: auto` on the panel, and the viewer ignores events whose target is
inside the panel). The right 360px of the viewer are still visible and clickable; do not
shrink the canvas.

### C26. The vector discriminator SimScale will not run without

A velocity inlet's value is three per-component functions, and the object
holding them must say so. Without `type: "COMPONENT"` the whole simulation is
refused, before meshing, with a message that names a JSON path and no user-
facing cause:

```
"cause": "Missing 'type' property for object 'value' -
          Path: /model/boundaryConditions/0/velocity/value/value"
```

Right:

```json
"velocity": { "type": "FIXED_VALUE", "value": {
  "value": { "type": "COMPONENT",
             "x": {"type": "CONSTANT", "value": 20},
             "y": {"type": "CONSTANT", "value": 0},
             "z": {"type": "CONSTANT", "value": 0} },
  "unit": "m/s" } }
```

A moving wall is the opposite and takes a plain vector with no tag at all
(`{"value": {"x": 20, "y": 0, "z": 0}, "unit": "m/s"}`). Confusing the two is
C6; forgetting the tag is this one. Found on 11 Sep 2026 on the first run that
reached SimScale: every velocity inlet the Workbench had ever written was
missing it, so no inlet had ever been accepted.

### C27. Send SimScale only the properties its schema has

`topologicalReference` has exactly two properties, `entities` and `sets`. The
worker was also passing the browser's face indices through as a third, `faces`,
so a later CAD edit could remap them. SimScale's parser rejects unknown
properties, and the run dies on a JSON error nobody can read. Keep the indices
in `runs.spec_snapshot`, which is where a remap should read them from, and post
a clean object.

The general rule: the document you store and the document you post are not the
same document. Ours carries face indices, provenance and units for our own use;
SimScale's carries only what its OpenAPI defines.

### C28. A face set can shrink between the Workbench and the solver

SimScale's geometry import deletes degenerate faces, and a real car has them:
the first end-to-end run had five zero-area slivers out of 131. Treating a
missing face as corruption and refusing the run produced advice that could never
work ("re-upload the geometry" yields the same five slivers).

Skip a face SimScale dropped, log it, and fail only when a boundary condition
is left with no faces at all. That keeps the guarantee that matters, which is
that no surface silently loses its physics. Better still, do not offer a
zero-area face for assignment in the first place: `/inspect` should mark them.

### C29. Mirror a job's ending onto its run

The worker writes both documents while it runs, so they agree. Every ending
that happens *without* the worker does not: a refusal in `onJobPending`, a
dispatch that never starts a container, a container that dies before its first
write. The job says failed and the run sits on "Queued" forever, with the job
chip counting it as running. `onJobFinished` (14.8) is not optional polish; it
is the only thing that closes that gap.

### C30. The image must contain every module the entry point imports

`services/simscale-job/Dockerfile` copied `simscale_job.py` and not
`spec_mode.py`, so the built image died on `import spec_mode` before it could
mark the job failed. A Dockerfile that names files one by one has to be edited
every time a module is added, and nothing reminds you. Either copy both
explicitly (done) or add an import smoke test to the build, as that Dockerfile
already does for the third-party libraries.

### C31. Test uids must look like real uids

`onJobPending` rejects a `user_id` shorter than ten characters. A test user
called `e2e-car` is refused with "Job has no valid user_id", which looks like a
product bug and is not. Use something the length of a real Firebase uid.

### C32. A mesh operation is versioned too

`POST /meshoperations` needs `"version": "10.0"` beside `name`, `geometryId`
and `model`, exactly as `POST /simulations` needs `"version": "34.0"`. Without
it the call is refused with `invalid-schema-version` and a list of every
version the API has ever had, which reads like a server fault and is not one.

### C33. SimScale will not check a simulation that has no mesh

`POST /simulations/{id}/check` on an incompressible setup answers "meshId is
mandatory for INCOMPRESSIBLE analysis type" until a mesh is attached. So the
order is: create the simulation, build the mesh, attach it, *then* check, then
run. Checking earlier looks tidier and can only ever fail.

One consequence worth stating: a setup error now surfaces after the mesh has
been paid for. That is why the client-side validation in 14.5 has to be good,
and why `onJobPending` refunds only up to the point where a mesh exists.

### C34. STEP declares its unit at the end of the file

A CAD file's `SI_UNIT(.MILLI.,.METRE.)` sits in the DATA section, which for an
OpenCASCADE export is the last handful of lines: line 26934 of 26941 on the
test car. An importer that sniffs the first few hundred kilobytes finds
nothing and silently falls back to metres, and a 2.2 m car becomes 2.2 km. Read
both ends of the file, and when there is still no declaration, say so rather
than guessing.

### C35. The callable SDK turns `undefined` into `null`

A dialog that carefully sends `description: undefined` for an empty box makes
the server see `null`, and a zod `.optional()` refuses it: "Expected string,
received null". Every optional field in a create schema therefore has to be
`.nullish()`, and the update variants must *not* default, or a rename would
blank every field the rename call did not carry. Better still, strip undefined
keys at the one place that calls the backend.

### C36. A button that explains why it does nothing is still a button that does nothing

Five controls in the first build were wired to a note about the build order:
the tree's every "+" (`onNodeAdd={() => {}}`), "New simulation" ("Creating a
simulation comes with the setup panels"), and the job panel's Cancel and Log
("comes with the queue", "comes with the runs panel"). In four of the five the
feature already existed somewhere else: the boundary condition panel lists
every type as a button, `createSimulation` and `cancelRun` are deployed
callables, and the run panel shows the log. Only the wiring was missing.

When a feature is not ready, leave the control out or disable it with a reason
the user can act on. A note describing the development plan is neither.

### C37. The tree draws the saved document, the panel edits a draft

So appending a boundary condition to the draft puts it nowhere the user can
see: they click "Velocity inlet" and the screen does not change, because the
tree is rendering the saved simulation. Adding a child is a structural act, not
an edit to a value, and SimScale creates the node on the click. Commit it
immediately; keep draft semantics for the fields inside it.

Compute the document you save rather than reading it back out of state, or the
save sends the version from before the click.

### C38. Name every control after the thing it acts on

The tree shipped with four buttons labelled "Add", two labelled "More actions"
and a set labelled "Collapse". They are distinguishable by eye, from position,
and not at all to a screen reader. `Add to Materials`, `More actions for Car
flow region`, `Collapse Boundary conditions`: the label already exists on the
row, so there is nothing to invent.

The same applies inside a panel. `Row` wraps its control in a `<label>` so the
field is named without every panel inventing an id, and any row holding more
than one input (a vector) says `group` so it does not claim to name all three.
Two vectors on one panel must not share element ids, or clicking one row's "x"
puts the cursor in the other's.

### C39. Several SimScale endpoints take their arguments in the query string

`POST /meshoperations/{id}/start` takes `simulationId` as a **query
parameter**. Sent as a JSON body it is silently ignored: the call returns a
success code, the operation stays in `READY` forever, and the worker polls it
reporting "Meshing 0%" until the job's own deadline kills it hours later. There
is no error anywhere to find.

The rule: read the OpenAPI `parameters` list for every endpoint before calling
it, and check the response of anything that starts work. A start that returns
202 and changes nothing is the worst kind of failure, because every dashboard
says the run is fine.

The run start endpoint, by contrast, takes neither a body nor query arguments.
They are not consistent with each other; the document is the authority.

### C40. A failed operation's reason is in its event log, nowhere else

`GET /meshoperations/{id}` on a failed mesh says `"status": "FAILED"` and
nothing more. The reason is in `/eventlog`, and it is usually the most useful
sentence in the whole system:

```
MSG_MESH_TOO_COARSE: The mesh could not be generated on the following entities
B1_TE495. Please try either of the following resolutions (by order of
priority): (a) change the small feature suppression under Advanced Settings,
(b) increasing the mesh fineness in problematic areas, or (c) delete undesired
small features in your CAD environment.
```

Showing "Meshing failed." instead of that throws away the only part of the
failure a team can act on. Read the event log at the moment of failure and put
its first ERROR on the job; keep the whole log in Storage for support.

The same applies to the geometry import and to the solver.

### C41. A CAD car will not mesh until its slivers are suppressed

Fineness 3 ("Coarse") failed to mesh a STEM Racing car. So did fineness 5
("Moderate"). Both died the same way:

```
MSG_MESH_TOO_COARSE: The mesh could not be generated on the following
entities B1_TE495.
```

Fineness was not the problem. The car carries features far below any sensible
cell size: ten of its 131 faces measured under 1e-7 m2, and the mesher fails on
them rather than skipping them. The fix is the first of SimScale's own three
recommendations, `advancedSimmetrixSettings.smallFeatureTolerance`, which no
default in this build set. 0.5 mm is a reasonable floor for a 200 mm car.

Set it in the default mesh spec, and expose it in the Mesh panel's Advanced
section so a car with even smaller detail can raise it. Without it, a real CAD
export does not mesh at any fineness, and the error names an entity id the user
has no way to find.

Fineness still matters for cost and for the wake, and Moderate remains the
right starting point. But do not reach for it first when the message says
"too coarse": read which entity failed and how big it is.

### C42. A finished mesh is not an attached mesh

`POST /meshoperations/{id}/start?simulationId=...` tells the *mesher* what to
mesh. It does not tell the *simulation* what it was meshed with. Those are two
different records, and `meshId` lives on the simulation.

So after the operation finishes you must read the simulation back, set
`meshId`, and PUT it. Skip that and the setup check answers "meshId is
mandatory for INCOMPRESSIBLE analysis type" a second after a mesh finished
successfully, and the solver refuses to start for the same reason. Run 9 on
11 Sep 2026 meshed to 95%, finished, and died exactly there, with a message
identical to the one a run gets when it has no mesh at all.

The cell and node counts are on the mesh too (`GET /meshes/{meshId}`), not on
the operation, so this is also where to read them for the Mesh panel.

### C43. Show a face's shape and size, not its number

The scene tree's face rows read "Face 1", "Face 2", "Face 3". Those rows exist
so a user can find the inlet or a wheel without hunting in the viewer, and a
number does not help anyone do that. `faces.json` already carries the surface
type and the area, so the row can read:

```
Face 1   plane, 0.125 m2
Face 2   plane, 0.827 m2
Face 3   plane, 0.747 m2
```

Now the two 0.125 m2 planes are obviously the ends of the tunnel, the pair at
0.747 m2 are the floor and roof, a cylinder is a wheel, and the slivers that
stop the mesher are the ones reading 1.1e-07 m2. The same applies to the rows
inside an assignment box.

---

### C44. A result item is named by the user, so match it by category

SimScale's results list gives each item a `name` and a `category`. The name is
whatever the user called the result control in the setup. The worker filtered
on `name == "Forces_Moments"`, which is the name *this worker* uses when it
builds a setup itself, so it only ever matched its own runs. A Workbench run
whose result control is called "Car forces" matched nothing, and Run 10 came
back from a complete, successful solve with no force trace at all:

```
No coefficient plot in the results. Columns seen:
  [('Car forces', 'FORCE_PLOT'), ('Car forces', 'MOMENT_PLOT'),
   (None, 'RESIDUALS_PLOT'), (None, 'DOMAIN_PLOT'), ... (None, 'SOLUTION')]
```

Match on `category` — `FORCE_PLOT`, `MOMENT_PLOT`, `RESIDUALS_PLOT` — and never
on a name a user can type.

---

### C45. Two functions in one file can still disagree about a shape

`export_plots` returns groups of series:

```python
{"forces": {"iterations": [...], "drag": [...], "lift": [...]},
 "moments": {...}, "residuals": {"series": {...}}}
```

`summarise` walked it as `{name: [row, row, ...]}` and took `rows[-1]`. On a
dict that is `KeyError: -1`, and it killed Run 10 after ten minutes of solving
879,511 cells. Neither function is wrong on its own; they were written against
different shapes and nothing checked that the one fed the other.

A contract between two functions in the same file is worth a test that needs no
network and no API key. `tests/test_summarise.py` runs in a second.

---

### C46. Fit to view has to know what is floating over the viewer

The settings panel floats over the left 362 px of the viewer. Fit to view
centred the model in the whole canvas, so on a 1280 px window the car was
framed 390 px to the left of the only strip you could see it in: it was always
behind the panel.

Fit into the free strip instead. Two parts, and the second is the one that gets
forgotten: a narrower strip subtends a narrower angle, so the camera has to sit
further back; and the model then has to be *slid* to the middle of that strip,
not left in the middle of the canvas.

Clamp the strip to the canvas. On a small laptop a 350 px panel can cover more
of a narrow viewer than the quarter you insist on fitting into, and then the
strip's own centre lies off the right-hand edge and the model is framed onto
pixels that do not exist.

Measure the panels on demand rather than watching them. Re-framing whenever the
job drawer opens throws away whatever the user had orbited to.

And check the arithmetic without the browser. A preview pane that is behind
another window paints about two frames a second and reports an empty canvas
whether the maths is right or wrong; `tests/test_framing.mjs` projects the
bounding sphere with the real camera and asserts where it lands.

---

### C47. The ink on top of the accent has to flip with the theme

`--on-accent: #ffffff` is correct on a light theme, where the accent is the
dark half of the pair. On a dark theme the accent is the *light* half, and the
same white lands at 3.5:1 — under AA — on every primary button. The account
avatar was worse: a white initial on the "ok" green at **1.6:1**, because a
status colour had been used as decoration.

Two rules follow. A status colour never does decorative work: an avatar is not
reporting that anything is fine. And every colour that sits on top of another
colour gets restated per theme, not defined once.

Accent text on a 10 % accent wash — the selected state of chips, tree rows,
library items and pressed icon buttons — lands at 4.4:1 in dark, just under AA.
It needs its own token, a lighter tint of the accent, not the accent itself.

`scripts/contrast-audit.mjs` resolves every `color` + `background` pair in the
stylesheets against all three theme palettes and measures it. Check that the
audit actually catches a known failure before trusting it: the first version of
mine reported a clean sheet because its block regex swallowed the comment above
each rule into that rule's selector, so the dark palette never matched and
every colour resolved to null.

---

### C48. A fault in reading the results must not fail a paid solve

Once the solver has finished, the money is spent and the answer exists. If the
worker then trips over its own plot parsing, the run must still finish with
whatever was recovered, and the fault must be a warning on the job. Run 10 was
marked **Failed** with 25 credits gone and a complete 879,511-cell solution
sitting in SimScale, because of a `KeyError` in a summary function.

Wrap everything after the solve in its own try/except, and when a package
arrives with nothing you can read in it, log what it *did* contain:

```python
names = [i.filename for i in zf.infolist() if not i.is_dir()]
log.warning("  No VTK files inside the package. It holds %d entries: %s",
            len(names), names[:20])
```

"No VTK files inside the package" tells you nothing on its own. The next run
should diagnose itself.

---

### C49. A field nobody writes is silent

The run panel's event log took its entries from `run.events`. Nothing has ever
written an `events` field onto a run, so every run there has ever been showed
"No events recorded for this run", and the panel looked like a working feature.

The log was real the whole time. `save_event_log` fetches SimScale's own
account of the run, uploads it to `results/{jobId}/logs/run.json`, and
**returns the path** — and both call sites threw the return value away, so the
file was saved and then nothing knew where it was.

This is the third time in one afternoon that a reader and a writer disagreed
about a name, after `run.results.glb_path` and `run.summary.drag_n`. In
JavaScript, reading a field nobody writes is not an error; it is `undefined`,
and it renders as an empty panel.

`tests/test_run_fields.mjs` collects every key written to a document across the
worker and the Cloud Functions, then flags every `run.x` the Workbench reads
that is not in that set. It found all three.

---

### C50. A user must never be shown a Python exception

Run 10's failure reached the Workbench as:

```
KeyError: -1
```

That is the whole message a team would have seen after waiting ten minutes and
spending 25 credits. It tells them nothing, and worse, it invites them to go
and change their setup, which was never the problem.

Errors the user can fix get their own exception type and are phrased in the
user's words. Everything else is a bug in the tool, and should say so:

> TurboFlow hit a fault of its own on this run. It is not something in your
> setup, so changing the simulation will not help. The run log has the details.

Keep the technical string in a separate `error_detail` field and show it behind
a "Technical detail" disclosure. The person the team forwards the link to needs
`KeyError: -1`; the team does not.

---

### C51. Drag is the force along the wind, not minus Fx

The worker negated Fx to get drag, with this reasoning written beside it:

> the wind blows in -x here: the inlet is at max x and the velocity is set to
> -INLET_VELOCITY

That is true of the setup *the worker builds itself* for the Fusion add-in. It
is not true of a setup a user built in the Workbench, where the inlet is
whichever face they picked and the velocity is whatever they typed. Run 11 set
+20 m/s in x, solved 879,511 cells correctly, and reported:

```
Drag   -0.2096 N
```

Drag is the component of the force along the free stream, and nothing else:

```python
drag = Fx * ux + Fy * uy      # u = the unit inlet velocity
side = Fx * -uy + Fy * ux     # the horizontal component across it
```

With `u = (-1, 0, 0)` that reduces to exactly the old `-Fx`, so add-in jobs
keep the numbers they have always had. Read the direction from the first
`VELOCITY_INLET_V3` in the spec and fall back to the add-in's convention when
there is no inlet to read.

---

### C52. A passing chart test can be testing a different chart

The React `Plot` component wants `{ name: [[x, y], ...] }`. `export_plots`
writes parallel arrays sharing one iteration axis:

```json
{"forces":    {"iterations": [...], "drag": [...], "lift": [...]},
 "residuals": {"iterations": [...], "series": {"Ux": [...], "p": [...]}}}
```

Nothing converted between them, so `series[n]` was a list of plain numbers,
destructuring one as `[x, y]` threw, and the entire run panel fell to the error
boundary reading **"This panel could not be drawn"** the first time any run
ever got far enough to have plots.

`tests/test_chart.mjs` was green throughout. It tests the *other* renderer, the
one on the classic page, against a fixture in the correct stored shape. A green
test on a component the user does not see is not coverage of the one they do.

Convert at the boundary, in the panel that owns both sides, and test the
adapter against `tests/plots.json` — a real capture from a completed run.
Include a check that the *un-adapted* shape still fails, or the test proves
nothing.

While fixing it: the worker had always written a moments trace and nothing had
ever drawn it. Pitch is what tells a team where their downforce actually sits.

---

### C53. A wash of a colour moves the ground towards the text

The run status strip paints its own status colour at 16 % behind text of that
same colour:

```css
.wb-runstatus-ok { background: color-mix(in srgb, var(--wb-ok) 16%, transparent);
                   color: var(--wb-ok); }
```

On the dark theme that wash lifts a near-black panel slightly and the bright
green stays clear of it. On the light theme it does the opposite: it pulls a
near-white panel **towards** the dark green, and "Finished" fell from 5.7:1 on
the plain panel to 4.1:1 on its own wash. The credits beside it, dim grey on a
green wash, reached 3.6:1.

Two things follow. Any colour used both as text and as a wash behind that text
needs checking in the theme where it is the *dark* half of the pair. And dim
secondary text has no business on a coloured wash at all: it is neither the
status colour nor readable, so it steps up to ink-2 inside the strip.

The static audit missed all of it, because it could not parse `color-mix` and
skipped every rule that used one. An audit that silently skips what it cannot
read reports a clean sheet on the thing it cannot see: the same failure as its
first version, which swallowed comments into selectors. **Check the pair count,
not just the failure count** - teaching it `color-mix` took it from 105 pairs
to 126, and the 21 it had never been looking at held six of the failures.

---

### C54. The client renames every field on the way in

`src/lib/firebase.js` converts **top-level** keys snake_case to camelCase on
every read, and back on every write. It is a deliberate bridge: Firestore is
snake_case, and these pages were written in camelCase.

So a run document that holds

```
results_glb_path   log_paths   error_detail   stage_text
```

reaches a React component as

```
resultsGlbPath     logPaths    errorDetail    stageText
```

Nested maps are **not** converted - `summary.drag` and `plots.forces.iterations`
keep the worker's spelling, because those blobs belong to whoever wrote them.
So within one component, `run.stageText` and `run.summary.drag` are both
correct, and `run.stage_text` and `run.summary.dragN` are both wrong.

Having already fixed three reader/writer name mismatches (C49), I then wrote
the *worker's* spelling into two more fixes, and the run panel reported "The
solver has not written its log yet" on a run whose log path was sitting in
Firestore.

Worse, `tests/test_run_fields.mjs` passed. It compared the Workbench's reads
against the **writer's** names, which is precisely backwards: it accepted
`run.results_glb_path`, the one spelling the client is never handed, and would
have rejected the correct `run.logPaths`. A test built on the wrong model of a
system is not weaker than no test, it is worse: it reported a clean sheet on
three live bugs.

The set to compare against is every writer key **put through the same
conversion the client applies**, and nothing else. Check it against a known-bad
case: a test that cannot fail has not been written yet.

---

### C55. A Storage rule cannot look a user up in Firestore

Results were written to `results/{jobId}/...`, and the only thing tying that
folder to a person was a cross-service lookup inside the Storage rules:

```
function ownsJob(jobId) {
  return signedIn()
    && firestore.exists(/databases/(default)/documents/jobs/$(jobId))
    && firestore.get(/databases/(default)/documents/jobs/$(jobId)).data.user_id
       == request.auth.uid;
}
```

It compiles. It deploys. It denies. Cut down to nothing but the `exists()`
call it still denies, so it is the lookup itself, not the comparison. Every
results download this product has ever offered has returned 403, to the owner,
and nothing said so: **a denied rule reports only "Permission denied"**, with no
hint that a line inside it failed rather than evaluated false.

The fix is the one the rules file's own header already describes, for the same
mistake made on geometry uploads:

> a uid in the path is a complete ownership check on its own, needs no lookup,
> and cannot half-work

So the worker writes to `users/{uid}/results/{jobId}/` and the rule is
`request.auth.uid == uid`.

Two lessons worth more than the fix. **Storage rules had no tests at all** —
`tests/test_security.mjs` is 69 checks of Firestore rules and not one of
Storage, which is exactly why this survived. And when checking a rule by hand,
get a control first: an allowed path with a missing object returns **404**, a
denied one returns **403**. Without knowing that, 403 on an empty folder looks
identical to a broken rule, and I read a correct rule as broken once before
spotting it.

---

### C56. Three of the test suites had not run in months

`tests/run-all.ps1` listed seven suites. Three of them died on import:

| Suite | Why |
|---|---|
| `test_plots.py` | pointed at `docker jobs/simscale_job.py` |
| `test_results_export.py` | same path, and stubbed **Supabase** uploads for a worker that now writes to Firebase Storage |
| `test_transform.py` | pointed at `tessellate/main.py` |

The services moved into `services/` during the queue-mode rewrite and nothing
followed them. A fourth entry, `test_lapsim.mjs`, was still listed after the
file had been deleted. None of it showed up as a failure anybody read, because
the runner printed FAIL beside a name and carried on, and nobody ran it.

Worse than the stale paths: `test_transform.py` source-sliced two functions out
of `main.py` by cutting between markers -

```python
for first, last in [("def exact_bbox", "def caller_uid"),
                    ("def apply_ops", '@app.route("/transform"')]:
```

`main.py` has since been reordered, and **both end markers now appear before
their function**, so both slices came out empty and the module defined nothing.
The error, `module 'ops' has no attribute 'apply_ops'`, reads exactly like
deleted code and was really a moved line. Extract by name with `ast` instead:
it cannot break on reordering, and it can say which function actually went
missing.

All three pass now, and `test_results_export.py` earns its place immediately -
it drives a real solution package through `export_results_for_viewer` and out
to a glTF plus field binaries, which is the path step 11 is about to depend on.

`sh tests/run-all.sh` runs everything needing neither an emulator nor a credit;
`sh tests/run-all.sh --emulator` adds the Firestore and Storage rules suites.

---

### C57. A flow region's frontal area is the tunnel, not the car

The geometry service reports `frontal_area_m2` as the area of the imported
model's **shadow**. For a bare car that is the car. TurboFlow does not import
bare cars: it imports a *flow region*, a tunnel box with the car subtracted, so
the shadow is the tunnel's cross-section. On the test model:

```
Frontal area      1253.46 cm2     = 0.125 m2
inlet face area                     0.125 m2
```

The same number, because they are the same surface.

That value was prefilled straight into the reference area of a forces-and-
moments result control. A team switching coefficients on would have divided
their drag by the tunnel and quoted a Cd wrong by the ratio of tunnel to car -
and Cd is the one figure a STEM Racing team is judged on. Nothing would have
looked broken; the number would simply have been wrong.

Telling the two apart is easy, because a solid box fills its own bounding box
and a car fills about half of it:

```js
const section = bbox.size[1] * bbox.size[2];   // y x z
const isDomain = frontal_area_m2 / section > 0.9;   // the test region: 0.98
```

So: show the figure with a warning saying what it actually measures, and leave
the reference area **empty** rather than filling it with a number that is
confidently wrong. An empty box a user has to fill beats a wrong one they will
not question.

Worth noting for whoever writes the test: a shadow can never exceed its own
bounding-box cross-section, so a fixture claiming otherwise is impossible. My
first "bare car" fixture did exactly that and the test failed on the fixture,
not the code.

---

### C58. A guess that is not cleared is a guess the next file inherits

The import dialog reads the unit out of a STEP file's own header and preselects
it. When a file declares nothing - every STL - it used to leave the dropdown
alone:

```js
if (declared) { setUnit(declared); setUnitFromFile(declared); }
else if (extOf(f.name) === "stl") { setUnitFromFile(null); }   // setUnit never called
```

So dropping a millimetre STEP, changing your mind and dropping an STL left the
STL set to **millimetres**, underneath a hint reading "STL files carry no unit,
so this is the one thing you have to get right". The same STL got a different
unit depending on what the user had looked at first, and nothing on screen said
so. A 210 mm car read as metres is 210 metres long; the other way round it is a
fifth of a millimetre. Either way the tunnel is meaningless and the run is paid
for.

Clearing a guess is as much a part of making one as setting it. Reset to the
default whenever the file declares nothing, and again when the user presses
Change.

Checked the way the bug happens rather than the way the code reads: drop a
millimetre STEP, press Change, drop an STL, read the dropdown back.

---

### C59. Queueing is not navigation, so it skipped the save guard

`navigate()` carries this comment, and it is right:

> Every navigation in the Workbench goes through this rather than calling go()
> directly, because the one that does not is the one that loses somebody's
> work.

Opening the Queue dialog was the one that did not. Both entry points - the "+"
on Simulation runs and the panel's own Queue button - called `setQueueFor()`
straight, so the open panel was never asked to commit.

Observed, not theorised: type 400 into End time, watch the panel's own
estimate change to **40 credits**, click Queue, and the dialog says *"End time
250 iterations. This run costs 25 credits."* Queue it and the run is built from
the 250 still in the database, charged 25, with 400 still on the screen behind
the dialog. The user is charged for a run they did not configure and shown a
number that is not the one they will get.

Two fixes, because there were two faults:

1. **Queue through the same guard as navigation.** `openQueue()` awaits
   `leaveRef.current()` exactly as `navigate()` does: a valid draft is saved on
   the way in, an invalid one holds the user where they are.
2. **Hold the simulation's id, not the simulation.** The dialog captured
   whatever the snapshot said when it opened - and step 1 saves immediately
   before, so the write and the snapshot carrying it back are still in flight
   at that moment. Resolve the row from the live collection at render instead.

Note what the save indicator does *not* mean. `useSaver` tracks requests in
flight, so "All changes saved" means "nothing is being written right now", not
"your edits are stored". It reads exactly the same with a dirty draft sitting
in an open panel, which is the message most likely to stop someone pressing
the tick.

Testing this needs care. A React-controlled number input will not take a
synthetic `input` event reliably - the controlled value wins the race and the
field snaps back, so the draft never goes dirty and the test proves nothing.
Use a **checkbox**: it commits on click with no local text state in the way.
Toggle it, confirm the store still disagrees, click Queue, and read the store
again.

---

### C60. Audit every route change, not just the one that broke

Fixing the Queue dialog was worth doing and was not the whole fault. Counting
the calls in App.jsx afterwards: **three** navigations went through the guard
and **eight** called `go()` straight. The queue path was simply the one whose
symptom cost money and so got noticed.

Of the eight, six were real navigation away from a panel that could be holding
uncommitted edits, and every one of them threw those edits away silently:

| Path | What a user was doing |
|---|---|
| a node's "+" | adding a boundary condition or material |
| Edit CAD | opening CAD mode on the geometry |
| View, in the job table | opening a run they had just queued |
| Log, in the job table | reading why a run failed |
| after Create simulation | the new simulation opens |
| after a geometry upload | the new geometry opens |

Two were correct as they stood, and it matters that they stay that way: the
setup panel's **X** and the results panel's close. The X is the discard
affordance - the draft hook's contract is "Escape and the white X discard" -
so routing it through a guard that saves would make the one control meaning
*throw this away* do the opposite. Both now say so in a comment, because the
next person counting `go(` calls will otherwise "fix" them.

The lesson is the shape of the search, not the six fixes. When a guard exists
and something slipped past it, the question is never "is that one path fixed"
but "how many paths are there, and which ones go through it". A grep for the
unguarded call is thirty seconds.

Verified on a real one rather than assumed: toggle a checkbox so the store and
the panel disagree, click **View** in the job table, and read the store back.

---

### C61. Count the menu items that are wired to nothing

The "+" buttons in the simulation tree were found wired to an empty function
and fixed. The **context menus were not looked at**, and they had the same
fault, worse:

```js
onGeometryAction={(what, g) => {
  if (what === "cad") { ... }        // and nothing else
}}
onSimulationAction={() => {}}        // nothing at all
```

Eleven items across three menus. **One** did something. Rename, Download,
Duplicate and Delete on a geometry; Rename, Duplicate and Delete on a
simulation; Rename, Duplicate and Delete on a boundary condition - all opened,
all clicked, all did absolutely nothing. No dialog, no change, no error.

What each one deserved was a different answer, and the split is the useful part:

- **Rename** works and is two lines: `name` is already in the fields
  firestore.rules lets an owner update, and `RenameDialog` already existed.
- **Download** works and is one line: the raw upload's path through
  `storage.url()`.
- **Duplicate** has no backend, so it goes.
- **Delete** on a geometry needs an answer for the simulation pointing at it,
  which is a design question, not a wiring one. It goes until there is one.
- The boundary-condition menu goes entirely: the panel's title *is* the name
  and its footer already has a working delete, so all three items were
  redundant as well as dead.

The rule is the same one this codebase already states in TopBar.jsx about
SimScale's AI Agent button - *a button for a thing that does not exist is worse
than no button* - and it applies to menus nobody thought to open.

While in there: the row menu did not close on Escape, so a keyboard user who
opened it to look had no way to change their mind.

**Testing note.** These menu items fire on `onMouseDown`, not `onClick`, so a
synthetic `element.click()` does nothing and the feature looks broken when it
is not. It cost three failed probes and a wrong conclusion before I read the
handler. Dispatch a real `mousedown`.

---

# APPENDIX A: SimScale API v0 endpoints (complete, from the OpenAPI document, 10 Sep 2026)

```
GET    /projects                                   List projects
POST   /projects                                   Create a new project
GET    /projects/{projectId}                       Get project
PUT    /projects/{projectId}                       Update project
POST   /projects/{projectId}/copy                  Copy project
GET    /permissions/projects/{projectId}/requester Get user project permissions
POST   /projects/{projectId}/geometryimports       Import a new geometry
GET    /projects/{projectId}/geometryimports/{id}  Get geometry import
GET    /projects/{projectId}/geometryimports/{id}/eventlog
GET    /projects/{projectId}/geometries            List geometries
GET    /projects/{projectId}/geometries/{id}       Get geometry
PUT    /projects/{projectId}/geometries/{id}       Update geometry (rename)
GET    /projects/{projectId}/geometries/{id}/mappings   Face/region id mapping (class=face|region|body, limit, page)
POST   /projects/{projectId}/geometryprimitives    Create a geometry primitive
POST   /projects/{projectId}/tableimports          Import a table (probe points, tabular BCs)
GET    /projects/{projectId}/meshoperations        List mesh operations
POST   /projects/{projectId}/meshoperations        Create a mesh operation
GET    /projects/{projectId}/meshoperations/{id}   Get mesh operation (status, progress, meshId)
PUT    /projects/{projectId}/meshoperations/{id}   Update mesh operation
POST   /projects/{projectId}/meshoperations/{id}/check
POST   /projects/{projectId}/meshoperations/{id}/estimate
POST   /projects/{projectId}/meshoperations/{id}/start   (?simulationId=)
POST   /projects/{projectId}/meshoperations/{id}/cancel
GET    /projects/{projectId}/meshoperations/{id}/eventlog
GET    /projects/{projectId}/meshoperations/{id}/sdkcode
GET    /projects/{projectId}/meshes                List meshes
GET    /projects/{projectId}/meshes/{meshId}       Get mesh (numberOfCells, numberOfNodes)
GET    /projects/{projectId}/simulations           List simulations
POST   /projects/{projectId}/simulations           Create simulation
GET    /projects/{projectId}/simulations/{id}      Get simulation spec
PUT    /projects/{projectId}/simulations/{id}      Update simulation spec
POST   /projects/{projectId}/simulations/{id}/check
POST   /projects/{projectId}/simulations/{id}/estimate
POST   /projects/{projectId}/simulations/{id}/materials   Update materials from the library
GET    /projects/{projectId}/simulations/{id}/runs        List runs
POST   /projects/{projectId}/simulations/{id}/runs        Create run
GET    /projects/{projectId}/simulations/{id}/runs/{runId}
PUT    /projects/{projectId}/simulations/{id}/runs/{runId}   (rename)
GET    /projects/{projectId}/simulations/{id}/runs/{runId}/eventlog
GET    /projects/{projectId}/simulations/{id}/sdkcode
GET    /projects/{projectId}/simulations/{id}/runs/{runId}/sdkcode
GET    /projects/{projectId}/simulations/{id}/runs/{runId}/spec
POST   /projects/{projectId}/simulations/{id}/runs/{runId}/start
POST   /projects/{projectId}/simulations/{id}/runs/{runId}/add-wind-data   (PWC only)
POST   /projects/{projectId}/simulations/{id}/runs/{runId}/cancel
GET    /projects/{projectId}/simulations/{id}/runs/{runId}/results   (type, category, quantity, name, direction, limit, page)
GET    /projects/{projectId}/simulations/{id}/runs/{runId}/subruns   (parametric)
GET    /projects/{projectId}/simulations/{id}/runs/{runId}/subruns/{subRunId}/spec
POST   /projects/{projectId}/simulations/{id}/runs/{runId}/subruns/{subRunId}/cancel
DELETE /projects/{projectId}/simulations/{id}/runs/{runId}/subruns/{subRunId}
GET    /projects/{projectId}/simulations/{id}/runs/{runId}/subruns/{subRunId}/results
GET    /projects/{projectId}/reports                 (reports: list, create, from-state, get, update, delete, start, cancel)
POST   /projects/{projectId}/reports
POST   /projects/{projectId}/reports/from-state
GET    /projects/{projectId}/reports/{reportId}
PUT    /projects/{projectId}/reports/{reportId}
DELETE /projects/{projectId}/reports/{reportId}
POST   /projects/{projectId}/reports/{reportId}/start
POST   /projects/{projectId}/reports/{reportId}/cancel
GET    /projects/{projectId}/postprocessing/results/{resultId}/manual-postprocessor-states
GET    /projects/{projectId}/postprocessing/results/{resultId}/automatic-postprocessor-states
POST   /storage                                      Create a temporary upload location (url, storageId, expiresAt)
GET    /materialgroups  POST /materialgroups  ... /materialgroups/{id}/materials ...   Material library
GET    /winddata
POST   /spaces/{spaceId}/folders   GET/PUT/DELETE /spaces/{spaceId}/folders/{folderId}
GET    /spaces/{spaceId}/content/projects   /content/folders   /folders/{folderId}/content/projects|folders
POST   /spaces/{spaceId}/move   POST /spaces/{spaceId}/folders/{folderId}/move
GET    /spaces   GET/PUT /spaces/{spaceId}   GET/PUT /permissions/spaces/{spaceId}   GET /permissions/spaces/{spaceId}/requester
POST   /users                                        Signup (enterprise)
GET    /ai/models   GET /ai/models/{id}   GET /ai/available-models   POST /ai/predict
POST   /projects/{projectId}/export   GET /projects/{projectId}/export/{exportId}
```

Run result types: `SOLUTION_FIELD`, `CONVERGENCE_PLOT`, `PLOT`, `TABLE`. Solution field
categories include `STATISTICAL_SURFACE_SOLUTION` and `TRANSIENT_SOLUTION`; downloads are
`PVD` or `ENSIGHT_GOLD` in `ZIP64`. Plot categories include `PROBE_POINT_PLOT`,
`FORCES_AND_MOMENTS_PLOT`, `AREA_AVERAGE_PLOT` **[verify exact names against a real run's
results list before hard-coding]**.

Incompressible boundary condition type keys: `VELOCITY_INLET_V3`, `VELOCITY_OUTLET_V7`,
`PRESSURE_INLET_V31`, `PRESSURE_OUTLET_V30`, `WALL_V34`, `FAN`, `SYMMETRY`, `PERIODIC`,
`WEDGE`, `CUSTOM_V37`, `EMPTY_2D`.

Mesh algorithm keys: `SIMMETRIX_MESHING_FLUID_V16` (Standard), `HEX_DOMINANT_SNAPPY_V5`,
`SIMMETRIX_MESHING_SOLID`, `SIMMETRIX_MESHING_ELECTROMAGNETICS`, `POLYGRID_MESHING`.

Geometry primitive keys: `CARTESIAN_BOX`, `ROTATABLE_CARTESIAN_BOX`, `LOCAL_CARTESIAN_BOX`,
`SPHERE`, `LOCAL_SPHERE`, `CYLINDER`, `POINT`, `BOX`, `HALF_SPACE`, `LOCAL_HALF_SPACE`.

# APPENDIX B: Default Incompressible spec

The file `docs/simscale/default_incompressible_spec.json` next to this document is the exact
`model` object SimScale's Workbench wrote for a new Incompressible simulation on 14 Aug 2026
(simulation `f665780d-87bb-4ce9-b2a0-2dec00c51292`). `createSimulation` sends it unchanged
with `geometryId` and `version: "34.0"` added. Every default in section 9 was read from it.

# APPENDIX C: Existing code to keep, change, or delete

| File | Action |
|---|---|
| `public/workbench.html` and `workbench-panels.js`, `workbench-results.js`, `workbench-adapter.js`, `cfd-setup.js` | Replace with `src/workbench/**` (React). Keep `cfd-setup.js`'s pricing and `derive()` maths as a module. Delete the rest at step 7. |
| `public/wb-viewcube.js` | Keep, wrap as a component. |
| `services/tessellate/main.py` | Keep. Add `/measure`. Make `/inspect` write `extras.adjacency` and per-face `start/count` in vertices. |
| `services/simscale-job/simscale_job.py` | Keep for the Fusion path. Add `SPEC_MODE`. Fix the last-time-step selection (line ~801). Write vector components. |
| `functions/src/jobs/onJobPending.ts` | Keep as the only charging path. |
| `functions/src/geometry/createUploadIntent.ts` | Extend (14.2). |
| `firestore.rules`, `storage.rules` | Extend as in 13.3 and 13.4. Never loosen the money rules. |
| `docs/WORKBENCH.md`, `docs/SIMSCALE.md` | Keep as history; this document supersedes them for the new Workbench. |

# APPENDIX D: SimScale docs figures used for verification

Copied on 10 Sep 2026 from SimScale's public documentation into `docs/simscale/figures/`.
The builder must open these and match them pixel for pixel where the spec says "verified".

| File | Shows |
|---|---|
| `conv_01_convergence-plot.jpg` | Run tree with convergence plots |
| `conv_02_residuals.png` | Residuals plot |
| `conv_03_quantities.png` | Good vs bad residuals |
| `conv_04_convergenceplots.jpg` | Domain, Walls, Inlets, Outlets plots |
| `conv_05_outlet.png` | Outlet plot |
| `conv_06_pressure-1.png` | Area average plot |
| `conv_07_continue-to-run.jpg` | Run panel and continue dialog |
| `conv_08_pressure-2-1.png` | Converged area average |
| `mesh_01_MEsh1.png` | Mesh panel top |
| `mesh_02_physics-cannot-be-taken-into-account-meshing-error.png` |  |
| `mesh_03_running-a-simulation-to-see-invalid-settings.png` |  |
| `mesh_04_gap-refinement-factor-2.png` |  |
| `mesh_05_gap-refinement.png` |  |
| `mesh_06_gap-refinement2.png` |  |
| `mesh_07_Fig1.png` | Standard mesher tree with refinement menu |
| `mesh_08_surface-custom-sizing-mesh-refinement.png` | Surface custom sizing panel |
| `mesh_09_volume-custom-sizing-mesh-refinement.png` | Volume custom sizing panel |
| `mesh_10_Volume-Custom.png` | Volume custom sizing distance mode |
| `mesh_11_Inflation.png` | Inflate boundary layer panel |
| `mesh_12_overall-layer-thickness.png` |  |
| `mesh_13_Meshstr.png` | Mesh structure |
| `mesh_14_image-3.png` | Extrusion refinement panel |
| `mesh_15_Replacesweep.png` |  |
| `mesh_16_Tjunction.png` |  |
| `mesh_17_sweep-mesh-results.png` |  |
| `mesh_18_image-19.png` |  |
| `mesh_19_Cell-zone.png` | Cell zone panel |
| `meshclip_01_mesh-clip-1.jpg` | Mesh clip button |
| `meshclip_02_mesh-clip-2.jpg` | Mesh clip panel |
| `meshclip_03_mesh-clip-4.jpg` | Generated mesh clip |
| `platform_01_new-dashboard-2.png` | Older dashboard layout with usage boxes |
| `platform_02_workbench-layout.jpg` | Whole Workbench with numbered parts: 1 tree, 2 settings panel, 3 scene tree, 4 viewer toolbar, 5 support, 6 orientation widget, 7 viewer, 8 job status |
| `post_01_entering-the-post-processor.jpg` |  |
| `post_02_image-37.png` | Post-processor overview with numbered parts |
| `post_03_legend-in-simscale-2-e1633729280931.jpg` | Legend toggle |
| `post_04_legend-bar-options.jpg` | Legend anatomy |
| `post_05_number-of-divisions-scale.jpg` | Legend divisions menu |
| `post_06_inspect-point-1.jpg` | Inspect point |
| `post_07_Post-Processing-statistics-panel.png` | Statistics card |
| `post_08_Post-Processing-Show-All.png` | Show all menu |
| `post_09_Post-Processing-Custom-Color-selection.png` | Custom colour menu |
| `post_10_Post-Processing-Edit-Color-Panel.png` | Edit colour panel |
| `post_11_creating-a-new-cutting-plane.png` | New cutting plane |
| `post_12_exporting-statistics-as-csv-with-cutting-plane.png` | Statistics on a cutting plane |
| `post_13_editing-cutting-plane-orientation-and-vectors.png` | Cutting plane orientation and vectors |
| `post_14_filters-settings.jpg` | Filter row icons |
| `post_15_iso-surface-1-e1633729933747.jpg` | Iso surface panel |
| `post_16_iso-volume-2-e1633729986973.jpg` | Iso volume panel |
| `post_17_iso-volumes-with-transparency-1.jpg` | Iso volume with transparency |
| `post_18_creating-a-particle-trace-1.jpg` | Particle trace creation |
| `post_19_particle-traces-multiple-filters-1-e1633730127608.jpg` | Multiple particle traces |
| `post_20_comets-and-spheres-particle-traces.jpg` | Comets and spheres |
| `post_21_image-21.png` | Plot over path settings |
| `post_22_image-23.png` | Plot over path result |
| `post_23_PostProcessing-Rotational-View.png` | Rotational filter |
| `post_24_PostProcessing-Rotational-Filter-Cylindrical-2D-View_2-1.png` | Rotational 2D view |
| `post_26_animation.jpg` | Animation filter |
| `post_27_animation-recording-in-simscale.png` | Recording |
| `post_28_downloading-an-animation.png` | Downloading an animation |
| `post_29_field-calculation-name-1.png` | Field calculator name |
| `post_30_adding-a-value-to-the-field-calculation.png` | Field calculator values |
| `post_31_total-pressure-formula.png` | Field calculator formula |
| `post_32_total-gauge-pressure.png` | Custom field result |
| `post_33_save-view.jpg` | Save view dialog |
| `post_34_manage-view-1.jpg` | Manage views dialog |
| `post_35_save-current-view-2.jpg` | Camera icon location |
| `post_36_image.png` | Compare button |
| `post_37_image-1.png` | Compare split view |
| `post_38_import-view-post-processor.png` | Import view |
| `post_39_Reset-post-processor-2.png` | Reset button |
| `post_40_reset-filter-1-e1633730297606.jpg` | Reset filter values |
| `simctrl_01_image-19.png` | Analysis types list |
| `simsetup_01_GeometryDialogBox-2.png` | Geometry panel with Create Simulation |
| `simsetup_02_image-13.png` | Analysis type list |
| `simsetup_03_SimulationTree-6.png` | Static simulation tree |
| `spoiler_01_2020-07-27_11-20-21.png` |  |
| `spoiler_02_spo1.jpg` |  |
| `spoiler_03_image-62.png` |  |
| `spoiler_04_image-51.png` |  |
| `spoiler_05_changing-render-mode.jpg` | Render mode dropdown |
| `spoiler_06_spo2_1.jpg` |  |
| `spoiler_07_spo2.jpg` | CAD Edit operations toolbar |
| `spoiler_08_spo3.jpg` | External flow volume panel |
| `spoiler_09_spo4.jpg` | Delete body panel |
| `spoiler_10_saved-selection-overview.png` |  |
| `spoiler_11_creating-save-selection-1.png` | Saved selections + button and selection highlight |
| `spoiler_12_create-selection-popup-2.png` |  |
| `spoiler_13_08-3.png` | Create Simulation dialog |
| `spoiler_14_global-settings-simulation.jpg` | Global settings panel and Incompressible tree |
| `spoiler_15_material-library-simscale.jpg` | Material library dialog with the fluid list |
| `spoiler_16_image-6.png` | Material panel (Air) with assignment block |
| `spoiler_17_image-10.png` |  |
| `spoiler_18_11-2.png` |  |
| `spoiler_19_spoiler-surfce-bc.jpg` | Wall boundary condition panel, no-slip |
| `spoiler_20_external-walls-spoiler-tutorial-1.jpg` | Wall panel, slip |
| `spoiler_21_image-76.png` | Velocity inlet panel, fixed value |
| `spoiler_22_spoiler-outlet-bc.jpg` | Pressure outlet panel |
| `spoiler_23_image-8.png` | Wall panel, moving wall |
| `spoiler_24_image-7.png` | Symmetry panel |
| `spoiler_25_image-17.png` | Simulation control panel |
| `spoiler_26_hexahedral-mesh-spoiler-tutorial.jpg` | Mesh panel with estimate and Generate footer |
| `spoiler_27_2020-07-10_15-05-35-2.jpg` | Refinements + menu |
| `spoiler_28_region-refinement-spoiler.jpg` | Region refinement panel |
| `spoiler_29_2020-07-10_14-51-35.jpg` | Cartesian box primitive panel |
| `spoiler_30_region-refinement-spoiler-2-1.jpg` | Region refinement with primitive assigned |
| `spoiler_31_2020-07-10_15-25-43.jpg` | Finished mesh in the viewer |
| `spoiler_33_pressurecontour.png` | Post-processor: Parts Color, iterations card, legend, run tree |
| `spoiler_34_hideouter.png` | Hide selection context menu |
| `spoiler_35_spoileronly.png` |  |
| `spoiler_36_tkecontour.png` | Cutting plane panel with vectors |
| `spoiler_37_particleTrace.png` | Particle trace seed pick |
| `spoiler_38_strealmline.png` | Particle trace panel |
| `wall_01_Boundary_layer_devlopment.png` |  |
| `wall_02_Boundary-layer-inflation-y-plus-less-than-1.jpg` |  |
| `wall_03_Slip-condition.png` |  |
| `wall_04_No_Slip_Setup.png` | No-slip setup |
| `wall_05_Slip_condition.png` |  |
| `wall_06_Slip_Setup_2.png` | Slip setup |
| `wall_07_moving_wall_velocity__2.png` |  |
| `wall_08_Moving_Wall_Setup_2.png` | Moving wall setup |
| `wall_09_Rotating_Cylinder.png` |  |
| `wall_10_image-46.png` | Rotating wall panel |
| `wall_11_Car_reference_wall_boundary_conditions_2.png` | Car reference wall BCs |
