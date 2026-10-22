"""The same cut as cut-core.js, done by the geometry service's own functions on
native OCC (cadquery 2.8.0), so the browser's result has something to be
compared against. Functions are lifted out of services/tessellate/main.py the
way tests/test_cut_car_out.py does it, so this runs the server's code and not a
copy of it.

Run: python reference.py <car.step> [--full]
"""
import ast, json, logging, pathlib, re, sys, time, types

import numpy
import cadquery as cq
from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut
from OCP.TopTools import TopTools_ListOfShape
from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.Bnd import Bnd_Box
from OCP.BRepBndLib import BRepBndLib

SRC = pathlib.Path(__file__).resolve().parents[2] / "services" / "tessellate" / "main.py"
WANTED = {"cut_parallel", "cut_car_out", "is_valid_solid", "volume_of", "fuse_bodies",
          "expected_removal", "build_domain", "detect_scale", "exact_bbox",
          "symmetry_plane", "classify_faces"}
CONSTANTS = {"UNITS", "GUESSABLE", "CAR_MIN_M", "CAR_MAX_M", "GROUND_GAP_M",
             "SYMMETRY_NUDGE_M", "DOMAIN_TOL", "MIN_SPAN", "_ENTITY", "_POINT",
             "_FACE_SURF", "_CYL_AXIS", "_AXIS_PT"}

mod = types.ModuleType("server")
mod.__dict__.update({"re": re, "numpy": numpy, "cq": cq, "log": logging.getLogger("server"),
                     "BRepAlgoAPI_Cut": BRepAlgoAPI_Cut, "TopTools_ListOfShape": TopTools_ListOfShape,
                     "BRepCheck_Analyzer": BRepCheck_Analyzer, "Bnd_Box": Bnd_Box,
                     "BRepBndLib": BRepBndLib})
tree = ast.parse(SRC.read_text(encoding="utf-8"))
nodes = [n for n in tree.body
         if (isinstance(n, ast.FunctionDef) and n.name in WANTED)
         or (isinstance(n, ast.Assign) and any(isinstance(t, (ast.Name, ast.Tuple)) and
             ({t.id} if isinstance(t, ast.Name) else {e.id for e in t.elts}) & CONSTANTS
             for t in n.targets))]
exec(compile(ast.Module(body=nodes, type_ignores=[]), str(SRC), "exec"), mod.__dict__)
s = mod

path = sys.argv[1]
symmetry = "--full" not in sys.argv
t0 = time.time()
imported = cq.importers.importStep(path)
solids = imported.solids().vals()
car = imported.val()
raw = s.exact_bbox(car)
scale, unit = s.detect_scale(raw)
verts, tris = car.tessellate(0.1, 0.5)
mv = numpy.array([(p.x, p.y, p.z) for p in verts])
plane, kind = s.symmetry_plane(mv, numpy.array(tris), scale)
bbox_m = {k: [c * scale for c in v] for k, v in raw.items()}
car_volume = sum(s.volume_of(one) for one in solids)
expected = s.expected_removal(car_volume, symmetry, kind)
nudges = ([s.SYMMETRY_NUDGE_M, 0.0, 2e-5, 1e-4] if kind == "half"
          else [0.0, 2e-5, 1e-4, s.SYMMETRY_NUDGE_M]) if symmetry else [0.0]
inv = 1 / scale


def tunnel_box(dom):
    ax0, ax1 = dom["outlet_x"] * inv, dom["inlet_x"] * inv
    az0, az1 = dom["ground_z"] * inv, dom["top_z"] * inv
    ay0, ay1 = sorted((dom["side_y"] * inv, dom["symmetry_y"] * inv))
    return (cq.Workplane("XY").box(ax1 - ax0, ay1 - ay0, az1 - az0, centered=False)
            .translate((ax0, ay0, az0)))


flow = None
for attempt, nudge in enumerate(nudges):
    # No wheels, to match the browser test: the floor goes under the lowest point.
    domain = s.build_domain(bbox_m, [], 1.5, 0.5, 0.3, 0.3, symmetry,
                            symmetry_y=plane * scale, nudge=nudge)
    tunnel = tunnel_box(domain)
    got, note = s.cut_car_out(tunnel.val(), car, solids, expected)
    if got is None:
        continue
    removed = tunnel.val().Volume() - got.Volume()
    if flow is None or removed > best:
        flow, best, attempts, dom, box = got, removed, attempt + 1, domain, tunnel
    if removed >= expected * 0.66 and not note:
        break

region = max(cq.Workplane(obj=flow).solids().vals(), key=lambda one: one.Volume())
removed = box.val().Volume() - region.Volume()
out = "reference-geometry.step"
cq.exporters.export(cq.Workplane(obj=region), out)
rows, counts = s.classify_faces(open(out, encoding="utf-8", errors="ignore").read(), dom, [], scale)
mm3 = (scale * 1000) ** 3
print(json.dumps({
    "unit": unit, "car": kind, "bodies": len(solids),
    "carVolumeMm3": car_volume * mm3, "expectedMm3": expected * mm3,
    "removedMm3": removed * mm3, "removedPct": removed / expected * 100,
    "attempts": attempts, "valid": bool(BRepCheck_Analyzer(region.wrapped).IsValid()),
    "faces": len(rows), "labels": counts, "seconds": round(time.time() - t0, 1),
}, indent=1))
