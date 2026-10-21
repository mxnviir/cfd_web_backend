"""Unpack a SimScale-shaped solution package into the workbench's format.

The real packages are ~1.7 GB, so this builds a small one with the same shape —
a surface .vtp carrying point fields, plus a larger volume .vtu that must be
ignored — and runs the shipping export function against it with the network
stubbed out. That exercises everything except the download itself: file
selection, decimation, field extraction, glTF export and the manifest.

Run: python tests/test_results_export.py      (needs pyvista, trimesh)
"""
import io, json, os, pathlib, types, zipfile

import numpy as np
import pyvista as pv
import trimesh

os.environ["MAX_VIEWER_TRIANGLES"] = "400"        # force the decimation path

# The worker moved to services/simscale-job in the queue-mode rewrite.
SRC = pathlib.Path(__file__).resolve().parents[1] / "services" / "simscale-job" / "simscale_job.py"
text = SRC.read_text(encoding="utf-8")

# ── build a package that looks like SimScale's ──
sphere = pv.Sphere(radius=0.1, theta_resolution=40, phi_resolution=40).triangulate()
n = sphere.n_points
sphere.point_data["p"] = np.linspace(-250.0, 480.0, n).astype(np.float32)
sphere.point_data["U"] = np.tile(np.array([3.0, 4.0, 0.0], dtype=np.float32), (n, 1))  # |U| = 5
sphere.point_data["k"] = np.full(n, 0.75, dtype=np.float32)
volume = pv.ImageData(dimensions=(20, 20, 20)).cast_to_unstructured_grid()

work = pathlib.Path(os.environ.get("TEMP", "/tmp")) / "tf_results_test"
work.mkdir(exist_ok=True)
sphere.save(work / "boundary.vtp")
volume.save(work / "internal.vtu")
pkg = io.BytesIO()
with zipfile.ZipFile(pkg, "w") as z:
    z.write(work / "internal.vtu", "case/internal.vtu")     # bigger, must be skipped
    z.write(work / "boundary.vtp", "case/boundary.vtp")
package_bytes = pkg.getvalue()
assert len(package_bytes) > 0

# ── stub the network: serve the package, capture the uploads ──
uploads = {}

class FakeResponse:
    def __init__(self, *, content=b"", payload=None, ok=True, status=200):
        self.content, self._payload, self.ok, self.status_code = content, payload, ok, status
        self.text = content.decode("utf-8", "ignore")
    def json(self): return self._payload
    def raise_for_status(self):
        if not self.ok: raise RuntimeError(self.status_code)
    def iter_content(self, chunk_size=1):
        for i in range(0, len(self.content), chunk_size):
            yield self.content[i:i + chunk_size]
    def __enter__(self): return self
    def __exit__(self, *a): return False

def fake_get(url, **kw):
    if url.endswith("/results"):
        return FakeResponse(payload={"_embedded": [
            {"type": "CONVERGENCE_PLOT", "download": {"url": "x"}},
            {"type": "SOLUTION_FIELD", "download": {"url": "https://example.test/solution.zip"}},
        ]})
    if "solution.zip" in url:
        return FakeResponse(content=package_bytes)
    raise AssertionError("unexpected GET " + url)

def fake_post(url, **kw):
    key = url.split("/cfd-files/", 1)[1]
    data = kw["data"]
    uploads[key] = data.read() if hasattr(data, "read") else data
    return FakeResponse()

# Uploads go to Firebase Storage now, not Supabase. The worker's upload_file
# calls fb_storage.bucket().blob(path).upload_from_filename(local), so that is
# the shape the stub has to have; the Supabase names below it are dead and
# harmless, kept only because slicing the module still mentions them.
class FakeBlob:
    def __init__(self, path): self.path = path
    def upload_from_filename(self, local, content_type=None):
        with open(local, "rb") as fh:
            uploads[self.path] = fh.read()

class FakeBucket:
    def blob(self, path): return FakeBlob(path)

mod = types.ModuleType("worker")
mod.__dict__.update({
    "requests": types.SimpleNamespace(get=fake_get, post=fake_post),
    "log": types.SimpleNamespace(info=lambda *a, **k: None, warning=print, error=print),
    "os": os, "tempfile": __import__("tempfile"),
    "fb_storage": types.SimpleNamespace(bucket=lambda: FakeBucket()),
    "SIMSCALE_API_BASE": "https://api.test/v0", "SIMSCALE_PROJECT_ID": "1",
    "SIMSCALE_API_KEY": "k",
})
start = text.index("MAX_PACKAGE_BYTES")
exec(compile(text[start:text.index("# ── Main ─")], "simscale_job.py", "exec"), mod.__dict__)

manifest = mod.export_results_for_viewer("job-1", "sim-1", "run-1", "jobs/u/j")
assert manifest, "no manifest returned"

# ── what the workbench needs must all be there ──
assert set(uploads) >= {"jobs/u/j/results.glb", "jobs/u/j/fields/p.bin",
                        "jobs/u/j/fields/U.bin", "jobs/u/j/fields.json"}, sorted(uploads)
assert "jobs/u/j/fields/k.bin" in uploads, "k was present in the data and should be exported"

glb = uploads["jobs/u/j/results.glb"]
assert glb[:4] == b"glTF", "results.glb is not a glTF file"
mesh = trimesh.load(io.BytesIO(glb), file_type="glb", force="mesh")
tris, verts = len(mesh.faces), len(mesh.vertices)

# decimation: the sphere has thousands of triangles, the budget is 400
assert sphere.n_cells > 2000, "test fixture is too small to prove decimation"
assert tris <= 400 * 1.1, f"decimation ignored: {tris} triangles for a 400 budget"
assert tris > 50, f"decimated into nothing: {tris} triangles"

# one float per vertex, matching the glb that will be drawn with it
for name in ("p", "U", "k"):
    raw = uploads[f"jobs/u/j/fields/{name}.bin"]
    assert len(raw) == verts * 4, f"{name}: {len(raw)} bytes for {verts} vertices"

# vectors are stored as magnitude, not as three components
u_vals = np.frombuffer(uploads["jobs/u/j/fields/U.bin"], dtype=np.float32)
assert np.allclose(u_vals, 5.0, atol=1e-3), f"|U| should be 5.0, got {u_vals[:3]}"

# ranges drive the legend, so they have to survive decimation
man = json.loads(uploads["jobs/u/j/fields.json"])
p_range = man["fields"]["p"]
assert -260 < p_range["min"] < -240 and 470 < p_range["max"] < 490, p_range
assert man["fields"]["k"]["min"] == man["fields"]["k"]["max"] == 0.75, "constant field kept its value"
assert man["vertexCount"] == verts and man["triangleCount"] == tris
assert man["glb"] == "jobs/u/j/results.glb"
assert p_range["label"] == "Pressure", "fields carry a human-readable label"

total_kb = sum(len(v) for v in uploads.values()) / 1024
print(f"package {len(package_bytes)/1024:.0f} KB in -> "
      f"{tris} triangles, {len(man['fields'])} fields, {total_kb:.0f} KB out")
print("ok - solution package unpacks into glb + field binaries the viewer can read")
