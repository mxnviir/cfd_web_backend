#!/usr/bin/env python3
"""
TurboFlow tessellation service.

A browser cannot render a STEP file — B-rep needs a CAD kernel to turn into
triangles. This is that kernel, as a small Cloud Run HTTP service: it reads the
uploaded STEP from Supabase Storage, tessellates it with OCC (via CadQuery),
and writes a .glb next to it that the workbench loads with three.js.

POST /tessellate   {"step_path": "jobs/<uid>/<jobId>/geometry.step"}
POST /infer_labels {"step_path": ..., "dest_path": ".../entity_labels.csv"}
      Authorization: Bearer <the caller's Supabase access token>

The token is verified against Supabase Auth and the path must sit under that
user's own folder, so one team cannot tessellate (or overwrite) another's file.
"""
import os, re, csv, io, math, tempfile, logging

import requests
import trimesh
import cadquery as cq
from OCP.Bnd import Bnd_Box
from OCP.BRepBndLib import BRepBndLib
from OCP.BRepAdaptor import BRepAdaptor_Surface
from OCP.GeomAbs import GeomAbs_Plane, GeomAbs_Cylinder
from OCP.IFSelect import IFSelect_RetDone
from OCP.STEPControl import STEPControl_Reader
from OCP.TopAbs import TopAbs_FACE
from OCP.TopExp import TopExp_Explorer
from flask import Flask, request, jsonify

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("tessellate")

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_ANON_KEY = os.environ["SUPABASE_ANON_KEY"]
SUPABASE_SERVICE_ROLE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
SUPABASE_BUCKET = os.environ.get("SUPABASE_BUCKET", "cfd-files")
# Deflection controls triangle density: smaller = finer mesh, bigger file.
LINEAR_DEFLECTION = float(os.environ.get("LINEAR_DEFLECTION", "0.1"))
ANGULAR_DEFLECTION = float(os.environ.get("ANGULAR_DEFLECTION", "0.3"))
MAX_STEP_BYTES = int(os.environ.get("MAX_STEP_BYTES", str(50 * 1024 * 1024)))

app = Flask(__name__)
_storage = f"{SUPABASE_URL}/storage/v1/object"
_svc = {"apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}"}


_SEGMENT_OK = re.compile(r"^[A-Za-z0-9._-]+$")


def owned_path(path, uid):
    """True if `path` is a storage key inside this caller's own jobs/<uid>/ folder.

    The previous check was `startswith(f"jobs/{uid}/") and ".." not in path`,
    which only rejects a LITERAL "..". A key such as
    jobs/<uid>/%2e%2e/%2e%2e/jobs/<victim>/geometry.step satisfies both and would
    escape the moment any layer percent-decodes it. Supabase treats keys
    literally today, so that was latent rather than live — but validating every
    segment against a strict allowlist makes it airtight regardless of what the
    storage layer does with encoding.
    """
    if not isinstance(path, str):
        return False
    parts = path.split("/")
    if len(parts) < 3 or parts[0] != "jobs" or parts[1] != uid:
        return False
    # "." and ".." both match the character allowlist, so they must be excluded
    # explicitly — otherwise the literal traversal this guard exists to stop
    # walks straight through it.
    return all(_SEGMENT_OK.match(p) and p not in (".", "..") for p in parts)


class TooLarge(Exception):
    """Source object exceeded MAX_STEP_BYTES."""


class NotFound(Exception):
    """Source object could not be read; carries the upstream status."""

    def __init__(self, status):
        self.status = status


def fetch_object(path, dest):
    """Download a storage object to `dest`, enforcing the size cap AS IT STREAMS.

    The cap used to be checked with len(r.content) — which only runs once the
    whole body is already resident in memory. A user controls the size of the
    objects under their own jobs/<uid>/ prefix, so a multi-gigabyte upload could
    OOM the instance before the 413 was ever produced. Streaming with a running
    total bounds memory to the chunk size regardless of what the caller uploaded.
    """
    with requests.get(f"{_storage}/{SUPABASE_BUCKET}/{path}",
                      headers=_svc, timeout=120, stream=True) as r:
        if not r.ok:
            raise NotFound(r.status_code)
        # Trust the declared length when it is already over the cap: no reason to
        # transfer a byte of something we are going to refuse anyway.
        declared = r.headers.get("Content-Length")
        if declared and declared.isdigit() and int(declared) > MAX_STEP_BYTES:
            raise TooLarge()
        total = 0
        with open(dest, "wb") as f:
            for chunk in r.iter_content(chunk_size=1024 * 1024):
                if not chunk:
                    continue
                total += len(chunk)
                if total > MAX_STEP_BYTES:
                    raise TooLarge()
                f.write(chunk)


def exact_bbox(shape):
    """Tight bounding box of a solid, as {min, max, size}.

    Shape.BoundingBox() is not optimal on every cadquery release — on 2.5.2 it
    reads ~0.1% large once a shape has been transformed, which showed up as a
    scaled part reporting 0.40077 m instead of 0.4. AddOptimal is exact and
    behaves the same on every version.
    """
    box = Bnd_Box()
    BRepBndLib.AddOptimal_s(shape.wrapped, box)
    x0, y0, z0, x1, y1, z1 = box.Get()
    return {"min": [x0, y0, z0], "max": [x1, y1, z1],
            "size": [x1 - x0, y1 - y0, z1 - z0]}


def caller_uid(req):
    """Supabase user id for the bearer token, or None."""
    token = (req.headers.get("Authorization") or "").removeprefix("Bearer ").strip()
    if not token:
        return None
    r = requests.get(f"{SUPABASE_URL}/auth/v1/user",
                     headers={"apikey": SUPABASE_ANON_KEY, "Authorization": f"Bearer {token}"},
                     timeout=10)
    return r.json().get("id") if r.ok else None


# The workbench is served from another origin (and will be behind Cloudflare),
# so every response needs CORS headers and preflights need answering. Auth is a
# Supabase bearer token, not a cookie, so a wildcard origin is safe here — a
# stolen token is the threat, and CORS would not stop that anyway.
@app.after_request
def cors(resp):
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Headers"] = "authorization, content-type"
    resp.headers["Access-Control-Allow-Methods"] = "POST, OPTIONS"
    resp.headers["Access-Control-Max-Age"] = "86400"
    return resp


@app.route("/tessellate", methods=["OPTIONS"])
def preflight():
    return "", 204


# /healthz is intercepted upstream before it reaches the container, so this is
# /health instead.
@app.get("/health")
def health():
    return "ok", 200


# ── edit operations ──────────────────────────────────────────────────────────
# Edits are replayed on the B-rep, never on the display mesh: SimScale meshes the
# STEP, so a modified triangle soup would be useless to it. Each op is a rigid
# transform or a uniform scale, which is what a kernel can apply to a solid
# without repairing topology afterwards.
def apply_ops(shape, ops):
    """cadquery Shape -> transformed Shape. Raises ValueError on a bad op."""
    if not isinstance(ops, list) or len(ops) > 32:
        raise ValueError("ops must be a list of at most 32 operations")
    axes = {"x": (1, 0, 0), "y": (0, 1, 0), "z": (0, 0, 1)}
    planes = {"x": "YZ", "y": "XZ", "z": "XY"}

    for op in ops:
        kind = (op or {}).get("type")
        if kind == "translate":
            d = [float(op.get(k, 0)) for k in ("dx", "dy", "dz")]
            shape = shape.translate(tuple(d))
        elif kind == "scale":
            f = float(op.get("factor", 1))
            if not 0.01 <= f <= 100:
                raise ValueError("scale factor must be between 0.01 and 100")
            shape = shape.scale(f)
        elif kind == "rotate":
            axis = str(op.get("axis", "z")).lower()
            if axis not in axes:
                raise ValueError("rotate axis must be x, y or z")
            v = axes[axis]
            shape = shape.rotate(cq.Vector(0, 0, 0), cq.Vector(*v), float(op.get("degrees", 0)))
        elif kind == "mirror":
            axis = str(op.get("axis", "y")).lower()
            if axis not in planes:
                raise ValueError("mirror axis must be x, y or z")
            # mirror across the plane normal to that axis
            shape = shape.mirror(planes[axis])
        else:
            raise ValueError(f"unknown operation '{kind}'")
    return shape


@app.route("/transform", methods=["OPTIONS"])
def transform_preflight():
    return "", 204


@app.post("/transform")
def transform():
    """Apply edit ops to a STEP and write a new STEP + glb alongside it."""
    uid = caller_uid(request)
    if not uid:
        return jsonify(error="Sign in required."), 401

    body = request.get_json(silent=True) or {}
    step_path, ops = body.get("step_path", ""), body.get("ops")
    if not owned_path(step_path, uid):
        return jsonify(error="That path is not yours."), 403
    if not step_path.lower().endswith((".step", ".stp")):
        return jsonify(error="Expected a .step file."), 400
    dest = body.get("dest_prefix") or ""
    if not owned_path(dest, uid):
        return jsonify(error="Destination is not yours."), 403

    # This service holds the service-role key, so it bypasses RLS entirely. The
    # storage policy grants users INSERT and never UPDATE — meaning they cannot
    # overwrite a geometry they already have — and that guarantee has to be
    # re-implemented here or writing through this endpoint quietly launders it.
    # Without this, "save as v2" pointed at an existing folder would destroy the
    # geometry a previous run was measured against.
    exists = requests.head(f"{_storage}/{SUPABASE_BUCKET}/{dest}/geometry.step",
                           headers=_svc, timeout=30)
    if exists.ok:
        return jsonify(error="That version already exists."), 409

    with tempfile.TemporaryDirectory() as tmp:
        local = os.path.join(tmp, "in.step")
        try:
            fetch_object(step_path, local)
        except NotFound as e:
            return jsonify(error=f"Could not read the source geometry ({e.status})."), 404
        except TooLarge:
            return jsonify(error="File is too large to edit."), 413

        try:
            shape = cq.importers.importStep(local).val()
            shape = apply_ops(shape, ops)
        except ValueError as e:
            return jsonify(error=str(e)), 400
        except Exception as e:
            log.warning("transform failed: %s", e)
            return jsonify(error="That geometry could not be edited."), 422

        bbox = exact_bbox(shape)

        wp = cq.Workplane(obj=shape)
        out_step = os.path.join(tmp, "out.step")
        cq.exporters.export(wp, out_step)
        out_stl = os.path.join(tmp, "out.stl")
        cq.exporters.export(wp, out_stl, tolerance=LINEAR_DEFLECTION,
                            angularTolerance=ANGULAR_DEFLECTION)
        mesh = trimesh.load(out_stl, force="mesh")
        out_glb = os.path.join(tmp, "out.glb")
        mesh.export(out_glb)

        paths = {"step": f"{dest}/geometry.step", "glb": f"{dest}/geometry.glb"}
        for local_file, remote, ctype in (
                (out_step, paths["step"], "application/step"),
                (out_glb, paths["glb"], "model/gltf-binary")):
            with open(local_file, "rb") as f:
                # no upsert: a version is written once and never rewritten
                up = requests.post(f"{_storage}/{SUPABASE_BUCKET}/{remote}", headers={
                    **_svc, "Content-Type": ctype}, data=f, timeout=120)
            if not up.ok:
                log.error("upload %s failed: %s", remote, up.status_code)
                return jsonify(error="Could not store the edited geometry."), 502

    return jsonify(
        step_path=paths["step"], glb_path=paths["glb"],
        triangle_count=int(len(mesh.faces)), bbox=bbox,
    )


def tessellate_with_faces(shape, faces, out_glb, tmp):
    """Tessellate per B-rep face so the glb can say which face each triangle
    came from, and write it to out_glb. Returns (mesh, face_groups).

    Why this is not just an extra attribute on the old path: that path was
    OCC -> STL -> trimesh -> glTF, and **STL is a flat triangle soup**. It has
    no concept of a face, so the association between a triangle and the B-rep
    face it came from is destroyed at the STL step and cannot be recovered
    afterwards. The only way to keep it is to tessellate each face separately
    and record the id as we concatenate.

    That association is what lets a user click a wheel and assign it a rotating
    wall, and what makes the automatic labelling in /infer_labels reviewable
    rather than something you have to take on trust.

    Falls back to the original STL path on any failure. This service is live and
    working (HANDOVER 19); a bug in here should cost face ids, not the geometry
    preview that every upload depends on.
    """
    face_groups = []
    try:
        import numpy as np
        verts, tris, fids = [], [], []
        offset = 0
        for i, f in enumerate(faces):
            vs, ts = f.tessellate(LINEAR_DEFLECTION, ANGULAR_DEFLECTION)
            if not vs or not ts:
                continue
            verts.extend([[v.x, v.y, v.z] for v in vs])
            tris.extend([[t[0] + offset, t[1] + offset, t[2] + offset] for t in ts])
            fids.extend([i] * len(vs))
            face_groups.append({"id": i, "triangles": len(ts)})
            offset += len(vs)

        if not tris:
            raise RuntimeError("per-face tessellation produced no triangles")

        mesh = trimesh.Trimesh(vertices=np.asarray(verts, dtype=np.float64),
                               faces=np.asarray(tris, dtype=np.int64),
                               process=False)     # process=True would weld
                                                  # vertices across faces and
                                                  # scramble the ids
        # trimesh writes vertex_attributes into glTF as a custom attribute. The
        # exact casing it emits is not something to bet on, so the viewer looks
        # for _FACEID and _faceid and falls back to a case-insensitive scan.
        mesh.vertex_attributes["FACEID"] = np.asarray(fids, dtype=np.float32)
        mesh.export(out_glb)
        log.info("  per-face tessellation: %d faces, %d triangles",
                 len(face_groups), len(tris))
        return mesh, face_groups
    except Exception as e:
        log.warning("  per-face tessellation failed (%s) — falling back to STL", e)

    local_stl = os.path.join(tmp, "geometry.stl")
    cq.exporters.export(shape, local_stl, tolerance=LINEAR_DEFLECTION,
                        angularTolerance=ANGULAR_DEFLECTION)
    mesh = trimesh.load(local_stl, force="mesh")
    mesh.export(out_glb)
    return mesh, []


@app.post("/tessellate")
def tessellate():
    uid = caller_uid(request)
    if not uid:
        return jsonify(error="Sign in required."), 401

    step_path = (request.get_json(silent=True) or {}).get("step_path", "")
    # Same rule as the storage policy: your own folder, nothing else.
    if not owned_path(step_path, uid):
        return jsonify(error="That path is not yours."), 403
    if not step_path.lower().endswith((".step", ".stp")):
        return jsonify(error="Expected a .step file."), 400

    with tempfile.TemporaryDirectory() as tmp:
        local_step = os.path.join(tmp, "geometry.step")
        try:
            fetch_object(step_path, local_step)
        except NotFound as e:
            return jsonify(error=f"Could not read the uploaded file ({e.status})."), 404
        except TooLarge:
            return jsonify(error="File is too large to tessellate."), 413

        try:
            shape = cq.importers.importStep(local_step)
        except Exception as e:
            log.warning("STEP import failed: %s", e)
            return jsonify(error="That STEP file could not be read."), 422

        solids = shape.solids().vals()
        faces = shape.faces().vals()
        bbox = exact_bbox(shape.val())

        local_glb = os.path.join(tmp, "geometry.glb")
        mesh, face_groups = tessellate_with_faces(shape, faces, local_glb, tmp)

        glb_path = step_path.rsplit("/", 1)[0] + "/geometry.glb"
        with open(local_glb, "rb") as f:
            up = requests.post(f"{_storage}/{SUPABASE_BUCKET}/{glb_path}", headers={
                **_svc, "Content-Type": "model/gltf-binary", "x-upsert": "true",
            }, data=f, timeout=120)
        if not up.ok:
            log.error("glb upload failed: %s %s", up.status_code, up.text[:200])
            return jsonify(error="Could not store the tessellated model."), 502

    return jsonify(
        glb_path=glb_path,
        face_count=len(faces),
        solid_count=len(solids),
        triangle_count=int(len(mesh.faces)),
        bbox=bbox,
        # Empty when the per-face path fell back to STL, which tells the caller
        # face picking is unavailable for this geometry rather than leaving it
        # to discover that by clicking and getting nothing.
        face_groups=face_groups,
    )


# ── label inference ──────────────────────────────────────────────────────────
# The worker needs an entity_labels.csv giving every STEP face a CFD role, and
# the Fusion plugin is the only thing that writes one. The workbench's Automatic
# CFD makes that CSV an optional second file picker, and credits are charged at
# insert time — so an upload without it takes the user's credits and only then
# fails in the worker. This kernel is already open with the same STEP in it, so
# it can derive the labels rather than the pipeline discovering they are absent.
#
# The geometry for this workflow is a wind-tunnel box enclosing the car, which
# makes the classification a measurement rather than a guess: a tunnel wall is a
# planar face with no thickness in one axis, sitting on that axis' extreme of the
# overall bounding box. Whatever is left over is the car.

TUNNEL_TOL_FRAC = 1e-4   # of the model diagonal — see the comment in infer_labels
WHEEL_AXIS_COS = 0.985   # an axle up to ~10° off y still counts as an axle
MAX_BLOCKAGE = 0.05      # cfd-setup.js: past this the tunnel walls alter the answer
MAX_CAR_BLOCKAGE = 0.5   # past this there is no tunnel around the car at all
LABEL_COLUMNS = ["step_entity_id", "label", "radius_m", "cx_m", "cy_m", "cz_m"]

# Flow runs in −x, so the inlet is the *maximum* x wall. Three independent
# statements in the pipeline agree: build_model() hands the VelocityInletBC a
# FixedValueVBC of (−U, 0, 0); it gives the ground a MovingWallVBC of the same
# vector, and a rolling road runs with the freestream, not against it; and
# cfd-setup.js notes drag "comes out of the solver negative for a body pointing
# into the flow". Air therefore enters at +x and leaves at −x.
AXIS_ROLE = {(0, "max"): "inlet", (0, "min"): "outlet",
             (1, "min"): "side", (1, "max"): "side",
             (2, "min"): "ground", (2, "max"): "top"}


def step_ident(model, ent):
    """The `#id` a STEP file writes for an entity, or None.

    !! RETURNS None FOR EVERY FACE. /infer_labels DOES NOT WORK. !!
    See FINDINGS.md 11. Kept as the single place the problem is described.

    Executed for the first time 14 Aug 2026 (cadquery 2.8.0; the container pins
    2.5.2, which will not install on Python 3.13). What was measured:

    - `IdentLabel` is never populated by STEPControl_Reader — 0 on every face of
      a six-face solid, with `StringLabel` giving '(#0..)'. So the two methods
      this function tries cannot work, whatever the file.
    - **The model index IS the file's `#id`.** Reading a box both ways, the
      model's ADVANCED_FACE indices were [17, 137, 237, 284, 331, 338] and the
      `#id`s in the file text were the same list. So the original comment here —
      that `Interface_InterfaceModel.Number()` is "OCC's own sequential
      numbering" that "would silently label the wrong faces" — was wrong. Number()
      is the right value. That is the useful half of this investigation.
    - But it still cannot be reached: `tr.EntityFromShapeResult(face, 1)` returns
      the right entity, and `model.Number()` on it returns 0, because the handle
      is a different Python wrapper around the same C++ object and Number()
      compares through the wrapper.

    **Do not try to match those wrappers by address.** It was tried, appeared to
    work on a six-face box, and is invalid: the wrappers are temporary, CPython
    frees them, and the addresses are reused — an instrumented run produced only
    4 distinct keys for 6 entities, so ids silently collide. That failure mode
    labels the wrong faces, which is exactly the outcome the original comment
    was worried about.

    Nor does the reverse direction work: walking the model's AdvancedFace
    entities and calling `tr.ShapeResult(ent)` resolves 0 of 6 faces, because
    the transfer records results for roots, not per-face sub-entities. And
    `OCP.TransferBRep`, which exposes the binding map properly, is not built in
    this OCP distribution.

    The way forward is `STEPCAFControl_Reader` + XCAF (both present in OCP),
    which keeps a real label tree per shape instead of relying on transfer
    bindings — or agreeing a different join key with SimScale's importer.

    Not a regression: automatic labelling has never worked, uploads still need
    an entity_labels.csv from the Fusion plugin, and autoCfd() surfaces the
    failure before inserting the job so nobody is charged.
    """
    return None


def read_step_faces(path):
    """(whole shape, [(Face, step_entity_id)]) for a STEP file.

    Drives STEPControl_Reader directly instead of cq.importers.importStep, which
    wraps the same reader with the same defaults — same shapes, same units — but
    throws the work session away. Keeping it is the only way to get back from a
    face to the entity that produced it.
    """
    reader = STEPControl_Reader()
    if reader.ReadFile(path) != IFSelect_RetDone:
        raise ValueError("That STEP file could not be read.")
    if reader.TransferRoots() == 0:
        raise ValueError("That STEP file contains no shapes.")

    shape = cq.Shape.cast(reader.OneShape())
    tr = reader.WS().TransferReader()
    model = reader.WS().Model()

    seen = {}
    exp = TopExp_Explorer(shape.wrapped, TopAbs_FACE)
    while exp.More():
        face = cq.Shape.cast(exp.Current())
        ent = None
        for mode in (1, -1):
            try:
                ent = tr.EntityFromShapeResult(face.wrapped, mode)
            except Exception:
                ent = None
            if ent is not None:
                break
        eid = step_ident(model, ent)
        if eid is not None and eid not in seen:
            seen[eid] = face
        exp.Next()

    if not seen:
        raise ValueError("No STEP entity ids could be recovered from that file.")
    return shape, [(f, eid) for eid, f in seen.items()]


def infer_labels(shape, faces):
    """Give every face of a car-in-a-wind-tunnel STEP a CFD role.

    `faces` is [(Face, step_entity_id)]. Returns
    {rows, counts, wheels, warnings, confident, blocked}. `blocked` is a sentence
    saying why no labels file should be written at all, or None — the difference
    between "I could not do this" and "I did this". Anything short of a textbook
    car in a textbook tunnel lands in `warnings` and clears `confident`, because
    a labels file that is quietly wrong produces a simulation that is quietly
    wrong, and nothing downstream would ever notice.
    """
    box = exact_bbox(shape)
    lo, hi, size = box["min"], box["max"], box["size"]
    diag = math.sqrt(sum(s * s for s in size))
    if diag <= 0:
        return {"rows": [], "counts": {}, "wheels": [], "confident": False,
                "warnings": ["The geometry has no extent."],
                "blocked": "The geometry has no extent."}

    # Tolerance from the model, never in millimetres — this competition's cars
    # are ~210 mm but nothing here may assume that. A tunnel wall is planar to
    # within the round-off of the decimals STEP writes it with, order 1e-7 of the
    # model; the smallest feature that is deliberately there, a wheel radius, is
    # order 1e-2 of it. 1e-4 of the diagonal sits three orders above the noise
    # and two below anything real, and scales with whatever the user uploaded.
    tol = TUNNEL_TOL_FRAC * diag
    warn = []

    # ── which faces are the tunnel ──
    tunnel, car = {}, []
    for face, eid in faces:
        fb = exact_bbox(face)
        hit = None
        if BRepAdaptor_Surface(face.wrapped).GetType() == GeomAbs_Plane:
            for axis in (0, 1, 2):
                if fb["size"][axis] > tol:
                    continue                       # not degenerate in this axis
                if abs(fb["min"][axis] - lo[axis]) <= tol:
                    hit = (axis, "min")
                elif abs(fb["max"][axis] - hi[axis]) <= tol:
                    hit = (axis, "max")
                if hit:
                    break
        if hit:
            tunnel[eid] = (AXIS_ROLE[hit], hit)
        else:
            car.append((eid, face, fb))

    if not car:
        return {"rows": [], "counts": {}, "wheels": [], "confident": False,
                "warnings": ["Every face lies on the bounding box."],
                "blocked": "Every face lies on the bounding box, so there is "
                           "nothing inside the tunnel to simulate."}

    car_lo = [min(fb["min"][a] for _, _, fb in car) for a in (0, 1, 2)]
    car_hi = [max(fb["max"][a] for _, _, fb in car) for a in (0, 1, 2)]

    # ── side vs symmetry ──
    # A half model is one-sided: the box stops at y = 0 and so does the car. Both
    # halves of that test matter — a full tunnel modelled from y = 0 to y = 1 has
    # a wall on y = 0 too, and it is an ordinary slip wall.
    sym_end = None
    for end in ("min", "max"):
        plane = lo[1] if end == "min" else hi[1]
        edge = car_lo[1] if end == "min" else car_hi[1]
        if abs(plane) <= tol and abs(edge) <= tol:
            sym_end = end
            for eid, (role, hit) in list(tunnel.items()):
                if hit == (1, end):
                    tunnel[eid] = ("symmetry", hit)

    # ── wheels ──
    # A wheel is a cylindrical face turning about y. The centre is taken on the
    # axis at the face's own mid-width, not at gp_Cylinder's local origin, whose
    # position along the axis depends on how the surface happened to be built —
    # two faces of one wheel must round to one centre or the worker counts two.
    wheels_by_eid = {}
    for eid, face, fb in car:
        surf = BRepAdaptor_Surface(face.wrapped)
        if surf.GetType() != GeomAbs_Cylinder:
            continue
        cyl = surf.Cylinder()
        axis = cyl.Axis()
        d = axis.Direction()
        if abs(d.Y()) < WHEEL_AXIS_COS:
            continue
        p = axis.Location()
        cy = 0.5 * (fb["min"][1] + fb["max"][1])
        t = (cy - p.Y()) / d.Y()
        wheels_by_eid[eid] = (cyl.Radius(), p.X() + t * d.X(), cy, p.Z() + t * d.Z())

    # ── rows, in entity-id order so the wheel numbering is deterministic ──
    rows = []
    for eid in sorted(eid for _, eid in faces):
        if eid in tunnel:
            rows.append([eid, tunnel[eid][0], "", "", "", ""])
        elif eid in wheels_by_eid:
            r, cx, cy, cz = wheels_by_eid[eid]
            rows.append([eid, "rotating_wall"] + [f"{v:.9g}" for v in (r, cx, cy, cz)])
        else:
            rows.append([eid, "car_no_slip", "", "", "", ""])

    counts = {}
    for row in rows:
        counts[row[1]] = counts.get(row[1], 0) + 1

    # Group exactly the way load_entity_labels() does — same rounding, same order,
    # same first-one-wins — or the worker sees a different wheel count than the
    # number reported here.
    wheel_map = {}
    for eid, label, r, cx, cy, cz in rows:
        if label != "rotating_wall":
            continue
        cx, cy, cz = float(cx), float(cy), float(cz)
        key = (round(cx, 3), round(cy, 3), round(cz, 3))
        if key not in wheel_map:
            idx = len(wheel_map) + 1
            wheel_map[key] = {"name": f"Wheel_{idx}", "label": f"rotating_wall_{idx}",
                              "radius_m": float(r), "cx_m": cx, "cy_m": cy, "cz_m": cz,
                              "faces": 0}
        wheel_map[key]["faces"] += 1
    wheels = list(wheel_map.values())

    # ── does this actually look like a car in a wind tunnel? ──
    blocked = None
    missing = [r for r in ("inlet", "outlet", "ground", "top") if not counts.get(r)]
    if missing:
        blocked = ("No wall was found for: " + ", ".join(missing) +
                   ". This STEP does not enclose the car in a wind tunnel.")
    elif counts.get("side", 0) + counts.get("symmetry", 0) < 2:
        blocked = "Only one side wall was found; a wind tunnel needs both."
    elif len(tunnel) < 6:
        blocked = f"Only {len(tunnel)} faces lie on the bounding box; a tunnel needs six walls."

    cross = size[1] * size[2]
    blockage = ((car_hi[1] - car_lo[1]) * (car_hi[2] - car_lo[2]) / cross) if cross > 0 else 1.0
    if blockage > MAX_CAR_BLOCKAGE and not blocked:
        blocked = (f"The car fills {blockage * 100:.0f}% of the tunnel cross-section, "
                   "so this is not a car inside a tunnel.")
    elif blockage > MAX_BLOCKAGE:
        warn.append(f"Blockage is {blockage * 100:.1f}% of the tunnel cross-section "
                    f"(above {MAX_BLOCKAGE * 100:.0f}% the walls alter the answer).")

    if not wheels:
        warn.append("No cylindrical face turning about y was found, so no wheel "
                    "rotates: every wheel will be a plain no-slip wall.")

    # The car should be clear of every wall but the ground it stands on and the
    # symmetry plane it is cut by. Touching any other means a car face probably
    # got absorbed into that wall.
    for axis, name in ((0, "x"), (1, "y"), (2, "z")):
        for end, near in (("min", car_lo[axis] - lo[axis]), ("max", hi[axis] - car_hi[axis])):
            if (axis, end) == (2, "min") or (axis == 1 and end == sym_end):
                continue
            if near <= tol:
                warn.append(f"The car touches the {end} {name} wall "
                            f"({AXIS_ROLE[(axis, end)]}); faces there may be mislabelled.")

    # Independent check on the one decision that inverts the whole result. The
    # conventional box is 3 car lengths upstream and 8 downstream, so the car
    # should sit far nearer the inlet than the outlet. Much more room in front
    # than behind means the tunnel was built for +x flow and these labels are
    # the wrong way round.
    upstream, downstream = hi[0] - car_hi[0], car_lo[0] - lo[0]
    if upstream > 2 * downstream:
        warn.append("The car sits much closer to the min-x wall than the max-x wall. "
                    "Flow runs -x, so max x was labelled the inlet — check that the "
                    "tunnel was not built for +x flow.")

    return {"rows": rows, "counts": counts, "wheels": wheels, "warnings": warn,
            "confident": blocked is None and not warn, "blocked": blocked}


def labels_csv(rows):
    """The rows as the CSV that load_entity_labels() reads."""
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(LABEL_COLUMNS)
    w.writerows(rows)
    return buf.getvalue()


@app.route("/infer_labels", methods=["OPTIONS"])
def infer_preflight():
    return "", 204


@app.post("/infer_labels")
def infer_endpoint():
    uid = caller_uid(request)
    if not uid:
        return jsonify(error="Sign in required."), 401

    body = request.get_json(silent=True) or {}
    step_path, dest = body.get("step_path", ""), body.get("dest_path") or ""
    if not owned_path(step_path, uid):
        return jsonify(error="That path is not yours."), 403
    if not step_path.lower().endswith((".step", ".stp")):
        return jsonify(error="Expected a .step file."), 400
    if not owned_path(dest, uid):
        return jsonify(error="Destination is not yours."), 403
    if not dest.lower().endswith(".csv"):
        return jsonify(error="Expected a .csv destination."), 400

    # Same write-once guard as /transform, for the same reason: this service
    # holds the service-role key and bypasses RLS, and the storage policy grants
    # INSERT and never UPDATE. A labels file is what a finished run was measured
    # against, so it is written once and never rewritten.
    exists = requests.head(f"{_storage}/{SUPABASE_BUCKET}/{dest}", headers=_svc, timeout=30)
    if exists.ok:
        return jsonify(error="Those labels already exist."), 409

    with tempfile.TemporaryDirectory() as tmp:
        local = os.path.join(tmp, "in.step")
        try:
            fetch_object(step_path, local)
        except NotFound as e:
            return jsonify(error=f"Could not read the source geometry ({e.status})."), 404
        except TooLarge:
            return jsonify(error="File is too large to label."), 413

        try:
            shape, faces = read_step_faces(local)
            out = infer_labels(shape, faces)
        except ValueError as e:
            return jsonify(error=str(e)), 422
        except Exception as e:
            log.warning("label inference failed: %s", e)
            return jsonify(error="That STEP file could not be labelled."), 422

        # A caller must be able to tell a refusal from a result. When the
        # geometry is not a car in a tunnel, nothing is written: a labels file
        # that is wrong costs a full run and looks exactly like one that is right.
        if out["blocked"]:
            return jsonify(error=out["blocked"], label_path=None, counts=out["counts"],
                           wheels=out["wheels"], confident=False,
                           warnings=out["warnings"]), 422

        up = requests.post(f"{_storage}/{SUPABASE_BUCKET}/{dest}", headers={
            **_svc, "Content-Type": "text/csv"},
            data=labels_csv(out["rows"]).encode("utf-8"), timeout=60)
        if not up.ok:
            log.error("labels upload failed: %s %s", up.status_code, up.text[:200])
            return jsonify(error="Could not store the inferred labels."), 502

    log.info("inferred labels for %s: %s", step_path, out["counts"])
    return jsonify(label_path=dest, counts=out["counts"], wheels=out["wheels"],
                   confident=out["confident"], warnings=out["warnings"])


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8080)))
