#!/usr/bin/env python3
"""
TurboFlow — SimScale Cloud Run Job
Reads job details from Firestore, downloads files from Firebase Storage,
runs the full SimScale pipeline, and writes status back to Firestore.

Triggered by Cloud Function via Cloud Run Jobs API.
Job ID is passed via environment variable JOB_ID.
"""

import csv, time, logging, sys, json, requests, os, tempfile
from collections import defaultdict

import firebase_admin
from firebase_admin import credentials, firestore, storage as fb_storage

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
SIMSCALE_API_KEY = "9abd88bc-e0d7-4477-9416-842a69d1158d"
SIMSCALE_API_BASE = "https://api.simscale.com/v0"
SIMSCALE_PROJECT_ID = "3955117048594207313"
FIREBASE_PROJECT = "turboflow-7b3ca"
STORAGE_BUCKET = "turboflow-7b3ca.firebasestorage.app"
INLET_VELOCITY = 20.0
AIR_DENSITY = 1.2041
AIR_KIN_VISC = 1.516e-5
POLL_INTERVAL = 15

class CancelledError(Exception):
    """Raised when the user cancels the job via Firestore."""
    pass

logging.basicConfig(level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)])
log = logging.getLogger("simscale_job")

# ── Firebase init (uses Application Default Credentials on Cloud Run) ─────────
firebase_admin.initialize_app(options={"storageBucket": STORAGE_BUCKET})
db = firestore.client()

# ── Firestore helpers ─────────────────────────────────────────────────────────
def set_status(job_id, status, extra=None):
    data = {"status": status}
    if extra:
        data.update(extra)
    db.collection("jobs").document(job_id).update(data)
    log.info(f"  [Firestore] status → {status}")

# ── Cancellation helpers ─────────────────────────────────────────────────────
def is_cancelling(job_id):
    """Returns True if the user has requested cancellation via Firestore."""
    try:
        doc = db.collection("jobs").document(job_id).get()
        return doc.exists and (doc.to_dict() or {}).get("status") == "cancelling"
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

# ── Download from Firebase Storage ───────────────────────────────────────────
def download_file(remote_path, local_path):
    bucket = fb_storage.bucket()
    blob = bucket.blob(remote_path)
    blob.download_to_filename(local_path)
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

        # Find all Forces_Moments PLOT items
        fm_items = [r for r in results
                    if r.get("type") == "PLOT" and r.get("name") == "Forces_Moments"]
        log.info(f"  Found {len(fm_items)} Forces_Moments items")

        if not fm_items:
            log.warning(f"  No Forces_Moments results. Available: {[(r.get('type'), r.get('name')) for r in results]}")
            return None, None

        import io

        # Log all FM items
        for fm in fm_items:
            log.info(f"  FM item: quantity={fm.get('quantity')} category={fm.get('category')} direction={fm.get('direction')}")

        def find_col(d, candidates_list):
            for k in d:
                if any(c.lower() in k.lower() for c in candidates_list):
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
            fx_col = find_col(last, ["fx", "force_x", "f_x", "x"])
            fz_col = find_col(last, ["fz", "force_z", "f_z", "z"])
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


# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    job_id = os.environ.get("JOB_ID")
    if not job_id:
        log.error("JOB_ID environment variable not set")
        sys.exit(1)

    log.info(f"═" * 55)
    log.info(f"  TurboFlow Job: {job_id}")
    log.info(f"═" * 55)

    # Fetch job document from Firestore
    doc = db.collection("jobs").document(job_id).get()
    if not doc.exists:
        log.error(f"Job {job_id} not found in Firestore")
        sys.exit(1)
    job = doc.to_dict()

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

if __name__ == "__main__":
    main()
