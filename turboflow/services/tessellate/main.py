"""TurboFlow geometry service.

Three jobs, all on the OCC kernel through CadQuery:

  /tessellate  STEP -> glTF, so the browser can draw the model.
  /inspect     Raw car STEP -> glTF whose triangles are grouped by STEP face,
               plus a description of every face, so the browser can let the user
               click one and say what it is.
  /transform   Replay edit operations on the B-rep and write a new version.
  /prepare     Turn a raw car into a wind-tunnel flow region plus the labels
               file that says which face is the inlet, the ground and each
               wheel. This is the Fusion 360 add-in's job, done server-side.

/prepare exists because until now a user needed a Fusion licence to run
anything. The Workbench could only accept a flow region the add-in had already
built: a box with the car cut out of it. A car on its own was useless to it.

The part that makes it possible is not obvious, so it is worth stating. The
add-in does not ask Fusion for STEP entity ids. It exports the STEP and then
reads the exported text back, matching ADVANCED_FACE records with a regular
expression and classifying each face by its surface type and where its centroid
sits relative to the domain walls (TurboFlow_CFD.py:449-556). FINDINGS.md
records that STEP entity ids cannot be recovered from an in-memory OCC model,
and that is true, but it does not apply here: we write the file, so we can read
its ids straight back out of it. /prepare does exactly what the add-in does, in
the same order, for the same reason.
"""
import io, os, re, csv, json, math, time, zlib, shutil, struct, datetime, tempfile, threading, logging

import numpy
import trimesh
import cadquery as cq
import firebase_admin
from firebase_admin import auth as fb_auth, storage as fb_storage, firestore as fb_firestore
from OCP.Bnd import Bnd_Box
from OCP.BRepBndLib import BRepBndLib
from OCP.BRepAdaptor import BRepAdaptor_Surface
from OCP.BRepLProp import BRepLProp_SLProps
from OCP.GeomAbs import GeomAbs_SurfaceType, GeomAbs_Shape
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.BRep import BRep_Tool
from OCP.TopLoc import TopLoc_Location
from OCP.TopAbs import TopAbs_Orientation, TopAbs_EDGE, TopAbs_FACE
from OCP.TopoDS import TopoDS
from OCP.TopExp import TopExp, TopExp_Explorer
from OCP.TopTools import (TopTools_IndexedDataMapOfShapeListOfShape,
                          TopTools_IndexedMapOfShape, TopTools_ListOfShape)
from OCP.BRepLib import BRepLib
from OCP.IGESControl import IGESControl_Reader
from OCP.STEPControl import (STEPControl_Writer, STEPControl_StepModelType,
                             STEPControl_Reader)
from OCP.IFSelect import IFSelect_ReturnStatus
from OCP.Interface import Interface_Static
from OCP.BRepGProp import BRepGProp
from OCP.GProp import GProp_GProps
from OCP.BRepBuilderAPI import BRepBuilderAPI_Sewing
from OCP.BRepCheck import BRepCheck_Analyzer, BRepCheck_Status
from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut
from OCP.TopAbs import TopAbs_SHELL, TopAbs_WIRE
from OCP.BRepExtrema import BRepExtrema_DistShapeShape
from OCP.gp import gp_Trsf, gp_Ax1, gp_Pnt, gp_Dir
from OCP.BRepBuilderAPI import BRepBuilderAPI_Transform
from flask import Flask, request, jsonify

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

# Stage timing and resident memory, because a container killed on signal 9
# leaves no traceback and no clue which line was holding the memory.
_T0 = [0.0]


def stage_reset():
    """Start the clock for this request.

    _T0 is a module global, so without this the first stage of a request
    measured the time since the *last* request finished. That is how a download
    of a 700 KB file came to be logged as taking 261.7 seconds, and it is the
    sort of number that sends you optimising the wrong thing.
    """
    import time as _t
    _T0[0] = _t.time()


def stage(label):
    import time as _t
    try:
        import resource
        rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024.0
    except Exception:
        rss = -1.0
    now = _t.time()
    delta = now - _T0[0] if _T0[0] else 0.0
    _T0[0] = now
    logging.getLogger("tessellate").info("STAGE %-24s +%5.1fs  peak rss %6.0f MB", label, delta, rss)
log = logging.getLogger("tessellate")

# Nothing project-specific is baked in. The bucket defaults from the project the
# service is deployed to, the same rule the SimScale worker follows.
GCP_PROJECT = os.environ.get("GOOGLE_CLOUD_PROJECT") or os.environ.get("GCLOUD_PROJECT", "")
STORAGE_BUCKET = (os.environ.get("STORAGE_BUCKET")
                  or (GCP_PROJECT + ".firebasestorage.app" if GCP_PROJECT else ""))
if not STORAGE_BUCKET:
    raise SystemExit("STORAGE_BUCKET is not set and GOOGLE_CLOUD_PROJECT gives no default.")

# Deflection controls triangle density: smaller means a finer mesh and a bigger
# file.
# Absolute, in the model's own units, and it was the wrong shape of number.
# 0.1 is a tenth of a millimetre, which on a 240 mm car is 160,000 triangles:
# more than the browser needs to draw it, more than the shadow rasteriser needs
# to measure it, and a 3.7 MB download. Deflection is now a fraction of the
# model's own diagonal, so a small car and a large one both come out around the
# same triangle count, with the old value as a floor so nothing gets coarser
# than it used to be by accident.
LINEAR_DEFLECTION = float(os.environ.get("LINEAR_DEFLECTION", "0.1"))
DEFLECTION_FRACTION = float(os.environ.get("DEFLECTION_FRACTION", "0.0015"))
ANGULAR_DEFLECTION = float(os.environ.get("ANGULAR_DEFLECTION", "0.3"))
MAX_STEP_BYTES = int(os.environ.get("MAX_STEP_BYTES", str(50 * 1024 * 1024)))

firebase_admin.initialize_app(options={"storageBucket": STORAGE_BUCKET})
app = Flask(__name__)


# ── rate limiting ────────────────────────────────────────────────────────────
# Nothing stopped one signed-in account calling /prepare in a loop. Every call
# imports a STEP, meshes it, runs a boolean cut and rasterises a shadow, on two
# CPUs, and it costs the caller nothing: credits are spent when a job is queued,
# which is a later and separate step. Cloud Run's instance cap limits the bill
# but not the queue, so a loop starves every real user instead of costing money.
#
# A fixed window per user per endpoint, counted in Firestore, deliberately the
# same scheme and the same collection as functions/src/lib/ratelimit.ts so the
# two halves of the backend do not disagree about what a limit means. Fixed
# windows allow a burst of up to twice the limit across a boundary. That is
# fine: the point is to stop a runaway loop, not to meter precisely.
RATE_LIMITS = {
    # /prepare is the expensive one, and the one a person runs a handful of
    # times per car, so it is the tightest.
    "prepare": (int(os.environ.get("RATE_PREPARE", "25")), 3600),
    "inspect": (int(os.environ.get("RATE_INSPECT", "80")), 3600),
    "tessellate": (int(os.environ.get("RATE_TESSELLATE", "80")), 3600),
    "transform": (int(os.environ.get("RATE_TRANSFORM", "80")), 3600),
    # Measuring is cheap and a user does it repeatedly while reading a
    # model, so the limit is loose. It still exists, because the endpoint
    # loads a STEP and that is not free.
    "measure": (int(os.environ.get("RATE_MEASURE", "300")), 3600),
}
RATE_COLLECTION = os.environ.get("RATE_COLLECTION", "rate")
_fs = None


def firestore_client():
    global _fs
    if _fs is None:
        _fs = fb_firestore.client()
    return _fs


def over_rate_limit(uid, action):
    """True when this caller has used the window up. Never blocks on failure.

    A limiter that takes the service down when Firestore hiccups is worse than
    the abuse it prevents, so an error here lets the request through and says
    so in the log.
    """
    rule = RATE_LIMITS.get(action)
    if not rule:
        return False
    limit, window = rule
    slot = int(time.time() // window)
    doc = firestore_client().collection(RATE_COLLECTION).document(
        "%s:svc_%s:%d" % (uid, action, slot))

    try:
        transaction = firestore_client().transaction()

        @fb_firestore.transactional
        def bump(txn):
            snap = doc.get(transaction=txn)
            prior = int((snap.to_dict() or {}).get("count", 0)) if snap.exists else 0
            count = prior + 1
            txn.set(doc, {
                "count": count,
                "uid": uid,
                "action": "svc_" + action,
                # A real future timestamp, one window past the end, because that
                # is what the TTL policy on this collection reads. Keeping it
                # past the end means a late call in the same window still sees
                # the count rather than starting again from zero.
                "expire_at": datetime.datetime.fromtimestamp(
                    (slot + 2) * window, tz=datetime.timezone.utc),
            }, merge=True)
            return count

        used = bump(transaction)
    except Exception as e:
        log.warning("rate limit check failed for %s on %s, allowing: %s", uid, action, e)
        return False

    if used > limit:
        log.warning("rate limit hit: %s used %d of %d on %s", uid, used, limit, action)
        return True
    return False


def limited(uid, action):
    """The refusal to return, or None to carry on."""
    if over_rate_limit(uid, action):
        limit, window = RATE_LIMITS[action]
        return jsonify(
            error="That is more than %d %s calls in %d hour. Wait a little and "
                  "try again." % (limit, action, window // 3600)), 429
    return None


# ── storage ──────────────────────────────────────────────────────────────────
def bucket():
    return fb_storage.bucket()


def download(remote, local):
    blob = bucket().blob(remote)
    if not blob.exists():
        return False
    blob.reload()
    if blob.size and blob.size > MAX_STEP_BYTES:
        raise ValueError("file is too large")
    blob.download_to_filename(local)
    return True


def upload(local, remote, ctype):
    bucket().blob(remote).upload_from_filename(local, content_type=ctype)


def remote_exists(remote):
    return bucket().blob(remote).exists()


# ── auth ─────────────────────────────────────────────────────────────────────
# Service accounts allowed to act on a user's behalf. processGeometry runs as
# one of these and calls /inspect for a user who is not present, so it says
# whose folder to work in with `on_behalf_of`.
#
# This has to be checked here rather than left to Cloud Run, because the
# service is deployed with allUsers as invoker: the browser calls it directly
# with a Firebase token, so Cloud Run cannot be the gate. A Google-issued ID
# token is verified in full, and only the addresses listed here are believed.
TRUSTED_CALLERS = set(
    e.strip() for e in os.environ.get("TRUSTED_CALLERS", "").split(",") if e.strip()
) or {
    "%s@appspot.gserviceaccount.com" % GCP_PROJECT,
    "%s-compute@developer.gserviceaccount.com" % os.environ.get("GCP_PROJECT_NUMBER", ""),
}


def service_caller_email(token):
    """The verified email of a Google service account, or None."""
    try:
        from google.oauth2 import id_token as google_id_token
        from google.auth.transport import requests as google_requests
        claims = google_id_token.verify_oauth2_token(
            token, google_requests.Request())
        if claims.get("email_verified") and claims.get("email") in TRUSTED_CALLERS:
            return claims["email"]
        log.info("service token from %s is not trusted", claims.get("email"))
    except Exception as e:
        log.debug("not a Google service token: %s", e)
    return None


def caller_uid(req):
    """Who this request is for: a signed-in person, or a trusted service.

    A user's Firebase token means the user. A trusted service account's Google
    token means whoever it names in `on_behalf_of`, which is how the geometry
    pipeline works on an upload minutes after the person who made it has gone.
    """
    token = (req.headers.get("Authorization") or "").removeprefix("Bearer ").strip()
    if not token:
        return None
    try:
        return fb_auth.verify_id_token(token).get("uid")
    except Exception as e:
        log.debug("not a Firebase token: %s", e)

    if service_caller_email(token):
        body = req.get_json(silent=True) or {}
        on_behalf = body.get("on_behalf_of")
        if isinstance(on_behalf, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", on_behalf):
            return on_behalf
        log.warning("trusted service call with no usable on_behalf_of")
        return None

    log.info("token rejected")
    return None


def owned(path, uid):
    """The caller's own storage prefix, and nothing else.

    This has to agree with storage.rules, where the uid in the path IS the
    ownership check. It was `jobs/{uid}/` here while the Workbench had already
    moved to `users/{uid}/geometries/`, so every call was refused with a 403
    that looked like an auth problem and was really a path problem.
    """
    return (isinstance(path, str) and path
            and ".." not in path
            and not path.startswith("/")
            and path.startswith(f"users/{uid}/"))


# ── geometry helpers ─────────────────────────────────────────────────────────
_MESHED = set()


# One imported STEP, kept for the next request. Reading an 11 MB car takes ten
# seconds and it is the largest single cost left, and the flow the user
# actually follows pays it twice: /inspect to look at the car, then /prepare to
# build the tunnel round the same car. The second one is now free.
#
# Keyed by the storage path and the object's generation, so an upload to the
# same path is a different key and can never be served a stale shape. Holds one
# entry: two would double the memory for a case that does not happen, since a
# user works on one car at a time and each instance serves few of them.
# Guarded, because gunicorn runs two threads in this process and OCC is not
# safe to triangulate the same shape from two of them at once. Geometry work
# is serialised anyway by being CPU bound; the lock only makes that explicit.
_IMPORT_LOCK = threading.Lock()
_IMPORT_CACHE = {"key": None, "shape": None}


def import_step_cached(local_path, key, fmt="STEP"):
    """Import, or hand back the same shape if this is the file we just read."""
    with _IMPORT_LOCK:
        if key and _IMPORT_CACHE["key"] == key:
            log.info("reusing the imported shape for %s", key)
            return cq.Workplane(obj=_IMPORT_CACHE["shape"]), True
        wp = read_any(local_path, fmt)
        if key:
            _IMPORT_CACHE["key"] = key
            _IMPORT_CACHE["shape"] = wp.val()
        return wp, False


def cached_shape_for(key):
    """True when this exact file is already imported and can be reused."""
    return bool(key) and _IMPORT_CACHE["key"] == key


def blob_key(path):
    """A key that changes when the bytes do."""
    try:
        blob = bucket().get_blob(path)
        return "%s@%s" % (path, blob.generation) if blob else None
    except Exception:
        return None


# What the browser is allowed to upload, and what OCC needs to read each one.
# Build spec 14.2: STEP, IGES and STL. Everything becomes STEP before it goes
# to SimScale, so a face id the user clicked is the face id SimScale is told
# about. That is the whole reason for converting at upload rather than later.
FORMATS = {
    ".step": "STEP", ".stp": "STEP",
    ".iges": "IGES", ".igs": "IGES",
    ".stl": "STL",
}


def format_of(path):
    ext = os.path.splitext(path.lower())[1]
    return FORMATS.get(ext), ext


# How big a mesh may be before the STEP re-export is skipped. Sewing one OCC
# face per triangle is the only route from a mesh to a solid model, and it is
# linear in triangles with a large constant: twenty thousand takes about a
# minute, two hundred thousand takes long enough that Cloud Run gives up. Above
# the cap the model is still uploaded, viewed and measured; only the SimScale
# export is withheld, and the caller is told why rather than left waiting.
STL_STEP_MAX_TRIANGLES = int(os.environ.get("STL_STEP_MAX_TRIANGLES", "20000"))


def mesh_groups(mesh, facet_split):
    """Which triangles belong to which clickable face.

    An STL has no faces, only triangles, so "click a face" has to be given a
    meaning here. With facet_split on it means a connected region: every
    triangle reachable across a shared edge without leaving the surface, which
    on a car exported as separate bodies gives one face per body. With it off
    the whole mesh is one face, which is the honest answer when the file is a
    single welded shell and there is nothing to separate.
    """
    n = len(mesh.faces)
    if n == 0:
        return []
    if not facet_split:
        return [numpy.arange(n, dtype=numpy.int64)]
    # An STL stores every triangle with its own three corners and no index, so
    # straight off the file no two triangles share a vertex and nothing is
    # adjacent to anything. Without this the whole model came back as one
    # region however many separate bodies it held. merge_vertices only remaps
    # the indices, so the triangle order the ranges depend on is untouched.
    mesh.merge_vertices()
    adj = mesh.face_adjacency
    if len(adj) == 0:
        return [numpy.arange(n, dtype=numpy.int64)]
    labels = connected_labels(adj, n)
    order = numpy.argsort(labels, kind="stable")
    counts = numpy.bincount(labels)
    bounds = numpy.cumsum(counts)[:-1]
    return [g for g in numpy.split(order, bounds) if len(g)]


def connected_labels(edges, count):
    """Which connected group each node belongs to, numbered from zero.

    trimesh has this, and it wants scipy for it: one sparse matrix and one call
    to csgraph. scipy is forty megabytes of compiled linear algebra to answer a
    question that union-find answers in twenty lines, in a container that is
    already slow to build and already at its memory limit on a large car.

    Union by size with path compression, so the whole thing is effectively
    linear in the number of shared edges.
    """
    parent = list(range(count))
    size = [1] * count

    def find(x):
        root = x
        while parent[root] != root:
            root = parent[root]
        while parent[x] != root:            # path compression, second pass
            parent[x], x = root, parent[x]
        return root

    for a, b in numpy.asarray(edges, dtype=numpy.int64):
        ra, rb = find(int(a)), find(int(b))
        if ra == rb:
            continue
        if size[ra] < size[rb]:
            ra, rb = rb, ra
        parent[rb] = ra
        size[ra] += size[rb]

    # Renumber the roots so the labels are 0..k-1 and bincount is dense.
    seen, labels = {}, numpy.empty(count, dtype=numpy.int64)
    for i in range(count):
        r = find(i)
        if r not in seen:
            seen[r] = len(seen)
        labels[i] = seen[r]
    return labels


def mesh_arrays_by_group(mesh, groups):
    """Vertices and triangles rewritten so each group owns a contiguous run.

    The same contract to_glb_by_face keeps for a STEP: no vertex is shared
    between two faces, so naming the face on the vertex is exact, and both the
    triangle range and the vertex range of a face are one slice.
    """
    V = numpy.asarray(mesh.vertices, dtype=float)
    F = numpy.asarray(mesh.faces, dtype=numpy.int64)
    out_v, out_t, out_o, ranges, vranges = [], [], [], [], []
    nv = nt = 0
    for gi, g in enumerate(groups):
        pts = V[F[g]].reshape(-1, 3)
        out_v.append(pts)
        out_t.append(numpy.arange(len(pts), dtype=numpy.int64).reshape(-1, 3) + nv)
        out_o.append(numpy.full(len(pts), gi, dtype=numpy.float32))
        vranges.append((nv, len(pts)))
        ranges.append((nt, len(g)))
        nv += len(pts)
        nt += len(g)
    return (numpy.concatenate(out_v), numpy.concatenate(out_t),
            numpy.concatenate(out_o), ranges, vranges)


def mesh_group_normals(verts, tris, ranges):
    """One area-weighted normal per group, for the face list."""
    P = numpy.asarray(verts, dtype=float)
    T = numpy.asarray(tris, dtype=numpy.int64)
    a, b, c = P[T[:, 0]], P[T[:, 1]], P[T[:, 2]]
    n = numpy.cross(b - a, c - a)                    # length is twice the area
    out = []
    for start, count in ranges:
        if count <= 0:
            out.append(None)
            continue
        v = n[start:start + count].sum(0)
        m = numpy.linalg.norm(v)
        out.append(None if m < 1e-20 else [round(float(x), 6) for x in v / m])
    return out


def turn_mesh_to_wind(verts):
    """The quarter turn about Z that orient_to_wind applies to a solid.

    A mesh has no cylinders, so the axle test that decides the STEP case is not
    available: this goes on the bounding box alone and puts the longest
    horizontal side along X, which is what the tunnel and the frontal area both
    assume. It is stated in the reply rather than done quietly.
    """
    P = numpy.asarray(verts, dtype=float)
    span = P.max(0) - P.min(0)
    if span[1] <= span[0]:
        return P, 0.0
    turned = P.copy()
    turned[:, 0] = P[:, 1]
    turned[:, 1] = -P[:, 0]
    return turned, -90.0


def read_iges(path):
    """An IGES file as a CadQuery Workplane.

    IGES carries surfaces, not solids, so what comes back is a shell at best
    and a pile of faces at worst. Sewing stitches faces that share an edge back
    into something the boolean cut can work with; without it the wind tunnel
    cut has nothing closed to subtract and quietly removes nothing.
    """
    reader = IGESControl_Reader()
    if reader.ReadFile(path) != IFSelect_ReturnStatus.IFSelect_RetDone:
        raise ValueError("that IGES file could not be read")
    reader.TransferRoots()
    shape = reader.OneShape()
    sew = BRepBuilderAPI_Sewing(1e-6)
    sew.Add(shape)
    sew.Perform()
    from cadquery.occ_impl.shapes import Shape
    return cq.Workplane(obj=Shape.cast(sew.SewedShape()))


def read_stl(path):
    """An STL as a CadQuery Workplane.

    A mesh, not a model: there are no analytic faces, so nothing here will ever
    report a cylinder and the wheel finder will come up empty. That is honest
    rather than a limitation to hide, and the caller says so to the user.
    """
    import trimesh as _tm
    mesh = _tm.load(path, force="mesh")
    if mesh is None or len(mesh.faces) == 0:
        raise ValueError("that STL file has no triangles")
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakePolygon, BRepBuilderAPI_MakeFace
    from OCP.gp import gp_Pnt
    sew = BRepBuilderAPI_Sewing(1e-6)
    for tri in mesh.vertices[mesh.faces]:
        poly = BRepBuilderAPI_MakePolygon()
        for v in tri:
            poly.Add(gp_Pnt(float(v[0]), float(v[1]), float(v[2])))
        poly.Close()
        if not poly.IsDone():
            continue
        face = BRepBuilderAPI_MakeFace(poly.Wire())
        if face.IsDone():
            sew.Add(face.Face())
    sew.Perform()
    from cadquery.occ_impl.shapes import Shape
    return cq.Workplane(obj=Shape.cast(sew.SewedShape()))


def parse_step_faces(step_path):
    """Every ADVANCED_FACE in a STEP file, with the corner points it uses.

    OCC will not say which entity produced which face. EntityFromShapeResult
    returns nothing on this build and OCP has no TransferBRep module to walk
    the binding table with, so the mapping is recovered from the file itself.
    The Fusion add-in has read STEP text this way for two years; this is the
    same idea pointed at a different question.

    Only VERTEX_POINTs are collected, not every CARTESIAN_POINT the face
    mentions. A face also references the origin of its plane, the centre of
    its circle and the control net of its spline, and none of those have a
    counterpart on the OCC side. Its corners do, exactly.
    """
    text = io.open(step_path, encoding="utf-8", errors="replace").read()
    body = text.split("DATA;", 1)[-1].split("ENDSEC;", 1)[0]

    kind = {}
    refs = {}
    points = {}
    # STEP writes reals as 1., 0.E0, -4.44E-16 and .5, and a pattern that
    # demands a digit after the point silently reads 1.E1 as 1 rather than
    # 10. Every coordinate then lands in the wrong place and nothing matches
    # anything, which is exactly what happened.
    number = re.compile(
        r"[-+]?(?:[0-9]+\.[0-9]*|\.[0-9]+|[0-9]+)(?:[EeDd][-+]?[0-9]+)?")

    for statement in body.split(";"):
        head = statement.find("=")
        if head < 0:
            continue
        left = statement[:head].strip()
        if not left.startswith("#"):
            continue
        try:
            eid = int(left[1:])
        except ValueError:
            continue
        rest = statement[head + 1:].strip()
        name_end = rest.find("(")
        if name_end < 0:
            continue
        kind[eid] = rest[:name_end].strip()
        refs[eid] = [int(x) for x in re.findall(r"#(\d+)", rest)]
        if kind[eid] == "CARTESIAN_POINT":
            tail = rest.split("'", 2)[-1]
            found = number.findall(tail)
            if len(found) >= 3:
                points[eid] = tuple(
                    float(v.replace("D", "E").replace("d", "e")) for v in found[:3])

    faces = {}
    for eid, what in kind.items():
        if what != "ADVANCED_FACE":
            continue
        seen = set()
        stack = [(eid, 0)]
        corners = []
        while stack:
            node, depth = stack.pop()
            if node in seen or depth > 8:
                continue
            seen.add(node)
            if kind.get(node) == "VERTEX_POINT":
                for ref in refs.get(node, ()):  # its one CARTESIAN_POINT
                    if ref in points:
                        corners.append(points[ref])
                continue
            for ref in refs.get(node, ()):
                stack.append((ref, depth + 1))
        if corners:
            faces[eid] = corners
    return faces


def _shape_key(corners):
    """A position-and-size fingerprint that survives a change of units.

    The STEP writer emits millimetres whatever the shape's own numbers were,
    so the two sides cannot be compared directly. Normalising each point
    cloud by its own overall extent removes the scale, and what is left is
    where the face sits on the car, which is what identifies it.
    """
    n = len(corners)
    cx = sum(c[0] for c in corners) / n
    cy = sum(c[1] for c in corners) / n
    cz = sum(c[2] for c in corners) / n
    return n, (cx, cy, cz)


def match_step_ids(step_path, faces):
    """Face index to STEP entity id, matched on the corners of each face."""
    parsed = parse_step_faces(step_path)
    if not parsed:
        log.warning("no ADVANCED_FACE entities found in the export")
        return {}

    ours = []
    for i, face in enumerate(faces):
        corners = []
        for v in face.Vertices():
            t = v.toTuple()
            corners.append((t[0], t[1], t[2]))
        ours.append((i, corners))

    # Normalise both clouds by their own extent, which is what makes the
    # comparison independent of the writer's unit choice.
    def extent(all_points):
        xs = [p[0] for p in all_points]
        ys = [p[1] for p in all_points]
        zs = [p[2] for p in all_points]
        lo = (min(xs), min(ys), min(zs))
        hi = (max(xs), max(ys), max(zs))
        span = tuple(max(hi[k] - lo[k], 1e-12) for k in range(3))
        return lo, span

    theirs_all = [p for c in parsed.values() for p in c]
    ours_all = [p for _, c in ours for p in c]
    if not theirs_all or not ours_all:
        return {}
    t_lo, t_span = extent(theirs_all)
    o_lo, o_span = extent(ours_all)

    def norm(point, lo, span):
        return tuple((point[k] - lo[k]) / span[k] for k in range(3))

    # Bucket by corner count first. Most faces have three or four corners, so
    # this alone does not identify them, but it cuts the search and makes a
    # mismatched count an obvious failure rather than a silent wrong pairing.
    buckets = {}
    for eid, corners in parsed.items():
        n, centre = _shape_key(corners)
        buckets.setdefault(n, []).append((eid, norm(centre, t_lo, t_span)))

    out = {}
    used = set()
    leftovers = []
    for i, corners in ours:
        if not corners:
            continue
        n, centre = _shape_key(corners)
        here = norm(centre, o_lo, o_span)
        best = None
        for eid, there in buckets.get(n, ()):
            if eid in used:
                continue
            d = sum((here[k] - there[k]) ** 2 for k in range(3))
            if best is None or d < best[0]:
                best = (d, eid)
        # A normalised distance of 1e-4 is a tenth of a millimetre on a
        # 200 mm car. Anything further apart is not the same face on this
        # pass, and pairing it anyway would put a boundary condition
        # somewhere the user never clicked.
        if best is None or best[0] > 1e-8:
            leftovers.append((i, here))
            continue
        used.add(best[1])
        out[i] = best[1]

    # A second pass over whatever is left, ignoring the corner count.
    #
    # A face with no entity id cannot carry a boundary condition at all: the
    # worker resolves every assignment through this map, and one it cannot
    # resolve fails the run. Dropping such a face used to be silent, and on the
    # first real car it dropped exactly one - the symmetry plane, whose corner
    # count differs between OCC's face and the exported ADVANCED_FACE because
    # the car's outline is cut out of it.
    #
    # So the leftovers are paired to the entities nobody claimed, nearest
    # first, and each pairing is logged. It is a guess, but it is a guess
    # between a handful of candidates by position, and the alternative is a
    # face with no physics on it.
    if leftovers:
        spare = [(eid, norm(_shape_key(c)[1], t_lo, t_span))
                 for eid, c in parsed.items() if eid not in used]
        pairs = sorted(
            ((sum((h[k] - there[k]) ** 2 for k in range(3)), i, eid)
             for i, h in leftovers for eid, there in spare),
            key=lambda x: x[0])
        taken_faces = set()
        for d, i, eid in pairs:
            if i in taken_faces or eid in used:
                continue
            taken_faces.add(i)
            used.add(eid)
            out[i] = eid
            log.info("    face %d paired to entity %d on the second pass (%g away)",
                     i, eid, d ** 0.5)

    missed = len(ours) - len(out)
    log.info("step ids: matched %d of %d faces (%d on the second pass, %d "
             "unmatched, %d entities)",
             len(out), len(ours), len(leftovers) - missed, missed, len(parsed))
    return out


def read_step_with_ids(path):
    """Import a STEP with STEPControl_Reader rather than through CadQuery.

    Same import, but the reader is kept rather than discarded, which is what
    lets a failure be reported as "that STEP file could not be read" instead
    of an OCC exception. The entity ids are not taken from here: see
    match_step_ids for why they come from the file this service writes.
    """
    reader = STEPControl_Reader()
    if reader.ReadFile(path) != IFSelect_ReturnStatus.IFSelect_RetDone:
        raise ValueError("that STEP file could not be read")
    reader.TransferRoots()
    if reader.NbShapes() < 1:
        raise ValueError("that STEP file contains no shapes")
    from cadquery.occ_impl.shapes import Shape
    shape = Shape.cast(reader.OneShape())

    # CadQuery's own traversal, not a raw TopExp_Explorer. /inspect reads its
    # faces with imported.faces().vals(), and the two do not have to agree on
    # order: one walks the shape, the other builds a deduplicated map. Keying
    # this by a different order than the consumer uses is a mapping that looks
    # right, produces no error, and puts the inlet on the underside of the car.
    return cq.Workplane(obj=shape)


def read_any(path, fmt):
    if fmt == "STEP":
        return read_step_with_ids(path)
    if fmt == "IGES":
        return read_iges(path)
    if fmt == "STL":
        return read_stl(path)
    raise ValueError("unsupported format: %s" % fmt)


def write_step(shape, path):
    """Export as STEP, which is the only thing the worker ever uploads.

    Written flat rather than as an assembly, and that is not a style
    choice. OCC's default keeps each solid's geometry in its own component
    coordinates with a placement transform above it, so the numbers in the
    file are not the numbers in the shape. Everything that reads the file
    back and expects to recognise the model then fails quietly: the face id
    matching found no face within a quarter of the car's length of where it
    should be, because it was comparing global coordinates against local
    ones. Flat bakes the placements into the points.
    """
    Interface_Static.SetIVal_s("write.step.assembly", 0)
    writer = STEPControl_Writer()
    writer.Transfer(shape.wrapped, STEPControl_StepModelType.STEPControl_AsIs)
    if writer.Write(path) != IFSelect_ReturnStatus.IFSelect_RetDone:
        raise ValueError("could not write the STEP export")
    return path


def solid_summary(solids, scale):
    """Volume and bounding box per solid, for solids.json and the parts list."""
    out = []
    for i, solid in enumerate(solids):
        props = GProp_GProps()
        try:
            BRepGProp.VolumeProperties_s(solid.wrapped, props)
            volume = props.Mass() * scale ** 3
        except Exception:
            volume = 0.0
        try:
            bb = exact_bbox(solid)
            box = {k: [c * scale for c in v] for k, v in bb.items()}
        except Exception:
            box = None
        out.append({"id": i, "name": "Solid %d" % (i + 1),
                    "volume_m3": round(float(volume), 12), "bbox": box})
    return out


def ensure_meshed(shape):
    """Triangulate once, and let everything else ride on it.

    This is a performance fix with a large number attached. An exact bounding
    box over a car full of B-splines takes eight and a half seconds when the
    shape has never been triangulated, because OCC has to solve for the extreme
    points of every surface. Run it after triangulation and the same call takes
    ten milliseconds, because it walks the triangles instead. The mesh costs
    half a second and is needed anyway, for the preview and for the frontal
    area, so meshing first makes the box effectively free.

    On the 11 MB car this was tested against, that is 8.5 seconds off /inspect
    on its own, and /inspect ran twice as slowly again on Cloud Run.
    """
    key = shape.wrapped.HashCode(0x7FFFFFFF) if hasattr(shape.wrapped, "HashCode") else id(shape.wrapped)
    if key in _MESHED:
        return shape
    BRepMesh_IncrementalMesh(shape.wrapped, deflection_for(shape), False,
                             ANGULAR_DEFLECTION, True)
    _MESHED.add(key)
    return shape


def deflection_for(shape):
    """How finely to triangulate this particular shape.

    Scaled to the model so the triangle count is roughly constant whatever
    units or size the car was drawn in, and never coarser than the old fixed
    value on a small model.
    """
    try:
        b = Bnd_Box()
        BRepBndLib.Add_s(shape.wrapped, b)
        x0, y0, z0, x1, y1, z1 = b.Get()
        diag = math.sqrt((x1 - x0) ** 2 + (y1 - y0) ** 2 + (z1 - z0) ** 2)
    except Exception:
        return LINEAR_DEFLECTION
    return max(LINEAR_DEFLECTION, diag * DEFLECTION_FRACTION)


def exact_bbox(shape):
    """Tight bounding box of a solid, as {min, max, size}.

    Shape.BoundingBox() is not optimal on every cadquery release. On 2.5.2 it
    reads about 0.1% large once a shape has been transformed, which showed up as
    a scaled part reporting 0.40077 m instead of 0.4. AddOptimal is exact and
    behaves the same on every version.
    """
    box = Bnd_Box()
    BRepBndLib.AddOptimal_s(shape.wrapped, box)
    x0, y0, z0, x1, y1, z1 = box.Get()
    return {"min": [x0, y0, z0], "max": [x1, y1, z1],
            "size": [x1 - x0, y1 - y0, z1 - z0]}


# A car this service will accept, in metres, along its longest side. STEM
# Racing cars are 170 to 210 mm; the window is wider so a mounting block or a
# generous model still passes, and narrow enough that only one unit can be
# right.
CAR_MIN_M, CAR_MAX_M = 0.10, 0.60
UNITS = (("m", 1.0), ("cm", 0.01), ("mm", 0.001),
         ("in", 0.0254), ("ft", 0.3048), ("yd", 0.9144))

# Only the metric three are ever guessed. A model 8 units long is 8 inches
# and also 8 feet, and both are a plausible object, so an imperial file has
# to say what it is rather than have it inferred wrongly in silence.
GUESSABLE = ("m", "cm", "mm")


def detect_scale(bbox, stated=None):
    """How many metres one model unit is.

    A STEP file carries its unit in its own header and CadQuery honours it, so
    a model arrives in millimetres, centimetres or metres depending on what
    wrote it. Everything downstream is in metres: the domain offsets the user
    types, the radius_m and cx_m columns the worker reads, and the velocities
    the solver applies. Getting it wrong scales Reynolds by a thousand and the
    run is quietly meaningless.

    Rather than testing ranges in order, which lets an early range swallow a
    value a later one would have claimed, every unit is tried and only those
    that put the car in a plausible size are kept. A real car matches exactly
    one: 219.88 units is 0.22 m as millimetres and 2.2 m as centimetres, and
    only the first is a car. Ambiguity is reported rather than guessed.
    """
    longest = max(bbox["size"])
    if longest <= 0:
        raise ValueError("the model has no size in any direction")

    if stated:
        for name, scale in UNITS:
            if name == stated:
                return scale, name
        raise ValueError(
            "unit must be one of " + ", ".join(n for n, _ in UNITS)
            + ", not '%s'" % stated)

    fits = [(n, s) for n, s in UNITS
            if n in GUESSABLE and CAR_MIN_M <= longest * s <= CAR_MAX_M]
    if len(fits) == 1:
        return fits[0][1], fits[0][0]
    if not fits:
        raise ValueError(
            f"could not tell what unit this model is in. It is {longest:g} units "
            f"along its longest side, which is no car at any scale: that is "
            f"{longest:g} m, {longest * 0.01:g} m or {longest * 0.001:g} m, and a "
            f"car is between {CAR_MIN_M} and {CAR_MAX_M} m. Send `unit` to say "
            "which it is.")
    raise ValueError(
        "could not tell what unit this model is in: "
        + " and ".join(f"{n} gives {longest * s:g} m" for n, s in fits)
        + ", both of which could be a car. Send `unit` to say which it is.")


def mesh_face_stats(verts, tris, ranges, scale):
    """Area and centroid of every face, straight off the triangles.

    Face.Area() and Face.Center() integrate over the real surface, which is
    exact and costs about three and a half seconds each across 2219 faces.
    Neither number is used as a measurement: the area drives "select faces the
    same size as this one" and the centroid places a wheel. Both are
    comparisons between faces of the same model, meshed the same way, so a
    consistent approximation serves them exactly as well as an exact one, and
    the triangles are already in memory.

    The frontal area, which IS a measurement, does not come from here. It is
    rasterised from the silhouette, because a sum of face areas would count
    every hidden surface.
    """
    P = numpy.asarray(verts, dtype=float)
    T = numpy.asarray(tris, dtype=numpy.int64)
    if len(T) == 0:
        return [(0.0, (0.0, 0.0, 0.0))] * len(ranges)
    a, b, c = P[T[:, 0]], P[T[:, 1]], P[T[:, 2]]
    tri_area = 0.5 * numpy.linalg.norm(numpy.cross(b - a, c - a), axis=1)
    tri_mid = (a + b + c) / 3.0

    # Segmented sums in two numpy calls rather than a slice per face. The
    # loop version was six seconds on a 2219 face car, which is the same
    # lesson as the rasteriser: the work is trivial, the interpreter round
    # trips are not.
    starts = numpy.array([r[0] for r in ranges], dtype=numpy.int64)
    counts = numpy.array([r[1] for r in ranges], dtype=numpy.int64)
    live = counts > 0
    areas = numpy.zeros(len(ranges), dtype=float)
    mids = numpy.zeros((len(ranges), 3), dtype=float)
    if live.any():
        at = starts[live]
        areas[live] = numpy.add.reduceat(tri_area, at)
        weighted = numpy.add.reduceat(tri_mid * tri_area[:, None], at)
        # reduceat runs each segment to the start of the next, which is what
        # is wanted here because the ranges are contiguous and in face order.
        safe = areas[live].copy()
        safe[safe <= 0] = 1.0
        mids[live] = weighted / safe[:, None]

    return [(float(areas[i]) * scale * scale,
             (float(mids[i][0]) * scale, float(mids[i][1]) * scale, float(mids[i][2]) * scale))
            for i in range(len(ranges))]


def face_boxes(verts, vranges, scale):
    """The bounding box of every face, from the vertices already in memory.

    The viewer needs one per face to frame a selection and to place a label
    without walking the triangles again. Each face owns a contiguous run of
    vertices, because to_glb_by_face writes them face by face and shares none,
    so a segmented min and max answer the whole model in two numpy calls.
    """
    P = numpy.asarray(verts, dtype=float)
    starts = numpy.array([r[0] for r in vranges], dtype=numpy.int64)
    counts = numpy.array([r[1] for r in vranges], dtype=numpy.int64)
    live = counts > 0
    out = [None] * len(vranges)
    if not live.any() or len(P) == 0:
        return out
    at = starts[live]
    lo = numpy.minimum.reduceat(P, at) * scale
    hi = numpy.maximum.reduceat(P, at) * scale
    for k, i in enumerate(numpy.nonzero(live)[0]):
        out[int(i)] = {"min": [round(float(v), 6) for v in lo[k]],
                       "max": [round(float(v), 6) for v in hi[k]]}
    return out


# A face this small is not a feature, it is debris.
#
# 0.25 mm2, a half-millimetre square. Measured against a real car: everything
# the team actually shaped came in far above it, and everything below was
# fragments of one shattered patch of bodywork.
SLIVER_AREA_M2 = 0.25e-6


def sliver_report(survey):
    """How much of this model is fragments, and where they are.

    Worth its own answer because of what it costs to find out any other way.
    A customer car arrived with 342 of its 640 faces under half a millimetre
    square, 286 of them inside one 20 mm band of the bodywork. SimScale meshed
    for ten minutes and then refused - "the mesh element size is too close to
    the cad tolerance" - naming one entity. Raising the tolerance that is meant
    to swallow such things, from 0.5 mm to 2 mm, simply moved the complaint to
    the next fragment half a millimetre away. There were 92 of them within
    5 mm of the first.

    None of that is visible in the Workbench, and every attempt to find it out
    costs a mesh. It is all in the face survey that has already been done.
    """
    areas = [(f.get("area_m2") or 0.0, f.get("cx_m") or 0.0, f.get("index"))
             for f in survey]
    tiny = [(a, x, i) for a, x, i in areas if 0 < a < SLIVER_AREA_M2]
    if not tiny or not areas:
        return {"count": 0, "of": len(areas), "faces": []}

    # Where along the car they sit, in 20 mm bands, so a person can be sent to
    # the right part of the model rather than told the whole thing is bad.
    band = {}
    for _, x, _i in tiny:
        k = math.floor(x / 0.02) * 0.02
        band[k] = band.get(k, 0) + 1
    worst = max(band.items(), key=lambda kv: kv[1])
    return {
        "count": len(tiny),
        "of": len(areas),
        "threshold_m2": SLIVER_AREA_M2,
        "worst_band_m": [round(worst[0], 4), round(worst[0] + 0.02, 4)],
        "worst_band_count": worst[1],
        "smallest_m2": min(a for a, _x, _i in tiny),
        # Which ones, so the mesher can be told to leave them alone. SimScale's
        # own second suggestion for the error they cause is to coarsen the mesh
        # around those entities, and it cannot be told that without the list.
        "faces": sorted(i for _a, _x, i in tiny if i is not None),
    }


def survey_faces(faces, scale, stats=None):
    """Everything the rest of the service wants to know about each face, once.

    The surface adaptor was being built four separate times per face: by
    cylinder_of, by describe_face, by find_wheels and by car_axis. On a car
    with 2219 faces that is nearly nine thousand adaptors to answer questions
    that one pass can answer together.
    """
    out = []
    for i, face in enumerate(faces):
        ad = BRepAdaptor_Surface(face.wrapped)
        kind = ad.GetType()
        if stats is not None:
            area, (mx, my, mz) = stats[i]
        else:
            c = face.Center()
            area = face.Area() * scale * scale
            mx, my, mz = c.x * scale, c.y * scale, c.z * scale
        info = {
            "index": i,
            "type": SURFACE_NAMES.get(kind, "other"),
            "area_m2": round(area, 9),
            "cx_m": round(mx, 6),
            "cy_m": round(my, 6),
            "cz_m": round(mz, 6),
        }
        # The outward normal at the middle of the face's parameter range.
        # Taken from the real surface rather than averaged over triangles,
        # because averaging a cylinder's triangle normals points at nothing.
        try:
            u = (ad.FirstUParameter() + ad.LastUParameter()) / 2.0
            v = (ad.FirstVParameter() + ad.LastVParameter()) / 2.0
            props = BRepLProp_SLProps(ad, u, v, 1, 1e-7)
            if props.IsNormalDefined():
                n = props.Normal()
                sign = -1.0 if face.wrapped.Orientation() == \
                    TopAbs_Orientation.TopAbs_REVERSED else 1.0
                info["normal"] = [round(n.X() * sign, 6), round(n.Y() * sign, 6),
                                  round(n.Z() * sign, 6)]
        except Exception:
            pass
        if kind == GeomAbs_SurfaceType.GeomAbs_Cylinder:
            cyl = ad.Cylinder()
            ax = cyl.Axis().Direction()
            loc = cyl.Location()
            info["radius_m"] = round(cyl.Radius() * scale, 6)
            info["axis"] = [round(ax.X(), 6), round(ax.Y(), 6), round(ax.Z(), 6)]
            info["axis_x_m"] = round(loc.X() * scale, 6)
            info["axis_y_m"] = round(loc.Y() * scale, 6)
            info["axis_z_m"] = round(loc.Z() * scale, 6)
        out.append(info)
    return out


def plane_normal(face):
    """The unit normal if this face is planar, else None."""
    ad = BRepAdaptor_Surface(face.wrapped)
    if ad.GetType() != GeomAbs_SurfaceType.GeomAbs_Plane:
        return None
    d = ad.Plane().Axis().Direction()
    return (d.X(), d.Y(), d.Z())


def cylinder_of(face):
    """(radius, axis_xyz, location_xyz) if this face is cylindrical, else None."""
    ad = BRepAdaptor_Surface(face.wrapped)
    if ad.GetType() != GeomAbs_SurfaceType.GeomAbs_Cylinder:
        return None
    cyl = ad.Cylinder()
    ax = cyl.Axis().Direction()
    loc = cyl.Location()
    return (cyl.Radius(), (ax.X(), ax.Y(), ax.Z()), (loc.X(), loc.Y(), loc.Z()))


def car_axis(bbox, faces):
    """Which way the car is pointing, and how to turn it to face the wind.

    Everything downstream assumes one arrangement: the car lies along X, its
    axles run along Y, the ground is below in Z, and the wind blows in -X. The
    Fusion add-in could assume that because the user built the wind tunnel in
    Fusion, where the car was already placed. A STEP file uploaded here has
    whatever orientation it was drawn in.

    A real competition car tested against this one is modelled along Y with its
    axles along X, so the tunnel came out built across the 65 mm width instead
    of along the 242 mm length, the wheels were not found, and the "frontal
    area" measured was the side profile. It completed and meant nothing, which
    is the failure mode this whole service is supposed to prevent.

    The long axis of the car is the direction of travel, and the axles are the
    cylinders across it. That is enough to tell the two apart without asking.
    """
    size = bbox["size"]
    long_axis = max(range(3), key=lambda i: size[i])

    # Which axis the wheel-sized cylinders turn about, as a cross-check and as
    # the tie-breaker when a car is nearly as wide as it is long.
    axle_votes = [0, 0, 0]
    for f in faces:
        ax = f.get("axis") if isinstance(f, dict) else None
        if ax is None:
            cyl = cylinder_of(f)
            if not cyl:
                continue
            ax = cyl[1]
        for i in range(3):
            if abs(abs(ax[i]) - 1.0) < 0.05:
                axle_votes[i] += 1
    axle_axis = max(range(3), key=lambda i: axle_votes[i]) if any(axle_votes) else 1

    return {"long_axis": long_axis, "axle_axis": axle_axis, "axle_votes": axle_votes}


def orient_to_wind(shape, bbox, faces):
    """Turn the car so it lies along X with its axles along Y.

    Only a quarter turn about Z is applied, which is the case that actually
    occurs: CAD packages agree about which way is up and disagree about which
    horizontal axis is forward. A car lying along Z would be a car standing on
    its nose, and rotating that automatically would be guessing.

    Returns the shape and how far it was turned, so the caller can say so
    rather than silently moving the user's geometry.
    """
    info = car_axis(bbox, faces)
    if info["long_axis"] != 1:
        return shape, 0.0, info                      # already along X, or on Z

    turn = gp_Trsf()
    turn.SetRotation(gp_Ax1(gp_Pnt(0, 0, 0), gp_Dir(0, 0, 1)), -math.pi / 2)
    moved = BRepBuilderAPI_Transform(shape.wrapped, turn, True)
    moved.Build()
    if not moved.IsDone():
        log.warning("could not rotate the car into the wind, using it as it is")
        return shape, 0.0, info
    from cadquery.occ_impl.shapes import Shape
    return Shape.cast(moved.Shape()), -90.0, info


def wheel_radii(body, default=0.014125):
    """Every wheel size this car is allowed to have.

    One number was wrong for real cars. A STEM Racing car often runs a smaller
    front wheel than rear, and a single radius with an eight per cent tolerance
    cannot cover 14.1 mm and 17 mm at once: widen the tolerance enough to catch
    both and it starts calling the axle a wheel.

    Takes `wheel_radii_m` when the caller sends a list, and falls back to the
    single `wheel_radius_m` that every older caller sends.
    """
    raw = body.get("wheel_radii_m")
    out = []
    if isinstance(raw, list):
        for one in raw:
            try:
                v = float(one)
            except (TypeError, ValueError):
                continue
            if 0.001 <= v <= 1.0:
                out.append(v)
    if not out:
        try:
            v = float(body.get("wheel_radius_m", default))
        except (TypeError, ValueError):
            v = default
        out = [v if 0.001 <= v <= 1.0 else default]
    # Two radii a hair apart are one radius, and each extra one is another
    # chance to call something that is not a wheel a wheel.
    kept = []
    for v in sorted(out):
        if not kept or abs(v - kept[-1]) > 1e-6:
            kept.append(v)
    return kept


# ── wheels ─────────────────────────────────────────────────────────────────────
# A wheel is now chosen by name, so the name has to mean the same wheel twice.
#
# Which wheels spin is the user's to set, and what they tick in the Workbench
# is matched against the wheels found when the tunnel is built - a second pass,
# over a different face list, possibly with a different search radius typed in
# between. An ordinal does not survive that: change the radius so one wheel
# drops out and every later "Wheel_3" becomes a different wheel.
#
# A position does survive it. Front left is front left in both passes, and it
# is also what a person would call it.
#
# Front is max x: build_domain puts the inlet there and the wind blows from it,
# so the end at max x is the end that meets the air. Left is +y, which is what
# x-forward and z-up make it in a right-handed frame.
FORE_NAMES = ["Front", "Rear"]
SIDE_NAMES = ["left", "right"]


def name_wheels(wheels):
    """Name each wheel for where it sits, and return them front-left first."""
    axles = []
    for w in sorted(wheels, key=lambda one: -one["cx_m"]):
        near = max(w["radius_m"], 1e-6)
        hit = next((a for a in axles if abs(a[0]["cx_m"] - w["cx_m"]) < near), None)
        if hit is None:
            axles.append([w])
        else:
            hit.append(w)

    out = []
    for ai, axle in enumerate(axles):
        fore = (FORE_NAMES[ai] if len(axles) == 2
                else "" if len(axles) == 1 else "Axle %d" % (ai + 1))
        axle.sort(key=lambda one: -one["cy_m"])         # +y is the left side
        for si, w in enumerate(axle):
            side = (SIDE_NAMES[si] if len(axle) == 2
                    else "" if len(axle) == 1 else str(si + 1))
            parts = [p for p in (fore, side) if p]
            w["name"] = " ".join(parts).capitalize() if parts else "Wheel"
            out.append(w)
    return out


def split_axle(faces, radius):
    """One entry per wheel on an axle, from the faces that share its axis.

    Two wheels on one axle are the same cylinder in x and z, tens of
    millimetres apart along y, and the grouping used to be on x and z alone: a
    four-wheel car came back as two wheels. Harmless to the solver - both
    wheels of an axle turn about one line at one speed, so a single boundary
    condition covers them - and wrong on every screen that shows it. It also
    makes "spin the front wheels only" impossible to ask for.

    Splitting on the cylinder origin's own y is not an option: that origin can
    sit anywhere along its axis, which is the failure find_wheels documents
    itself as avoiding. So the split is on where the face's surface actually
    is - its extent along y - and two faces are the same wheel when their
    extents touch or nearly touch. A wheel's own faces overlap; the gap to the
    wheel at the other end of the axle is most of the car's width.
    """
    gap = radius * 0.5
    clusters = []
    for f in sorted(faces, key=lambda one: one["y_lo"]):
        if clusters and f["y_lo"] - clusters[-1]["y_hi"] <= gap:
            clusters[-1]["y_hi"] = max(clusters[-1]["y_hi"], f["y_hi"])
            clusters[-1]["faces"].append(f)
        else:
            clusters.append({"y_lo": f["y_lo"], "y_hi": f["y_hi"], "faces": [f]})
    return clusters


def wheels_from_axles(found):
    """Axles keyed by (x, z), each a list of faces, into named wheels.

    y_lo_m and y_hi_m are how far a wheel reaches along its own axle. They are
    what group_wheel_faces uses to decide which of two coaxial wheels a face
    belongs to, since x and z cannot tell those two apart.
    """
    out = []
    for (x, z), faces in sorted(found.items()):
        for c in split_axle(faces, max(f["radius"] for f in faces)):
            out.append({
                "radius_m": round(max(f["radius"] for f in c["faces"]), 6),
                "cx_m": round(x, 6),
                "cy_m": round((c["y_lo"] + c["y_hi"]) / 2.0, 6),
                "cz_m": round(z, 6),
                "y_lo_m": round(c["y_lo"], 6),
                "y_hi_m": round(c["y_hi"], 6),
                "face_indices": sorted(f["index"] for f in c["faces"]),
                "source": "auto",
            })
    return name_wheels(out)


def find_wheels_from(survey, radii, tolerance):
    """find_wheels, reading the one survey pass instead of re-adapting."""
    found = {}
    for f in survey:
        if f["type"] != "cylinder" or "axis" not in f:
            continue
        if abs(abs(f["axis"][1]) - 1.0) > 0.05:
            continue
        r_m = f["radius_m"]
        if not any(r * (1 - tolerance) <= r_m <= r * (1 + tolerance) for r in radii):
            continue
        x, z = f["axis_x_m"], f["axis_z_m"]
        near = r_m * 0.5
        key = next((k for k in found
                    if abs(k[0] - x) < near and abs(k[1] - z) < near), None)
        if key is None:
            key = (x, z)
            found[key] = []
        box = f.get("bbox")
        if box:
            y_lo, y_hi = float(box["min"][1]), float(box["max"][1])
        else:
            # No tessellated box for this face, so the only y to hand is the
            # cylinder origin - which can sit anywhere along the axis. Such a
            # face may fail to split from its partner at the other end of the
            # axle, which is exactly the behaviour this pass used to have and
            # is better than dropping the wheel.
            y_lo = y_hi = float(f.get("cy_m", f.get("axis_y_m", 0.0)))
        found[key].append({"index": f["index"], "radius": r_m,
                           "y_lo": y_lo, "y_hi": y_hi})
    return wheels_from_axles(found)


def find_wheels(faces, radii, tolerance, scale):
    """Wheels, as the add-in finds them: cylindrical faces about Y.

    A wheel is a cylindrical face whose axis lies within 0.05 of the Y axis and
    whose radius is within `tolerance` of the radius the user gave
    (TurboFlow_CFD.py:282-304).

    Grouping differs from the add-in in two ways, both deliberate. The add-in
    keys a wheel on its cylinder origin rounded to 1 mm in all three axes, but
    the origin of a cylindrical face can sit anywhere along its own axis, so
    the two faces of one wheel can disagree in Y and become two wheels. And
    since the axis is Y, x and z identify an *axle* rather than a wheel: the
    two wheels on it are separated along y, which is what split_axle does,
    using the faces' real extent rather than that same unreliable origin.
    """
    found = {}
    for fi, face in enumerate(faces):
        cyl = cylinder_of(face)
        if not cyl:
            continue
        r, ax, loc = cyl
        if abs(abs(ax[1]) - 1.0) > 0.05:
            continue
        r_m = r * scale
        if not any(rr * (1 - tolerance) <= r_m <= rr * (1 + tolerance) for rr in radii):
            continue
        # Group by proximity rather than by a rounded key. Two faces of one
        # wheel can have axis origins a millimetre or two apart, which a fixed
        # rounding splits into two wheels, while real axles on these cars are
        # tens of millimetres apart and never merge at this threshold.
        x, z = loc[0] * scale, loc[2] * scale
        near = r_m * 0.5
        key = next((k for k in found
                    if abs(k[0] - x) < near and abs(k[1] - z) < near), None)
        if key is None:
            key = (x, z)
            found[key] = []
        bb = face.BoundingBox()
        # Which faces these are, so the viewer can light up what it detected and
        # the user can see whether to trust it before paying for a run.
        found[key].append({"index": fi, "radius": r_m,
                           "y_lo": bb.ymin * scale, "y_hi": bb.ymax * scale})
    return wheels_from_axles(found)


def cut_parallel(shape, tools):
    """Subtract every body from the shape, in one boolean, using every core.

    OCC runs a boolean on one thread and compares every face of one argument
    against every face of the other unless told otherwise. Both defaults are
    wrong for this job: the container has four cores doing nothing, and a car
    against a wind tunnel is mostly pairs of faces nowhere near each other,
    which an oriented bounding box rejects immediately.

    Measured on the test car, which is 9 bodies of B-splines inside a box:
    22.7 s through cadquery's own cut, which is 80% of everything /prepare
    does. Both switches are one line each and neither changes the result.

    Returns None if OCC did not finish, so the caller can fall back.
    """
    args = TopTools_ListOfShape()
    args.Append(shape.wrapped)
    tool_list = TopTools_ListOfShape()
    for one in tools:
        tool_list.Append(one.wrapped)

    op = BRepAlgoAPI_Cut()
    op.SetArguments(args)
    op.SetTools(tool_list)
    op.SetRunParallel(True)
    op.SetUseOBB(True)
    op.Build()
    if not op.IsDone():
        return None
    from cadquery.occ_impl.shapes import Shape
    return Shape.cast(op.Shape())


# BRepCheck's statuses as words, so a failure can be described rather than
# numbered.
CHECK_NAMES = {getattr(BRepCheck_Status, n): n[len("BRepCheck_"):]
               for n in dir(BRepCheck_Status) if n.startswith("BRepCheck_")}


def faulty_faces(shape, limit=6):
    """The faces OCC will not accept, and where they are.

    "Invalid solid" on its own sends a person back to a two thousand face model
    with nowhere to start looking. On the car this was written for, 2 faces out
    of 1,161 are wrong and both sit inside one box three millimetres across,
    which is a half minute's work in Fusion once you know which corner of the
    car to open.
    """
    from cadquery.occ_impl.shapes import Shape
    analyzer = BRepCheck_Analyzer(shape.wrapped)
    out = []
    exp = TopExp_Explorer(shape.wrapped, TopAbs_FACE)
    while exp.More():
        face = TopoDS.Face_s(exp.Current())
        problems = set()
        res = analyzer.Result(face)
        if res is not None:
            problems |= {CHECK_NAMES.get(st, "") for st in res.Status()}
        # The wire is where a self-intersection is recorded, not the face.
        wires = TopExp_Explorer(face, TopAbs_WIRE)
        while wires.More():
            res = analyzer.Result(wires.Current())
            if res is not None:
                problems |= {CHECK_NAMES.get(st, "") for st in res.Status()}
            wires.Next()
        problems -= {"NoError", ""}
        if problems:
            box = Shape.cast(face).BoundingBox()
            out.append({
                "centre": [round((box.xmin + box.xmax) / 2, 3),
                           round((box.ymin + box.ymax) / 2, 3),
                           round((box.zmin + box.zmax) / 2, 3)],
                "problems": sorted(problems),
            })
            if len(out) >= limit:
                break
        exp.Next()
    return out


def describe_spot(point, lo, hi, unit="mm"):
    """Where a point sits on the car, in words that survive a rotation.

    Not coordinates. /prepare works on the copy of the car that has already
    been turned to face the wind, and /inspect may have turned it, so numbers
    read off it are not the numbers in the file the user opens - the first
    version of this message sent someone to x = -126 on a car that is 33 mm
    wide. Distance back from the nose, out from the centreline and up from the
    ground mean the same thing whichever way round the car is drawn.

    The nose is the +x end: the air comes from the inlet at high x and flows
    toward -x, which is what FLOW_DIRECTION says on the other side.
    """
    x, y, z = point
    back = hi[0] - x
    side = y - (lo[1] + hi[1]) / 2.0
    up = z - lo[2]
    hand = "left" if side < 0 else "right"
    return ("%.0f %s back from the nose, %.0f %s %s of the centreline, "
            "%.0f %s up from the ground"
            % (back, unit, abs(side), unit, hand, up, unit))


def expected_removal(car_volume, symmetry, kind):
    """How much volume a correct cut takes out of the tunnel.

    A half tunnel stops at the symmetry plane. A whole car standing in it has
    half of itself past the plane, so a good cut removes about half the car. A
    car drawn as a half model has nothing past the plane - it was modelled
    stopping at its own centreline - so a good cut removes all of it.

    This used to be half in both cases, and cut_car_out refuses anything over
    1.5 times the estimate. So every half-model car was refused: car-17-3's cut
    removed 106,357 mm3, 97% of the car, against a ceiling of 82,047, and
    failed on all four symmetry positions with "Could not cut the car out".
    """
    if symmetry and kind != "half":
        return car_volume * 0.5
    return car_volume


def cut_car_out(tunnel, car, solids, expected):
    """The flow region: the tunnel with the car taken out of it.

    Measured on a real car that this could not do at all. It has 29 bodies and
    2,219 faces, and two of its bodies are not valid solids: four faces carry
    self-intersecting wires and come back with negative area, which is a face
    turned inside out. No repair fixed them. ShapeFix at four precisions, a
    re-sew at four tolerances, flipping the reversed faces, dropping them, and
    a fuzzy boolean at four values all left the solids exactly as invalid as
    they started.

    What does work is the shape of the request. Handing OCC 29 separate tools
    made it remove 13% of the car; handing it the same geometry as one
    compound removed 98% and took 7 seconds instead of 16. One tool means one
    general fuse rather than an intersection graph over 29 arguments, and it
    is the arguments' interactions with each other that the bad faces poison.

    The per-body path is still here because a compound is not always the
    winner, and it is now guarded by an invariant rather than by hope: cutting
    with a tool can remove at most the volume of that tool. Without that,
    cutting by a 246 mm3 bracket removed 262,870,338 mm3 - the whole wind
    tunnel - and the old code accepted it, because all it asked was whether
    the result had positive volume. It also cuts the sound bodies first: once
    a cut has involved an invalid body every later boolean on that result
    blows up, so the damage has to come last where nothing follows it.

    Returns (region, note) where note describes anything it could not remove.
    """
    best, best_removed, how = None, -1.0, ""
    start_volume = tunnel.Volume()

    def sane(shape):
        """Removed a believable amount: not nothing, not the whole domain."""
        if shape is None:
            return None
        try:
            left = shape.Volume()
        except Exception:
            return None
        removed = start_volume - left
        if left <= 0 or removed <= 0:
            return None
        # 1.5 rather than 1.0 because "expected" is an estimate: a half tunnel
        # is split at the symmetry plane and a car is not perfectly symmetric,
        # so a correct cut lands a few per cent either side of it.
        if removed > expected * 1.5:
            return None
        return removed

    # One tool, which is the whole car. Fastest, and on a car with bad faces
    # it is the only one that works.
    once = cut_parallel(tunnel, [car])
    removed = sane(once)
    if removed is not None:
        best, best_removed, how = once, removed, "one pass, whole car"
        if removed >= expected * 0.8:
            log.info("cut: %s, removed %.1f mm3 of about %.1f expected",
                     how, removed, expected)
            return best, ""

    # The same car as one solid. Cars are drawn as overlapping bodies - a wing
    # pushed into the nose, an axle through a wheel - and the overlap is what
    # the boolean trips on. car-17-3's nine bodies overlap by 2,005 mm3. Cut as a
    # compound in a half tunnel it removed the whole tunnel; body at a time it
    # cut everything but the front wing, which "removed" 1,427 mm3 for an
    # 818 mm3 body and was refused, so the run would have had no front wing.
    # Fused first, the same cut removes 100% of the car, cleanly, at every safe
    # symmetry position. Only reached when the fast cut above has failed: a
    # fuse costs seconds on a small car and more on a big assembly.
    fused = fuse_bodies(solids)
    if fused is not None:
        whole = cut_parallel(tunnel, [fused])
        removed = sane(whole)
        if removed is not None and removed >= expected * 0.8:
            log.info("cut: fused car, removed %.1f mm3 of about %.1f expected",
                     removed, expected)
            return whole, ""
        if removed is not None and removed > best_removed:
            best, best_removed, how = whole, removed, "fused car"

    # Body at a time. Sound ones first: see above.
    ordered = sorted(
        solids,
        key=lambda one: (not is_valid_solid(one), volume_of(one)))
    flow, missed = tunnel, []
    for one in ordered:
        vol = volume_of(one)
        if vol <= 0:
            continue
        before = flow.Volume()
        try:
            nxt = cut_parallel(flow, [one])
        except Exception as e:
            log.warning("cut of one body failed, skipped: %s", e)
            missed.append(vol)
            continue
        if nxt is None:
            missed.append(vol)
            continue
        try:
            took = before - nxt.Volume()
        except Exception:
            missed.append(vol)
            continue
        # The invariant. A cut takes away the part of the tool that was inside
        # the shape, so it cannot take away more than the tool.
        if took > vol * 1.01 + 1e-6:
            log.info("refused a cut that removed %.1f mm3 for a %.1f mm3 body", took, vol)
            missed.append(vol)
            continue
        if took <= 1e-9:
            missed.append(vol)
            continue
        flow = nxt

    removed = sane(flow)
    if removed is not None and removed > best_removed:
        best, best_removed, how = flow, removed, "body at a time"

    if best is None:
        return None, ""

    note = ""
    if missed and how == "body at a time":
        note = ("%d part%s of the car could not be cut out of the tunnel"
                % (len(missed), "" if len(missed) == 1 else "s"))
    log.info("cut: %s, removed %.1f mm3 of about %.1f expected%s",
             how, best_removed, expected, "; " + note if note else "")
    return best, note


def fuse_bodies(solids):
    """All of a car's bodies as one solid, or None if the fuse fails."""
    if len(solids) < 2:
        return None
    try:
        fused = solids[0].fuse(*solids[1:])
        return fused if fused.Volume() > 0 else None
    except Exception as e:
        log.warning("fusing the car's bodies failed: %s", e)
        return None


def is_valid_solid(one):
    """Whether OCC considers this body a well-formed solid."""
    try:
        return bool(BRepCheck_Analyzer(one.wrapped).IsValid())
    except Exception:
        return False


def volume_of(one):
    try:
        return float(one.Volume())
    except Exception:
        return 0.0


def symmetry_plane(verts, tris, scale):
    """Where the car's own mirror plane is, in model units.

    build_domain used to assume y = 0, and said so: "a half model pins the +y
    wall to y = 0, which assumes the car itself is modelled as a half about
    y = 0". Nothing checked it. It happens to be true of the first car through
    this path and it is not true of a car drawn anywhere else in its sketch,
    and when it is false the plane slices through bodywork, throws away what is
    past it, and mirrors the rest - so the solver gets a car nobody designed,
    and converges on it, and reports a drag.

    Measured from the triangles, not from the bounding box. That is not a
    detail: exact_bbox is OCC's AddOptimal over the B-rep, and on a car made of
    B-splines it reports 6.1 mm of y that no triangle occupies. Reading the
    plane off that box put it 15 mm inside a car whose every solid stops dead
    at y = 0, and cut a third of the bodywork away. The mesh is also what
    actually gets cut and solved, so it is the thing to measure.

    A half model has a flat face in a plane of constant y at one end of itself,
    and a flank at the other end that is not flat. Both halves matter. A gently
    curved flank is flat to a tenth of a millimetre over a surprising part of
    its height - a third of the side profile at 100 mm radius - so "enough flat
    area at one end" on its own calls a whole car a half one. Comparing the two
    ends is what separates them, and on the real car it is not close: 42% of
    the side profile at the cut, 6% at the flank.

    Where both ends are equally and almost entirely flat, which is what a
    slab-sided car looks like, nothing here can tell a half from a whole and it
    says so instead of guessing.

    Returns (y, kind): "half" and the cut face, "centre" and the car's own
    centreline, or "ambiguous" and the centreline for the caller to warn about.
    """
    if len(tris) == 0:
        return 0.0, "centre"
    v = numpy.asarray(verts, dtype=float)
    t = numpy.asarray(tris, dtype=numpy.int64)
    if len(v) == 0:
        return 0.0, "centre"

    mesh_lo, mesh_hi = v.min(0), v.max(0)
    lo, hi = float(mesh_lo[1]), float(mesh_hi[1])
    centre = (lo + hi) / 2.0
    if hi <= lo:
        return centre, "centre"

    areas = numpy.linalg.norm(
        numpy.cross(v[t[:, 1]] - v[t[:, 0]], v[t[:, 2]] - v[t[:, 0]]), axis=1) / 2.0
    ys = v[:, 1][t]

    # How much surface lies within a tenth of a millimetre of each end plane.
    #
    # Not "how much of it is flat". Flatness per triangle is a property of the
    # mesh rather than of the car: the finer a curved flank is tessellated, the
    # more of it has three corners at the same y to within any tolerance, so
    # the same car scores differently depending only on how finely it was
    # triangulated. Two flanks of 100 and 130 mm radius came out 0.19 and 0.25
    # apart at one density and 0.6 and 0.75 at another. Distance to the plane
    # does not move: a cut face is all of it in the plane, and a flank of
    # radius R has a band sqrt(2 R d) wide near its apex and nothing else.
    tol = 1e-4 / scale
    profile = float((mesh_hi[0] - mesh_lo[0]) * (mesh_hi[2] - mesh_lo[2])) or 1.0

    shares = [
        float(areas[(numpy.abs(ys - edge) < tol).all(axis=1)].sum()) / profile
        for edge in (hi, lo)
    ]
    top_share, bottom_share = shares
    big, small = max(shares), min(shares)

    # Not enough flat area anywhere to be a cut face. A sponsor plate or a
    # mirror housing is a few per cent; a cut face is tens of per cent.
    if big < 0.15:
        return centre, "centre"
    # One end much flatter than the other is a cut face against a flank. Twice
    # is the margin, from the two cases that have to fall on opposite sides of
    # it: the real car measures 7x, and a half car whose remaining flank is a
    # gentle 100 mm radius - about the flattest bodywork gets - measures 2.7x,
    # while both flanks of a whole car measure 1.0x whatever their shape.
    if big > small * 2.0:
        return (float(hi) if top_share >= bottom_share else float(lo)), "half"
    # Both ends flat and similar. If they are only mildly flat, they are two
    # flanks and this is a whole car; if they are almost entirely flat, it is a
    # slab-sided car and could be either.
    return centre, ("ambiguous" if big > 0.5 else "centre")


def label_faces(meta, domain, wheels, symmetry):
    """Which wall of the tunnel each face is, by face index.

    The same decision classify_faces makes, made against the tessellated faces
    instead of against the text of the exported STEP. That matters because the
    STEP route has a join in it that can fail: entity numbers are recovered by
    matching corner clouds (match_step_ids), and a face it cannot pair has no
    index, so its label is dropped. On the first real car that happened to
    exactly one face - the symmetry plane - and the result was a setup with no
    symmetry boundary condition at all. SimScale gives an unassigned face its
    default, so the mirror plane would have been solved as a sticky wall down
    the centreline of the car, and the run would have finished and reported a
    drag.

    Here every face has an index by construction, so no label can go missing.
    The STEP entity ids are still needed - the worker resolves a face to a
    SimScale name through them - but they are no longer what decides physics.

    A wall is recognised by sitting in the plane of one of the six sides *and*
    spanning most of it. The span test is what keeps a flat piece of bodywork
    that happens to lie in the floor plane from being labelled as the road.
    """
    xs = (domain["outlet_x"], domain["inlet_x"])
    zs = (domain["ground_z"], domain["top_z"])
    ys = tuple(sorted((domain["side_y"], domain["symmetry_y"])))
    span = (xs[1] - xs[0], ys[1] - ys[0], zs[1] - zs[0])

    def covers(box, a, b):
        """Does this face cover most of the domain in the two axes across it?"""
        if not box:
            return False
        lo, hi = box["min"], box["max"]
        return ((hi[a] - lo[a]) > 0.5 * span[a]) and ((hi[b] - lo[b]) > 0.5 * span[b])

    def wheel_of(f):
        if f.get("type") != "cylinder" or "axis" not in f:
            return None
        if abs(abs(f["axis"][1]) - 1.0) > 0.05:
            return None
        for w in wheels:
            if (abs(f.get("axis_x_m", 1e9) - w["cx_m"]) < 0.01
                    and abs(f.get("axis_z_m", 1e9) - w["cz_m"]) < 0.01):
                return w
        return None

    out = {}
    for f in meta:
        i = f["index"]
        if wheel_of(f) is not None:
            out[i] = "rotating_wall"
            continue
        if f.get("type") != "plane":
            out[i] = "car_no_slip"
            continue
        cx, cy, cz = f["cx_m"], f["cy_m"], f["cz_m"]
        box = f.get("bbox")
        label = None
        if abs(cx - domain["inlet_x"]) < DOMAIN_TOL and covers(box, 1, 2):
            label = "inlet"
        elif abs(cx - domain["outlet_x"]) < DOMAIN_TOL and covers(box, 1, 2):
            label = "outlet"
        elif abs(cz - domain["top_z"]) < DOMAIN_TOL and covers(box, 0, 1):
            label = "top"
        elif abs(cz - domain["ground_z"]) < DOMAIN_TOL and covers(box, 0, 1):
            label = "ground"
        elif abs(cy - domain["side_y"]) < DOMAIN_TOL and covers(box, 0, 2):
            label = "side"
        elif abs(cy - domain["symmetry_y"]) < DOMAIN_TOL and covers(box, 0, 2):
            # Without a symmetry plane the far wall is just the other side.
            label = "symmetry" if symmetry else "side"
        out[i] = label or "car_no_slip"
    return out


def wheel_for_face(f, wheels):
    """Which wheel a rotating face belongs to, or None.

    Coaxial about y within 10 mm in x and z, which is the same test label_faces
    used to call it a wheel face at all - and then, among the wheels that pass
    it, the one whose own span along the axle is nearest. x and z name an axle,
    not a wheel, so without the second step every face on a four-wheel car
    lands on whichever of the two wheels was listed first.
    """
    fy = f.get("cy_m")
    best, best_gap = None, None
    for j, w in enumerate(wheels):
        if abs(f.get("axis_x_m", 1e9) - w["cx_m"]) >= 0.01:
            continue
        if abs(f.get("axis_z_m", 1e9) - w["cz_m"]) >= 0.01:
            continue
        if fy is None:
            return j
        lo = w.get("y_lo_m", w.get("cy_m", 0.0))
        hi = w.get("y_hi_m", w.get("cy_m", 0.0))
        gap = 0.0 if lo <= fy <= hi else min(abs(fy - lo), abs(fy - hi))
        if best_gap is None or gap < best_gap:
            best, best_gap = j, gap
    return best


def group_wheel_faces(meta, per_face, wheels):
    """Sort the labelled faces into wheels, carrying each wheel's own radius.

    The radius here is the one thing that must not be re-measured off the
    face, because omega is speed over radius and the solver spins the wall at
    whatever number this produces.

    What used to happen: every face labelled rotating_wall was keyed on its own
    cylinder origin rounded to a millimetre in x, y and z, and the group's
    radius was the largest radius among its own faces. Two things go wrong at
    once. The origin of a cylindrical face can sit anywhere along its own axis,
    so the inner and outer face of one wheel disagree in y and split into two
    wheels - the exact failure find_wheels documents itself as avoiding, undone
    here. And the axle and the hub are coaxial with the wheel, so they are
    labelled with it, but they are not wheels: on a real car a 1.4 mm axle pin
    came out as a wheel of radius 1.4 mm and would have been spun at ten times
    the right speed.

    So the group is the wheel the face belongs to - the one find_wheels already
    found, whose radius passed the tolerance check and which the user saw in
    the viewer before agreeing to it - and every coaxial face on it turns at
    that wheel's speed, which is what an axle welded to a wheel actually does.

    Returns (labels, tunnel_wheels) and sets meta[i]["label"] on the way.
    """
    labels, wheel_faces = {}, {}
    for i, label in sorted(per_face.items()):
        meta[i]["label"] = label
        if label != "rotating_wall":
            labels.setdefault(label, []).append(i)
            continue
        hit = wheel_for_face(meta[i], wheels)
        if hit is None:
            # Labelled as turning but belonging to no wheel anyone found. A
            # plain wall beats a wall spun at a speed nothing measured.
            meta[i]["label"] = "car_no_slip"
            labels.setdefault("car_no_slip", []).append(i)
            continue
        wheel_faces.setdefault(hit, []).append(i)

    tunnel_wheels = []
    for n, (j, faces) in enumerate(sorted(wheel_faces.items()), start=1):
        w = wheels[j]
        # A wheel with no usable radius cannot be spun - omega is speed over
        # radius - so it becomes a plain wall rather than a face with no
        # physics at all. Same demotion the labels CSV applies.
        if not (w.get("radius_m", 0) > 0):
            labels.setdefault("car_no_slip", []).extend(faces)
            for k in faces:
                meta[k]["label"] = "car_no_slip"
            continue
        tunnel_wheels.append({
            "name": w.get("name") or ("Wheel_%d" % n),
            "radius_m": round(w["radius_m"], 6),
            "cx_m": w["cx_m"], "cy_m": w["cy_m"], "cz_m": w["cz_m"],
            "y_lo_m": w.get("y_lo_m", w["cy_m"]),
            "y_hi_m": w.get("y_hi_m", w["cy_m"]),
            "face_indices": sorted(faces),
            "source": "labelled",
        })
    for key in labels:
        labels[key] = sorted(labels[key])
    return labels, tunnel_wheels


def build_domain(bbox_m, wheels, up, down, side, top, symmetry, symmetry_y=0.0,
                 nudge=None):
    """The wind tunnel, in metres, positioned around the car.

    Mirrors TurboFlow_CFD.py:306-333. Two details carried over deliberately:

    The inlet is at MAX x and the outlet at MIN x, because the solver drives the
    flow in the -x direction (`vel_func(-INLET_VELOCITY, 0, 0)`). A car has to be
    modelled nose-toward -x or the run finishes cleanly with the wake at the
    wrong end.

    The floor is set from the lowest wheel bottom, not from the body's own
    minimum. A car sitting on its wheels has its lowest bodywork above the
    contact patch, and taking the body minimum would put the road surface
    inside the wheels. It sits GROUND_GAP_M under the tyres: see that constant
    for why the gap is a tenth of a millimetre and not either 30 mm or zero.
    """
    lo, hi = bbox_m["min"], bbox_m["max"]

    if wheels:
        ground = min(w["cz_m"] - w["radius_m"] for w in wheels) - GROUND_GAP_M
    else:
        # No wheels found: the lowest thing on the car stands in for the
        # contact patch. Still offset, for the same tangency reason.
        ground = lo[2] - GROUND_GAP_M

    dom = {
        "outlet_x": lo[0] - down,
        "inlet_x": hi[0] + up,
        "ground_z": ground,
        "top_z": hi[2] + top,
        "side_y": lo[1] - side,
    }
    dom["symmetry"] = bool(symmetry)
    if not symmetry:
        # A whole car gets a slip wall on both sides and no mirror plane.
        dom["symmetry_y"] = hi[1] + side
        return dom

    # Where the car's own mirror plane is, worked out by symmetry_plane rather
    # than assumed to be the origin.
    plane = float(symmetry_y)

    # Nudged a few microns into the car, and this is the whole reason a half
    # tunnel works at all.
    #
    # A half model's cut face lies exactly in the plane the symmetry wall lies
    # in. Cutting a solid out of a box when one of its faces is coplanar with a
    # face of the box is the degenerate case of a boolean: OCC returns a shape
    # it calls valid, and SimScale's importer then refuses it with
    # "model-has-invalid-geometry" and a list of bad_face_face faults whose
    # positions all read Y = 2e-15. That cost a real run to discover, and the
    # message the user saw was "check that it is a closed solid".
    #
    # Moving the wall two microns towards the car makes the two planes
    # distinct, so the cut is an ordinary one through solid material. Two
    # microns on a 227 mm car is a ten-thousandth of its width, four hundred
    # times finer than the smallest feature the mesher is asked to keep, and
    # far larger than the 1e-7 OCC calls coincident.
    #
    # How far, though, is the caller's business. A whole car has no cut face on
    # the plane at all - the plane goes through solid bodywork - so it needs no
    # nudge, and giving it one does harm: on a real 5-body car, a wall 2 microns
    # off centre made the boolean subtract the four wheels and leave the
    # bodywork behind, while 0, 0.5 microns and 10 microns all cut it perfectly.
    # There is no safe constant, only a value that happens to miss every
    # tangency in one particular car, so the caller tries a few and checks.
    step = SYMMETRY_NUDGE_M if nudge is None else float(nudge)
    toward_car = -1.0 if (plane - lo[1]) > (hi[1] - plane) else 1.0
    plane += toward_car * step                  # build_domain works in metres

    dom["symmetry_y"] = plane

    # The tunnel runs from the plane, over the car, to a wall beyond it. Which
    # way that is depends on which side of its own mirror plane the car was
    # drawn, and it is not always the low side: a car mirrored the other way
    # sits entirely above its plane. side_y used to be lo[1] - side either way,
    # so on such a car the box spanned from below the car to the plane at its
    # bottom edge - a tunnel built alongside the car rather than around it, and
    # a boolean cut that removes almost nothing. The volume check further down
    # would have refused the run, which is better than solving it, but the
    # message would have said the STEP was a surface model.
    if (hi[1] - plane) > (plane - lo[1]):
        dom["side_y"] = hi[1] + side
    else:
        dom["side_y"] = lo[1] - side
    return dom


# ── STEP face labelling ──────────────────────────────────────────────────────
# Ported from TurboFlow_CFD.py:449-556. Tolerances are the add-in's, so the two
# routes label the same car the same way.
DOMAIN_TOL = 0.05     # metres a face centroid may sit off a domain wall

# How far the symmetry wall is moved off the car's own cut plane, in metres.
# See build_domain for why it cannot be zero.
SYMMETRY_NUDGE_M = 2e-6
# How far the road sits below the bottom of the wheels.
#
# 0.1 mm, which is as near to touching as a mesher will tolerate. It was 30 mm,
# which is not a road surface at all: a STEM Racing car with a 30 mm air gap
# under its wheels is a car in flight, and everything under it - the whole
# ground effect these teams design for - is solved wrong.
#
# Not zero, because a wheel resting exactly on the road touches it at a single
# line. Tangent contact is the same degenerate case as the coplanar symmetry
# face below: the boolean produces something OCC calls valid and the mesher
# then cannot build a cell against. A tenth of a millimetre is 1/280th of a
# wheel radius, far too small to change the flow, and far too large for the
# 1e-7 that OCC treats as coincident.
GROUND_GAP_M = 1e-4
MIN_SPAN = 0.30       # metres: below this a plane is car bodywork, not a wall

_ENTITY = re.compile(r"#(\d+)\s*=\s*(.+?)(?=\n#|\nENDSEC|$)", re.DOTALL)
_POINT = re.compile(r"\(\s*'[^']*'\s*,\s*\(\s*([\d\.\+\-Ee]+)\s*,"
                    r"\s*([\d\.\+\-Ee]+)\s*,\s*([\d\.\+\-Ee]+)")
_FACE_SURF = re.compile(r"ADVANCED_FACE\s*\(\s*'[^']*'\s*,\s*\([^)]+\)\s*,\s*#(\d+)")
_CYL_AXIS = re.compile(r"CYLINDRICAL_SURFACE\s*\(\s*'[^']*'\s*,\s*#(\d+)\s*,\s*[\d\.Ee\+\-]+")
_AXIS_PT = re.compile(r"AXIS2_PLACEMENT_3D\s*\(\s*'[^']*'\s*,\s*#(\d+)")


def classify_faces(step_text, domain, wheels, scale):
    """Every ADVANCED_FACE in the exported STEP, labelled.

    `scale` converts the file's own units to metres, and every comparison below
    is in metres.
    """
    entities = {int(m.group(1)): m.group(2).strip().rstrip(";")
                for m in _ENTITY.finditer(step_text)}

    points = {}
    for eid, body in entities.items():
        if body.startswith("CARTESIAN_POINT"):
            pm = _POINT.search(body)
            if pm:
                points[eid] = tuple(float(pm.group(i)) * scale for i in (1, 2, 3))

    def refs(eid):
        return [int(x) for x in re.findall(r"#(\d+)", entities.get(eid, ""))]

    def face_points(fid):
        """The vertices of this face's own boundary loops, and nothing else.

        The add-in walks every reference it can reach from a face down to a
        depth of twelve (TurboFlow_CFD.py:473-481). That wanders: edge curves
        are shared between neighbouring faces, so the walk crosses into
        topology belonging to the rest of the solid. On a real car it gave
        three of the six tunnel walls a bounding box spanning the entire
        domain, and centroids that sat nowhere near the plane they belonged
        to. The inlet and the top were then never recognised, and a run built
        from those labels has no inlet at all.

        This follows one typed chain instead: face, to its bounds, to the edge
        loop, to each oriented edge, to the edge curve, to its two vertices.
        Every face then reports a real plane with one zero span.
        """
        m = re.match(r"ADVANCED_FACE\s*\(\s*'[^']*'\s*,\s*\(([^)]*)\)", entities.get(fid, ""))
        if not m:
            return []
        out = []
        for bound in [int(x) for x in re.findall(r"#(\d+)", m.group(1))]:
            for loop in refs(bound):
                if not entities.get(loop, "").startswith("EDGE_LOOP"):
                    continue
                for oriented in refs(loop):
                    if not entities.get(oriented, "").startswith("ORIENTED_EDGE"):
                        continue
                    for curve in refs(oriented):
                        if not entities.get(curve, "").startswith("EDGE_CURVE"):
                            continue
                        for vertex in refs(curve):
                            if not entities.get(vertex, "").startswith("VERTEX_POINT"):
                                continue
                            out.extend(points[p] for p in refs(vertex) if p in points)
        return out

    def wheel_at(x, y, z):
        for w in wheels:
            if (abs(x - w["cx_m"]) < 0.01 and abs(z - w["cz_m"]) < 0.01):
                return w
        return None

    def classify(fid):
        body = entities.get(fid, "")
        sm = _FACE_SURF.search(body)
        if not sm:
            return ("car_no_slip", "", "", "", "")
        surf = entities.get(int(sm.group(1)), "")

        if surf.startswith("CYLINDRICAL_SURFACE"):
            rm = _CYL_AXIS.search(surf)
            if rm:
                apm = _AXIS_PT.search(entities.get(int(rm.group(1)), ""))
                if apm:
                    pt = points.get(int(apm.group(1)))
                    if pt:
                        w = wheel_at(*pt)
                        if w:
                            return ("rotating_wall", w["radius_m"],
                                    w["cx_m"], w["cy_m"], w["cz_m"])

        if surf.startswith("PLANE"):
            pts = face_points(fid)
            if not pts:
                return ("car_no_slip", "", "", "", "")
            sx = max(p[0] for p in pts) - min(p[0] for p in pts)
            sy = max(p[1] for p in pts) - min(p[1] for p in pts)
            sz = max(p[2] for p in pts) - min(p[2] for p in pts)
            # Anything smaller than a domain wall is bodywork that happens to be
            # flat, not the tunnel.
            if max(sx, sy, sz) < MIN_SPAN:
                return ("car_no_slip", "", "", "", "")
            cx = sum(p[0] for p in pts) / len(pts)
            cy = sum(p[1] for p in pts) / len(pts)
            cz = sum(p[2] for p in pts) / len(pts)
            if abs(cx - domain["inlet_x"]) < DOMAIN_TOL:
                return ("inlet", "", "", "", "")
            if abs(cx - domain["outlet_x"]) < DOMAIN_TOL:
                return ("outlet", "", "", "", "")
            if abs(cz - domain["top_z"]) < DOMAIN_TOL:
                return ("top", "", "", "", "")
            if abs(cy - domain["side_y"]) < DOMAIN_TOL:
                return ("side", "", "", "", "")
            if abs(cy - domain["symmetry_y"]) < DOMAIN_TOL and sx > MIN_SPAN and sz > MIN_SPAN:
                # Without a symmetry plane the far wall is just the other side.
                return ("symmetry" if domain["symmetry"] else "side", "", "", "", "")
            if abs(cz - domain["ground_z"]) < DOMAIN_TOL and sx > MIN_SPAN and sy > MIN_SPAN:
                return ("ground", "", "", "", "")

        return ("car_no_slip", "", "", "", "")

    rows, counts = [], {}
    for fid in sorted(e for e, b in entities.items() if b.startswith("ADVANCED_FACE")):
        row = classify(fid)
        rows.append((fid,) + row)
        counts[row[0]] = counts.get(row[0], 0) + 1
    return rows, counts


def write_labels_csv(path, rows):
    """The labels file, in the column order the worker's reader expects.

    A rotating_wall row with no usable radius is demoted to car_no_slip rather
    than written as it is. The worker's loader falls back to the bare label
    "rotating_wall" on a bad radius, and build_model never looks that label up,
    so those faces would end up with no boundary condition at all rather than
    being treated as a wall (simscale_job.py:280-317).
    """
    demoted = 0
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["step_entity_id", "label", "radius_m", "cx_m", "cy_m", "cz_m"])
        for fid, label, radius, cx, cy, cz in rows:
            if label == "rotating_wall":
                try:
                    if not (float(radius) > 0):
                        raise ValueError
                except (TypeError, ValueError):
                    label, radius, cx, cy, cz = "car_no_slip", "", "", "", ""
                    demoted += 1
            w.writerow([fid, label, radius, cx, cy, cz])
    return demoted


# ── CORS ─────────────────────────────────────────────────────────────────────
# The Workbench is served from another origin, so every response needs CORS
# headers and preflights need answering. Auth is a bearer token rather than a
# cookie, so a wildcard origin is safe: a stolen token is the threat, and CORS
# would not stop that anyway.
@app.after_request
def cors(resp):
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Headers"] = "authorization, content-type"
    resp.headers["Access-Control-Allow-Methods"] = "POST, OPTIONS"
    resp.headers["Access-Control-Max-Age"] = "86400"
    return resp


@app.route("/tessellate", methods=["OPTIONS"])
@app.route("/transform", methods=["OPTIONS"])
@app.route("/prepare", methods=["OPTIONS"])
@app.route("/inspect", methods=["OPTIONS"])
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
            shape = shape.mirror(planes[axis])
        else:
            raise ValueError(f"unknown operation '{kind}'")
    return shape


SURFACE_NAMES = {
    GeomAbs_SurfaceType.GeomAbs_Plane: "plane",
    GeomAbs_SurfaceType.GeomAbs_Cylinder: "cylinder",
    GeomAbs_SurfaceType.GeomAbs_Cone: "cone",
    GeomAbs_SurfaceType.GeomAbs_Sphere: "sphere",
    GeomAbs_SurfaceType.GeomAbs_Torus: "torus",
    GeomAbs_SurfaceType.GeomAbs_BezierSurface: "bezier",
    GeomAbs_SurfaceType.GeomAbs_BSplineSurface: "bspline",
}


def solid_of_face(solids, faces):
    """Which solid each face belongs to, by index into `solids`.

    Needed for selecting a whole part in one click, which is what a person
    means when they point at a wheel: the wheel is a body, not a face. OCC
    knows the answer, it just has to be asked once per solid rather than once
    per face, which is why this walks the solids and not the faces.
    """
    # Indexed maps rather than HashCode: newer OCP builds dropped HashCode
    # from TopoDS_Face entirely, so the version that shipped would have raised
    # AttributeError the moment the pinned CadQuery moved. FindIndex is the
    # supported way to ask "which of these shapes is this" and it is faster,
    # because the map is built once instead of a dictionary per solid.
    fmap = TopTools_IndexedMapOfShape()
    for f in faces:
        fmap.Add(f.wrapped)
    out = [-1] * len(faces)
    for si, solid in enumerate(solids):
        exp = TopExp_Explorer(solid.wrapped, TopAbs_FACE)
        while exp.More():
            at = fmap.FindIndex(exp.Current())
            if at > 0:
                out[at - 1] = si
            exp.Next()
    return out


def describe_face(face, index, scale):
    """What the browser needs to draw, name and pick one face.

    The cylinder fields are the ones that matter: a face the user clicks to say
    "this is a wheel" carries its own radius and axis, so the browser does not
    have to guess a radius the CSV cannot do without.
    """
    ad = BRepAdaptor_Surface(face.wrapped)
    kind = SURFACE_NAMES.get(ad.GetType(), "other")
    c = face.Center()
    out = {
        "index": index,
        "type": kind,
        "area_m2": round(face.Area() * scale * scale, 9),
        "cx_m": round(c.x * scale, 6),
        "cy_m": round(c.y * scale, 6),
        "cz_m": round(c.z * scale, 6),
    }
    cyl = cylinder_of(face)
    if cyl:
        r, ax, loc = cyl
        out["radius_m"] = round(r * scale, 6)
        out["axis"] = [round(v, 6) for v in ax]
        out["axis_x_m"] = round(loc[0] * scale, 6)
        out["axis_y_m"] = round(loc[1] * scale, 6)
        out["axis_z_m"] = round(loc[2] * scale, 6)
    return out


# Faces either side of a smooth edge. SimScale calls this "expand selection to
# tangent faces", and it is the difference between clicking a wheel and clicking
# one patch of a wheel: a tyre modelled as several trimmed cylinders is one
# thing to a person and several to the file.
#
# OCC records smoothness on the edge, but only if the STEP happened to say so,
# which most do not. EncodeRegularity works it out from the geometry and writes
# it on, which is what makes Continuity_s meaningful here.
TANGENT_DEGREES = float(os.environ.get("TANGENT_DEGREES", "1.0"))


def face_adjacency(shape, faces):
    """Every pair of faces that share an edge, with the angle between them.

    Build spec 14.3 wants `extras.adjacency = [[faceA, faceB, dihedralDeg]]`.
    The angle is what makes it useful beyond "these touch": zero degrees is a
    smooth join, which is the same thing tangent_neighbours reports, and a
    large angle is a real edge. Sending the angle rather than a boolean lets
    the viewer offer a threshold without asking the server again.

    Measured from the face normals at the middle of the shared edge, because
    two faces can meet smoothly at one end of an edge and sharply at the other
    and a single number has to come from somewhere stated.
    """
    from OCP.BRepAdaptor import BRepAdaptor_Curve
    from OCP.BRepLProp import BRepLProp_SLProps
    from OCP.ShapeAnalysis import ShapeAnalysis_Surface
    from OCP.BRep import BRep_Tool as BT

    index = TopTools_IndexedMapOfShape()
    for f in faces:
        index.Add(f.wrapped)
    owners = TopTools_IndexedDataMapOfShapeListOfShape()
    TopExp.MapShapesAndAncestors_s(shape.wrapped, TopAbs_EDGE, TopAbs_FACE, owners)

    out = []
    for i in range(1, owners.Extent() + 1):
        edge = owners.FindKey(i)
        sides = list(owners.FindFromIndex(i))
        if len(sides) != 2:
            continue
        a = index.FindIndex(sides[0]) - 1
        b = index.FindIndex(sides[1]) - 1
        if a < 0 or b < 0 or a == b:
            continue
        try:
            curve = BRepAdaptor_Curve(TopoDS.Edge_s(edge))
            mid = curve.Value((curve.FirstParameter() + curve.LastParameter()) / 2.0)
            normals = []
            for side in sides:
                srf = BT.Surface_s(TopoDS.Face_s(side))
                uv = ShapeAnalysis_Surface(srf).ValueOfUV(mid, 1e-6)
                props = BRepLProp_SLProps(
                    BRepAdaptor_Surface(TopoDS.Face_s(side)), uv.X(), uv.Y(), 1, 1e-6)
                if not props.IsNormalDefined():
                    normals = []
                    break
                n = props.Normal()
                normals.append((n.X(), n.Y(), n.Z()))
            if len(normals) != 2:
                continue
            dot = sum(x * y for x, y in zip(*normals))
            angle = math.degrees(math.acos(max(-1.0, min(1.0, dot))))
        except Exception:
            continue
        out.append([a, b, round(angle, 2)])
    return out


def tangent_neighbours(shape, faces):
    try:
        BRepLib.EncodeRegularity_s(shape.wrapped, math.radians(TANGENT_DEGREES))
    except Exception as e:
        log.warning("could not encode edge regularity: %s", e)
        return [[] for _ in faces]

    index = TopTools_IndexedMapOfShape()
    for f in faces:
        index.Add(f.wrapped)
    owners = TopTools_IndexedDataMapOfShapeListOfShape()
    TopExp.MapShapesAndAncestors_s(shape.wrapped, TopAbs_EDGE, TopAbs_FACE, owners)

    adj = [set() for _ in faces]
    for i in range(1, owners.Extent() + 1):
        edge = owners.FindKey(i)
        sides = list(owners.FindFromIndex(i))
        if len(sides) != 2:
            continue
        a = index.FindIndex(sides[0]) - 1
        b = index.FindIndex(sides[1]) - 1
        # a == b is the seam of a closed face, a cylinder joined to itself. It is
        # tangent, and saying so would make every cylinder its own neighbour.
        if a < 0 or b < 0 or a == b:
            continue
        try:
            cont = BRep_Tool.Continuity_s(TopoDS.Edge_s(edge),
                                          TopoDS.Face_s(sides[0]),
                                          TopoDS.Face_s(sides[1]))
        except Exception:
            continue
        if cont != GeomAbs_Shape.GeomAbs_C0:
            adj[a].add(b)
            adj[b].add(a)
    return [sorted(x) for x in adj]


# Cells across the longer side of the shadow. At this resolution the answer is
# within about a tenth of a percent, checked against a box, a sphere and a
# cylinder whose shadows are known exactly.
FRONTAL_CELLS = int(os.environ.get("FRONTAL_CELLS", "900"))


# Cells expanded per batch. Three million candidate cells at once would be a
# few hundred megabytes of temporaries; a million at a time is not.
RASTER_CHUNK = 1 << 20


THUMB_W, THUMB_H = 512, 384
THUMB_MARGIN = 16
_THUMB_EMPTY = 1 << 40


def _write_png_gray_alpha(gray, alpha, path):
    """An 8 bit greyscale-plus-alpha PNG, written without an image library.

    Pillow is not a dependency of this container and adding one to write a
    thumbnail would be a strange trade. A PNG is a signature, three chunks and
    a zlib stream, and the alpha channel means the dashboard's own background
    shows through the car rather than a grey rectangle sitting in a dark card.
    """
    h, w = gray.shape
    rows = bytearray()
    inter = numpy.empty((h, w * 2), dtype=numpy.uint8)
    inter[:, 0::2] = gray
    inter[:, 1::2] = alpha
    for y in range(h):
        rows.append(0)                      # filter type 0, none
        rows += inter[y].tobytes()

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff))

    with open(path, "wb") as fh:
        fh.write(b"\x89PNG\r\n\x1a\n")
        fh.write(chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 4, 0, 0, 0)))
        fh.write(chunk(b"IDAT", zlib.compress(bytes(rows), 6)))
        fh.write(chunk(b"IEND", b""))
    return path


def render_thumb(verts, tris, path):
    """A shaded three-quarter view of the model, rasterised with numpy.

    The obvious way to make a thumbnail is to render one, and the obvious way
    to render one needs a GPU and a display, neither of which a Cloud Run
    container has. pyrender and trimesh's own viewer both want OpenGL, so this
    projects the triangles by hand instead: an orthographic camera above and to
    one side, a nearest-surface test per pixel, and one Lambert term.

    Depth and shade travel together in one integer, the depth in the high bits
    and the shade in the low eight, so sorting by that integer puts the nearest
    surface first and carries its brightness with it. That turns the whole
    hidden-surface problem into a single lexsort.
    """
    P = numpy.asarray(verts, dtype=float)
    T = numpy.asarray(tris, dtype=numpy.int64)
    if len(T) == 0 or len(P) == 0:
        return None

    eye = numpy.array([1.0, -1.0, 0.6])
    eye /= numpy.linalg.norm(eye)
    fwd = -eye
    right = numpy.cross(fwd, numpy.array([0.0, 0.0, 1.0]))
    if numpy.linalg.norm(right) < 1e-9:
        right = numpy.array([1.0, 0.0, 0.0])
    right /= numpy.linalg.norm(right)
    up = numpy.cross(right, fwd)
    # Mostly from overhead and a little to the left of the camera. A light on
    # the camera axis is the easy choice and the wrong one: every visible face
    # then returns almost the same brightness and the car reads as a flat
    # silhouette, which is exactly what a thumbnail must not be.
    light = numpy.array([0.35, -0.55, 1.0])
    light /= numpy.linalg.norm(light)

    X, Y, Z = P @ right, P @ up, P @ fwd
    spanx = max(X.max() - X.min(), 1e-12)
    spany = max(Y.max() - Y.min(), 1e-12)
    k = min((THUMB_W - 2 * THUMB_MARGIN) / spanx, (THUMB_H - 2 * THUMB_MARGIN) / spany)
    px = (X - (X.max() + X.min()) / 2) * k + THUMB_W / 2
    # Screen rows run downwards, so up in the model is a smaller row number.
    py = THUMB_H / 2 - (Y - (Y.max() + Y.min()) / 2) * k

    a, b, c = P[T[:, 0]], P[T[:, 1]], P[T[:, 2]]
    nrm = numpy.cross(b - a, c - a)
    length = numpy.linalg.norm(nrm, axis=1)
    length[length == 0] = 1.0
    lam = numpy.clip((nrm / length[:, None]) @ light, 0.0, 1.0)
    shade = (45 + 195 * lam).astype(numpy.int64)

    zmin, zmax = Z.min(), Z.max()
    zk = 16777215.0 / max(zmax - zmin, 1e-12)

    ax, ay = px[T[:, 0]], py[T[:, 0]]
    bx, by = px[T[:, 1]], py[T[:, 1]]
    cx, cy = px[T[:, 2]], py[T[:, 2]]
    za, zb, zc = Z[T[:, 0]], Z[T[:, 1]], Z[T[:, 2]]
    det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)

    lox = numpy.minimum(numpy.minimum(ax, bx), cx)
    hix = numpy.maximum(numpy.maximum(ax, bx), cx)
    loy = numpy.minimum(numpy.minimum(ay, by), cy)
    hiy = numpy.maximum(numpy.maximum(ay, by), cy)
    i0 = numpy.clip(numpy.floor(lox).astype(numpy.int64), 0, THUMB_W)
    i1 = numpy.clip(numpy.ceil(hix).astype(numpy.int64) + 1, 0, THUMB_W)
    j0 = numpy.clip(numpy.floor(loy).astype(numpy.int64), 0, THUMB_H)
    j1 = numpy.clip(numpy.ceil(hiy).astype(numpy.int64) + 1, 0, THUMB_H)
    w, h = i1 - i0, j1 - j0
    keep = (w > 0) & (h > 0) & (numpy.abs(det) > 1e-12)
    if not keep.any():
        return None
    i0, j0, w, h = i0[keep], j0[keep], w[keep], h[keep]
    ax, ay, bx, by, cx, cy, det = (v[keep] for v in (ax, ay, bx, by, cx, cy, det))
    za, zb, zc, shade = za[keep], zb[keep], zc[keep], shade[keep]

    counts = w * h
    starts = numpy.cumsum(counts) - counts
    total = int(counts.sum())
    hits_idx, hits_key = [], []
    for begin in range(0, total, RASTER_CHUNK):
        flat = numpy.arange(begin, min(total, begin + RASTER_CHUNK))
        t = numpy.searchsorted(starts, flat, side="right") - 1
        di, dj = numpy.divmod(flat - starts[t], h[t])
        ii, jj = i0[t] + di, j0[t] + dj
        sx, sy = ii + 0.5, jj + 0.5
        u = ((by[t] - cy[t]) * (sx - cx[t]) + (cx[t] - bx[t]) * (sy - cy[t])) / det[t]
        v = ((cy[t] - ay[t]) * (sx - cx[t]) + (ax[t] - cx[t]) * (sy - cy[t])) / det[t]
        inside = (u >= 0) & (v >= 0) & (u + v <= 1)
        if not inside.any():
            continue
        u, v, t = u[inside], v[inside], t[inside]
        zp = u * za[t] + v * zb[t] + (1.0 - u - v) * zc[t]
        dq = numpy.clip(((zp - zmin) * zk).astype(numpy.int64), 0, 16777215)
        hits_idx.append(jj[inside] * THUMB_W + ii[inside])
        hits_key.append((dq << 8) | shade[t])
    if not hits_idx:
        return None

    idx = numpy.concatenate(hits_idx)
    key = numpy.concatenate(hits_key)
    # Nearest surface per pixel: sort by pixel then by depth, and the first
    # entry for each pixel is the one that is visible.
    order = numpy.lexsort((key, idx))
    idx, key = idx[order], key[order]
    first = numpy.ones(len(idx), dtype=bool)
    first[1:] = idx[1:] != idx[:-1]
    buf = numpy.full(THUMB_W * THUMB_H, _THUMB_EMPTY, dtype=numpy.int64)
    buf[idx[first]] = key[first]

    drawn = buf != _THUMB_EMPTY
    gray = numpy.where(drawn, buf & 0xFF, 0).astype(numpy.uint8).reshape(THUMB_H, THUMB_W)
    alpha = (drawn * 255).astype(numpy.uint8).reshape(THUMB_H, THUMB_W)
    return _write_png_gray_alpha(gray, alpha, path)


def _shadow_grid(verts, tris, y_lo=None, y_hi=None):
    """Rasterise the car's shadow along the wind onto the (y, z) plane.

    Force coefficients need this area and there is no honest shortcut. Adding
    up triangle areas does not work: a car has bodywork behind bodywork and
    every hidden surface would be counted again. The shadow is a union, not a
    sum, so it is rasterised and a covered cell counts once however many times
    it is covered.

    Every triangle's cell box is expanded into one flat list of candidate
    cells and the barycentric test runs over all of them at once. The previous
    version looped in Python, which was not slow because of the work: three
    million cells is nothing, but a hundred and thirty thousand round trips
    through the interpreter to reach them took five and a half seconds. This
    takes half of one, and produces a bit-identical grid.
    """
    if len(tris) == 0:
        return None, 0.0, 0.0, None, 0
    pts = numpy.asarray(verts, dtype=float)[:, 1:3]        # (y, z)
    lo, hi = pts.min(0), pts.max(0)
    if y_lo is not None:
        lo[0] = max(lo[0], y_lo)
    if y_hi is not None:
        hi[0] = min(hi[0], y_hi)
    span = hi - lo
    if span[0] <= 0 or span[1] <= 0:
        return None, 0.0, 0.0, None, 0

    per = FRONTAL_CELLS / max(span)
    nx = max(1, int(span[0] * per))
    ny = max(1, int(span[1] * per))
    cw, ch = span[0] / nx, span[1] / ny
    grid = numpy.zeros((nx, ny), dtype=bool)

    tri = pts[numpy.asarray(tris, dtype=numpy.int64)]      # (n, 3, 2)
    tmin, tmax = tri.min(1), tri.max(1)
    i0 = numpy.clip(((tmin[:, 0] - lo[0]) / cw).astype(numpy.int64), 0, nx)
    i1 = numpy.clip(numpy.ceil((tmax[:, 0] - lo[0]) / cw).astype(numpy.int64), 0, nx)
    j0 = numpy.clip(((tmin[:, 1] - lo[1]) / ch).astype(numpy.int64), 0, ny)
    j1 = numpy.clip(numpy.ceil((tmax[:, 1] - lo[1]) / ch).astype(numpy.int64), 0, ny)
    w, h = i1 - i0, j1 - j0

    ax, ay = tri[:, 0, 0], tri[:, 0, 1]
    bx, by = tri[:, 1, 0], tri[:, 1, 1]
    cx, cy = tri[:, 2, 0], tri[:, 2, 1]
    det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
    # A triangle edge-on to the wind casts no shadow, and dividing by its
    # determinant would be dividing by zero.
    keep = (w > 0) & (h > 0) & (numpy.abs(det) > 1e-20)
    if not keep.any():
        return grid, cw, ch, lo, nx

    i0, j0, w, h = i0[keep], j0[keep], w[keep], h[keep]
    ax, ay, bx, by, cx, cy, det = (v[keep] for v in (ax, ay, bx, by, cx, cy, det))
    counts = w * h
    starts = numpy.cumsum(counts) - counts
    total = int(counts.sum())

    for begin in range(0, total, RASTER_CHUNK):
        flat = numpy.arange(begin, min(total, begin + RASTER_CHUNK))
        t = numpy.searchsorted(starts, flat, side="right") - 1
        di, dj = numpy.divmod(flat - starts[t], h[t])
        ii = i0[t] + di
        jj = j0[t] + dj
        px = lo[0] + (ii + 0.5) * cw
        py = lo[1] + (jj + 0.5) * ch
        u = ((by[t] - cy[t]) * (px - cx[t]) + (cx[t] - bx[t]) * (py - cy[t])) / det[t]
        v = ((cy[t] - ay[t]) * (px - cx[t]) + (ax[t] - cx[t]) * (py - cy[t])) / det[t]
        inside = (u >= 0) & (v >= 0) & (u + v <= 1)
        grid[ii[inside], jj[inside]] = True

    return grid, cw, ch, lo, nx


def frontal_area(verts, tris, y_lo=None, y_hi=None):
    """The area of the shadow, in model units.

    `y_lo` and `y_hi` clip it to the wind tunnel's own width. A whole car in a
    half tunnel is solved as a half, reports half the force, and needs half the
    area with it or the coefficient comes out at twice what it should be.
    """
    grid, cw, ch, _lo, _nx = _shadow_grid(verts, tris, y_lo, y_hi)
    return 0.0 if grid is None else float(grid.sum() * cw * ch)


def frontal_area_pair(verts, tris, split_at=0.0):
    """The whole shadow and the half of it on one side of a plane, in one pass.

    Rasterising twice to get these two numbers walked a hundred and sixty
    thousand triangles a second time to fill in a grid that had already been
    filled in. The grid holds the answer to both questions: the full area is
    every covered cell, the half is the covered cells on one side of the split.
    """
    grid, cw, ch, lo, nx = _shadow_grid(verts, tris)
    if grid is None:
        return 0.0, 0.0
    full = float(grid.sum() * cw * ch)
    edge = int(round((split_at - lo[0]) / cw))
    edge = max(0, min(nx, edge))
    half = float(grid[:edge, :].sum() * cw * ch)
    return full, half


def mesh_arrays(shape, faces):
    """Vertices and triangles for a whole shape, for measuring rather than drawing."""
    BRepMesh_IncrementalMesh(shape.wrapped, LINEAR_DEFLECTION, False,
                             ANGULAR_DEFLECTION, True)
    verts, tris = [], []
    for face in faces:
        loc = TopLoc_Location()
        t = BRep_Tool.Triangulation_s(face.wrapped, loc)
        if t is None:
            continue
        trsf = loc.Transformation()
        base = len(verts)
        for i in range(1, t.NbNodes() + 1):
            pt = t.Node(i).Transformed(trsf)
            verts.append((pt.X(), pt.Y(), pt.Z()))
        for i in range(1, t.NbTriangles() + 1):
            a, b, c = t.Triangle(i).Get()
            tris.append((base + a - 1, base + b - 1, base + c - 1))
    return verts, tris


def to_glb_by_face(faces, shape, tmp, name="out"):
    """Tessellate face by face, keeping the triangles of each face together.

    The triangles are read out of OCC's own triangulation one face at a time
    and written in face order, so a triangle index in the glTF maps back to a
    face by a range lookup, and a click in the viewer becomes a STEP face.

    This replaced an export to STL that was then reloaded through trimesh. STL
    is a bag of loose triangles with no record of which face each came from, so
    everything arrived welded into one anonymous surface. That, and nothing
    else, is why face picking never worked.

    trimesh is given the arrays directly with process=False. Its usual load path
    welds vertices and reorders triangles, which would break the mapping without
    reporting anything.
    """
    # Deliberately does NOT mesh. The caller does that, once, through
    # ensure_meshed. Meshing here as well was a second pass over an already
    # triangulated shape, and on an 11 MB car with 2219 faces it did not just
    # waste time: it took the container past its memory limit and Cloud Run
    # killed the process, so the browser waited ninety seconds and got nothing
    # back. The first mesh of the same shape, one second earlier, was fine.
    ensure_meshed(shape)
    verts, tris, ranges, vranges, owner = [], [], [], [], []
    for fi, face in enumerate(faces):
        loc = TopLoc_Location()
        t = BRep_Tool.Triangulation_s(face.wrapped, loc)
        if t is None:
            ranges.append((len(tris), 0))
            vranges.append((len(verts), 0))
            continue
        trsf = loc.Transformation()
        base = len(verts)
        for i in range(1, t.NbNodes() + 1):
            pt = t.Node(i).Transformed(trsf)
            verts.append((pt.X(), pt.Y(), pt.Z()))
            # No vertex is shared between two faces here, so naming the face on
            # the vertex is exact. The viewer already reads a _FACEID attribute
            # and has never been given one, which is why its picking and its
            # face highlighting have sat unused.
            owner.append(fi)
        # A reversed face has its triangles wound the other way. Left alone the
        # normals point into the model and it renders inside out.
        vranges.append((base, len(verts) - base))
        rev = face.wrapped.Orientation() == TopAbs_Orientation.TopAbs_REVERSED
        start = len(tris)
        for i in range(1, t.NbTriangles() + 1):
            a, b, c = t.Triangle(i).Get()
            if rev:
                b, c = c, b
            tris.append((base + a - 1, base + b - 1, base + c - 1))
        ranges.append((start, len(tris) - start))

    stage("glb: read %d tris from %d faces" % (len(tris), len(faces)))
    if not tris:
        raise ValueError("nothing to tessellate")
    mesh = trimesh.Trimesh(vertices=numpy.array(verts, dtype=float),
                           faces=numpy.array(tris, dtype=int), process=False)
    mesh.vertex_attributes["_FACEID"] = numpy.array(owner, dtype=numpy.float32)
    stage("glb: trimesh built")
    glb = os.path.join(tmp, name + ".glb")
    mesh.export(glb)
    stage("glb: exported")
    # The arrays go back with it. The frontal area needs exactly these, and
    # reading every triangulation again to rebuild them cost a second and a
    # second fifty megabytes for nothing.
    return glb, ranges, vranges, len(tris), verts, tris


@app.post("/transform")
def transform():
    """Apply edit ops to a STEP and write a new STEP plus glb alongside it."""
    uid = caller_uid(request)
    if not uid:
        return jsonify(error="Sign in required."), 401
    refused = limited(uid, "transform")
    if refused:
        return refused

    body = request.get_json(silent=True) or {}
    step_path, ops = body.get("step_path", ""), body.get("ops")
    dest = body.get("dest_prefix") or ""
    if not owned(step_path, uid):
        return jsonify(error="That path is not yours."), 403
    if not step_path.lower().endswith((".step", ".stp")):
        return jsonify(error="Expected a .step file."), 400
    if not owned(dest + "/", uid):
        return jsonify(error="Destination is not yours."), 403

    # A version is written once and never rewritten. Without this, "save as v2"
    # pointed at an existing folder would destroy the geometry an earlier run
    # was measured against.
    if remote_exists(f"{dest}/geometry.step"):
        return jsonify(error="That version already exists."), 409

    with tempfile.TemporaryDirectory() as tmp:
        local = os.path.join(tmp, "in.step")
        try:
            if not download(step_path, local):
                return jsonify(error="Could not read the source geometry."), 404
        except ValueError:
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
        ensure_meshed(shape)
        out_glb, _r, _vr, tris, _v, _t = to_glb_by_face(wp.faces().vals(), shape, tmp)

        paths = {"step": f"{dest}/geometry.step", "glb": f"{dest}/geometry.glb"}
        upload(out_step, paths["step"], "application/step")
        upload(out_glb, paths["glb"], "model/gltf-binary")

    return jsonify(step_path=paths["step"], glb_path=paths["glb"],
                   triangle_count=tris, bbox=bbox)


@app.post("/tessellate")
def tessellate():
    uid = caller_uid(request)
    if not uid:
        return jsonify(error="Sign in required."), 401
    refused = limited(uid, "tessellate")
    if refused:
        return refused

    step_path = (request.get_json(silent=True) or {}).get("step_path", "")
    if not owned(step_path, uid):
        return jsonify(error="That path is not yours."), 403
    if not step_path.lower().endswith((".step", ".stp")):
        return jsonify(error="Expected a .step file."), 400

    with tempfile.TemporaryDirectory() as tmp:
        local_step = os.path.join(tmp, "geometry.step")
        try:
            if not download(step_path, local_step):
                return jsonify(error="Could not read the uploaded file."), 404
        except ValueError:
            return jsonify(error="File is too large to tessellate."), 413

        try:
            shape = cq.importers.importStep(local_step)
        except Exception as e:
            log.warning("STEP import failed: %s", e)
            return jsonify(error="That STEP file could not be read."), 422

        solids = shape.solids().vals()
        faces = shape.faces().vals()
        bbox = exact_bbox(shape.val())
        try:
            scale, unit = detect_scale(bbox, None)
        except ValueError:
            # A flow region is a wind tunnel, metres across, so the car-sized
            # check cannot place it. The preview does not need a scale.
            scale, unit = 1.0, "unknown"
        ensure_meshed(shape.val())
        local_glb, ranges, vranges, tris, mv, mt = to_glb_by_face(
            faces, shape.val(), tmp, "geometry")

        # The same face data /inspect returns, so a flow region the Fusion
        # add-in built is as clickable as a car prepared here. Nothing else in
        # the Workbench could pick a face on one of those before.
        # One pass over the faces, shared by the metadata, the wheel search and
        # the orientation check, instead of a surface adaptor per face per
        # question. There were four such passes.
        meta = survey_faces(faces, scale, mesh_face_stats(mv, mt, ranges, scale))
        prep_boxes = face_boxes(mv, vranges, scale)
        for i, d in enumerate(meta):
            d["tri_start"], d["tri_count"] = ranges[i]
            d["start"], d["count"] = vranges[i]
            d["bbox"] = prep_boxes[i]
        for d, near in zip(meta, tangent_neighbours(shape.val(), faces)):
            d["tangent"] = near

        glb_path = step_path.rsplit("/", 1)[0] + "/geometry.glb"
        upload(local_glb, glb_path, "model/gltf-binary")

    return jsonify(glb_path=glb_path, face_count=len(faces), faces=meta,
                   solid_count=len(solids), triangle_count=tris, bbox=bbox,
                   unit=unit, scale_to_m=scale)


def group_volume(mesh, g):
    """The volume a group of triangles encloses, or zero if it encloses none.

    The divergence theorem gives a number for any bag of triangles, closed or
    not, and reporting that number for an open shell would be inventing a
    solid. So the edges are counted first: a closed surface uses every edge
    exactly twice, and anything else is a sheet.
    """
    T = numpy.asarray(mesh.faces, dtype=numpy.int64)[g]
    V = numpy.asarray(mesh.vertices, dtype=float)
    edges = numpy.sort(numpy.concatenate(
        [T[:, [0, 1]], T[:, [1, 2]], T[:, [2, 0]]]), axis=1)
    _, counts = numpy.unique(edges, axis=0, return_counts=True)
    if not bool((counts == 2).all()):
        return 0.0
    a, b, c = V[T[:, 0]], V[T[:, 1]], V[T[:, 2]]
    return abs(float(numpy.einsum("ij,ij->i", a, numpy.cross(b, c)).sum()) / 6.0)


def inspect_mesh(step_path, ext, vdir, version, b):
    """/inspect for an STL, which never goes near the OCC kernel.

    A STEP is a model: surfaces with types, edges that meet, solids that
    enclose. An STL is a heap of triangles, and putting one through the solid
    path means building an OCC face per triangle and sewing them, which on a
    hundred thousand triangles takes longer than Cloud Run will wait and gives
    back a shape with a hundred thousand faces that nobody can click usefully.

    So the mesh keeps its own path all the way through. It costs the things a
    mesh genuinely does not have, and those are reported rather than faked:
    no cylinders, so no wheels are found; no shared edges between analytic
    faces, so no adjacency and no tangent growing; and the orientation guess
    falls back to the bounding box.
    """
    opts = b.get("import_options") or {}
    facet_split = bool(opts.get("facet_split", True))

    with tempfile.TemporaryDirectory() as tmp:
        local = os.path.join(tmp, "raw" + ext)
        try:
            if not download(step_path, local):
                return jsonify(error="Could not read the uploaded file."), 404
        except ValueError:
            return jsonify(error="File is too large to open."), 413
        stage("downloaded")

        try:
            mesh = trimesh.load(local, file_type="stl", force="mesh", process=False)
        except Exception as e:
            log.warning("STL import failed: %s", e)
            return jsonify(error="That STL file could not be read."), 422
        if mesh is None or len(getattr(mesh, "faces", [])) == 0:
            return jsonify(error="That STL file has no triangles."), 422
        stage("imported %d triangles" % len(mesh.faces))

        groups = mesh_groups(mesh, facet_split)
        verts, tris, owner, ranges, vranges = mesh_arrays_by_group(mesh, groups)
        verts, turned = turn_mesh_to_wind(verts)
        stage("grouped into %d faces" % len(groups))

        lo, hi = verts.min(0), verts.max(0)
        raw_bbox = {"min": [float(v) for v in lo], "max": [float(v) for v in hi],
                    "size": [float(v) for v in hi - lo]}
        try:
            scale, unit = detect_scale(raw_bbox, b.get("input_unit") or b.get("unit"))
        except ValueError as e:
            return jsonify(error=str(e)), 422
        bbox_m = {k: [c * scale for c in v] for k, v in raw_bbox.items()}

        drawn = trimesh.Trimesh(vertices=verts, faces=tris, process=False)
        drawn.vertex_attributes["_FACEID"] = owner
        glb = os.path.join(tmp, "raw.glb")
        drawn.export(glb)
        stage("glb")

        stats = mesh_face_stats(verts, tris, ranges, scale)
        boxes = face_boxes(verts, vranges, scale)
        normals = mesh_group_normals(verts, tris, ranges)
        meta = []
        for i in range(len(groups)):
            area, (mx, my, mz) = stats[i]
            d = {"index": i, "type": "mesh", "area_m2": round(area, 9),
                 "cx_m": round(mx, 6), "cy_m": round(my, 6), "cz_m": round(mz, 6),
                 "tri_start": ranges[i][0], "tri_count": ranges[i][1],
                 "start": vranges[i][0], "count": vranges[i][1],
                 "bbox": boxes[i], "tangent": [],
                 "solid": i if facet_split else 0}
            if normals[i]:
                d["normal"] = normals[i]
            meta.append(d)
        stage("survey")

        solids_info = [
            {"id": i, "name": "Region %d" % (i + 1),
             "volume_m3": round(group_volume(mesh, g) * scale ** 3, 12),
             "bbox": boxes[i], "mesh": True}
            for i, g in enumerate(groups)]

        area_full, area_half = frontal_area_pair(verts, tris, split_at=0.0)
        area_full *= scale * scale
        area_half *= scale * scale
        stage("frontal area")

        thumb = None
        try:
            thumb = render_thumb(verts, tris, os.path.join(tmp, "thumb.png"))
            stage("thumb")
        except Exception as e:
            log.warning("thumbnail failed: %s", e)

        # The one thing a mesh cannot give cheaply. Above the cap the model is
        # still uploaded, drawn and measured; only the SimScale export is
        # missing, and the reply says so instead of the user finding out when
        # a run fails.
        step_out = os.path.join(tmp, "geometry.step")
        step_note = None
        if len(mesh.faces) > STL_STEP_MAX_TRIANGLES:
            step_note = ("This STL has %d triangles. Above %d it is shown and "
                         "measured but not converted to STEP, so running a "
                         "simulation needs the STEP or IGES original."
                         % (len(mesh.faces), STL_STEP_MAX_TRIANGLES))
        else:
            try:
                solid = read_stl(local).val()
                if turned:
                    spin = gp_Trsf()
                    spin.SetRotation(gp_Ax1(gp_Pnt(0, 0, 0), gp_Dir(0, 0, 1)),
                                     -math.pi / 2)
                    moved = BRepBuilderAPI_Transform(solid.wrapped, spin, True)
                    moved.Build()
                    if moved.IsDone():
                        from cadquery.occ_impl.shapes import Shape
                        solid = Shape.cast(moved.Shape())
                write_step(solid, step_out)
                stage("step export")
            except Exception as e:
                log.warning("STL to STEP failed: %s", e)
                step_note = "This STL could not be converted to STEP."

        faces_json = os.path.join(tmp, "faces.json")
        with open(faces_json, "w", encoding="utf-8") as fh:
            json.dump({"version": version, "unit": unit, "scale_to_m": scale,
                       "faces": meta, "adjacency": []}, fh)
        solids_json = os.path.join(tmp, "solids.json")
        with open(solids_json, "w", encoding="utf-8") as fh:
            json.dump({"version": version, "solids": solids_info}, fh)

        paths = {"glb": "%s/model.glb" % vdir,
                 "faces": "%s/faces.json" % vdir,
                 "solids": "%s/solids.json" % vdir}
        if thumb:
            paths["thumb"] = "%s/thumb.png" % vdir
            upload(thumb, paths["thumb"], "image/png")
        if step_note is None:
            paths["step"] = "%s/geometry.step" % vdir
            upload(step_out, paths["step"], "application/step")
        upload(glb, paths["glb"], "model/gltf-binary")
        upload(faces_json, paths["faces"], "application/json")
        upload(solids_json, paths["solids"], "application/json")
        glb_path = step_path.rsplit("/", 1)[0] + "/raw.glb"
        upload(glb, glb_path, "model/gltf-binary")
        stage("uploaded")

    domain = build_domain(bbox_m, [], 1.5, 0.5, 0.3, 0.3,
                          bool(b.get("symmetry", True)))
    return jsonify(glb_path=glb_path, bbox=bbox_m, unit=unit, scale_to_m=scale,
                   version=version, format="STL", paths=paths,
                   adjacency_count=0, solids=solids_info,
                   faces=meta, wheels=[], domain=domain,
                   frontal_area_m2=round(area_full, 9),
                   frontal_area_half_m2=round(area_half, 9),
                   rotated_deg=turned,
                   car_axis={"long_axis": 0, "source": "bounding box"},
                   step_note=step_note,
                   face_count=len(groups), solid_count=len(groups),
                   triangle_count=len(tris))


@app.post("/inspect")
def inspect():
    """Raw car STEP in, a pickable model of it out.

    This is what the Workbench shows before anything is built. The Fusion add-in
    never needed it: it worked inside Fusion, where the user already had the car
    on screen and could click its faces. Here the car arrives as a file, so the
    faces have to be sent to the browser with enough detail to click.

    Nothing is written except the preview model, and no flow region is built, so
    this is free to call as often as the user changes their mind.
    """
    stage_reset()
    uid = caller_uid(request)
    if not uid:
        return jsonify(error="Sign in required."), 401
    refused = limited(uid, "inspect")
    if refused:
        return refused

    b = request.get_json(silent=True) or {}
    step_path = b.get("step_path") or b.get("raw_path") or ""
    if not owned(step_path, uid):
        return jsonify(error="That path is not yours."), 403
    fmt, ext = format_of(step_path)
    if not fmt:
        return jsonify(
            error="Expected a STEP, IGES or STL file. That one ends in "
                  + (ext or "nothing") + "."), 400

    # The version this run produces. Everything it writes lands under v{n}/ so
    # a CAD edit can add v2 without touching what v1's simulations point at.
    try:
        version = int(b.get("version", 1))
    except (TypeError, ValueError):
        return jsonify(error="version must be a whole number."), 400
    if not (1 <= version <= 999):
        return jsonify(error="version must be between 1 and 999."), 400
    vdir = "%s/v%d" % (step_path.rsplit("/", 1)[0], version)

    # A mesh has its own route through: see inspect_mesh for why the solid
    # path cannot be reused for one.
    if fmt == "STL":
        return inspect_mesh(step_path, ext, vdir, version, b)

    try:
        radii = wheel_radii(b)
        wheel_tol = float(b.get("wheel_tolerance", 0.08))
    except (TypeError, ValueError):
        return jsonify(error="Wheel radius and tolerance must be numbers."), 400

    with tempfile.TemporaryDirectory() as tmp:
        local = os.path.join(tmp, "raw" + ext)
        # Ask what the file is before fetching it. On a cache hit there is
        # nothing to fetch: the shape is already in memory and downloading
        # eleven megabytes to throw them away is most of the wait.
        key = blob_key(step_path)
        if not cached_shape_for(key):
            try:
                if not download(step_path, local):
                    return jsonify(error="Could not read the uploaded file."), 404
            except ValueError:
                return jsonify(error="File is too large to open."), 413
        stage("downloaded")

        try:
            imported, reused = import_step_cached(local, key, fmt)
        except ValueError as e:
            return jsonify(error=str(e)), 422
        except Exception as e:
            log.warning("%s import failed: %s", fmt, e)
            return jsonify(error="That %s file could not be read." % fmt), 422

        solids = imported.solids().vals()
        if not solids:
            return jsonify(error="That file contains no solid bodies."), 422

        stage("imported")
        # Triangulate first: it makes the exact bounding box essentially
        # free, and every step after this needs the mesh anyway.
        ensure_meshed(imported.val())
        stage("meshed")
        raw_bbox = exact_bbox(imported.val())
        faces = imported.faces().vals()

        # Turn the car to face the wind before measuring anything, because
        # every measurement below assumes it already does.
        stage("bbox+faces")
        shape, turned, axis_info = orient_to_wind(imported.val(), raw_bbox, faces)
        stage("oriented")
        if turned:
            ensure_meshed(shape)
            raw_bbox = exact_bbox(shape)
            faces = cq.Workplane(obj=shape).faces().vals()
            imported = cq.Workplane(obj=shape)

        try:
            scale, unit = detect_scale(raw_bbox, b.get("unit"))
        except ValueError as e:
            # The size did not settle it on its own. Fall back to what the user
            # said the file was in at upload, rather than refusing: an IGES
            # usually carries no unit at all, and that answer is the only one
            # there is. It is a fallback and not the first choice because a
            # STEP header states its unit and knows better than a dropdown.
            fallback = b.get("input_unit")
            if not fallback:
                return jsonify(error=str(e)), 422
            try:
                scale, unit = detect_scale(raw_bbox, fallback)
            except ValueError as e2:
                return jsonify(error=str(e2)), 422
        bbox_m = {k: [c * scale for c in v] for k, v in raw_bbox.items()}

        try:
            glb, ranges, vranges, tris, mv, mt = to_glb_by_face(faces, shape, tmp, "raw")
            stage("glb")
        except Exception as e:
            log.warning("per-face tessellation failed: %s", e)
            return jsonify(error="That model could not be drawn."), 422

        # One pass over the faces, with the area and centroid taken from the
        # triangles rather than integrated over the real surface. Both are
        # only ever compared against other faces of the same model, so a
        # consistent approximation is worth six seconds.
        meta = survey_faces(faces, scale, mesh_face_stats(mv, mt, ranges, scale))
        boxes = face_boxes(mv, vranges, scale)
        for i, d in enumerate(meta):
            d["tri_start"], d["tri_count"] = ranges[i]
            # start and count are the face's run of vertices, which is what the
            # viewer writes its per-vertex selection attribute over. The
            # triangle range above is the other half: a click gives a triangle
            # index, the highlight needs vertices.
            d["start"], d["count"] = vranges[i]
            d["bbox"] = boxes[i]
        # Which faces meet this one smoothly, so the browser can grow a
        # selection across a tyre split into several patches without asking
        # again. Computed here because only OCC knows.
        stage("survey")
        adjacency = face_adjacency(shape, faces)
        tangent = [[] for _ in faces]
        # Not `a, b`: `b` is the request body in this scope, and rebinding it
        # here made every later b.get() an attribute error on an int.
        for fa, fb, angle in adjacency:
            if angle <= TANGENT_DEGREES:
                tangent[fa].append(fb)
                tangent[fb].append(fa)
        for d, near in zip(meta, tangent):
            d["tangent"] = sorted(near)
        for d, si in zip(meta, solid_of_face(imported.solids().vals(), faces)):
            d["solid"] = si
        stage("solid owners")
        stage("tangents")

        # The whole car's shadow, and the half a symmetric tunnel would see,
        # from one pass over the triangles rather than two. The half is the
        # same rasterisation with the far side of the grid dropped, so doing it
        # twice was eight and a half seconds spent to learn nothing new.
        # Split where the car's own mirror plane is, not at the origin. A half
        # car drawn 6 mm off centre reported a half area equal to its full one,
        # which is the tell that the plane was in the wrong place - and the same
        # wrong plane was about to be used to build the tunnel.
        sym_y_raw, sym_kind = symmetry_plane(mv, mt, scale)
        area_full, area_half = frontal_area_pair(mv, mt, split_at=sym_y_raw)
        stage("frontal area")
        area_full *= scale * scale
        area_half *= scale * scale

        wheels = find_wheels_from(meta, radii, wheel_tol)
        stage("wheels")

        # Adjacency is already computed above, and tangency was derived from
        # it rather than asked of OCC a second time.
        solids_info = solid_summary(imported.solids().vals(), scale)
        stage("adjacency and solids")

        # The STEP is written before faces.json, not after, because the face
        # ids in faces.json are matched against it. Written the other way
        # round the ids are computed after the file that names them has
        # already been serialised, which is a crash if you are lucky.
        step_out = os.path.join(tmp, "geometry.step")
        try:
            write_step(shape, step_out)
        except Exception as e:
            log.warning("STEP export failed: %s", e)
            return jsonify(error="That model could not be converted to STEP."), 422
        stage("step export")

        # Which STEP entity each face became in the file the worker will
        # upload. SimScale names its faces at import and maps those names
        # back to STEP entity numbers, so this is the only id the browser,
        # OCC and SimScale all agree on, and every boundary condition
        # depends on it.
        try:
            step_ids = match_step_ids(step_out, faces)
        except Exception as e:
            log.warning("could not match STEP entity ids: %s", e)
            step_ids = {}
        for i, d in enumerate(meta):
            if i in step_ids:
                d["step_id"] = step_ids[i]
        stage("step ids")

        # Everything for this version, together, so a CAD edit can write v2
        # without disturbing what v1's simulations already point at. The face
        # list is a file rather than a document field because 2219 faces is
        # well past Firestore's 1 MiB limit.
        faces_json = os.path.join(tmp, "faces.json")
        with open(faces_json, "w", encoding="utf-8") as fh:
            json.dump({"version": version, "unit": unit, "scale_to_m": scale,
                       "step_id_count": len(step_ids),
                       "faces": meta, "adjacency": adjacency}, fh)
        solids_json = os.path.join(tmp, "solids.json")
        with open(solids_json, "w", encoding="utf-8") as fh:
            json.dump({"version": version, "solids": solids_info}, fh)

        # Best effort: a card without a picture is a smaller problem than an
        # upload that fails at the last step over a thumbnail.
        thumb = None
        try:
            thumb = render_thumb(mv, mt, os.path.join(tmp, "thumb.png"))
            stage("thumb")
        except Exception as e:
            log.warning("thumbnail failed: %s", e)

        paths = {
            "glb": "%s/model.glb" % vdir,
            "faces": "%s/faces.json" % vdir,
            "solids": "%s/solids.json" % vdir,
            "step": "%s/geometry.step" % vdir,
        }
        if thumb:
            paths["thumb"] = "%s/thumb.png" % vdir
            upload(thumb, paths["thumb"], "image/png")
        upload(glb, paths["glb"], "model/gltf-binary")
        upload(faces_json, paths["faces"], "application/json")
        upload(solids_json, paths["solids"], "application/json")
        upload(step_out, paths["step"], "application/step")
        # The old flat path, so anything still reading it keeps working while
        # the new Workbench is being built alongside the old one.
        glb_path = step_path.rsplit("/", 1)[0] + "/raw.glb"
        upload(glb, glb_path, "model/gltf-binary")
        stage("uploaded")

    # The default box, so the viewer has something to draw before the user drags
    # anything. These are the add-in's own offsets.
    domain = build_domain(bbox_m, wheels, 1.5, 0.5, 0.3, 0.3,
                          bool(b.get("symmetry", True)),
                          symmetry_y=sym_y_raw * scale)
    return jsonify(glb_path=glb_path, bbox=bbox_m, unit=unit, scale_to_m=scale,
                   symmetry_plane_y=round(sym_y_raw * scale, 6), symmetry_kind=sym_kind,
                   version=version, format=fmt, paths=paths,
                   adjacency_count=len(adjacency), solids=solids_info,
                   faces=meta, wheels=wheels, domain=domain,
                   frontal_area_m2=round(area_full, 9),
                   frontal_area_half_m2=round(area_half, 9),
                   rotated_deg=turned, car_axis=axis_info,
                   face_count=len(faces), solid_count=len(solids),
                   # Said at import, because the alternative is finding out
                   # from a mesh that ran for ten minutes and then refused.
                   slivers=sliver_report(meta),
                   triangle_count=tris)


@app.post("/measure")
def measure():
    """The distance between two faces of a model, from the real surfaces.

    Build spec 6.6. The browser has triangles, and the shortest distance
    between two triangle meshes is not the shortest distance between the
    surfaces they approximate. On a fillet against a flat panel the two
    answers differ by the deflection of the mesh, which is exactly the size of
    the gap somebody is trying to measure.

    So this loads the version's own STEP and asks OCC, which walks the real
    B-rep and returns the extremum. That is the number a judge would accept.
    """
    uid = caller_uid(request)
    if not uid:
        return jsonify(error="Sign in required."), 401
    refused = limited(uid, "measure")
    if refused:
        return refused

    b = request.get_json(silent=True) or {}
    step_path = b.get("step_path") or ""
    if not owned(step_path, uid):
        return jsonify(error="That path is not yours."), 403
    ids = b.get("faces") or []
    if not isinstance(ids, list) or len(ids) != 2:
        return jsonify(error="Measuring a distance needs exactly two faces."), 400
    try:
        a_id, b_id = int(ids[0]), int(ids[1])
    except (TypeError, ValueError):
        return jsonify(error="Face ids must be whole numbers."), 400
    if a_id == b_id:
        return jsonify(error="Those are the same face."), 400

    with tempfile.TemporaryDirectory() as tmp:
        local = os.path.join(tmp, "geometry.step")
        key = blob_key(step_path)
        if not cached_shape_for(key):
            try:
                if not download(step_path, local):
                    return jsonify(error="Could not read that model."), 404
            except ValueError:
                return jsonify(error="File is too large to open."), 413
        try:
            imported, _reused = import_step_cached(local, key, "STEP")
        except Exception as e:
            log.warning("measure import failed: %s", e)
            return jsonify(error="That model could not be read."), 422

        faces = imported.faces().vals()
        if not (0 <= a_id < len(faces) and 0 <= b_id < len(faces)):
            return jsonify(error="No such face on this model."), 400
        fa, fb = faces[a_id], faces[b_id]

        try:
            scale, _unit = detect_scale(exact_bbox(imported.val()), b.get("unit"))
        except ValueError:
            scale = 1.0

        ext = BRepExtrema_DistShapeShape(fa.wrapped, fb.wrapped)
        if not ext.IsDone() or ext.NbSolution() < 1:
            return jsonify(error="Those two faces could not be measured."), 422
        smallest = ext.Value() * scale

        # The far corner as well, which is what "longest distance" means in
        # every CAD package: the extremum of the two bounding boxes, not a
        # second B-rep pass, because the far extremum is not well defined on
        # curved surfaces and every package approximates it the same way.
        ba, bb = exact_bbox(fa), exact_bbox(fb)
        largest = max(
            math.dist([ba[k1][i] for i in range(3)], [bb[k2][j] for j in range(3)])
            for k1 in ("min", "max") for k2 in ("min", "max")
        ) * scale

        out = {"min_distance_m": round(smallest, 9),
               "max_distance_m": round(largest, 9)}

        # For two planes, the angle between them and the distance along the
        # normal. Those are the two numbers a designer actually wants from a
        # pair of panels, and they are meaningless for anything curved.
        na, nb = plane_normal(fa), plane_normal(fb)
        if na and nb:
            dot = max(-1.0, min(1.0, sum(x * y for x, y in zip(na, nb))))
            out["angle_deg"] = round(math.degrees(math.acos(abs(dot))), 4)
            ca, cb = fa.Center(), fb.Center()
            gap = [(cb.x - ca.x) * scale, (cb.y - ca.y) * scale, (cb.z - ca.z) * scale]
            out["normal_distance_m"] = round(abs(sum(g * n for g, n in zip(gap, na))), 9)

    return jsonify(**out)


@app.post("/prepare")
def prepare():
    """Raw car STEP in, wind-tunnel flow region plus entity_labels.csv out.

    The add-in's pipeline, step for step: find the wheels, size the tunnel round
    the car, cut the car out of it, export, then read the exported STEP's own
    face ids back and label them.
    """
    stage_reset()
    uid = caller_uid(request)
    if not uid:
        return jsonify(error="Sign in required."), 401
    refused = limited(uid, "prepare")
    if refused:
        return refused

    b = request.get_json(silent=True) or {}
    step_path = b.get("step_path", "")
    dest = (b.get("dest_prefix") or "").rstrip("/")
    if not owned(step_path, uid):
        return jsonify(error="That path is not yours."), 403
    if not owned(dest + "/", uid):
        return jsonify(error="Destination is not yours."), 403
    if not step_path.lower().endswith((".step", ".stp")):
        return jsonify(error="Expected a .step file."), 400

    def num(key, default, lo, hi):
        try:
            v = float(b.get(key, default))
        except (TypeError, ValueError):
            raise ValueError(f"{key} must be a number")
        if not (lo <= v <= hi):
            raise ValueError(f"{key} must be between {lo} and {hi}")
        return v

    try:
        radii = wheel_radii(b)
        wheel_tol = num("wheel_tolerance", 0.08, 0.0, 0.5)
        up = num("upstream_m", 1.5, 0.05, 50.0)
        down = num("downstream_m", 0.5, 0.05, 50.0)
        side = num("side_m", 0.3, 0.01, 10.0)
        top = num("top_m", 0.3, 0.01, 10.0)
    except ValueError as e:
        return jsonify(error=str(e)), 400
    symmetry = bool(b.get("symmetry", True))

    # The version this tunnel becomes. Changing the tunnel is not an edit to
    # the old one: a run queued against v2 must keep solving the v2 tunnel
    # after somebody switches from a half model to a full one.
    try:
        version = int(b.get("version", 1))
    except (TypeError, ValueError):
        return jsonify(error="version must be a whole number."), 400
    if not (1 <= version <= 999):
        return jsonify(error="version must be between 1 and 999."), 400

    # Wheels the user picked by hand in the viewer, which override the automatic
    # search entirely rather than adding to it. Auto-detection finds cylinders
    # about Y of roughly the right size, and on a car whose wheels are modelled
    # as several trimmed surfaces, or whose body has a cylinder of its own, it
    # finds the wrong thing. Picking is the way out of that, so when the user has
    # picked, what they picked is what runs.
    picked_wheels = None
    if b.get("wheels") is not None:
        raw_wheels = b.get("wheels")
        if not isinstance(raw_wheels, list) or not raw_wheels:
            return jsonify(error="wheels must be a non-empty list."), 400
        if len(raw_wheels) > 20:
            return jsonify(error="That is more wheels than a car has."), 400
        picked_wheels = []
        for i, w in enumerate(raw_wheels, start=1):
            if not isinstance(w, dict):
                return jsonify(error="Each wheel must be an object."), 400
            try:
                r = float(w.get("radius_m"))
                cx, cy, cz = (float(w.get("cx_m")), float(w.get("cy_m")),
                              float(w.get("cz_m")))
            except (TypeError, ValueError):
                return jsonify(
                    error="Each wheel needs a radius and a centre."), 400
            # A wheel with no usable radius is the fault that silently strips the
            # boundary condition off those faces, so it is refused here rather
            # than written and demoted later.
            if not (0.001 <= r <= 1.0):
                return jsonify(
                    error=f"Wheel {i} has a radius of {r} m, which is not a "
                          f"wheel. Give a radius between 1 mm and 1 m."), 400
            faces = w.get("face_indices") or []
            picked_wheels.append({
                "name": str(w.get("name") or f"Wheel_{i}")[:40],
                "radius_m": round(r, 6),
                "cx_m": round(cx, 6), "cy_m": round(cy, 6), "cz_m": round(cz, 6),
                "face_indices": [int(f) for f in faces if isinstance(f, int)],
                "source": "picked",
            })

    if remote_exists(f"{dest}/geometry.step"):
        return jsonify(error="This geometry has already been prepared."), 409

    with tempfile.TemporaryDirectory() as tmp:
        raw = os.path.join(tmp, "raw.step")
        try:
            if not download(step_path, raw):
                return jsonify(error="Could not read the uploaded file."), 404
        except ValueError:
            return jsonify(error="File is too large to prepare."), 413

        stage("downloaded")
        try:
            imported, reused = import_step_cached(raw, blob_key(step_path))
        except Exception as e:
            log.warning("STEP import failed: %s", e)
            return jsonify(error="That STEP file could not be read."), 422
        stage("imported (cached)" if reused else "imported")

        solids = imported.solids().vals()
        if not solids:
            return jsonify(error="That file contains no solid bodies."), 422

        # Same two fixes as /inspect, and for the same reasons: triangulate
        # before measuring so the exact box is free, and turn the car to face
        # the wind before building a tunnel that assumes it already does.
        car = imported.val()
        ensure_meshed(car)
        raw_bbox = exact_bbox(car)
        car_faces = imported.faces().vals()

        stage("meshed and measured")
        car, turned, axis_info = orient_to_wind(car, raw_bbox, car_faces)
        stage("oriented")
        if turned:
            ensure_meshed(car)
            raw_bbox = exact_bbox(car)
            imported = cq.Workplane(obj=car)
            car_faces = imported.faces().vals()
            solids = imported.solids().vals()
            log.info("rotated the car %.0f degrees to lie along the wind", turned)

        try:
            scale, unit = detect_scale(raw_bbox, b.get("unit"))
        except ValueError as e:
            return jsonify(error=str(e)), 422

        bbox_m = {k: [c * scale for c in v] for k, v in raw_bbox.items()}
        if picked_wheels is None:
            wheels = find_wheels(car_faces, radii, wheel_tol, scale)
        else:
            wheels = picked_wheels
        # The triangles first, because where the symmetry plane goes is
        # measured from them and the tunnel is built around that.
        mv, mt = mesh_arrays(car, car_faces)
        stage("car triangles")
        sym_y_raw, sym_kind = symmetry_plane(mv, mt, scale)
        stage("symmetry plane")
        # A half-model car in a full-width tunnel is half a car in open air:
        # the flat face on its centreline meets the wind as if it were real
        # bodywork. It builds and solves without complaint, and every number
        # that comes back is for a car nobody designed.
        if sym_kind == "half" and not symmetry:
            return jsonify(
                error="This file is half a car: one side of it is a flat face "
                      "on its centreline. Build it with Width set to Half, "
                      "which mirrors it into the whole car. A full-width "
                      "tunnel would solve half a car in open air."), 422
        # Where to put the symmetry wall, in order of preference.
        #
        # A half model has a flat cut face lying in the plane, and a wall
        # exactly on it is the degenerate boolean this whole nudge exists to
        # avoid. A whole car has no such face - the plane passes through solid
        # bodywork - so it wants no nudge at all.
        #
        # More than one candidate because no single offset is safe. A real car
        # cut perfectly at 0, at 0.5 microns and at 10 microns, and at 2
        # microns - the value this service had always used - the boolean
        # removed its four wheels and left the bodywork standing. Nothing about
        # the geometry predicts which offsets are unlucky, so the cut is tried
        # and measured, and the first one that actually removes the car wins.
        nudges = ([SYMMETRY_NUDGE_M, 0.0, 2e-5, 1e-4]
                  if sym_kind == "half" else [0.0, 2e-5, 1e-4, SYMMETRY_NUDGE_M])
        domain = build_domain(bbox_m, wheels, up, down, side, top, symmetry,
                              symmetry_y=sym_y_raw * scale, nudge=nudges[0])
        if symmetry:
            log.info("symmetry plane at y=%.4f m (%s), car spans %.4f to %.4f",
                     sym_y_raw * scale, sym_kind, bbox_m["min"][1], bbox_m["max"][1])

        # The shadow the car casts into the wind, over exactly the width of
        # tunnel being built. This is the reference area a coefficient needs,
        # and it has to agree with the forces the solver reports: half a tunnel
        # gives half the force and must be paired with half the area.
        area_m2 = frontal_area(
            mv, mt,
            y_lo=min(domain["side_y"], domain["symmetry_y"]) / scale,
            y_hi=max(domain["side_y"], domain["symmetry_y"]) / scale) * scale * scale

        stage("frontal area")
        # Back into the model's own units to build the box, because the solids
        # are still in them and a boolean between mixed scales is meaningless.
        inv = 1.0 / scale

        def tunnel_box(dom):
            """The box for a domain, in the model's own units."""
            ax0, ax1 = dom["outlet_x"] * inv, dom["inlet_x"] * inv
            az0, az1 = dom["ground_z"] * inv, dom["top_z"] * inv
            ay0, ay1 = sorted((dom["side_y"] * inv, dom["symmetry_y"] * inv))
            return (cq.Workplane("XY")
                    .box(ax1 - ax0, ay1 - ay0, az1 - az0, centered=False)
                    .translate((ax0, ay0, az0)))

        try:
            tunnel = tunnel_box(domain)
            # How much of the car the tunnel should take away. A half tunnel
            # is split at the symmetry plane and takes about half; a full one
            # takes all of it. Only an estimate - the car is not perfectly
            # symmetric - but close enough to tell a cut that worked from one
            # that did nothing or ate the whole domain.
            car_volume_raw = sum(volume_of(one) for one in solids)
            expected = expected_removal(car_volume_raw, symmetry, sym_kind)

            # Cut, measure, and move the wall if the car is still standing.
            #
            # "Did it work" cannot be answered by whether the boolean raised,
            # because the failure this guards against does not raise: it
            # returns a tunnel with the wheels taken out and the bodywork left
            # in, which meshes, solves and reports a drag for four wheels
            # flying in formation. Two thirds of the expected volume is the
            # line: a correct cut lands within a few per cent of it, and the
            # wheels-only failure came in at 21%.
            flow, cut_note, best_removed = None, "", -1.0
            for attempt, step in enumerate(nudges if symmetry else [0.0]):
                if attempt:
                    domain = build_domain(bbox_m, wheels, up, down, side, top,
                                          symmetry, symmetry_y=sym_y_raw * scale,
                                          nudge=step)
                    tunnel = tunnel_box(domain)
                got, note = cut_car_out(tunnel.val(), car, solids, expected)
                if got is None:
                    continue
                removed = tunnel.val().Volume() - got.Volume()
                # A cut with a part missing loses to one without, whatever it
                # removed: a car without its front wing is a different car.
                if (flow is None or (cut_note and not note)
                        or (bool(cut_note) == bool(note) and removed > best_removed)):
                    flow, cut_note, best_removed = got, note, removed
                if removed >= expected * 0.66 and not note:
                    if attempt:
                        log.info("symmetry wall moved to %.6g m to get a clean cut", step)
                    break
                log.info("wall at %.6g m removed %.1f of %.1f expected, moving it",
                         step, removed, expected)
            if flow is None:
                return jsonify(
                    error="Could not cut the car out of the wind tunnel. The "
                          "geometry may have gaps or self-intersections."), 422
            if best_removed < expected * 0.66:
                return jsonify(
                    error="The car could not be cut out of the wind tunnel. "
                          "Every position tried left most of the bodywork "
                          "behind, so the tunnel would have solved the wheels "
                          "alone. This usually means the bodywork is not a "
                          "closed solid: check it in your CAD tool."), 422
            stage("cut")
        except Exception as e:
            log.warning("boolean failed: %s", e)
            return jsonify(
                error="Could not cut the car out of the wind tunnel. The "
                      "geometry may have gaps or self-intersections."), 422

        # The cut can leave the void inside the car as its own solid. The
        # external flow region is the biggest thing left.
        pieces = cq.Workplane(obj=flow).solids().vals()
        stage("pieces")
        if not pieces:
            return jsonify(error="The wind tunnel came out empty."), 422
        region = max(pieces, key=lambda s: s.Volume())

        # The one check that catches a boolean which quietly did nothing. A flow
        # region the same size as the box it started as is an empty wind tunnel:
        # it meshes, it solves, it reports a drag of nothing, and it costs the
        # user a run. The yardstick is the car, not the box, because the box is
        # around three thousand times the car's volume and any fraction of it is
        # either far below boolean noise or far above a whole car. A half car
        # against a symmetry plane removes about half, so the floor sits well
        # under that while still being far above nothing.
        car_volume = sum(volume_of(one) for one in solids)
        removed = tunnel.val().Volume() - region.Volume()
        if car_volume <= 0 or removed < car_volume * 0.05:
            log.warning("cut removed %.6g of a car measuring %.6g",
                        removed, car_volume)
            return jsonify(
                error="The car could not be cut out of the wind tunnel. The "
                      "wind tunnel came out empty, so this geometry would "
                      "solve to nothing. Check the STEP file is a solid car "
                      "and not a surface model."), 422

        # And the other end of it, which nothing used to check. A boolean that
        # goes wrong does not always do nothing: cutting this car by a 246 mm3
        # bracket once removed 262,870,338 mm3, the entire wind tunnel, and the
        # only test was whether anything was left. Something was, so it passed.
        # Nothing can remove more of the tunnel than the car occupies.
        if removed > car_volume * 1.5:
            log.warning("cut removed %.6g, more than the whole car at %.6g",
                        removed, car_volume)
            return jsonify(
                error="The car could not be cut out of the wind tunnel. The "
                      "cut took away far more than the car, which means it "
                      "went wrong rather than merely failing. Check the STEP "
                      "file for self-intersecting or inverted faces."), 422

        # Is what came out of the boolean a solid the solver can read?
        #
        # SimScale's importer refuses a shape it cannot make sense of, and it
        # says only that it could not read the geometry - after the user has
        # paid for the run and waited three minutes for the upload. Everything
        # it objects to is knowable here, for nothing, before the tunnel is
        # written.
        #
        # Two things are checked. OCC's own validity analyser, which catches a
        # boolean that produced self-intersecting or unclosed geometry. And the
        # shell count: a solid has one outer shell, and every extra one is a
        # sealed void inside the tunnel. A body that does not touch the car -
        # a wheel floating clear of the bodywork - cuts a bubble of nothing out
        # of the middle of the flow region, and a bubble is not a fluid domain.
        shell_volumes = []
        exp = TopExp_Explorer(region.wrapped, TopAbs_SHELL)
        while exp.More():
            try:
                props = GProp_GProps()
                BRepGProp.VolumeProperties_s(exp.Current(), props)
                shell_volumes.append(abs(props.Mass()) * scale ** 3)
            except Exception:
                shell_volumes.append(0.0)
            exp.Next()
        # The outer shell is the tunnel; everything else is something the cut
        # took out of the middle of it.
        shell_volumes.sort(reverse=True)
        voids = shell_volumes[1:]
        valid = BRepCheck_Analyzer(region.wrapped).IsValid()
        log.info("flow region: valid=%s shells=%d voids=%s volume=%.6g m3",
                 valid, len(shell_volumes),
                 ["%.3g" % v for v in voids], region.Volume() * scale ** 3)

        # Invalid, but with nothing to point at.
        #
        # BRepCheck is stricter than the solver. A correct tunnel around a car
        # whose wheels stand clear of the bodywork comes back "invalid" with no
        # fault on any face, wire or edge: the wheels are sealed voids, which
        # is exactly right - the air flows all the way round them - and the
        # analyzer objects to the shell arrangement rather than to anything a
        # person could repair. Refusing there blocked a tunnel that had removed
        # 100.0% of the car, and the advice it printed ("repair those faces")
        # named no faces because there were none.
        #
        # So: refuse when the fault can be described, and carry on when it
        # cannot. SimScale has meshed regions this analyzer calls invalid.
        if not valid and not faulty_faces(region):
            log.warning("region reports invalid but no face, wire or edge is at "
                        "fault; %d shells, %d voids - continuing", len(shell_volumes),
                        len(voids))
            valid = True
            cut_note = (cut_note or "") + (
                "; " if cut_note else "") + (
                "the tunnel is geometrically correct but OCC does not certify "
                "it as a valid solid")

        if not valid:
            faults = faulty_faces(region)
            lo = [bbox_m["min"][i] / scale for i in range(3)]
            hi = [bbox_m["max"][i] / scale for i in range(3)]
            for f in faults:
                f["where"] = describe_spot(f["centre"], lo, hi, unit)
            where = ""
            if faults:
                # A face and its twin sit in the same place, so the same
                # description twice reads as sloppiness rather than two faces.
                seen, spots = set(), []
                for f in faults:
                    if f["where"] not in seen:
                        seen.add(f["where"])
                        spots.append(f["where"])
                where = (" %d face%s of the car will not orient. Look %s."
                         % (len(faults), "" if len(faults) == 1 else "s",
                            "; and ".join(spots[:2])))
            log.warning("region invalid: %s", faults)
            return jsonify(
                error="The wind tunnel came out of the cut as an invalid solid."
                      + where
                      + " This is a fault in the car rather than the tunnel: "
                        "the usual cause is a face turned inside out, or a face "
                        "boundary that crosses itself. Repair those faces in "
                        "your CAD tool and import the car again.",
                faulty_faces=faults), 422

        # A void is not wrong on its own. A wheel modelled clear of the
        # bodywork leaves a wheel-shaped hole in the middle of the air, and
        # that is exactly right: the air flows all the way round it. What is
        # wrong is a void with no volume - a sliver left behind where the car's
        # cut face lies in the same plane as the tunnel's wall, which is a
        # boolean artefact and the kind of thing a mesher refuses.
        #
        # A cubic tenth of a millimetre is the line. The smallest real part of
        # one of these cars is thousands of times that.
        slivers = [v for v in voids if v < 1e-12]
        if slivers:
            return jsonify(
                error=f"The cut left {len(slivers)} sliver(s) of nothing inside "
                      "the wind tunnel, too small to mesh. This usually happens "
                      "where a flat face of the car lies in exactly the same "
                      "plane as a tunnel wall. Try the full-width tunnel, or "
                      "move the car a little off that plane in your CAD tool."), 422
        stage("validity")

        out_step = os.path.join(tmp, "geometry.step")
        wp = cq.Workplane(obj=region)
        cq.exporters.export(wp, out_step)

        stage("step export")
        with open(out_step, "r", encoding="utf-8", errors="ignore") as f:
            step_text = f.read()
        rows, counts = classify_faces(step_text, domain, wheels, scale)

        stage("classify (STEP text)")
        labels_csv = os.path.join(tmp, "entity_labels.csv")
        demoted = write_labels_csv(labels_csv, rows)
        if demoted:
            counts["car_no_slip"] = counts.get("car_no_slip", 0) + demoted
            counts["rotating_wall"] = max(0, counts.get("rotating_wall", 0) - demoted)

        ensure_meshed(region)
        region_faces = wp.faces().vals()
        out_glb, ranges, vranges, tris, mvr, mtr = to_glb_by_face(
            region_faces, region, tmp, "flow")

        # ── the same artefacts /inspect writes, for the tunnel ────────────
        #
        # Without these the prepared flow region is a STEP and a CSV and
        # nothing else: no model the browser can draw, no face list, and above
        # all no step_id per face. The Workbench's worker resolves a boundary
        # condition by face index -> step_id -> SimScale name (spec_mode.
        # resolve_spec), so a geometry with no faces.json cannot carry one at
        # all. That is why this endpoint has never been reachable from the
        # Workbench: it produced exactly what the *Fusion* worker reads and
        # nothing the queue-mode one does.
        #
        # Everything here is free relative to what has already happened: the
        # region is imported, cut and meshed by this point.
        step_ids = {}
        try:
            step_ids = match_step_ids(out_step, region_faces)
        except Exception as e:
            log.warning("could not match STEP entity ids on the tunnel: %s", e)

        stage("tunnel step ids")
        meta = survey_faces(region_faces, scale,
                            mesh_face_stats(mvr, mtr, ranges, scale))
        stage("tunnel survey")
        boxes = face_boxes(mvr, vranges, scale)
        for i, d in enumerate(meta):
            d["tri_start"], d["tri_count"] = ranges[i]
            d["start"], d["count"] = vranges[i]
            d["bbox"] = boxes[i]
            if i in step_ids:
                d["step_id"] = step_ids[i]

        # Which wall each face is, by face index.
        #
        # From the geometry of the tessellated faces, not from the STEP text.
        # The entity route drops any face match_step_ids cannot pair, and on
        # the first real car that was the symmetry plane - one face out of 151,
        # left with no boundary condition at all.
        per_face = label_faces(meta, domain, wheels, symmetry)
        labels, tunnel_wheels = group_wheel_faces(meta, per_face, wheels)

        # Faces the worker will not be able to name to the solver. A face with
        # no STEP entity id cannot be resolved to a SimScale face, so a
        # boundary condition on it is refused when the run is queued. Better to
        # say which, here, than to have the run refuse itself later.
        unresolvable = sorted(i for i in per_face if i not in step_ids)

        stage("labels")
        adjacency = face_adjacency(region, region_faces)
        stage("tunnel adjacency")
        for d, si in zip(meta, solid_of_face(cq.Workplane(obj=region).solids().vals(),
                                             region_faces)):
            d["solid"] = si

        faces_json = os.path.join(tmp, "faces.json")
        with open(faces_json, "w", encoding="utf-8") as fh:
            json.dump({"version": version, "unit": unit, "scale_to_m": scale,
                       "step_id_count": len(step_ids),
                       "faces": meta, "adjacency": adjacency}, fh)
        solids_json = os.path.join(tmp, "solids.json")
        with open(solids_json, "w", encoding="utf-8") as fh:
            json.dump({"version": version,
                       "solids": solid_summary([region], scale)}, fh)

        paths = {
            "step": f"{dest}/geometry.step",
            "labels": f"{dest}/entity_labels.csv",
            "glb": f"{dest}/geometry.glb",
            "faces": f"{dest}/faces.json",
            "solids": f"{dest}/solids.json",
        }
        stage("wrote json")
        upload(out_step, paths["step"], "application/step")
        upload(labels_csv, paths["labels"], "text/csv")
        upload(out_glb, paths["glb"], "model/gltf-binary")
        upload(faces_json, paths["faces"], "application/json")
        upload(solids_json, paths["solids"], "application/json")
        stage("uploaded")

    # Anything the caller should see before paying for a run. A missing inlet is
    # the failure that produces a run which completes and means nothing, so the
    # counts go back rather than just a success.
    # Checked against the labels the setup is built from, not against the
    # STEP-side tally. The two disagree precisely when a label fails to reach a
    # face index, which is the case this check exists to catch - and while it
    # read `counts` it reported nothing while the symmetry plane went missing.
    wanted = ["inlet", "outlet", "ground", "car_no_slip"]
    if symmetry:
        wanted.append("symmetry")
    missing = [k for k in wanted if not labels.get(k)]
    return jsonify(
        step_path=paths["step"], label_path=paths["labels"], glb_path=paths["glb"],
        paths=paths, version=version,
        bbox=bbox_m, domain=domain, unit=unit, scale_to_m=scale,
        # The wheels found on the car, and the wheels as they exist on the
        # tunnel. They are not the same list: the boolean cut replaces every
        # face, so a face index into the car means nothing on the flow region.
        # Everything downstream assigns boundary conditions on the tunnel, so
        # `wheels` is the tunnel's and `car_wheels` is kept only for support.
        wheels=tunnel_wheels, car_wheels=wheels,
        unresolvable_faces=unresolvable[:50],
        void_count=len(voids), void_volumes_m3=[round(v, 12) for v in voids[:10]],
        symmetry_plane_y=round(sym_y_raw * scale, 6), symmetry_kind=sym_kind,
        labels=labels, label_counts=counts, missing_labels=missing,
        frontal_area_m2=round(area_m2, 9), rotated_deg=turned,
        reference_length_m=round(bbox_m["size"][0], 6),
        face_count=len(meta), solid_count=len(solids),
        triangle_count=tris, demoted_wheel_faces=demoted,
        slivers=sliver_report(meta),
        # Empty unless a body defeated the boolean. Said out loud rather
        # than left in the log, because a part that was not cut out is a
        # part the air flows straight through.
        cut_note=cut_note,
    )


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8080)))
