# 10. Glossary

Words used across the code, the docs and the chats.

| Word | Meaning |
|---|---|
| **STEM Racing** | The school competition (formerly F1 in Schools) where teams design small CO2-powered model cars. TurboFlow's customers. |
| **CFD** | Computational fluid dynamics: simulating air flow round the car. |
| **SimScale** | The commercial cloud CFD service that does TurboFlow's meshing and solving. One account, one API key, held by the backend only. |
| **Run** | One simulation of one setup. In the code, a `runs/{id}` document (what the Workbench shows) plus a `jobs/{id}` document (the money). |
| **Job** | The money document for a run, `jobs/{id}`. Entering `pending` is what charges the account and starts the worker. Fusion runs have a job and no run document. |
| **Group** | A container for any number of simulations. Replaced SimScale-style projects and folders on 12 Sep. |
| **Garage** | `/dashboard`: one row per group with its best drag, run count and any live run. The way into the Workbench. |
| **Workbench** | The browser tool at `/workbench/{groupId}`: upload a car, set it up in four steps, queue, read results. |
| **Geometry** | One uploaded car, `geometries/{id}`, with numbered **versions**. |
| **Version** | One state of a geometry, in its own folder `v{n}/`. Kind `raw` is the car; kind `flow_domain` is a tunnel built round it. |
| **Flow region / flow domain / tunnel** | The box of air with the car cut out of it. What SimScale actually meshes. |
| **The negative** | The owner's word for the car-shaped hole in the flow region. The viewer must never show it. |
| **Half tunnel / symmetry** | Solving half the car against a mirror plane. A quarter of the cells, same answer for drag; forces are doubled back up. |
| **Half model** | A car drawn as only one half, with a flat face on its centreline. Must be solved in a half tunnel. |
| **Mirror plane / symmetry plane** | The car's centreline plane, found from its triangles. |
| **Nudge** | Moving the mirror wall a few microns off the plane so the cut is not degenerate; several offsets are tried. |
| **Setup / spec** | The SimScale model JSON for a simulation (`simulations.spec`): materials, boundary conditions, numerics, controls. Faces are stored as browser face indices and translated at run time. |
| **Mesh spec** | The mesher settings (`simulations.mesh_spec`): Simmetrix fluid mesher, fineness, refinements, small-feature tolerance. |
| **Fineness** | SimScale's 0 to 10 mesh fineness. Priced rungs 9.0, 9.2, 9.5, 9.7, 10.0; draft rungs 7 and 8. |
| **Level** | The 1 to 5 price level that a fineness maps to. Level 3 is fineness 9.5. |
| **Iterations / end time** | How many solver steps a steady run takes. 1 to 3,000. |
| **Credits** | What runs cost. Bought with PayPal; 50 free on sign-up. |
| **Ledger** | `users/{uid}/transactions`: every credit movement, written only by the backend. Refunds are computed from it. |
| **Charge, refund, reversal** | Credits taken for a run; given back because the user cancelled before solving; given back because TurboFlow failed before solving. |
| **Unlimited pass** | A paid period in which runs cost nothing. Stacks on any time left. |
| **Sponsored / sponsor rate** | A team discount: they pay `sponsor_rate` times the list price, at least 1 credit. |
| **Clamp** | Cutting a setup down to what was paid for, at queue time. |
| **Connection token** | `tfk_...`: a revocable token a team pastes into the Fusion add-in. Exchanged for a session marked `fusion`, which may submit runs and nothing more. |
| **humanOnly** | A callable that refuses connection-token sessions. |
| **guard()** | The check every callable runs first: signed in, rate limited, input validated. |
| **Spec mode** | The worker's Workbench path: send the saved setup to SimScale. |
| **Label mode** | The worker's Fusion path: build the model from `entity_labels.csv` and four numbers. |
| **entity_labels.csv** | Which STEP face is the inlet, outlet, ground, top, side, symmetry, car, or which wheel (with radius and centre). |
| **STEP entity id** | A face's number inside the STEP file. The one name a face shares between the browser, the file and SimScale. |
| **Slivers** | Tiny faces and edges in CAD (under 0.25 mm² or 0.5 mm). The mesher refuses them. |
| **Small-feature tolerance** | Mesher setting that ignores features below a size; set to 2 mm. |
| **Frontal area** | The car's shadow along the wind, the reference area for drag and lift coefficients; over half the width for a half tunnel. |
| **Drag, lift, Cd, Cl** | Force along the wind; force upward (negative is downforce); and the same as coefficients, independent of speed. |
| **Rotating wall / spinning wheels** | Wheel faces given the angular speed of a wheel rolling on the road (speed divided by radius). |
| **Moving ground** | The road moves at the air speed, as it does relative to a real car. |
| **Quick setup** | One button that runs all four setup steps from saved defaults. |
| **Draft** | A panel's unsaved edits; saved only by the tick or Enter. |
| **OpenFOAM case** | What SimScale returns as a run's full result: the solver's own files. Converted for the viewer and offered as a ParaView download. |
| **Event log** | SimScale's log of an operation; the only place a failure's reason appears. |
| **Geometry service / tessellate** | The old app's Python OpenCascade service on Cloud Run. Deleted 22 Oct 2026; geometry now runs in the browser (`src/workbench/geometry/`). |
| **Worker** | The Python SimScale program (`services/simscale-job`), one Cloud Run job execution per run. |
| **Warm instance / min instances** | Keeping a Cloud Run service running while idle to avoid start-up delay. Costs money all the time. |
| **Emulators** | Firebase's local copies of Auth, Firestore, Functions and Storage, project `demo-turboflow`. |
| **The switch** | Moving production from the original app to the new build, per `docs/PROD_CUTOVER.md`. Not done. |
| **occt-wasm** | OpenCascade 8 compiled to WebAssembly; runs the browser tunnel cut. |
| **DESIGN_RULES.md** | The design rules for every page and the tool ("No AI slop"). |
| **UNVERIFIED** | Could not be checked from where the writer was. Treat as unknown. |
