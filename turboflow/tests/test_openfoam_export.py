"""SimScale's OpenFOAM results become 3D results the Workbench can draw.

SimScale's solution field result offers one export format, OPEN_FOAM: a whole
case, with case.foam, the mesh in constant/polyMesh and a directory per written
time, and no VTK in it. The exporter only understood VTK, so every real run
ended with "No VTK files inside the package" and no 3D results, and the site
told people to send their job id on Instagram to get files back by hand.

This builds a real, if tiny, OpenFOAM case: a 3 x 3 x 3 block of cells with the
middle cell taken out as the car, the six outer walls as the wind tunnel, the
patches named face1..face7 the way SimScale names them. Then it runs the
shipping export against it with the network stubbed, and checks:

  - the case itself is kept for download,
  - the tunnel walls are dropped and only the car is drawn,
  - the fields on the car come through with their values.

Run: python tests/test_openfoam_export.py      (needs pyvista, trimesh)
"""
import io, json, os, pathlib, tempfile, types, zipfile

import numpy as np
import trimesh

SRC = pathlib.Path(__file__).resolve().parents[1] / "services" / "simscale-job" / "simscale_job.py"
text = SRC.read_text(encoding="utf-8")

# ── a tiny OpenFOAM case ────────────────────────────────────────────────────
N = 3
HOLE = (1, 1, 1)                                   # the "car": the middle cell
cells = [(i, j, k) for k in range(N) for j in range(N) for i in range(N) if (i, j, k) != HOLE]
index = {c: n for n, c in enumerate(cells)}
pid = lambda x, y, z: x + (N + 1) * (y + (N + 1) * z)
points = [(x, y, z) for z in range(N + 1) for y in range(N + 1) for x in range(N + 1)]


def quad(axis, at, lo, sign):
    """Four point ids of a unit face on plane axis=at, normal along +/- axis."""
    a, b = lo
    if axis == 0:
        pts = [(at, a, b), (at, a + 1, b), (at, a + 1, b + 1), (at, a, b + 1)]
    elif axis == 1:
        pts = [(a, at, b), (a, at, b + 1), (a + 1, at, b + 1), (a + 1, at, b)]
    else:
        pts = [(a, b, at), (a + 1, b, at), (a + 1, b + 1, at), (a, b + 1, at)]
    ids = [pid(*p) for p in pts]
    return ids if sign > 0 else ids[::-1]


def other(c, axis):
    return tuple(v + (1 if n == axis else 0) for n, v in enumerate(c))


def face_lo(c, axis):
    return tuple(v for n, v in enumerate(c) if n != axis)


internal, walls = [], {}
WALL = {(0, 0): "face1", (0, 1): "face2", (1, 0): "face3", (1, 1): "face4",
        (2, 0): "face5", (2, 1): "face6"}           # outlet, inlet, side, symmetry, road, roof
for c in cells:
    for axis in range(3):
        for sign in (1, -1):
            nb = tuple(v + (sign if n == axis else 0) for n, v in enumerate(c))
            at = c[axis] + (1 if sign > 0 else 0)
            f = quad(axis, at, face_lo(c, axis), sign)
            if nb in index:
                if sign > 0:
                    internal.append((index[c], index[nb], f))
            elif nb == HOLE:
                walls.setdefault("face7", []).append((index[c], f))
            else:
                walls.setdefault(WALL[(axis, 0 if sign < 0 else 1)], []).append((index[c], f))
internal.sort(key=lambda x: (x[0], x[1]))
patches = [f"face{n}" for n in range(1, 8)]
faces = [f for _, _, f in internal] + [f for p in patches for _, f in walls[p]]
owner = [o for o, _, _ in internal] + [o for p in patches for o, _ in walls[p]]
neighbour = [nb for _, nb, _ in internal]

HEAD = "FoamFile\n{{\n    version 2.0;\n    format ascii;\n    class {cls};\n    object {obj};\n}}\n"
case = pathlib.Path(tempfile.mkdtemp()) / "case"
(case / "constant" / "polyMesh").mkdir(parents=True)
(case / "system").mkdir()
(case / "1000").mkdir()
(case / "case.foam").write_text("")
(case / "system" / "controlDict").write_text(
    HEAD.format(cls="dictionary", obj="controlDict")
    + "application simpleFoam;\nstartTime 0;\nendTime 1000;\ndeltaT 1;\nwriteControl timeStep;\nwriteInterval 1000;\n")


def write_list(name, cls, items, fmt):
    body = f"{len(items)}\n(\n" + "\n".join(fmt(x) for x in items) + "\n)\n"
    (case / "constant" / "polyMesh" / name).write_text(HEAD.format(cls=cls, obj=name) + body)


write_list("points", "vectorField", points, lambda p: f"({p[0]} {p[1]} {p[2]})")
write_list("faces", "faceList", faces, lambda f: f"4({f[0]} {f[1]} {f[2]} {f[3]})")
write_list("owner", "labelList", owner, str)
write_list("neighbour", "labelList", neighbour, str)
start, entries = len(internal), []
for p in patches:
    entries.append(f"    {p}\n    {{\n        type wall;\n        nFaces {len(walls[p])};\n"
                   f"        startFace {start};\n    }}")
    start += len(walls[p])
(case / "constant" / "polyMesh" / "boundary").write_text(
    HEAD.format(cls="polyBoundaryMesh", obj="boundary")
    + f"{len(patches)}\n(\n" + "\n".join(entries) + "\n)\n")

CAR_P, CAR_U = 100.0, (3.0, 4.0, 0.0)                 # |U| = 5 on the car
for field, cls, dims, inside, car_value, wall_value in [
        ("p", "volScalarField", "[0 2 -2 0 0 0 0]", "0", f"{CAR_P}", "0"),
        ("U", "volVectorField", "[0 1 -1 0 0 0 0]", "(0 0 0)", "({} {} {})".format(*CAR_U), "(0 0 0)")]:
    bf = "\n".join(
        f"    {p} {{ type fixedValue; value uniform {car_value if p == 'face7' else wall_value}; }}"
        for p in patches)
    (case / "1000" / field).write_text(
        HEAD.format(cls=cls, obj=field)
        + f"dimensions {dims};\ninternalField uniform {inside};\nboundaryField\n{{\n{bf}\n}}\n")

package = io.BytesIO()
with zipfile.ZipFile(package, "w") as z:
    for f in case.rglob("*"):
        if f.is_file():
            z.write(f, f.relative_to(case).as_posix())
package_bytes = package.getvalue()

# ── stub the network, run the shipping code ─────────────────────────────────
uploads = {}


class Response:
    ok, status_code = True, 200
    def __init__(self, payload=None, content=b""):
        self._payload, self._content = payload, content
    def json(self): return self._payload
    def raise_for_status(self): pass
    def iter_content(self, chunk_size=1):
        for i in range(0, len(self._content), chunk_size):
            yield self._content[i:i + chunk_size]
    def __enter__(self): return self
    def __exit__(self, *a): return False


def fake_get(url, **kw):
    if url.endswith("/results"):
        return Response({"_embedded": [
            {"type": "SOLUTION_FIELD", "download": {"url": "https://x/solution.zip"}}]})
    return Response(content=package_bytes)


class Blob:
    def __init__(self, path): self.path = path
    def upload_from_filename(self, local, content_type=None):
        uploads[self.path] = (content_type, open(local, "rb").read())


mod = types.ModuleType("worker")
mod.__dict__.update({
    "requests": types.SimpleNamespace(get=fake_get),
    "log": types.SimpleNamespace(info=lambda *a, **k: None, warning=print, error=print),
    "os": os, "tempfile": tempfile,
    "fb_storage": types.SimpleNamespace(bucket=lambda: types.SimpleNamespace(blob=Blob)),
    "SIMSCALE_API_BASE": "https://api.test/v0", "SIMSCALE_PROJECT_ID": "1", "SIMSCALE_API_KEY": "k",
})
exec(compile(text[text.index("MAX_PACKAGE_BYTES"):text.index("# ── Main ─")], str(SRC), "exec"), mod.__dict__)

manifest = mod.export_results_for_viewer("job-1", "sim-1", "run-1", "users/u/results/j")

checks, failures = 0, []


def ok(what, cond, detail=""):
    global checks
    checks += 1
    if not cond:
        failures.append(f"{what}{': ' + str(detail) if detail else ''}")


ok("an OpenFOAM package produces a manifest", manifest is not None)
manifest = manifest or {}
ok("the case is kept for download", "users/u/results/j/case.zip" in uploads, sorted(uploads))
if "users/u/results/j/case.zip" in uploads:
    ctype, data = uploads["users/u/results/j/case.zip"]
    ok("as the zip SimScale sent, unchanged", data == package_bytes)
    ok("with a zip content type", ctype == "application/zip", ctype)
ok("the manifest says where the case is", manifest.get("case") == "users/u/results/j/case.zip",
   manifest.get("case"))
ok("a surface was drawn", "users/u/results/j/results.glb" in uploads, sorted(uploads))

if "users/u/results/j/results.glb" in uploads:
    mesh = trimesh.load(io.BytesIO(uploads["users/u/results/j/results.glb"][1]),
                        file_type="glb", force="mesh")
    lo, hi = mesh.bounds
    # The car is the unit cube from 1 to 2 on every axis. A surface reaching the
    # 0..3 box means a tunnel wall was drawn as if it were bodywork.
    ok("only the car is drawn, no tunnel wall",
       np.allclose(lo, 1.0, atol=1e-6) and np.allclose(hi, 2.0, atol=1e-6), (lo, hi))
    ok("all six faces of it", len(mesh.faces) == 12, f"{len(mesh.faces)} triangles")
    verts = len(mesh.vertices)
    for name in ("p", "U"):
        path = f"users/u/results/j/fields/{name}.bin"
        ok(f"{name} is exported", path in uploads)
        if path in uploads:
            vals = np.frombuffer(uploads[path][1], dtype=np.float32)
            ok(f"{name} has one value per vertex", len(vals) == verts, f"{len(vals)} for {verts}")
            want = CAR_P if name == "p" else 5.0
            ok(f"{name} carries the car's value", np.allclose(vals, want, atol=1e-3),
               f"{vals.min():.3f}..{vals.max():.3f}, wanted {want}")

print(f"openfoam export: {checks} checks")
if failures:
    print(f"\nFAIL  {len(failures)} of {checks}\n")
    for f in failures:
        print("   -", f)
    raise SystemExit(1)
