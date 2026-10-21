#!/usr/bin/env python3
"""
TurboFlow — SimScale Cloud Run Job
Reads job details from Supabase (Postgres), downloads files from Supabase
Storage, runs the full SimScale pipeline, and writes status back to Supabase.

Triggered by Cloud Function via Cloud Run Jobs API.
Job ID is passed via environment variable JOB_ID.
"""

import csv, time, logging, sys, json, requests, os, tempfile, re
from collections import defaultdict

from supabase import create_client, Client

from simscale_sdk import (
    Configuration, ApiClient,
    StorageApi, GeometryImportsApi,
    GeometryImportRequest, GeometryImportRequestLocation, GeometryImportRequestOptions,
    GeometriesApi, SimulationsApi, SimulationRunsApi, MeshOperationsApi,
    SimulationSpec, SimulationRun,
    SymmetryBC,
    MeshOperation, SimmetrixMeshingFluid, AutomaticLayerOn,
    AutomaticMeshSizingSimmetrix, AutomaticCurvature, SurfaceCustomSizing,
    Incompressible, FluidModel, FluidInitialConditions,
    IncompressibleFluidMaterials, IncompressibleMaterial,
    NewtonianViscosityModel, DimensionalKinematicViscosity, DimensionalDensity,
    AdvancedConcepts,
    FluidNumerics, RelaxationFactor, ResidualControls, Tolerance,
    DimensionalPressure, FluidSolvers, Schemes,
    TimeDifferentiationSchemes, GradientSchemes, DivergenceSchemes,
    LaplacianSchemes, InterpolationSchemes, SurfaceNormalGradientSchemes,
    ScotchDecomposeAlgorithm,
    VelocityInletBC, PressureOutletBC, WallBC,
    FixedValueVBC, FixedValuePBC,
    MovingWallVBC, SlipVBC, NoSlipVBC,
    TopologicalReference,
    FluidSimulationControl, DimensionalTime, TimeStepWriteControl,
    FluidResultControls, ForcesMomentsResultControl,
    DimensionalVectorLength, DecimalVector,
    DimensionalVectorFunctionSpeed, ComponentVectorFunction, ConstantFunction,
    DimensionalVectorSpeed,
    DimensionalFunctionPressure,
)

# ── Config ────────────────────────────────────────────────────────────────────
# No default: a live API key does not belong in source. Set it on the Cloud Run
# job (it is in .env.deploy).
SIMSCALE_API_KEY = os.environ["SIMSCALE_API_KEY"]
SIMSCALE_API_BASE = "https://api.simscale.com/v0"
SIMSCALE_PROJECT_ID = "3955117048594207313"
SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE_ROLE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
SUPABASE_BUCKET = os.environ.get("SUPABASE_BUCKET", "cfd-files")
INLET_VELOCITY = 20.0
AIR_DENSITY = 1.2041
AIR_KIN_VISC = 1.516e-5
POLL_INTERVAL = 15

class CancelledError(Exception):
    """Raised when the user cancels the job via Supabase."""
    pass

logging.basicConfig(level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)])
log = logging.getLogger("simscale_job")

# ── Supabase init (service role — full access, bypasses RLS) ──────────────────
sb: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

# The app/UI use camelCase field names; Postgres columns are snake_case. Convert
# at the DB boundary so the pipeline body below can keep using camelCase keys.
def _to_snake(s):
    out = []
    for i, c in enumerate(s):
        if c.isupper():
            if i > 0 and s[i - 1] != "_":
                out.append("_")
            out.append(c.lower())
        else:
            out.append(c)
    return "".join(out)

_to_camel = lambda s: re.sub(r"_([a-z0-9])", lambda m: m.group(1).upper(), s)

# ── Supabase helpers ──────────────────────────────────────────────────────────
def fetch_job(job_id, columns="*"):
    """One job row as a dict, or None.

    maybe_single() returns None (not a response object) when nothing matches,
    so every caller has to guard both. Doing it here once keeps that out of the
    call sites.
    """
    res = sb.table("jobs").select(columns).eq("id", job_id).maybe_single().execute()
    return res.data if res and res.data else None

def set_status(job_id, status, extra=None):
    data = {"status": status}
    if extra:
        data.update(extra)
    # A SimScale traceback can run to thousands of characters. Truncate rather
    # than risk the write failing, which would leave the job stuck in its last
    # status forever — a job that cannot be marked failed is worse than a
    # shortened error message.
    if isinstance(data.get("error"), str) and len(data["error"]) > 4000:
        data["error"] = data["error"][:3997] + "..."
    row = {_to_snake(k): v for k, v in data.items()}
    sb.table("jobs").update(row).eq("id", job_id).execute()
    log.info(f"  [Supabase] status → {status}")

# ── Cancellation helpers ─────────────────────────────────────────────────────
def is_cancelling(job_id):
    """Returns True if the user has requested cancellation via Supabase."""
    try:
        row = fetch_job(job_id, "status")
        return bool(row) and row.get("status") == "cancelling"
    except Exception:
        return False

def cancel_mesh_operation(mesh_op_id):
    """Ask SimScale to stop a running mesh operation."""
    try:
        headers = {"X-API-KEY": SIMSCALE_API_KEY}
        url = (f"{SIMSCALE_API_BASE}/projects/{SIMSCALE_PROJECT_ID}"
               f"/meshoperations/{mesh_op_id}/cancel")
        resp = requests.post(url, headers=headers, timeout=15)
        log.info(f"  SimScale cancel mesh → {resp.status_code}")
    except Exception as e:
        log.warning(f"  cancel_mesh_operation failed: {e}")

def cancel_simulation_run(simulation_id, run_id):
    """Ask SimScale to stop a running simulation."""
    try:
        headers = {"X-API-KEY": SIMSCALE_API_KEY}
        url = (f"{SIMSCALE_API_BASE}/projects/{SIMSCALE_PROJECT_ID}"
               f"/simulations/{simulation_id}/runs/{run_id}/cancel")
        resp = requests.post(url, headers=headers, timeout=15)
        log.info(f"  SimScale cancel run → {resp.status_code}")
    except Exception as e:
        log.warning(f"  cancel_simulation_run failed: {e}")

# ── Download from Supabase Storage ───────────────────────────────────────────
def download_file(remote_path, local_path):
    data = sb.storage.from_(SUPABASE_BUCKET).download(remote_path)
    with open(local_path, "wb") as f:
        f.write(data)
    log.info(f"  Downloaded {remote_path} → {local_path}")

# ── SimScale clients ──────────────────────────────────────────────────────────
def build_clients():
    conf = Configuration()
    conf.host = SIMSCALE_API_BASE
    conf.api_key = {"X-API-KEY": SIMSCALE_API_KEY}
    client = ApiClient(configuration=conf)
    return {
        "geometry": GeometriesApi(client),
        "sims":     SimulationsApi(client),
        "runs":     SimulationRunsApi(client),
        "mesh":     MeshOperationsApi(client),
        "storage":  StorageApi(client),
        "geo_imp":  GeometryImportsApi(client),
        "client":   client,
    }

# ── Upload geometry to SimScale ───────────────────────────────────────────────
def upload_geometry(api, step_path, geom_name):
    log.info("── Uploading geometry to SimScale ──")
    storage = api["storage"].create_storage()
    with open(step_path, "rb") as f:
        data = f.read()
    log.info(f"    File size: {len(data)/1024/1024:.1f} MB")
    api["client"].rest_client.PUT(
        url=storage.url,
        headers={"Content-Type": "application/octet-stream"},
        body=data,
    )
    geo_import = api["geo_imp"].import_geometry(
        SIMSCALE_PROJECT_ID,
        GeometryImportRequest(
            name=geom_name,
            location=GeometryImportRequestLocation(storage_id=storage.storage_id),
            format="STEP",
            input_unit="m",
            options=GeometryImportRequestOptions(
                facet_split=False, sewing=True, improve=True,
                optimize_for_lbm_solver=False),
        ),
    )
    geo_import_id = geo_import.geometry_import_id
    while True:
        geo_import = api["geo_imp"].get_geometry_import(SIMSCALE_PROJECT_ID, geo_import_id)
        status = (geo_import.status or "").upper()
        log.info(f"    {status}")
        if status == "FINISHED":
            break
        if status in ("CANCELED", "FAILED"):
            raise RuntimeError(f"Geometry import failed: {status}")
        time.sleep(POLL_INTERVAL)
    log.info(f"  ✅ geometry_id: {geo_import.geometry_id}")
    return geo_import.geometry_id

# ── Load entity labels from CSV ───────────────────────────────────────────────
def load_entity_labels(label_path):
    log.info("── Loading entity labels ──")
    entity_label = {}
    wheel_map = {}
    with open(label_path) as f:
        for row in csv.DictReader(f):
            eid = int(row["step_entity_id"])
            label = row["label"]
            if label == "rotating_wall" and row.get("radius_m"):
                try:
                    r  = float(row["radius_m"])
                    cx = float(row["cx_m"])
                    cy = float(row["cy_m"])
                    cz = float(row["cz_m"])
                    key = (round(cx, 3), round(cy, 3), round(cz, 3))
                    if key not in wheel_map:
                        idx = len(wheel_map) + 1
                        wheel_map[key] = {
                            "name":  f"Wheel_{idx}",
                            "label": f"rotating_wall_{idx}",
                            "cx_m":  cx, "cy_m": cy, "cz_m": cz,
                            "omega": INLET_VELOCITY / r,
                        }
                    entity_label[eid] = wheel_map[key]["label"]
                except (ValueError, KeyError):
                    entity_label[eid] = label
            else:
                entity_label[eid] = label
    wheels = list(wheel_map.values())
    log.info(f"  Wheels detected: {len(wheels)}")
    return entity_label, wheels

# ── Fetch face mappings ───────────────────────────────────────────────────────
def fetch_label_to_names(api, geometry_id, entity_label):
    log.info("── Fetching face mappings ──")
    label_to_names = defaultdict(list)
    page = 1
    while True:
        res = api["geometry"].get_geometry_mappings(
            SIMSCALE_PROJECT_ID, geometry_id, _class="face", limit=100, page=page)
        batch = res.embedded or []
        for e in batch:
            d = e.to_dict()
            orig = d.get("originate_from") or []
            if not orig:
                continue
            eid = int(orig[0].get("entity") or 0)
            label = entity_label.get(eid)
            if label:
                label_to_names[label].append(d["name"])
        if len(batch) < 100:
            break
        page += 1
    for label, names in sorted(label_to_names.items()):
        log.info(f"    {label:<25} {len(names)} faces")
    return label_to_names

# ── Fetch region names ────────────────────────────────────────────────────────
def get_region_names(api, geometry_id):
    res = api["geometry"].get_geometry_mappings(
        SIMSCALE_PROJECT_ID, geometry_id, _class="region", limit=100, page=1)
    return [e.to_dict().get("name", "") for e in (res.embedded or [])]

# ── BC helpers ────────────────────────────────────────────────────────────────
def vel_func(vx, vy, vz):
    return DimensionalVectorFunctionSpeed(
        value=ComponentVectorFunction(
            x=ConstantFunction(value=vx),
            y=ConstantFunction(value=vy),
            z=ConstantFunction(value=vz),
        ), unit="m/s")

def vel_plain(vx, vy, vz):
    return DimensionalVectorSpeed(
        value=DecimalVector(x=vx, y=vy, z=vz), unit="m/s")

# ── Build simulation model ────────────────────────────────────────────────────
def build_model(label_to_names, region_names, wheels, geometry_id, iteration_count=1000, debug_mesh=False):
    def ents(label): return label_to_names.get(label, [])
    def topo(label): return TopologicalReference(entities=ents(label), sets=[])

    air = IncompressibleMaterial(
        name="Air",
        viscosity_model=NewtonianViscosityModel(
            kinematic_viscosity=DimensionalKinematicViscosity(
                value=AIR_KIN_VISC, unit="m²/s")),
        density=DimensionalDensity(value=AIR_DENSITY, unit="kg/m³"),
        topological_reference=TopologicalReference(entities=region_names, sets=[]),
    )

    bcs = []

    if ents("inlet"):
        bcs.append(VelocityInletBC(name="Inlet",
            velocity=FixedValueVBC(value=vel_func(-INLET_VELOCITY, 0, 0)),
            topological_reference=topo("inlet")))

    if ents("outlet"):
        bcs.append(PressureOutletBC(name="Outlet",
            gauge_pressure=FixedValuePBC(
                value=DimensionalFunctionPressure(
                    value=ConstantFunction(value=0.0), unit="Pa")),
            topological_reference=topo("outlet")))

    if ents("ground"):
        bcs.append(WallBC(name="Ground",
            velocity=MovingWallVBC(value=vel_plain(-INLET_VELOCITY, 0, 0)),
            topological_reference=topo("ground")))

    for label, name in [("top", "Top"), ("side", "Side")]:
        if ents(label):
            bcs.append(WallBC(name=name, velocity=SlipVBC(),
                topological_reference=topo(label)))

    if ents("symmetry"):
        bcs.append(SymmetryBC(name="Symmetry",
            topological_reference=topo("symmetry")))

    if ents("car_no_slip"):
        bcs.append(WallBC(name="Car", velocity=NoSlipVBC(),
            topological_reference=topo("car_no_slip")))

    wheel_bc_indices = {}
    for w in wheels:
        wlabel = w["label"]
        if ents(wlabel):
            wheel_bc_indices[len(bcs)] = w
            bcs.append(WallBC(name=w["name"], velocity=NoSlipVBC(),
                topological_reference=TopologicalReference(
                    entities=ents(wlabel), sets=[])))

    # Forces & moments covers car body + all wheel faces
    fm_faces = list(ents("car_no_slip"))
    for w in wheels:
        fm_faces.extend(ents(w["label"]))

    fm = ForcesMomentsResultControl(
        name="Forces_Moments",
        write_control=TimeStepWriteControl(write_interval=1 if debug_mesh else 100),
        center_of_rotation=DimensionalVectorLength(
            value=DecimalVector(x=0.1, y=0.0, z=0.014), unit="m"),
        topological_reference=TopologicalReference(
            entities=fm_faces, sets=[]))

    model = Incompressible(
        turbulence_model="KOMEGASST",
        model=FluidModel(),
        initial_conditions=FluidInitialConditions(),
        advanced_concepts=AdvancedConcepts(),
        materials=IncompressibleFluidMaterials(fluids=[air]),
        boundary_conditions=bcs,
        numerics=FluidNumerics(
            relaxation_factor=RelaxationFactor(),
            pressure_reference_value=DimensionalPressure(value=0, unit="Pa"),
            residual_controls=ResidualControls(
                velocity=Tolerance(absolute_tolerance=1e-5),
                pressure=Tolerance(absolute_tolerance=1e-5),
                turbulent_kinetic_energy=Tolerance(absolute_tolerance=1e-5),
                omega_dissipation_rate=Tolerance(absolute_tolerance=1e-5)),
            solvers=FluidSolvers(),
            schemes=Schemes(
                time_differentiation=TimeDifferentiationSchemes(),
                gradient=GradientSchemes(),
                divergence=DivergenceSchemes(),
                laplacian=LaplacianSchemes(),
                interpolation=InterpolationSchemes(),
                surface_normal_gradient=SurfaceNormalGradientSchemes())),
        simulation_control=FluidSimulationControl(
            end_time=DimensionalTime(value=iteration_count, unit="s"),
            delta_t=DimensionalTime(value=1, unit="s"),
            write_control=TimeStepWriteControl(write_interval=1 if debug_mesh else 100),
            max_run_time=DimensionalTime(value=36000, unit="s"),
            decompose_algorithm=ScotchDecomposeAlgorithm()),
        result_control=FluidResultControls(forces_moments=[fm]),
    )
    return model, wheel_bc_indices

# ── Patch wheel BCs ───────────────────────────────────────────────────────────
def patch_wheel_bcs(payload_dict, wheel_bc_indices):
    bcs = payload_dict["model"]["boundaryConditions"]
    for idx, w in wheel_bc_indices.items():
        bcs[idx]["velocity"] = {
            "type": "ROTATING_WALL_VELOCITY",
            "rotation": {
                "type": "ANGULAR_ROTATION",
                "rotationCenter": {
                    "value": {"x": w["cx_m"], "y": w["cy_m"], "z": w["cz_m"]},
                    "unit": "m"
                },
                "rotationAxis": {"value": {"x": 0.0, "y": 1.0, "z": 0.0}},
                "angularVelocity": {
                    "value": {"type": "CONSTANT", "value": w["omega"]},
                    "unit": "rad/s"
                }
            }
        }
    return payload_dict

# ── Create simulation ─────────────────────────────────────────────────────────
def create_simulation(api, label_to_names, region_names, wheels, geometry_id, sim_name, iteration_count=1000, debug_mesh=False):
    model, wheel_bc_indices = build_model(label_to_names, region_names, wheels, geometry_id, iteration_count, debug_mesh)
    spec = SimulationSpec(name=sim_name, geometry_id=geometry_id, model=model)
    payload = api["client"].sanitize_for_serialization(spec)
    payload = patch_wheel_bcs(payload, wheel_bc_indices)
    payload["version"] = "34.0"
    headers = {"X-API-KEY": SIMSCALE_API_KEY, "Content-Type": "application/json"}
    url = f"{SIMSCALE_API_BASE}/projects/{SIMSCALE_PROJECT_ID}/simulations"
    resp = requests.post(url, headers=headers, data=json.dumps(payload))
    if resp.status_code not in (200, 201):
        raise RuntimeError(f"create_simulation failed: {resp.status_code} {resp.text[:500]}")
    sim_id = resp.json()["simulationId"]
    log.info(f"  ✅ simulation_id: {sim_id}")
    return sim_id

# ── Mesh ──────────────────────────────────────────────────────────────────────
def create_mesh(api, simulation_id, geometry_id, label_to_names, wheels, job_id, mesh_cells_m=10.0, refine_level=3, debug_mesh=False):
    car_faces = label_to_names.get("car_no_slip", [])
    wheel_faces = []
    for w in wheels:
        wheel_faces.extend(label_to_names.get(w["label"], []))

    surface_refinements = []
    if car_faces:
        surface_refinements.append(SurfaceCustomSizing(
            name="Car_Surface_Refinement",
            sizing=AutomaticMeshSizingSimmetrix(fineness=10),
            topological_reference=TopologicalReference(entities=car_faces, sets=[])))
    if wheel_faces:
        surface_refinements.append(SurfaceCustomSizing(
            name="Wheel_Surface_Refinement",
            sizing=AutomaticMeshSizingSimmetrix(fineness=10),
            topological_reference=TopologicalReference(entities=wheel_faces, sets=[])))

    # Fineness map — all values divisible by 0.1 (SimScale requirement)
    _FINENESS = {1: 9.0, 2: 9.2, 3: 9.5, 4: 9.7, 5: 10.0}
    if debug_mesh:
        mesh_fineness = 1.0
    else:
        mesh_fineness = _FINENESS.get(max(1, min(5, refine_level)), 9.5)
    log.info(f"  Mesh fineness: {mesh_fineness} (refine_level={refine_level} debug={debug_mesh})")

    op = api["mesh"].create_mesh_operation(SIMSCALE_PROJECT_ID, MeshOperation(
        name="turboflow_mesh", geometry_id=geometry_id,
        model=SimmetrixMeshingFluid(
            physics_based_meshing=True,
            sizing=AutomaticMeshSizingSimmetrix(fineness=mesh_fineness),
            automatic_layer_settings=AutomaticLayerOn(),
            refinements=surface_refinements if surface_refinements else None)))
    mesh_op_id = op.mesh_operation_id
    api["mesh"].start_mesh_operation(
        SIMSCALE_PROJECT_ID, mesh_op_id, simulation_id=simulation_id)
    log.info("  Polling mesh...")
    while True:
        if is_cancelling(job_id):
            log.info("  ⛔ Cancellation requested — stopping mesh")
            cancel_mesh_operation(mesh_op_id)
            raise CancelledError()
        result = api["mesh"].get_mesh_operation(SIMSCALE_PROJECT_ID, mesh_op_id)
        status = (result.status or "").upper()
        log.info(f"    {status}")
        if status in ("FINISHED", "SUCCESS"):
            spec = api["sims"].get_simulation(SIMSCALE_PROJECT_ID, simulation_id)
            spec.mesh_id = result.mesh_id
            api["sims"].update_simulation(SIMSCALE_PROJECT_ID, simulation_id, spec)
            log.info(f"  ✅ mesh_id: {result.mesh_id}")
            return result.mesh_id
        if status in ("FAILED", "ERROR", "CANCELED"):
            raise RuntimeError(f"Mesh failed: {status}")
        time.sleep(POLL_INTERVAL)

# ── Run ───────────────────────────────────────────────────────────────────────
def start_run(api, simulation_id, job_id):
    run = api["runs"].create_simulation_run(
        SIMSCALE_PROJECT_ID, simulation_id, SimulationRun(name="Run_1"))
    run_id = run.run_id
    api["runs"].start_simulation_run(SIMSCALE_PROJECT_ID, simulation_id, run_id)
    log.info("  Polling run...")
    while True:
        if is_cancelling(job_id):
            log.info("  ⛔ Cancellation requested — stopping run")
            cancel_simulation_run(simulation_id, run_id)
            raise CancelledError()
        result = api["runs"].get_simulation_run(
            SIMSCALE_PROJECT_ID, simulation_id, run_id)
        status = (result.status or "").upper()
        log.info(f"    {status}")
        if status in ("FINISHED", "SUCCESS"):
            log.info("  ✅ Complete!")
            return run_id
        if status in ("FAILED", "ERROR", "CANCELED"):
            raise RuntimeError(f"Run failed: {status}")
        time.sleep(POLL_INTERVAL)


# ── Extract drag & lift from Forces_Moments result CSV ───────────────────────
def extract_drag_lift(simulation_id, run_id):
    """
    _embedded is a flat list of result objects. Each has:
      type, name, download:{url, format, ...}, quantity, etc.
    Forces_Moments results are type=PLOT name=Forces_Moments.
    There are two of them (pressure + viscous or total variants).
    We download each and pick the one with the largest force magnitude.
    """
    headers = {"X-API-KEY": SIMSCALE_API_KEY}
    try:
        url = (f"{SIMSCALE_API_BASE}/projects/{SIMSCALE_PROJECT_ID}"
               f"/simulations/{simulation_id}/runs/{run_id}/results")
        resp = requests.get(url, headers=headers, timeout=30)
        if not resp.ok:
            log.warning(f"  Results list failed: {resp.status_code}")
            return None, None

        results = resp.json().get("_embedded", [])
        if not isinstance(results, list):
            log.warning(f"  Unexpected _embedded type: {type(results)}")
            return None, None

        # Forces only. SimScale returns Forces_Moments twice — one FORCE_PLOT
        # (newtons) and one MOMENT_PLOT (newton-metres). The original code summed
        # both, which adds a moment to a force.
        fm_items = [r for r in results
                    if r.get("type") == "PLOT" and r.get("name") == "Forces_Moments"
                    and r.get("category") == "FORCE_PLOT"]
        log.info(f"  Found {len(fm_items)} Forces_Moments FORCE_PLOT items")

        if not fm_items:
            log.warning(f"  No Forces_Moments results. Available: {[(r.get('type'), r.get('name')) for r in results]}")
            return None, None

        import io

        # Log all FM items
        for fm in fm_items:
            log.info(f"  FM item: quantity={fm.get('quantity')} category={fm.get('category')} direction={fm.get('direction')}")

        def find_col(d, candidates_list):
            # Exact prefix, not substring. The old fuzzy match on "x" hit
            # PRESSURE_FORCE_X first and silently dropped skin friction —
            # about 10% of the drag on these bodies.
            for want in candidates_list:
                for k in d:
                    if k and k.strip().upper().startswith(want.upper()):
                        return k
            return None

        def parse_last_row(download_url):
            """Download CSV and return last row as dict, or None on failure."""
            csv_resp = requests.get(download_url, headers=headers, timeout=60)
            if not csv_resp.ok:
                log.warning(f"  CSV download failed: {csv_resp.status_code}")
                return None
            log.info(f"  CSV preview: {csv_resp.text[:300]}")
            reader = csv.DictReader(io.StringIO(csv_resp.text))
            rows = list(reader)
            if not rows:
                return None
            return rows[-1]

        # SimScale returns two FM items: one for pressure forces, one for viscous forces.
        # Total force = pressure + viscous. We sum both.
        total_drag, total_lift = 0.0, 0.0
        parsed_any = False

        for fm in fm_items:
            download_url = fm.get("download", {}).get("url")
            if not download_url:
                continue
            last = parse_last_row(download_url)
            if last is None:
                continue
            log.info(f"  Last row (quantity={fm.get('quantity')}): {dict(last)}")
            # TOTAL = pressure + viscous. Drag is X, lift is Z.
            fx_col = find_col(last, ["TOTAL_FORCE_X"])
            fz_col = find_col(last, ["TOTAL_FORCE_Z"])
            log.info(f"  fx_col={fx_col} fz_col={fz_col}")
            if fx_col and fz_col:
                total_drag += float(last[fx_col])
                total_lift += float(last[fz_col])
                parsed_any = True

        if not parsed_any:
            log.warning("  Could not parse any FM CSV")
            return None, None

        log.info(f"  ✅ Total Drag: {total_drag} N, Total Lift: {total_lift} N")
        return total_drag, total_lift

    except Exception as e:
        log.warning(f"  extract_drag_lift failed: {e}", exc_info=True)
        return None, None


# ── Get ParaView download URL ─────────────────────────────────────────────────
def get_paraview_download_url(simulation_id, run_id):
    """
    _embedded flat list contains a SOLUTION_FIELD item with a download.url
    that points to the VTK/ParaView result package.
    """
    headers = {"X-API-KEY": SIMSCALE_API_KEY}
    try:
        url = (f"{SIMSCALE_API_BASE}/projects/{SIMSCALE_PROJECT_ID}"
               f"/simulations/{simulation_id}/runs/{run_id}/results")
        resp = requests.get(url, headers=headers, timeout=30)
        if not resp.ok:
            log.warning(f"  ParaView results resp: {resp.status_code}")
            return None

        results = resp.json().get("_embedded", [])
        if not isinstance(results, list):
            return None

        # SOLUTION_FIELD is the VTK/ParaView result
        solution = next((r for r in results if r.get("type") == "SOLUTION_FIELD"), None)
        if solution:
            dl = solution.get("download", {})
            url = dl.get("url")
            log.info(f"  ParaView SOLUTION_FIELD url: {url}")
            if url:
                return url

        # Fallback: any item with a workbenchUrl
        for r in results:
            wb = r.get("workbenchUrl")
            if wb:
                log.info(f"  Fallback workbenchUrl: {wb}")
                return wb

        log.warning("  No ParaView URL found in results")
    except Exception as e:
        log.warning(f"  get_paraview_download_url failed: {e}", exc_info=True)
    return None


# ── Export results for TurboFlow's own viewer ────────────────────────────────
# SimScale hands back a VTK package. The workbench cannot read that, so unpack
# it here into two web-native pieces stored next to the geometry:
#
#   results.glb   surface triangles only, no colours
#   fields/<name>.bin  one Float32Array per field, one value per glb vertex
#   fields.json   what fields exist, their ranges and file names
#
# Keeping fields out of the glb means the viewer downloads the geometry once and
# switches between pressure / velocity / k / omega without refetching it, and
# colouring happens in a shader rather than being baked in.
# ponytail: surface fields only. Volume data is 10-100x larger and the 1 GB free
# tier will not hold it; slices through the volume need a server-side cut.
# Measured on a real run: a SOLUTION_FIELD package is ~1.7 GB and the download
# URL does not honour Range requests, so there is no way to fetch part of it.
# The whole thing comes down, the surface comes out, the rest is thrown away.
MAX_PACKAGE_BYTES = int(os.environ.get("MAX_PACKAGE_BYTES", str(6 * 1024**3)))
MAX_VIEWER_TRIANGLES = int(os.environ.get("MAX_VIEWER_TRIANGLES", "300000"))

RESULT_FIELDS = {
    "p": "Pressure", "U": "Velocity", "k": "Turb. kinetic energy",
    "omega": "Specific dissipation", "nut": "Turb. viscosity",
    "wallShearStress": "Wall shear stress",
}

def export_results_for_viewer(job_id, simulation_id, run_id, dest_prefix):
    import zipfile, io as _io, json as _json
    import numpy as np
    import pyvista as pv
    import trimesh

    url = get_solution_field_url(simulation_id, run_id)
    if not url:
        log.warning("  No SOLUTION_FIELD to export")
        return None

    with tempfile.TemporaryDirectory() as tmp:
        # Measured against a real run: these packages are 600 MB+. Never hold one
        # in memory — on Cloud Run /tmp is RAM-backed too, so this streams to
        # disk and then extracts only the surface entries, not the whole archive.
        pkg = os.path.join(tmp, "solution.zip")
        log.info("  Downloading solution field package…")
        with requests.get(url, headers={"X-API-KEY": SIMSCALE_API_KEY},
                          timeout=(30, 1800), stream=True) as resp:
            resp.raise_for_status()
            written = 0
            with open(pkg, "wb") as f:
                for chunk in resp.iter_content(chunk_size=4 << 20):
                    f.write(chunk)
                    written += len(chunk)
                    if written > MAX_PACKAGE_BYTES:
                        log.warning(f"  Package exceeds {MAX_PACKAGE_BYTES / 1e9:.1f} GB; "
                                    "skipping viewer export (results stay in SimScale)")
                        return None
        log.info(f"  Package: {written / 1e6:.1f} MB")

        try:
            zf = zipfile.ZipFile(pkg)
        except zipfile.BadZipFile:
            log.warning("  Solution package is not a zip; skipping viewer export")
            return None

        # Boundary/surface entries only. The volume field is where the bulk of
        # those 600 MB lives and we do not draw it.
        with zf:
            entries = [i for i in zf.infolist()
                       if i.filename.lower().endswith((".vtp", ".vtu", ".vtk", ".pvtu"))
                       and not i.is_dir()]
            if not entries:
                log.warning("  No VTK files inside the package")
                return None
            surface = [i for i in entries
                       if i.filename.lower().endswith(".vtp")
                       or "boundary" in i.filename.lower()
                       or "surface" in i.filename.lower()]
            pool = surface or entries
            pick = min(pool, key=lambda i: i.file_size) if not surface else max(pool, key=lambda i: i.file_size)
            log.info(f"  Extracting {pick.filename} ({pick.file_size / 1e6:.1f} MB)")
            zf.extract(pick, tmp)
            vtk_path = os.path.join(tmp, pick.filename)

        os.remove(pkg)                      # reclaim before VTK doubles it in memory
        mesh = pv.read(vtk_path)
        log.info(f"  Reading {os.path.basename(vtk_path)}: {mesh.n_points} points")

        surf = mesh.extract_surface() if not isinstance(mesh, pv.PolyData) else mesh
        surf = surf.triangulate().clean()

        # Solver meshes run to millions of cells. Nobody inspects a car body at
        # that density in a browser, and Storage is 1 GB. Decimate to a budget,
        # which is a visual change only — drag and lift come from the solver, not
        # from this surface.
        tris = surf.n_cells
        if tris > MAX_VIEWER_TRIANGLES:
            keep = MAX_VIEWER_TRIANGLES / tris
            log.info(f"  Decimating {tris} -> ~{MAX_VIEWER_TRIANGLES} triangles")
            # vtkQuadricDecimation throws point data away unless told to weigh
            # attributes in its error metric — and the flag that does that was
            # renamed in pyvista 0.45. Without it every decimated run would ship
            # geometry with no fields at all, which is most real runs. Ask for
            # whichever name this build understands.
            import inspect as _inspect
            opts = _inspect.signature(surf.decimate).parameters
            flag = next((n for n in ("enable_all_attribute_error", "attribute_error")
                         if n in opts), None)
            kw = {flag: True} if flag else {}
            reduced = surf.decimate(1 - keep, **kw)
            if set(RESULT_FIELDS) & set(surf.point_data) and not (
                    set(RESULT_FIELDS) & set(reduced.point_data)):
                # Better a heavier download than a result nobody can colour.
                log.warning("  Decimation dropped the fields; keeping the full surface")
            else:
                surf = reduced
                log.info(f"  Decimated to {surf.n_cells} triangles, {surf.n_points} points")
        pts = np.asarray(surf.points, dtype=np.float32)
        faces = surf.faces.reshape(-1, 4)[:, 1:4].astype(np.uint32)

        glb_local = os.path.join(tmp, "results.glb")
        trimesh.Trimesh(vertices=pts, faces=faces, process=False).export(glb_local)
        uploaded = {"glb": f"{dest_prefix}/results.glb", "fields": {}}
        upload_file(glb_local, uploaded["glb"], "model/gltf-binary")

        for name, label in RESULT_FIELDS.items():
            if name not in surf.point_data:
                continue
            arr = np.asarray(surf.point_data[name], dtype=np.float32)
            if arr.ndim > 1:                      # vectors -> magnitude
                arr = np.linalg.norm(arr, axis=1).astype(np.float32)
            if arr.shape[0] != pts.shape[0]:
                continue
            path = f"{dest_prefix}/fields/{name}.bin"
            local = os.path.join(tmp, f"{name}.bin")
            arr.tofile(local)
            upload_file(local, path, "application/octet-stream")
            uploaded["fields"][name] = {
                "label": label, "path": path,
                "min": float(np.nanmin(arr)), "max": float(np.nanmax(arr)),
            }

        manifest = {
            "jobId": job_id, "vertexCount": int(pts.shape[0]),
            "triangleCount": int(faces.shape[0]), **uploaded,
        }
        man_local = os.path.join(tmp, "fields.json")
        with open(man_local, "w") as f:
            _json.dump(manifest, f)
        upload_file(man_local, f"{dest_prefix}/fields.json", "application/json")

    log.info(f"  Exported {len(uploaded['fields'])} field(s) for the viewer")
    return manifest


# ── Convergence + force history ──────────────────────────────────────────────
# Unlike the solution field (1.7 GB), these are CSVs of a few KB: residuals per
# iteration and the force trace. Small enough to keep on the job row as jsonb,
# which is what lets the workbench draw convergence charts without another
# round trip to SimScale.
PLOT_POINTS = 250     # enough to draw; nobody reads 1000 pixels of residual

def _downsample(rows, n=PLOT_POINTS):
    if len(rows) <= n:
        return rows
    step = len(rows) / n
    return [rows[min(int(i * step), len(rows) - 1)] for i in range(n)]


def export_plots(simulation_id, run_id):
    import csv as _csv, io as _io
    out = {}
    try:
        r = requests.get(
            f"{SIMSCALE_API_BASE}/projects/{SIMSCALE_PROJECT_ID}"
            f"/simulations/{simulation_id}/runs/{run_id}/results",
            headers={"X-API-KEY": SIMSCALE_API_KEY}, timeout=30)
        if not r.ok:
            return None
        items = r.json().get("_embedded", []) or []

        def fetch_rows(item):
            url = (item.get("download") or {}).get("url")
            if not url:
                return []
            resp = requests.get(url, headers={"X-API-KEY": SIMSCALE_API_KEY}, timeout=120)
            if not resp.ok:
                return []
            return list(_csv.DictReader(_io.StringIO(resp.text)))

        # Residuals: one series per solved variable, log-scaled by the viewer.
        res = next((i for i in items if i.get("category") == "RESIDUALS_PLOT"), None)
        if res:
            rows = _downsample(fetch_rows(res))
            if rows:
                cols = [c for c in rows[0] if c and not c.lower().startswith("time")]
                it_col = next(iter(rows[0]))
                out["residuals"] = {
                    "iterations": [_num(r0.get(it_col)) for r0 in rows],
                    "series": {c: [_num(r0.get(c)) for r0 in rows] for c in cols},
                }

        # Force trace: drag is X, lift is Z. FORCE_PLOT only — the sibling
        # MOMENT_PLOT carries newton-metres under identical column names.
        fm = [i for i in items
              if i.get("name") == "Forces_Moments" and i.get("category") == "FORCE_PLOT"]
        drag, lift, iters = [], [], []
        for item in fm:
            rows = _downsample(fetch_rows(item))
            if not rows:
                continue
            it_col = next(iter(rows[0]))
            fx = next((c for c in rows[0] if c and c.upper().startswith("TOTAL_FORCE_X")), None)
            fz = next((c for c in rows[0] if c and c.upper().startswith("TOTAL_FORCE_Z")), None)
            if not (fx and fz):
                continue
            iters = [_num(r0.get(it_col)) for r0 in rows]
            xs = [_num(r0.get(fx)) for r0 in rows]
            zs = [_num(r0.get(fz)) for r0 in rows]
            # Several FM items (pressure / viscous) sum into one trace.
            drag = [a + b for a, b in zip(drag, xs)] if drag else xs
            lift = [a + b for a, b in zip(lift, zs)] if lift else zs
        if iters:
            out["forces"] = {"iterations": iters, "drag": drag, "lift": lift}
    except Exception as e:
        log.warning(f"  Plot export failed: {e}")
        return None
    return out or None


def _num(v):
    try:
        return float(str(v).strip().strip('"'))
    except (TypeError, ValueError):
        return None


def get_solution_field_url(simulation_id, run_id):
    """download.url of the SOLUTION_FIELD result item, or None."""
    r = requests.get(
        f"{SIMSCALE_API_BASE}/projects/{SIMSCALE_PROJECT_ID}"
        f"/simulations/{simulation_id}/runs/{run_id}/results",
        headers={"X-API-KEY": SIMSCALE_API_KEY}, timeout=30)
    if not r.ok:
        return None
    for item in r.json().get("_embedded", []) or []:
        if item.get("type") == "SOLUTION_FIELD":
            return item.get("download", {}).get("url")
    return None


def upload_file(local_path, remote_path, content_type):
    with open(local_path, "rb") as f:
        r = requests.post(
            f"{SUPABASE_URL}/storage/v1/object/{SUPABASE_BUCKET}/{remote_path}",
            headers={"apikey": SUPABASE_SERVICE_ROLE_KEY,
                     "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
                     "Content-Type": content_type, "x-upsert": "true"},
            data=f, timeout=600)
    if not r.ok:
        raise RuntimeError(f"upload {remote_path} failed: {r.status_code} {r.text[:200]}")


# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    job_id = os.environ.get("JOB_ID")
    if not job_id:
        log.error("JOB_ID environment variable not set")
        sys.exit(1)

    log.info(f"═" * 55)
    log.info(f"  TurboFlow Job: {job_id}")
    log.info(f"═" * 55)

    # Fetch job row from Supabase (converted to camelCase for the pipeline below)
    row = fetch_job(job_id)
    if not row:
        log.error(f"Job {job_id} not found in Supabase")
        sys.exit(1)
    job = {_to_camel(k): v for k, v in row.items()}

    # Web-submitted jobs carry no geometry (the Fusion plugin uploads it), so
    # bail out with a status the UI can show instead of a KeyError traceback.
    if not job.get("stepPath") or not job.get("labelPath"):
        msg = "Job has no uploaded geometry (stepPath/labelPath missing)."
        log.error(msg)
        set_status(job_id, "failed", {"error": msg})
        sys.exit(1)

    set_status(job_id, "downloading")

    # Download files to temp directory
    with tempfile.TemporaryDirectory() as tmpdir:
        step_path  = os.path.join(tmpdir, "geometry.step")
        label_path = os.path.join(tmpdir, "entity_labels.csv")
        download_file(job["stepPath"],  step_path)
        download_file(job["labelPath"], label_path)

        geom_name = f"turboflow_{job_id[:8]}"
        sim_name  = f"turboflow_{job_id[:8]}_KOmegaSST_20ms"

        try:
            api = build_clients()

            set_status(job_id, "uploading_geometry")
            geometry_id = upload_geometry(api, step_path, geom_name)

            set_status(job_id, "processing")
            entity_label, wheels = load_entity_labels(label_path)
            label_to_names = fetch_label_to_names(api, geometry_id, entity_label)
            region_names   = get_region_names(api, geometry_id)

            iteration_count = int(job.get("iterationCount", 1000))
            iteration_count = max(1, min(3000, iteration_count))
            # meshCellsM is stamped by Cloud Function from refineLevel — trust it
            mesh_cells_m    = float(job.get("meshCellsM", 15.0))
            mesh_cells_m    = max(0.1, min(20.0, mesh_cells_m))
            refine_level    = int(job.get("refineLevel", 3))
            debug_mesh      = bool(job.get("debugMesh", False))
            log.info(f"  iterationCount={iteration_count} refineLevel={refine_level} meshCellsM={mesh_cells_m} debug={debug_mesh}")

            set_status(job_id, "creating_simulation")
            simulation_id = create_simulation(
                api, label_to_names, region_names, wheels, geometry_id, sim_name, iteration_count, debug_mesh)

            set_status(job_id, "meshing", {"simulationId": simulation_id})
            mesh_id = create_mesh(api, simulation_id, geometry_id, label_to_names, wheels, job_id, mesh_cells_m, refine_level, debug_mesh)

            set_status(job_id, "running", {"meshId": mesh_id})
            run_id = start_run(api, simulation_id, job_id)

            # Extract drag & lift from last iteration
            drag_N, lift_N = extract_drag_lift(simulation_id, run_id)
            paraview_url   = get_paraview_download_url(simulation_id, run_id)

            complete_data = {
                "runId":        run_id,
                "geometryId":   geometry_id,
                "simulationId": simulation_id,
                "meshId":       mesh_id,
            }
            if drag_N is not None:  complete_data["drag_N"]  = drag_N
            if lift_N is not None:  complete_data["lift_N"]  = lift_N
            if paraview_url:        complete_data["paraviewUrl"] = paraview_url

            # Convergence + force history: cheap, so do it before the big one.
            try:
                plots = export_plots(simulation_id, run_id)
                if plots:
                    complete_data["plots"] = plots
            except Exception as e:
                log.warning(f"  Plot export failed: {e}")

            # Unpack the VTK results for TurboFlow's own viewer. Best effort:
            # the run itself succeeded, so never fail it over post-processing.
            try:
                prefix = (job.get("stepPath") or f"jobs/{job.get('userId')}/{job_id}").rsplit("/", 1)[0]
                manifest = export_results_for_viewer(job_id, simulation_id, run_id, prefix)
                if manifest:
                    complete_data["resultsGlbPath"] = manifest["glb"]
                    complete_data["resultsFields"]  = manifest["fields"]
            except Exception as e:
                log.warning(f"  Viewer export failed (results still available in SimScale): {e}")

            set_status(job_id, "complete", complete_data)
            log.info("═" * 55)
            log.info("  Job complete!")
            log.info("═" * 55)

        except CancelledError:
            log.info("  Job cancelled by user.")
            set_status(job_id, "cancelled")
            sys.exit(0)
        except Exception as e:
            log.error(f"Job failed: {e}")
            set_status(job_id, "failed", {"error": str(e)})
            sys.exit(1)
        finally:
            # Free storage: the STEP/CSV are only needed to seed SimScale, which
            # now holds the geometry. Delete them so the 1 GB free tier lasts.
            paths = [p for p in (job.get("stepPath"), job.get("labelPath")) if p]
            if paths:
                try:
                    sb.storage.from_(SUPABASE_BUCKET).remove(paths)
                    log.info(f"  Cleaned up input files: {paths}")
                except Exception as e:
                    log.warning(f"  Input-file cleanup failed: {e}")

if __name__ == "__main__":
    main()
