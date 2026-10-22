#!/usr/bin/env python3
"""
TurboFlow — SimScale Cloud Run Job

Reads the job from Firestore, downloads the STEP and entity_labels.csv from
Firebase Storage, runs the SimScale pipeline, exports results for the Workbench,
and writes progress back to the job document.

Started by onJobPending through the Cloud Run Jobs API. The job id arrives in
the JOB_ID environment variable.
"""

# Before anything heavy, so the log says when the process itself began.
#
# A queued run took 4 minutes to fail on a setup the solver rejects in one
# second. Cloud Run started the container 9 seconds after the button was
# pressed and the first line of this file's own logging appeared 3 minutes 27
# seconds after that, which made the wait look like a queue when it was this
# module loading. These two lines are how that gets attributed rather than
# guessed at.
import time as _time
_BOOT = _time.time()
print("[boot] interpreter up, importing", flush=True)

import csv, time, logging, sys, json, math, requests, os, tempfile, re

import spec_mode
from collections import defaultdict

import firebase_admin
from firebase_admin import firestore, storage as fb_storage

from simscale_sdk import (
    Configuration, ApiClient,
    StorageApi, GeometryImportsApi,
    GeometryImportRequest, GeometryImportRequestLocation, GeometryImportRequestOptions,
    GeometriesApi, SimulationsApi, SimulationRunsApi, MeshOperationsApi,
    SimulationSpec, SimulationRun,
    SymmetryBC,
    MeshOperation, SimmetrixMeshingFluid, AutomaticLayerOn, AdvancedSimmetrixFluidSettings,
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
    ForceMomentCoefficientsResultControl,
    DimensionalArea, DimensionalLength, DimensionalSpeed,
    DimensionalVectorLength, DecimalVector,
    DimensionalVectorFunctionSpeed, ComponentVectorFunction, ConstantFunction,
    DimensionalVectorSpeed,
    DimensionalFunctionPressure,
)

# ── Config ────────────────────────────────────────────────────────────────────
# Nothing project- or credential-specific is baked in. A live API key does not
# belong in source, and a hardcoded bucket means a worker deployed anywhere else
# still reads and writes production's files.


def _load_env_file(path):
    """Load KEY=VALUE lines from a dotenv-style file without overriding existing env vars."""
    if not os.path.isfile(path):
        return
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value


# Local dev: pull in env/worker/simscale-job.env (git-ignored) when present.
# On Cloud Run these are set on the service, so the file is simply absent.
_load_env_file(os.environ.get("ENV_FILE") or os.path.join(
    os.path.dirname(__file__), "..", "..", "..", "env", "worker", "simscale-job.env"))

SIMSCALE_API_KEY = os.environ.get("SIMSCALE_API_KEY", "")
SIMSCALE_API_BASE = os.environ.get("SIMSCALE_API_BASE", "https://api.simscale.com/v0")
SIMSCALE_PROJECT_ID = os.environ.get("SIMSCALE_PROJECT_ID", "")
GCP_PROJECT = (os.environ.get("GOOGLE_CLOUD_PROJECT")
               or os.environ.get("GCLOUD_PROJECT", ""))
STORAGE_BUCKET = (os.environ.get("STORAGE_BUCKET")
                  or (GCP_PROJECT + ".firebasestorage.app" if GCP_PROJECT else ""))

# Freestream speed for the run being processed. Set from the job in main().
#
# This was a constant in both copies of this worker, and nothing ever read
# inlet_velocity off the job — so every run solved at 20 m/s regardless of the
# wind speed the user chose in Fusion and was charged for.
INLET_VELOCITY = 20.0
# The car's measured shadow, in square metres, and its length. Both come from
# the job, because only the geometry service has ever seen the car. Without an
# area there is no coefficient to compute, and a made-up one is worse than none.
FRONTAL_AREA_M2 = None
REFERENCE_LENGTH_M = None
AIR_DENSITY = 1.2041
AIR_KIN_VISC = 1.516e-5
POLL_INTERVAL = 15

# How long the whole job may take before this worker gives up on it.
#
# Cloud Run kills a task at its own timeout, and a killed task writes nothing —
# so the job document stays on whatever status it last reached. The user then
# sees a run that is permanently "running", which is also a status that cannot
# be refunded. Stopping ourselves first means the job is marked failed and the
# credits come back. Keep this below the Cloud Run task timeout.
MAX_RUN_SECONDS = int(os.environ.get("MAX_RUN_SECONDS", 6 * 3600))
_started_at = time.monotonic()

def check_deadline(stage):
    if time.monotonic() - _started_at > MAX_RUN_SECONDS:
        raise RuntimeError(
            f"Gave up waiting at the {stage} stage after "
            f"{MAX_RUN_SECONDS // 3600}h. The run may still be going in SimScale.")

class CancelledError(Exception):
    """Raised when the user cancels the job from the website."""
    pass


class MeshingError(Exception):
    """SimScale's mesher refused the geometry: something the user can change."""
    pass


logging.basicConfig(level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)])
print("[boot] imports done in %.1fs" % (_time.time() - _BOOT), flush=True)

log = logging.getLogger("simscale_job")

# ── Firebase init ─────────────────────────────────────────────────────────────
# Only the bucket is checked here, because without it Firebase cannot be
# initialised and there is nowhere to report anything to.
#
# The SimScale settings are deliberately NOT checked at import time. Exiting
# here would leave the job document on 'pending' — already charged, with nothing
# running and no explanation — which is the same shape as the bug where web jobs
# were charged and never dispatched. They are checked in main(), once there is a
# job to mark failed.
if not STORAGE_BUCKET:
    log.error("STORAGE_BUCKET is not set, and GOOGLE_CLOUD_PROJECT gives no default.")
    sys.exit(1)

# A secret that exists but has not been given a real value yet. Matches
# secretValue() in the backend, so both report "not configured" rather than
# sending the literal word to the API and reporting an authentication failure.
PLACEHOLDERS = {"", "unset", "UNSET", "REPLACE_ME", "changeme"}

def missing_simscale_config():
    """Which SimScale settings are absent, as a list of names."""
    return [n for n, v in (("SIMSCALE_API_KEY", SIMSCALE_API_KEY),
                           ("SIMSCALE_PROJECT_ID", SIMSCALE_PROJECT_ID))
            if (v or "").strip() in PLACEHOLDERS]

# Application Default Credentials on Cloud Run — the Admin SDK, so the rules do
# not apply here. That is why every path this worker touches is checked against
# the job's owner before it is used (see owned_path).
firebase_admin.initialize_app(options={"storageBucket": STORAGE_BUCKET})
db = firestore.client()

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

# ── Firestore helpers ─────────────────────────────────────────────────────────
def fetch_job(job_id, columns="*"):
    """The job document as a dict, or None.

    `columns` is ignored: Firestore has no column projection, and a job document
    is small. The argument stays so the call sites read the same.
    """
    del columns
    snap = db.collection("jobs").document(job_id).get()
    return snap.to_dict() if snap.exists else None

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
    db.collection("jobs").document(job_id).update(row)
    log.info(f"  [Firestore] status → {status}")

# ── Cancellation helpers ─────────────────────────────────────────────────────
def is_cancelling(job_id):
    """True once the user has asked to cancel, which the website does by setting
    the job status to 'cancelling'."""
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

# ── Firebase Storage ─────────────────────────────────────────────────────────
def owned_path(path, user_id, job_id):
    """True if this worker should be willing to read `path` for this job.

    The worker runs with Admin credentials, so it can read any object in the
    bucket. The Firestore rules stop a client naming someone else's file on a
    new job, but a job document written before those rules — or by anything that
    bypasses them later — would have this worker fetch another team's geometry
    and hand back a run based on it. Cheap to check here, and it does not depend
    on the rules being right.
    """
    if not isinstance(path, str) or not path:
        return False
    if ".." in path or path.startswith("/"):
        return False
    return path.startswith(f"users/{user_id}/") or path.startswith(f"jobs/{job_id}/")

def download_file(remote_path, local_path):
    blob = fb_storage.bucket().blob(remote_path)
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
def upload_geometry(api, step_path, geom_name, job_id):
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
        # This loop had neither of these. A user who cancelled during a long
        # geometry import was not noticed until it finished.
        check_deadline("geometry import")
        if is_cancelling(job_id):
            log.info("  ⛔ Cancellation requested — abandoning geometry import")
            raise CancelledError()
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
                    # A radius of zero is a plausible thing to find in a
                    # hand-made CSV, and INLET_VELOCITY / 0 raises
                    # ZeroDivisionError, which the except below does not catch —
                    # so one bad row killed the whole run with a traceback
                    # instead of leaving that face as a plain wall.
                    if r <= 0:
                        raise ValueError("radius_m must be greater than zero")
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
def build_model(label_to_names, region_names, wheels, geometry_id,
                iteration_count=1000, debug_mesh=False,
                frontal_area=None, reference_length=None):
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

    # Every iteration, as the Workbench path writes them. This is a few numbers
    # per iteration, not the flow field (that is simulation_control's
    # write_control below). At 100 a 100-iteration run had one force sample,
    # and SimScale then offers the plot with no export at all
    # ("availableExportFormats": [], "download": null): on 27 Sep 2026 an
    # add-in run solved and came back with no drag and no lift.
    write_every = TimeStepWriteControl(write_interval=1)
    fm = ForcesMomentsResultControl(
        name="Forces_Moments",
        write_control=write_every,
        center_of_rotation=DimensionalVectorLength(
            value=DecimalVector(x=0.1, y=0.0, z=0.014), unit="m"),
        topological_reference=TopologicalReference(
            entities=fm_faces, sets=[]))
    controls = [fm]

    # Drag and lift coefficients, computed by the solver rather than divided out
    # afterwards. It is the same arithmetic either way, but only the solver can
    # do it per iteration, so this is what makes a Cd trace possible at all
    # instead of one number at the end.
    #
    # Drag is along -x because that is the way the wind blows here: the inlet is
    # at max x and the velocity is set to -INLET_VELOCITY. Naming the direction
    # rather than the axis is also what keeps the number positive.
    if frontal_area and frontal_area > 0:
        controls.append(ForceMomentCoefficientsResultControl(
            name="Force_Coefficients",
            write_control=write_every,
            center_of_rotation=DimensionalVectorLength(
                value=DecimalVector(x=0.1, y=0.0, z=0.014), unit="m"),
            lift_direction=DimensionalVectorLength(
                value=DecimalVector(x=0.0, y=0.0, z=1.0), unit="m"),
            drag_direction=DimensionalVectorLength(
                value=DecimalVector(x=-1.0, y=0.0, z=0.0), unit="m"),
            pitch_axis=DimensionalVectorLength(
                value=DecimalVector(x=0.0, y=1.0, z=0.0), unit="m"),
            freestream_velocity_magnitude=DimensionalSpeed(
                value=INLET_VELOCITY, unit="m/s"),
            reference_length=DimensionalLength(
                value=float(reference_length or 0.2), unit="m"),
            reference_area_value=DimensionalArea(
                value=float(frontal_area), unit="m\u00b2"),
            topological_reference=TopologicalReference(
                entities=fm_faces, sets=[])))
    else:
        log.warning("  No frontal area on the job, so no coefficient plot. "
                    "Drag and lift in newtons are unaffected.")

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
        result_control=FluidResultControls(forces_moments=controls),
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
    model, wheel_bc_indices = build_model(
        label_to_names, region_names, wheels, geometry_id, iteration_count,
        debug_mesh, frontal_area=FRONTAL_AREA_M2, reference_length=REFERENCE_LENGTH_M)
    spec = SimulationSpec(name=sim_name, geometry_id=geometry_id, model=model)
    payload = api["client"].sanitize_for_serialization(spec)
    payload = patch_wheel_bcs(payload, wheel_bc_indices)
    payload["version"] = "34.0"
    headers = {"X-API-KEY": SIMSCALE_API_KEY, "Content-Type": "application/json"}
    url = f"{SIMSCALE_API_BASE}/projects/{SIMSCALE_PROJECT_ID}/simulations"
    # Every other call here has a timeout; without one a hung SimScale
    # endpoint holds the whole Cloud Run task open until its own deadline.
    resp = requests.post(url, headers=headers, data=json.dumps(payload),
                         timeout=(15, 120))
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

    # The same 2 mm small-feature tolerance the Workbench path has sent since
    # 11 Sep 2026. Without it SimScale sizes the mesh around every sliver in the
    # CAD: on 27 Sep 2026 a 16-face test car that meshed to 1.1 million cells
    # through the Workbench was refused here in 15 seconds with "no instance with
    # sufficient computational resources could be assigned".
    op = api["mesh"].create_mesh_operation(SIMSCALE_PROJECT_ID, MeshOperation(
        name="turboflow_mesh", geometry_id=geometry_id,
        model=SimmetrixMeshingFluid(
            physics_based_meshing=True,
            sizing=AutomaticMeshSizingSimmetrix(fineness=mesh_fineness),
            automatic_layer_settings=AutomaticLayerOn(),
            advanced_simmetrix_settings=AdvancedSimmetrixFluidSettings(
                small_feature_tolerance=DimensionalLength(value=0.002, unit="m")),
            refinements=surface_refinements if surface_refinements else None)))
    mesh_op_id = op.mesh_operation_id
    api["mesh"].start_mesh_operation(
        SIMSCALE_PROJECT_ID, mesh_op_id, simulation_id=simulation_id)
    log.info("  Polling mesh...")
    while True:
        check_deadline("meshing")
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
            # "Mesh failed: FAILED" was all a Fusion user ever saw. The reason
            # is in the operation's event log, as on the Workbench path.
            reason = spec_mode.first_error_in_event_log(
                SIMSCALE_API_BASE, SIMSCALE_PROJECT_ID, SIMSCALE_API_KEY,
                f"meshoperations/{mesh_op_id}/eventlog")
            raise RuntimeError(f"Mesh failed. {reason}" if reason else f"Mesh failed: {status}")
        time.sleep(POLL_INTERVAL)

# ── Run ───────────────────────────────────────────────────────────────────────
def start_run(api, simulation_id, job_id):
    run = api["runs"].create_simulation_run(
        SIMSCALE_PROJECT_ID, simulation_id, SimulationRun(name="Run_1"))
    run_id = run.run_id
    api["runs"].start_simulation_run(SIMSCALE_PROJECT_ID, simulation_id, run_id)
    log.info("  Polling run...")
    while True:
        check_deadline("solving")
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
def wait_for_result_links(simulation_id, run_id, timeout_s=240):
    """Wait until SimScale has attached a file to the run's force plot.

    SimScale reports a run FINISHED before its result files exist: straight
    afterwards every result item comes back with "download": null. The
    Workbench path never noticed, because it saves the event log and exports
    the 3D results first, which takes a minute or two. The add-in path read
    the forces half a second after FINISHED and got nothing, so on 27 Sep 2026
    a finished add-in run reported no drag and no lift. Returns whether the
    files arrived; on a timeout the caller reads whatever there is.
    """
    url = (f"{SIMSCALE_API_BASE}/projects/{SIMSCALE_PROJECT_ID}"
           f"/simulations/{simulation_id}/runs/{run_id}/results")
    deadline = time.time() + timeout_s
    while True:
        try:
            r = requests.get(url, headers={"X-API-KEY": SIMSCALE_API_KEY}, timeout=30)
            items = (r.json().get("_embedded") or []) if r.ok else []
            if any(i.get("category") == "FORCE_PLOT" and download_url_of(i) for i in items):
                return True
        except Exception as e:
            log.warning(f"  Result list not readable yet: {e}")
        if time.time() > deadline:
            log.warning("  Result files still not attached; reading what there is")
            return False
        log.info("  Waiting for SimScale to attach the result files")
        time.sleep(10)


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
        # By category, not by name: the name is whatever the result control was
        # called, which is the user's wording, not ours.
        fm_items = [r for r in results
                    if r.get("type") == "PLOT" and r.get("category") == "FORCE_PLOT"]
        log.info(f"  Found {len(fm_items)} FORCE_PLOT items")

        if not fm_items:
            log.warning(f"  No force plots. Available: {[(r.get('name'), r.get('category')) for r in results]}")
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
            download_url = download_url_of(fm)
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
                # Drag is the force along the wind, and the wind blows in -x
                # here: the inlet is at max x and the velocity is set to
                # -INLET_VELOCITY. So Fx on the car is negative, and reporting
                # it raw gives a car with minus one newton of drag. The
                # coefficient was saved from this by an abs() on the client;
                # the newtons on the readout were not.
                total_drag += -float(last[fx_col])
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
            url = download_url_of(solution)
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


def download_url_of(item):
    """A result item's download link, or None.

    SimScale sends "download": null on items it has no file for yet, rather
    than leaving the key out, so item.get("download", {}) hands back None and
    the next .get() raises. On 27 Sep 2026 that crashed the Fusion path's
    drag and lift, its ParaView link and its viewer export on a run that had
    solved perfectly well, and the job was still marked complete.
    """
    return ((item or {}).get("download") or {}).get("url")


RESULT_FIELDS = {
    "p": "Pressure", "U": "Velocity", "k": "Turb. kinetic energy",
    "omega": "Specific dissipation", "nut": "Turb. viscosity",
    "wallShearStress": "Wall shear stress",
}

def openfoam_car_surface(zf, tmp):
    """The car's surface with its fields, from an OpenFOAM case package.

    This is what SimScale actually delivers. Its solution field result offers
    one export format, OPEN_FOAM, and the package is a whole case: case.foam,
    the mesh in constant/polyMesh and a directory per written time, with no VTK
    anywhere in it. The exporter below only looked for VTK, so on every real
    run it logged "No VTK files inside the package" and returned nothing, and
    no run ever had 3D results.

    The car is every boundary patch that is not a tunnel wall. SimScale names
    the patches face1..faceN, so position is the only thing that separates
    them: the walls - inlet, outlet, road, roof, side and symmetry plane - are
    the patches lying flat on the domain's bounding box, and nothing on a car
    does that.

    Returns a PolyData, or None if the package is not an OpenFOAM case.
    """
    import re as _re
    import numpy as _np
    import pyvista as _pv

    names = [i.filename for i in zf.infolist() if not i.is_dir()]
    if "case.foam" not in names:
        return None
    times = sorted({n.split("/", 1)[0] for n in names if _re.match(r"^\d+(\.\d+)?/", n)},
                   key=float)
    if not times:
        return None
    last = times[-1]
    # Only what the reader needs for the last time. rampsFaceMap is 20 MB of
    # SimScale bookkeeping and phi is the face flux; neither is drawn.
    keep = [n for n in names
            if n == "case.foam"
            or (n.startswith(("constant/", "system/")) and not n.endswith("rampsFaceMap"))
            or (n.startswith(last + "/") and n.count("/") == 1
                and n.split("/", 1)[1].split(".")[0] in RESULT_FIELDS)]
    for n in keep:
        zf.extract(n, tmp)

    reader = _pv.OpenFOAMReader(os.path.join(tmp, "case.foam"))
    reader.set_active_time_value(float(last))
    reader.disable_all_patch_arrays()
    for patch in reader.patch_array_names:
        if patch.startswith("patch/"):
            reader.enable_patch_array(patch)
    reader.cell_to_point_creation = True
    boundary = reader.read()["boundary"]
    blocks = [boundary[k] for k in boundary.keys()
              if boundary[k] is not None and boundary[k].n_cells]
    if not blocks:
        return None

    lo = _np.min([b.bounds[0::2] for b in blocks], axis=0)
    hi = _np.max([b.bounds[1::2] for b in blocks], axis=0)
    tol = float(_np.max(hi - lo)) * 1e-6

    def tunnel_wall(b):
        bb = b.bounds
        for a in range(3):
            flat = bb[2 * a + 1] - bb[2 * a] <= tol
            if flat and (abs(bb[2 * a] - lo[a]) <= tol or abs(bb[2 * a + 1] - hi[a]) <= tol):
                return True
        return False

    car = [b for b in blocks if not tunnel_wall(b)]
    log.info(f"  OpenFOAM case at t={last}: {len(blocks)} patches, "
             f"{len(blocks) - len(car)} tunnel walls, {len(car)} on the car")
    if not car:
        return None
    merged = car[0] if len(car) == 1 else car[0].merge(car[1:])
    return merged.extract_surface()


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

        # The case itself, kept for anyone who wants to open it in ParaView,
        # which reads it as it is. Before this, the only copy stayed in
        # SimScale and the way to get one was to message us on Instagram.
        # Uploaded before any parsing, so a conversion that fails below still
        # leaves the download in place.
        case_path = None
        try:
            upload_file(pkg, f"{dest_prefix}/case.zip", "application/zip")
            case_path = f"{dest_prefix}/case.zip"
        except Exception as e:
            log.warning(f"  Could not keep the case for download: {e}")
        only_case = {"case": case_path, "glb": None, "fields": {}} if case_path else None

        try:
            zf = zipfile.ZipFile(pkg)
        except zipfile.BadZipFile:
            log.warning("  Solution package is not a zip; skipping viewer export")
            return only_case

        # Boundary/surface entries only. The volume field is where the bulk of
        # those 600 MB lives and we do not draw it. A package with no VTK in it
        # is read as the OpenFOAM case SimScale actually sends.
        mesh = None
        with zf:
            entries = [i for i in zf.infolist()
                       if i.filename.lower().endswith((".vtp", ".vtu", ".vtk", ".pvtu"))
                       and not i.is_dir()]
            if entries:
                surface = [i for i in entries
                           if i.filename.lower().endswith(".vtp")
                           or "boundary" in i.filename.lower()
                           or "surface" in i.filename.lower()]
                pool = surface or entries
                pick = min(pool, key=lambda i: i.file_size) if not surface else max(pool, key=lambda i: i.file_size)
                log.info(f"  Extracting {pick.filename} ({pick.file_size / 1e6:.1f} MB)")
                zf.extract(pick, tmp)
                vtk_path = os.path.join(tmp, pick.filename)
            else:
                mesh = openfoam_car_surface(zf, tmp)
                if mesh is None:
                    names = [i.filename for i in zf.infolist() if not i.is_dir()]
                    log.warning("  Neither VTK nor an OpenFOAM case in the package. "
                                "It holds %d entries: %s", len(names), names[:20])
                    return only_case

        os.remove(pkg)                      # reclaim before VTK doubles it in memory
        if mesh is None:
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
            "triangleCount": int(faces.shape[0]), **uploaded, "case": case_path,
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


def flow_direction(spec):
    """The unit vector the wind blows along, from the first velocity inlet.

    Drag is the force along the free stream, and nothing else. The old code
    negated Fx on the flat assumption that the wind blows in -x, which is true
    of the setup this worker builds for the Fusion add-in and is not true of a
    setup a user built in the Workbench. Run 11 pointed its inlet at +20 m/s in
    x and reported a drag of -0.21 N.

    Falls back to the add-in's own convention when there is no velocity inlet
    to read, so legacy jobs keep the numbers they have always had.
    """
    for bc in (spec or {}).get("boundaryConditions") or []:
        if bc.get("type") != "VELOCITY_INLET_V3":
            continue
        v = ((bc.get("velocity") or {}).get("value") or {}).get("value") or {}
        try:
            c = [float((v.get(ax) or {}).get("value") or 0.0) for ax in ("x", "y", "z")]
        except (TypeError, ValueError):
            continue
        mag = math.sqrt(sum(n * n for n in c))
        if mag > 1e-9:
            return (c[0] / mag, c[1] / mag, c[2] / mag)
    return (-1.0, 0.0, 0.0)


def symmetry_factor(spec):
    """How many of the solved car there really are: 2 for a half model, else 1.

    A half tunnel is half a car against a mirror. It costs a quarter of the
    cells and gives the right coefficients, because the reference area is
    halved along with the force - but the force itself, in newtons, is half of
    what the car makes, and nothing ever doubled it. A team reading drag off a
    run to feed a lap-time calculator, which wants newtons, was reading half
    their drag and would have believed their car was twice as slippery as it is.

    The tell is the boundary condition: a symmetry plane in the setup is a
    mirror, and a mirror means two of everything that was solved.
    """
    for bc in (spec or {}).get("boundaryConditions") or []:
        if bc.get("type") != "SYMMETRY":
            continue
        ref = bc.get("topologicalReference") or {}
        if ref.get("faces") or ref.get("entities") or ref.get("sets"):
            return 2
    return 1


# What a mirror does to each trace. Everything else is left alone.
DOUBLES = {"forces": ("drag", "lift"), "moments": ("pitch",)}
CANCELS = {"forces": ("side",), "moments": ("roll", "yaw")}


def whole_car(plots, factor):
    """The whole car's forces, from the half of it that was solved.

    Drag and lift double: the mirror image of the solved half pushes the same
    way. Pitch doubles for the same reason, and it does so about any centre at
    all, because a pitching moment is built out of x and z alone.

    Side force cancels, and so do roll and yaw: whatever the solved half does,
    its mirror image does the opposite. Those three are reported as nothing
    rather than doubled or left as they are. A half model's side force is a
    real number the solver worked out and it is not the car's - the car has no
    side force, by the same symmetry that let us solve half of it. The
    cancellation is exact only when moments are taken about a point on the
    mirror plane, which is what momentCentre in prepareDomain.ts now makes sure
    of.

    Coefficients are not touched. The solver divided by the reference area of
    the tunnel it was given, so those were the whole car's already.
    """
    if not plots or factor == 1:
        return plots
    for group, keys in DOUBLES.items():
        block = plots.get(group) or {}
        for key in keys:
            if block.get(key):
                block[key] = [None if v is None else v * factor for v in block[key]]
        # Form drag and skin friction are the same force split in two, so they
        # scale with it. Left alone they would no longer add up to the total.
        for part in (block.get("split") or {}).values():
            for key in keys:
                if part.get(key):
                    part[key] = [None if v is None else v * factor for v in part[key]]
    for group, keys in CANCELS.items():
        block = plots.get(group) or {}
        for key in keys:
            if block.get(key):
                block[key] = [0.0 for _ in block[key]]
    plots["whole_car"] = {
        "factor": factor,
        "cancels": sorted(k for keys in CANCELS.values() for k in keys),
    }
    return plots


def export_plots(simulation_id, run_id, flow_dir=(-1.0, 0.0, 0.0)):
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
            url = download_url_of(item)
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

        # Force trace. SimScale writes one FORCE_PLOT per contribution, one for
        # pressure and one for viscous, under identical column names, so they
        # are summed. The sibling MOMENT_PLOT carries newton-metres under those
        # same names again and must not be mixed in.
        #
        # Drag is the component of the force along the free stream, F . u.
        # With u = (-1, 0, 0) that is exactly the old "negate Fx", so add-in
        # jobs are unchanged; with a Workbench inlet pointing any other way it
        # is now right rather than backwards.
        ux, uy, _uz = flow_dir
        # Side is the horizontal component across the wind, z x u.
        sx, sy = -uy, ux

        def _series(item, col):
            return [_num(r.get(col)) for r in item]

        def _add(acc, xs):
            return [a + b for a, b in zip(acc, xs)] if acc else list(xs)

        # Matched on category alone. SimScale labels each result item with the
        # *name the user gave the result control*, so the earlier
        # `name == "Forces_Moments"` only worked for runs this worker had built
        # the setup for. A Workbench run whose result control is called
        # "Car forces" matched nothing, and Run 10 came back with a full solve
        # and no force trace at all.
        fm = [i for i in items if i.get("category") == "FORCE_PLOT"]
        drag, lift, side, iters = [], [], [], []
        # Pressure against viscous is form drag against skin friction, which is
        # the single most useful thing a team can be told about their car: one
        # is fixed by shape, the other by surface.
        split = {}
        for item in fm:
            rows = _downsample(fetch_rows(item))
            if not rows:
                continue
            it_col = next(iter(rows[0]))
            cols = {ax: next((c for c in rows[0]
                              if c and c.upper().startswith("TOTAL_FORCE_" + ax)), None)
                    for ax in ("X", "Y", "Z")}
            if not (cols["X"] and cols["Z"]):
                continue
            iters = [_num(r0.get(it_col)) for r0 in rows]
            fx = _series(rows, cols["X"])
            fy = _series(rows, cols["Y"]) if cols["Y"] else [0.0] * len(fx)
            xs = [None if a is None else a * ux + (b or 0.0) * uy
                  for a, b in zip(fx, fy)]
            drag = _add(drag, xs)
            lift = _add(lift, _series(rows, cols["Z"]))
            side = _add(side, [None if a is None else a * sx + (b or 0.0) * sy
                               for a, b in zip(fx, fy)])
            what = str(item.get("quantity") or item.get("name") or "").lower()
            key = ("pressure" if "pressure" in what
                   else "viscous" if "viscous" in what or "friction" in what else None)
            if key:
                split[key] = {"drag": xs, "lift": _series(rows, cols["Z"])}
        if iters:
            out["forces"] = {"iterations": iters, "drag": drag, "lift": lift}
            if side:
                out["forces"]["side"] = side
            if split:
                out["forces"]["split"] = split

        # Moments: pitch, roll and yaw about the centre of rotation. Pitch is
        # what tells a team where their downforce actually sits, which is not
        # something total lift can answer.
        mom = [i for i in items if i.get("category") == "MOMENT_PLOT"]
        roll, pitch, yaw, m_iters = [], [], [], []
        for item in mom:
            rows = _downsample(fetch_rows(item))
            if not rows:
                continue
            it_col = next(iter(rows[0]))
            cols = {ax: next((c for c in rows[0]
                              if c and c.upper().startswith("TOTAL_MOMENT_" + ax)), None)
                    for ax in ("X", "Y", "Z")}
            if not any(cols.values()):
                continue
            m_iters = [_num(r0.get(it_col)) for r0 in rows]
            if cols["X"]:
                roll = _add(roll, _series(rows, cols["X"]))
            if cols["Y"]:
                pitch = _add(pitch, _series(rows, cols["Y"]))
            if cols["Z"]:
                yaw = _add(yaw, _series(rows, cols["Z"]))
        if m_iters and (roll or pitch or yaw):
            out["moments"] = {"iterations": m_iters, "roll": roll,
                              "pitch": pitch, "yaw": yaw}

        # The coefficients the solver worked out for itself, per iteration. The
        # client can only divide the final force by an area and get one number;
        # this is the whole trace, and it is the one people actually quote.
        coef = [i for i in items
                if i.get("category") in ("FORCE_COEFFICIENTS_PLOT", "COEFFICIENTS_PLOT")
                or "coeff" in str(i.get("name") or "").lower()]
        for item in coef:
            rows = _downsample(fetch_rows(item))
            if not rows:
                continue
            it_col = next(iter(rows[0]))
            def pick(*starts):
                for c in rows[0]:
                    if c and any(c.upper().startswith(t) for t in starts):
                        return c
                return None
            cd = pick("TOTAL_DRAG_COEFF", "DRAG_COEFF", "CD")
            cl = pick("TOTAL_LIFT_COEFF", "LIFT_COEFF", "CL")
            cm = pick("TOTAL_MOMENT_COEFF", "PITCHING_MOMENT_COEFF", "CM")
            got = {}
            if cd:
                got["cd"] = _series(rows, cd)
            if cl:
                got["cl"] = _series(rows, cl)
            if cm:
                got["cm"] = _series(rows, cm)
            if got:
                got["iterations"] = [_num(r0.get(it_col)) for r0 in rows]
                out["coefficients"] = got
                break
        if "coefficients" not in out:
            log.info("  No coefficient plot in the results. Columns seen: %s",
                     [(i.get("name"), i.get("category")) for i in items])
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
            return download_url_of(item)
    return None


def upload_file(local_path, remote_path, content_type):
    blob = fb_storage.bucket().blob(remote_path)
    blob.upload_from_filename(local_path, content_type=content_type)


# ── Main ──────────────────────────────────────────────────────────────────────

# ── the Workbench path ───────────────────────────────────────────────────────
def fetch_run(run_id):
    if not run_id:
        return None
    snap = db.collection("runs").document(run_id).get()
    return snap.to_dict() if snap.exists else None


def read_json_blob(path):
    blob = fb_storage.bucket().blob(path)
    return json.loads(blob.download_as_bytes().decode("utf-8"))


def run_spec_mode(job, job_id, run_id):
    """Send the setup the Workbench built, and report every step of it.

    Build spec 14.7. This does not build a model: the spec on the run
    document is what the user made, and rewriting any of it here would mean
    the panel showed one thing and the solver received another.
    """
    api = build_clients()
    set_stage = spec_mode.make_stage_writer(db, job_id, run_id)
    run = fetch_run(run_id) or {}
    spec = run.get("spec_snapshot")
    mesh_spec = run.get("mesh_snapshot") or {}
    if not spec:
        raise RuntimeError("This run has no saved setup to send.")

    # The owner goes in the path.
    #
    # Results used to live at results/{job_id}, and the only way to tie that
    # back to a person was a Firestore lookup from inside the Storage rules.
    # That lookup does not work in this project: a rule of just
    # `firestore.exists(/databases/(default)/documents/jobs/$(jobId))` denies
    # an owner reading their own file, and a denied rule says nothing but
    # "Permission denied". So every results download has always failed.
    #
    # This is the same lesson the geometry uploads already learned, and the
    # header of storage.rules already says it: a uid in the path is a complete
    # ownership check on its own, needs no lookup, and cannot half-work.
    owner = job.get("userId") or ""
    if not owner:
        raise RuntimeError("This job has no owner, so its results have nowhere to go.")
    dest = f"users/{owner}/results/{job_id}"
    geometry_id_local = job.get("geometryId")
    version = int(run.get("geometry_version") or 0)

    # ── 1. upload ────────────────────────────────────────────────────────
    set_stage("uploading_geometry", "Uploading to the solver", 0.05)
    step_path = job.get("stepPath")
    if not owned_path(step_path, job.get("userId") or "", job_id):
        raise RuntimeError("This run's geometry does not belong to its owner.")
    local_step = "/tmp/geometry.step"
    download_file(step_path, local_step)

    geo_doc = db.collection("geometries").document(geometry_id_local).get().to_dict() or {}
    options = geo_doc.get("import_options") or {}
    version_doc = (geo_doc.get("versions") or {}).get(str(version)) \
        or (geo_doc.get("versions") or {}).get(version) or {}
    # The version records the unit its STEP was written in: a tunnel built in
    # the browser is millimetres, one the old geometry service built is metres.
    # The import request states the source unit, and a wrong one scales the car
    # a thousand times either way - metres for a millimetre file is the stadium
    # mistake in the other direction. Read it; "m" only for versions old
    # enough not to record one.
    input_unit = version_doc.get("unit") or "m"
    simscale_geometry_id = upload_geometry_spec(
        api, local_step, f"tf-{job_id}", job_id,
        input_unit=input_unit,
        facet_split=bool(options.get("facet_split", False)),
        sewing=bool(options.get("sewing", True)),
        improve=bool(options.get("improve", True)),
    )

    # Recorded the moment it exists, not at the end. Every later failure is
    # about this geometry, and without the id written down the only way to find
    # it again is to guess from timestamps, which is how the first end-to-end
    # run was debugged on 11 Sep 2026.
    set_stage("uploading_geometry", "Uploading to the solver", 0.12,
              {"simscale": {"geometry_id": simscale_geometry_id}})

    # ── 2. the face map ──────────────────────────────────────────────────
    set_stage("processing", "Reading the geometry", 0.15)
    faces_path = (geo_doc.get("versions") or {}).get(str(version), {}).get("faces_path")
    if not faces_path:
        faces_path = (geo_doc.get("versions") or {}).get(version, {}).get("faces_path")
    if not faces_path:
        raise RuntimeError("This geometry has no face list, so the setup cannot be sent.")
    faces_json = read_json_blob(faces_path)

    step_id_to_names = spec_mode.fetch_step_id_to_names(
        api, SIMSCALE_PROJECT_ID, simscale_geometry_id)
    regions = spec_mode.region_names(api, SIMSCALE_PROJECT_ID, simscale_geometry_id)
    with open("/tmp/simscale_map.json", "w", encoding="utf-8") as fh:
        json.dump({"faces": {str(k): v for k, v in step_id_to_names.items()},
                   "regions": regions}, fh)
    upload_file("/tmp/simscale_map.json", f"{dest}/simscale_map.json", "application/json")

    resolved = spec_mode.resolve_spec(
        json.loads(json.dumps(spec)), faces_json, step_id_to_names, regions)

    # ── 3. create the simulation ─────────────────────────────────────────
    # The label says what is happening. It used to say "Checking the setup"
    # here, which was true when the check ran at this point and became a lie
    # when the check moved after the mesh: the run panel said it was checking
    # for the whole of meshing.
    set_stage("creating_simulation", "Sending the setup to the solver", 0.2)
    created = spec_mode.api_post(
        SIMSCALE_API_BASE, SIMSCALE_PROJECT_ID, SIMSCALE_API_KEY, "simulations",
        {"name": f"tf-{job_id}", "geometryId": simscale_geometry_id,
         "model": resolved, "version": "34.0"})
    if created.status_code >= 400:
        # The whole body goes to the log; one sentence goes to the run panel.
        log.error("  simulation refused, raw body: %s", created.text[:1500])
        raise spec_mode.SpecError(
            "The solver would not accept this setup. "
            + spec_mode.readable_api_error(created.text))
    simulation_id = created.json()["simulationId"]
    db.collection("runs").document(run_id).update(
        {"simscale.simulation_id": simulation_id,
         "simscale.geometry_id": simscale_geometry_id})

    # The setup check happens after the mesh, not here.
    #
    # SimScale refuses to check an incompressible simulation that has no mesh
    # attached: "meshId is mandatory for INCOMPRESSIBLE analysis type". So a
    # check at this point can only ever fail, and it failed on a rule about the
    # solver's own sequencing rather than on anything the user had done. Run 4
    # on 11 Sep 2026 died exactly there, having got everything else right.

    # ── 4. mesh ──────────────────────────────────────────────────────────
    set_stage("meshing", "Meshing", 0.25)
    mesh_body = spec_mode.resolve_spec(
        json.loads(json.dumps(mesh_spec)), faces_json, step_id_to_names, regions)
    mesh_created = spec_mode.api_post(
        SIMSCALE_API_BASE, SIMSCALE_PROJECT_ID, SIMSCALE_API_KEY, "meshoperations",
        {"name": f"tf-mesh-{job_id}", "geometryId": simscale_geometry_id,
         # A mesh operation is versioned like a simulation is, and leaving it
         # out is refused with "invalid-schema-version" and a list of every
         # version the API knows. 10.0 is the current one and the default the
         # SDK's MeshOperation carries.
         "version": "10.0",
         "model": mesh_body})
    if mesh_created.status_code >= 400:
        log.error("  mesh refused, raw body: %s", mesh_created.text[:1500])
        raise spec_mode.SpecError(
            "The mesher would not accept these settings. "
            + spec_mode.readable_api_error(mesh_created.text))
    mesh_op_id = mesh_created.json()["meshOperationId"]
    started_mesh = spec_mode.api_post(
        SIMSCALE_API_BASE, SIMSCALE_PROJECT_ID, SIMSCALE_API_KEY,
        f"meshoperations/{mesh_op_id}/start", None,
        params={"simulationId": simulation_id})
    if started_mesh.status_code >= 400:
        log.error("  mesh start refused, raw body: %s", started_mesh.text[:1000])
        raise spec_mode.SpecError(
            "The mesher would not start. "
            + spec_mode.readable_api_error(started_mesh.text))

    mesh_id = poll_operation(
        api, job_id, run_id, set_stage,
        f"meshoperations/{mesh_op_id}", "Meshing", 0.25, 0.5,
        cancel=lambda: cancel_mesh_operation(mesh_op_id))
    mesh_log = spec_mode.save_event_log(
        SIMSCALE_API_BASE, SIMSCALE_PROJECT_ID, SIMSCALE_API_KEY,
        f"meshoperations/{mesh_op_id}/eventlog", dest, "mesh.json", upload_file)
    set_status(job_id, "meshing", {"mesh_id": mesh_id or mesh_op_id})
    # The path, not the log. Both call sites threw the return value away, so
    # SimScale's own account of the run was saved and then nothing knew where
    # it was, and the Workbench's event log read "No events recorded".
    db.collection("runs").document(run_id).update({
        "simscale.mesh_id": mesh_id or mesh_op_id,
        **({"log_paths.mesh": mesh_log} if mesh_log else {}),
    })

    # ── 4a. attach the mesh to the simulation ────────────────────────────
    # Meshing it is not the same as telling the simulation about it.
    if mesh_id:
        spec_mode.attach_mesh(SIMSCALE_API_BASE, SIMSCALE_PROJECT_ID,
                              SIMSCALE_API_KEY, simulation_id, mesh_id)
        # The cell counts live on the mesh, not on the operation.
        mesh_doc = spec_mode.api_get(SIMSCALE_API_BASE, SIMSCALE_PROJECT_ID,
                                     SIMSCALE_API_KEY, f"meshes/{mesh_id}")
        if mesh_doc.status_code < 400:
            body = mesh_doc.json()
            db.collection("runs").document(run_id).update({"mesh": {
                "cell_count": body.get("numberOfCells"),
                "node_count": body.get("numberOfNodes"),
                "name": body.get("name"),
            }})
            log.info("  mesh: %s cells, %s nodes",
                     body.get("numberOfCells"), body.get("numberOfNodes"))

    # ── 4b. check, now that there is a mesh to check against ─────────────
    # Still before the solver starts, which is the point: a setup that cannot
    # run should stop here, where the only thing spent is the mesh.
    set_stage("checking", "Checking the setup", 0.48)
    spec_mode.check_setup(SIMSCALE_API_BASE, SIMSCALE_PROJECT_ID,
                          SIMSCALE_API_KEY, simulation_id)

    # ── 5. run ───────────────────────────────────────────────────────────
    set_stage("running", "Running the solver", 0.5)
    started = spec_mode.api_post(
        SIMSCALE_API_BASE, SIMSCALE_PROJECT_ID, SIMSCALE_API_KEY,
        f"simulations/{simulation_id}/runs", {"name": run.get("name") or f"tf-{job_id}"})
    if started.status_code >= 400:
        raise RuntimeError("The solver would not start. "
                           + spec_mode.readable_api_error(started.text))
    simulation_run_id = started.json()["runId"]
    spec_mode.api_post(SIMSCALE_API_BASE, SIMSCALE_PROJECT_ID, SIMSCALE_API_KEY,
                       f"simulations/{simulation_id}/runs/{simulation_run_id}/start", {})
    set_status(job_id, "running", {"run_id": simulation_run_id,
                                   "simulation_id": simulation_id})
    db.collection("runs").document(run_id).update({"simscale.run_id": simulation_run_id})

    poll_operation(
        api, job_id, run_id, set_stage,
        f"simulations/{simulation_id}/runs/{simulation_run_id}",
        "Running", 0.5, 0.9,
        cancel=lambda: cancel_simulation_run(simulation_id, simulation_run_id))
    run_log = spec_mode.save_event_log(
        SIMSCALE_API_BASE, SIMSCALE_PROJECT_ID, SIMSCALE_API_KEY,
        f"simulations/{simulation_id}/runs/{simulation_run_id}/eventlog",
        dest, "run.json", upload_file)
    if run_log:
        db.collection("runs").document(run_id).update({"log_paths.run": run_log})

    # ── 6. results ───────────────────────────────────────────────────────
    set_stage("downloading_results", "Downloading the results", 0.9)
    wait_for_result_links(simulation_id, simulation_run_id)
    # Past this point the solve is done and paid for. A fault in our own
    # reading of the results must not turn a finished run into a failed one:
    # Run 10 solved 879,511 cells for ten minutes and was then marked Failed
    # because summarise() indexed a dict with -1. Record what we did get, and
    # let the run finish.
    viewer, plots, summary = None, None, {}
    try:
        viewer = export_results_for_viewer(job_id, simulation_id, simulation_run_id, dest)
    except Exception as e:
        log.warning(f"  Viewer export failed, results stay in SimScale: {e}")
    factor = symmetry_factor(spec)
    try:
        plots = whole_car(
            export_plots(simulation_id, simulation_run_id, flow_direction(spec)),
            factor)
        summary = summarise(plots)
        # Said on the run, so the panel can print "whole car, from a half
        # model" beside the number rather than leaving a team to wonder why
        # TurboFlow and SimScale's own plots differ by exactly two.
        if summary and factor != 1:
            summary["doubled"] = True
    except Exception as e:
        log.warning(f"  Plot export failed: {e}")

    patch = {
        "status": "finished",
        "stage_text": "Finished",
        "progress": 1.0,
        "plots": {k: spec_mode.downsample(v) for k, v in (plots or {}).items()},
        "summary": summary,
        "finished_at": firestore.SERVER_TIMESTAMP,
    }
    if viewer:
        patch["results_glb_path"] = viewer.get("glb")
        patch["results_fields"] = viewer.get("fields")
        patch["case_path"] = viewer.get("case")
    db.collection("runs").document(run_id).update(patch)
    set_status(job_id, "complete", {
        "results_glb_path": (viewer or {}).get("glb"),
        "results_fields": (viewer or {}).get("fields"),
        "case_path": (viewer or {}).get("case"),
        "simulation_id": simulation_id,
        "run_id": simulation_run_id,
    })
    log.info("  Finished %s", run_id)


def upload_geometry_spec(api, step_path, geom_name, job_id, input_unit="m",
                         facet_split=False, sewing=True, improve=True):
    """upload_geometry, with the import options the user chose.

    The older one hard-codes them, which is right for a flow region the
    Fusion add-in built and wrong for a car the user uploaded: facet_split on
    a car with curved bodywork splits every panel into hundreds of faces and
    every assignment the user made points at the wrong ones.
    """
    storage = api["storage"].create_storage()
    with open(step_path, "rb") as fh:
        data = fh.read()
    log.info("    File size: %.1f MB", len(data) / 1024 / 1024)
    api["client"].rest_client.PUT(
        url=storage.url,
        headers={"Content-Type": "application/octet-stream"},
        body=data)
    geo_import = api["geo_imp"].import_geometry(
        SIMSCALE_PROJECT_ID,
        GeometryImportRequest(
            name=geom_name,
            location=GeometryImportRequestLocation(storage_id=storage.storage_id),
            format="STEP",
            input_unit=input_unit,
            options=GeometryImportRequestOptions(
                facet_split=facet_split, sewing=sewing, improve=improve,
                optimize_for_lbm_solver=False),
        ),
    )
    while True:
        check_deadline("geometry import")
        if is_cancelling(job_id):
            raise CancelledError()
        geo_import = api["geo_imp"].get_geometry_import(
            SIMSCALE_PROJECT_ID, geo_import.geometry_import_id)
        status = (geo_import.status or "").upper()
        if status == "FINISHED":
            return geo_import.geometry_id
        if status in ("CANCELED", "FAILED"):
            # SimScale's own account of what is wrong, not ours.
            #
            # This used to say only "check that it is a closed solid", which is
            # advice, not information - the user cannot act on it and neither
            # can support. SimScale knows exactly what it objected to and says
            # so: a failureReason with a code and a list of faults, each naming
            # a face and the point in space where the fault is. On the first
            # tunnel this path ever built, that was
            # "model-has-invalid-geometry ... bad_face_face ... Y: 2.2e-15",
            # which says in one line that the trouble is at the symmetry plane.
            # Finding that out without it took a paid run and an hour.
            raise spec_mode.SpecError(geometry_import_error(geo_import))
        time.sleep(POLL_INTERVAL)


def geometry_import_error(geo_import):
    """Why SimScale refused a geometry, as a sentence.

    The faults are grouped by code and counted rather than listed: a car can
    produce hundreds of them and they are all the same problem. The position of
    the first is kept, because where a fault is, is usually what identifies it.
    """
    try:
        body = geo_import.to_dict() if hasattr(geo_import, "to_dict") else dict(geo_import)
    except Exception:
        body = {}
    reason = body.get("failure_reason") or body.get("failureReason") or {}
    if not isinstance(reason, dict):
        reason = {}
    code = str(reason.get("code") or "").strip()
    faults = reason.get("details", {}).get("faults") if isinstance(reason.get("details"), dict) else None
    faults = faults if isinstance(faults, list) else []

    counts = {}
    for f in faults:
        if isinstance(f, dict):
            counts[str(f.get("code") or "fault")] = counts.get(str(f.get("code") or "fault"), 0) + 1

    parts = []
    if code:
        parts.append(code.replace("-", " "))
    if counts:
        parts.append(", ".join(f"{n} x {c.replace('-', ' ')}" for c, n in
                               sorted(counts.items(), key=lambda kv: -kv[1])[:3]))
    where = None
    for f in faults:
        pos = f.get("position") if isinstance(f, dict) else None
        if isinstance(pos, dict):
            try:
                where = "near (%.4g, %.4g, %.4g) m" % (
                    float(pos.get("X", 0)), float(pos.get("Y", 0)), float(pos.get("Z", 0)))
            except (TypeError, ValueError):
                where = None
            break
    if where:
        parts.append(where)

    if not parts:
        return ("The solver could not read this geometry. Check that it is a "
                "closed solid with no self-intersecting faces.")
    return "The solver refused this geometry: " + "; ".join(parts) + "."


def poll_operation(api, job_id, run_id, set_stage, path, label, lo, hi, cancel=None):
    """Wait for a SimScale operation, reporting its progress as it goes.

    lo and hi map the operation's own 0 to 1 onto a slice of the run's
    overall bar, so the user sees one bar that only moves forward rather than
    three that each restart at zero.
    """
    last = -1
    # How many polls an operation may stay in READY before we call it stuck.
    #
    # READY means created but not started. A start that was accepted and did
    # nothing leaves it there for ever, and the worker used to poll a dead
    # operation until the six-hour deadline, reporting "Meshing 0%" the whole
    # time. Two minutes of READY is already wrong; six hours is unforgivable.
    ready_polls = 0
    READY_LIMIT = 8
    while True:
        check_deadline(label)
        if is_cancelling(job_id):
            if cancel:
                cancel()
            set_stage("cancelled", "Cancelled", None)
            raise CancelledError()
        resp = spec_mode.api_get(SIMSCALE_API_BASE, SIMSCALE_PROJECT_ID,
                                 SIMSCALE_API_KEY, path)
        if resp.status_code >= 400:
            raise RuntimeError(f"{label} could not be checked: {resp.text[:200]}")
        body = resp.json()
        status = str(body.get("status") or "").upper()
        progress = float(body.get("progress") or 0)
        pct = int(progress * 100)
        if pct != last:
            set_stage(
                "meshing" if label == "Meshing" else "running",
                f"{label} {pct}%", lo + (hi - lo) * progress)
            last = pct
        if status == "READY":
            ready_polls += 1
            if ready_polls >= READY_LIMIT:
                raise RuntimeError(
                    f"{label} was created but never started. SimScale still "
                    "reports it as READY, which usually means the start "
                    "request was accepted and ignored.")
        else:
            ready_polls = 0
        if status == "FINISHED":
            return body.get("meshId") or body.get("id")
        if status in ("CANCELED", "CANCELLED"):
            set_stage("cancelled", "Cancelled", None)
            raise CancelledError()
        if status == "FAILED":
            # The reason lives in the event log, not on the operation.
            reason = spec_mode.first_error_in_event_log(
                SIMSCALE_API_BASE, SIMSCALE_PROJECT_ID, SIMSCALE_API_KEY,
                f"{path}/eventlog")
            detail = f"{label} failed. {reason}" if reason else f"{label} failed."
            # A mesh the mesher refuses is about the geometry and the mesh
            # settings, both of which the user can change. It used to fall
            # through to "a fault of our own, changing the simulation will not
            # help", which told them the one thing that was not true.
            if label == "Meshing":
                raise MeshingError(detail)
            raise RuntimeError(detail)
        time.sleep(POLL_INTERVAL)


def summarise(plots):
    """The last point of each trace, which is the answer the team wants.

    This used to walk `plots` as {name: [row, row, ...]} and take `rows[-1]`.
    export_plots has never returned that: it returns {"forces": {"drag": [...],
    "lift": [...]}, "moments": {...}, ...}, so `rows[-1]` indexed a dict with
    -1 and Run 10 died with KeyError: -1 after a complete, successful solve.

    The keys below are the ones the run panel reads, so a new one here shows up
    in the Workbench without any other change.
    """
    def last(series):
        for v in reversed(series or []):
            if isinstance(v, (int, float)):
                return float(v)
        return None

    out = {}
    for group, keys in (("forces", ("drag", "lift", "side")),
                        ("moments", ("roll", "pitch", "yaw")),
                        ("coefficients", ("cd", "cl", "cm"))):
        block = (plots or {}).get(group) or {}
        for key in keys:
            v = last(block.get(key))
            if v is not None:
                out[key] = v
    return out


def export_again(job_id, row):
    """Rebuild a finished run's 3D results and case download from SimScale.

    For runs that finished before this worker could read the OpenFOAM case
    SimScale sends: their results are still in SimScale, and this fetches and
    converts them without solving anything again or charging anything. Run the
    job with EXPORT_ONLY=1 and the JOB_ID of a completed job.
    """
    sim_id, run_id = row.get("simulation_id"), row.get("run_id")
    owner = row.get("user_id") or row.get("userId")
    if row.get("status") != "complete" or not (sim_id and run_id and owner):
        raise RuntimeError("Only a completed job with SimScale ids and an owner can be exported again.")
    viewer = export_results_for_viewer(job_id, sim_id, run_id, f"users/{owner}/results/{job_id}")
    if not viewer:
        raise RuntimeError("SimScale returned nothing that could be exported.")
    fields = {"results_glb_path": viewer.get("glb"), "results_fields": viewer.get("fields"),
              "case_path": viewer.get("case")}
    db.collection("jobs").document(job_id).update(fields)
    if row.get("run_ref"):
        db.collection("runs").document(row["run_ref"]).update(fields)
    log.info("  Exported %s again: %s", job_id, ", ".join(k for k, v in fields.items() if v))


def main():
    job_id = os.environ.get("JOB_ID")
    if not job_id:
        log.error("JOB_ID environment variable not set")
        sys.exit(1)

    log.info(f"═" * 55)
    log.info(f"  TurboFlow Job: {job_id}")
    log.info(f"═" * 55)

    # The job document, converted to camelCase for the pipeline below. Firestore
    # is snake_case; this worker, the Fusion add-in and the SimScale SDK calls
    # below all speak camelCase, so the conversion happens once, here.
    row = fetch_job(job_id)
    if not row:
        log.error(f"Job {job_id} not found in Firestore")
        sys.exit(1)
    job = {_to_camel(k): v for k, v in row.items()}

    if os.environ.get("EXPORT_ONLY") == "1":
        export_again(job_id, row)
        return

    # ── which path ───────────────────────────────────────────────────────
    # A Workbench run carries its own SimScale spec and a run document to
    # report into. A Fusion job carries neither: it has a flow region the
    # add-in already built and four columns describing the run, and it takes
    # the older path below. Both have to keep working, because installed
    # add-ins are out there and cannot be updated on our schedule.
    if os.environ.get("SPEC_MODE") == "1" or row.get("spec_mode") is True:
        run_id = os.environ.get("RUN_ID") or row.get("run_ref") or ""
        absent = missing_simscale_config()
        if absent:
            msg = ("The simulation worker is not configured: "
                   + ", ".join(absent) + " is not set.")
            log.error(msg)
            set_status(job_id, "failed", {"error": msg})
            if run_id:
                db.collection("runs").document(run_id).update(
                    {"status": "failed", "stage_text": "Failed", "error": msg})
            sys.exit(1)
        try:
            run_spec_mode(job, job_id, run_id)
            return
        except CancelledError:
            log.info("  Cancelled")
            set_status(job_id, "cancelled")
            if run_id:
                db.collection("runs").document(run_id).update(
                    {"status": "cancelled", "stage_text": "Cancelled"})
            return
        except spec_mode.SpecError as e:
            # Something about the setup the user can fix, said in their
            # words. No mesh_id has been written at this point, so
            # onJobPending reverses the whole charge.
            msg = str(e)
            log.error("  Setup refused: %s", msg)
            set_status(job_id, "failed", {"error": msg})
            if run_id:
                db.collection("runs").document(run_id).update(
                    {"status": "failed", "stage_text": "Failed", "error": msg[:900]})
            sys.exit(1)
        except MeshingError as e:
            # The mesher's own reason goes beside it for support; no mesh_id
            # has been written, so onJobPending reverses the charge as before.
            detail = str(e)
            log.error("  Meshing refused: %s", detail)
            msg = ("The mesher could not mesh this car. That is nearly always "
                   "very small faces or edges in the CAD. Re-export the body "
                   "from your CAD tool with small features removed, or pick a "
                   "coarser mesh and queue it again.")
            set_status(job_id, "failed", {"error": msg, "error_detail": detail[:900]})
            if run_id:
                db.collection("runs").document(run_id).update(
                    {"status": "failed", "stage_text": "Failed",
                     "error": msg, "error_detail": detail[:900]})
            sys.exit(1)
        except Exception as e:
            # A fault of ours, not of the user's setup. SpecError above is the
            # channel for anything they can fix; everything reaching here is a
            # bug, and "KeyError: -1" told the owner of Run 10 nothing except
            # that we had written some Python badly. Say what it means for
            # them, and keep the technical string beside it for support.
            detail = f"{type(e).__name__}: {e}"
            log.exception("  Run failed")
            msg = ("TurboFlow hit a fault of its own on this run. It is not "
                   "something in your setup, so changing the simulation will "
                   "not help. The run log has the details.")
            set_status(job_id, "failed", {"error": msg, "error_detail": detail[:900]})
            if run_id:
                db.collection("runs").document(run_id).update(
                    {"status": "failed", "stage_text": "Failed",
                     "error": msg, "error_detail": detail[:900]})
            sys.exit(1)

    # Solve at the speed the user picked and paid for, not at a constant.
    # Clamped to the same 1-100 m/s the backend and the Fusion dialog clamp to.
    global INLET_VELOCITY, FRONTAL_AREA_M2, REFERENCE_LENGTH_M
    try:
        INLET_VELOCITY = max(1.0, min(100.0, float(job.get("inletVelocity", 20.0))))
        # Clamped, not trusted. It only scales a reported coefficient and cannot
        # touch billing, but a zero or a negative would make the solver's own
        # division meaningless and it is cheaper to refuse here.
        try:
            area = float(job.get("frontalAreaM2") or 0)
            FRONTAL_AREA_M2 = area if 1e-6 < area < 10.0 else None
        except (TypeError, ValueError):
            FRONTAL_AREA_M2 = None
        try:
            length = float(job.get("referenceLengthM") or 0)
            REFERENCE_LENGTH_M = length if 1e-4 < length < 100.0 else None
        except (TypeError, ValueError):
            REFERENCE_LENGTH_M = None
    except (TypeError, ValueError):
        INLET_VELOCITY = 20.0
    log.info(f"  Inlet velocity: {INLET_VELOCITY} m/s")

    # Web-submitted jobs carry no geometry (the Fusion plugin uploads it), so
    # bail out with a status the UI can show instead of a KeyError traceback.
    if not job.get("stepPath") or not job.get("labelPath"):
        msg = "Job has no uploaded geometry (stepPath/labelPath missing)."
        log.error(msg)
        set_status(job_id, "failed", {"error": msg})
        sys.exit(1)

    # Now that there is a job to report against, a misconfigured worker can say
    # so on the job itself instead of dying silently and leaving it 'pending'.
    absent = missing_simscale_config()
    if absent:
        msg = ("The simulation worker is not configured: "
               + ", ".join(absent) + " is not set.")
        log.error(msg)
        set_status(job_id, "failed", {"error": msg})
        sys.exit(1)

    owner = job.get("userId") or ""
    for field in ("stepPath", "labelPath"):
        if not owned_path(job.get(field), owner, job_id):
            msg = f"{field} does not belong to this job's owner."
            log.error(msg + f" ({job.get(field)!r})")
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
        sim_name  = f"turboflow_{job_id[:8]}_KOmegaSST_{INLET_VELOCITY:g}ms"

        try:
            api = build_clients()

            set_status(job_id, "uploading_geometry")
            geometry_id = upload_geometry(api, step_path, geom_name, job_id)

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
            wait_for_result_links(simulation_id, run_id)

            # Extract drag & lift from last iteration
            drag_N, lift_N = extract_drag_lift(simulation_id, run_id)
            # Half a car reports half the force here too. The add-in's setup
            # has no spec dictionary to read a symmetry plane out of, but it
            # has the labels the plane was built from, which say the same
            # thing.
            factor = 2 if label_to_names.get("symmetry") else 1
            if factor != 1:
                drag_N = None if drag_N is None else drag_N * factor
                lift_N = None if lift_N is None else lift_N * factor
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
                plots = whole_car(export_plots(simulation_id, run_id), factor)
                if plots:
                    complete_data["plots"] = plots
            except Exception as e:
                log.warning(f"  Plot export failed: {e}")

            # Unpack the VTK results for TurboFlow's own viewer. Best effort:
            # the run itself succeeded, so never fail it over post-processing.
            try:
                # The owner's results folder, as the Workbench path uses.
                # This wrote beside the upload in jobs/{job}, and the storage
                # rules give nobody read access there, so the owner could
                # never have opened what it produced.
                prefix = f"users/{job.get('userId')}/results/{job_id}"
                manifest = export_results_for_viewer(job_id, simulation_id, run_id, prefix)
                if manifest:
                    complete_data["resultsGlbPath"] = manifest.get("glb")
                    complete_data["resultsFields"]  = manifest.get("fields")
                    complete_data["casePath"]       = manifest.get("case")
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
        # The inputs are deliberately NOT deleted here.
        #
        # This used to remove the STEP and the CSV once SimScale had the
        # geometry, to save space. That was survivable while a job owned its own
        # upload folder. It is not now: uploads are keyed by geometry, and a
        # geometry is meant to be run repeatedly — so deleting them after the
        # first run left every later run downloading a file that no longer
        # existed. Storage retention is a real question, but it belongs to a
        # policy that knows about geometries, not to the end of one run.

if __name__ == "__main__":
    main()
