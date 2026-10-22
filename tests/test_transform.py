"""Exercise the CAD edit operations against a real solid.

apply_ops is source-sliced out of tessellate/main.py so the geometry maths under
test is the code that ships — main.py itself imports flask, which a test box does
not need.

Run: python tests/test_transform.py      (needs cadquery)
"""
import pathlib, types, math

import ast
import cadquery as cq

from OCP.Bnd import Bnd_Box
from OCP.BRepBndLib import BRepBndLib

# The services were gathered under services/ in the queue-mode rewrite.
SRC = pathlib.Path(__file__).resolve().parents[1] / "services" / "tessellate" / "main.py"
text = SRC.read_text(encoding="utf-8")

# Pulled out by name, not by slicing between two markers.
#
# The old version cut from "def exact_bbox" to "def caller_uid" and from
# "def apply_ops" to '@app.route("/transform"'. main.py has since been
# reordered and both end markers now appear *before* their function, so both
# slices came out empty and the module defined nothing. The test failed with
# "module 'ops' has no attribute 'apply_ops'", which reads like deleted code
# and was really a moved line.
mod = types.ModuleType("ops")
mod.__dict__.update({"cq": cq, "Bnd_Box": Bnd_Box, "BRepBndLib": BRepBndLib})
tree = ast.parse(text)
wanted = {"exact_bbox", "apply_ops"}
found = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in wanted]
missing = wanted - {n.name for n in found}
if missing:
    raise SystemExit(f"tessellate/main.py no longer defines: {sorted(missing)}")
exec(compile(ast.Module(body=found, type_ignores=[]), str(SRC), "exec"), mod.__dict__)
apply_ops, exact_bbox = mod.apply_ops, mod.exact_bbox

# A deliberately asymmetric solid: a symmetric one would hide mirror bugs.
base = (cq.Workplane("XY").box(0.200, 0.100, 0.050)
        .faces(">Z").workplane().rect(0.05, 0.02).extrude(0.02)
        .translate((0.03, 0.01, 0)))
shape = base.val()
bb0 = shape.BoundingBox()
vol0 = shape.Volume()

def bbox(s):
    b = s.BoundingBox()
    return (b.xlen, b.ylen, b.zlen), (b.xmin, b.ymin, b.zmin)

def close(a, b, tol=1e-6):
    assert abs(a - b) <= tol * max(1.0, abs(b)), f"{a} != {b}"

# ── translate: bbox moves, size and volume do not ──
moved = apply_ops(shape, [{"type": "translate", "dx": 0.5, "dy": -0.25, "dz": 0.1}])
(sz, mn) = bbox(moved)
close(sz[0], bb0.xlen); close(sz[1], bb0.ylen); close(sz[2], bb0.zlen)
close(mn[0], bb0.xmin + 0.5); close(mn[1], bb0.ymin - 0.25); close(mn[2], bb0.zmin + 0.1)
close(moved.Volume(), vol0)

# ── scale: every dimension by the factor, volume by the cube ──
scaled = apply_ops(shape, [{"type": "scale", "factor": 2.0}])
(sz, _) = bbox(scaled)
close(sz[0], bb0.xlen * 2); close(sz[1], bb0.ylen * 2); close(sz[2], bb0.zlen * 2)
close(scaled.Volume(), vol0 * 8, tol=1e-4)

# ── rotate 90 deg about Z: x and y extents swap ──
rot = apply_ops(shape, [{"type": "rotate", "axis": "z", "degrees": 90}])
(sz, _) = bbox(rot)
close(sz[0], bb0.ylen, tol=1e-5); close(sz[1], bb0.xlen, tol=1e-5)
close(rot.Volume(), vol0, tol=1e-4)

# ── rotate 360 deg is identity ──
spun = apply_ops(shape, [{"type": "rotate", "axis": "y", "degrees": 360}])
(sz, _) = bbox(spun)
close(sz[0], bb0.xlen, tol=1e-5); close(sz[2], bb0.zlen, tol=1e-5)

# ── mirror about the Y axis plane: volume kept, asymmetry flips ──
mirrored = apply_ops(shape, [{"type": "mirror", "axis": "y"}])
close(mirrored.Volume(), vol0, tol=1e-4)
(sz, mn) = bbox(mirrored)
close(sz[1], bb0.ylen, tol=1e-5)
assert abs(mn[1] - bb0.ymin) > 1e-9, "mirror about Y did not move the asymmetric feature"

# ── ops compose in order ──
chained = apply_ops(shape, [{"type": "scale", "factor": 2},
                            {"type": "translate", "dx": 1.0}])
(sz, mn) = bbox(chained)
close(sz[0], bb0.xlen * 2)
close(mn[0], bb0.xmin * 2 + 1.0, tol=1e-5)

# ── guards ──
for bad, why in [
    ([{"type": "scale", "factor": 0}], "zero scale"),
    ([{"type": "scale", "factor": 1e6}], "runaway scale"),
    ([{"type": "rotate", "axis": "q"}], "bad axis"),
    ([{"type": "explode"}], "unknown op"),
    ([{"type": "translate"}] * 33, "too many ops"),
    ("not-a-list", "non-list"),
]:
    try:
        apply_ops(shape, bad)
    except ValueError:
        pass
    else:
        raise AssertionError(f"{why} was accepted")

# ── the reported bounding box must be exact, not merely close ──
# Regression: on cadquery 2.5.2 (what the container pins) Shape.BoundingBox()
# is non-optimal after a transform and reported a 0.4 m part as 0.40077 m.
# That number sizes the wind tunnel around the car, so "close" is not good
# enough. exact_bbox uses BRepBndLib.AddOptimal_s, which is exact on any version.
base_box = exact_bbox(shape)
for factor in (2.0, 0.5, 3.7):
    got = exact_bbox(apply_ops(shape, [{"type": "scale", "factor": factor}]))["size"]
    for axis, (g, b) in enumerate(zip(got, base_box["size"])):
        assert abs(g - b * factor) < 1e-9, (
            f"scale {factor}, axis {axis}: {g} != {b * factor} "
            f"(off by {abs(g - b * factor):.2e} m)")

# a pure move must not change the size at all
moved_box = exact_bbox(apply_ops(shape, [{"type": "translate", "dx": 1.234}]))["size"]
for g, b in zip(moved_box, base_box["size"]):
    assert abs(g - b) < 1e-12, f"translate changed a dimension: {g} != {b}"

print(f"base solid: {vol0 * 1e6:.2f} cm^3, bbox {bb0.xlen:.3f} x {bb0.ylen:.3f} x {bb0.zlen:.3f} m")
print(f"exact bbox: {' x '.join(f'{v:.6f}' for v in base_box['size'])} m, scales exactly")
print("ok - translate, scale, rotate, mirror, composition and guards all hold")
