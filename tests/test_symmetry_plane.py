"""Where the symmetry plane goes, on cars that are not drawn on the origin.

build_domain assumed the plane was y = 0 and said so in a comment: "assumes the
car itself is modelled as a half about y = 0". The first real car put through
the automatic setup spans y = -36.5 mm to y = +6.1 mm - a half car drawn 6 mm
off the origin - so the plane sliced 6 mm of centreline bodywork off, threw it
away, and mirrored the rest. That solves, converges and reports a drag for a
car nobody designed.

Nothing about that is visible in a result, so it is checked here instead, on
meshes built to be exactly the cases that occur. No OCC: symmetry_plane reads
triangles, and triangles can be written down.

Run: python tests/test_symmetry_plane.py      (needs numpy)
"""
import pathlib, types, ast

import numpy

SRC = pathlib.Path(__file__).resolve().parents[1] / "services" / "tessellate" / "main.py"

mod = types.ModuleType("sym")
mod.__dict__.update({"numpy": numpy, "SYMMETRY_NUDGE_M": 2e-6,
                     "GROUND_GAP_M": 1e-4})
tree = ast.parse(SRC.read_text(encoding="utf-8"))
# _shadow_grid too: deciding whether a car is a half model is a question about
# its silhouette, and the silhouette is what that function rasterises.
wanted = {"symmetry_plane", "build_domain"}
found = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in wanted]
missing = wanted - {n.name for n in found}
if missing:
    raise SystemExit(f"tessellate/main.py no longer defines: {sorted(missing)}")
exec(compile(ast.Module(body=found, type_ignores=[]), str(SRC), "exec"), mod.__dict__)
symmetry_plane, build_domain = mod.symmetry_plane, mod.build_domain

checks = 0
failures = []


def ok(what, condition, detail=""):
    global checks
    checks += 1
    if not condition:
        failures.append(f"{what}\n     {detail}")


def close(what, got, want, tol=1e-6):
    ok(what, abs(got - want) < tol, f"got {got!r}, expected {want!r}")


def quad(p0, p1, p2, p3, verts, tris):
    """Two triangles making a flat rectangle, appended to the arrays."""
    base = len(verts)
    verts.extend([p0, p1, p2, p3])
    tris.append((base, base + 1, base + 2))
    tris.append((base, base + 2, base + 3))


def curved_side(y_out, out, x0, x1, z0, z1, verts, tris, radius=0.100, n=48):
    """A flank curved like real bodywork, tessellated finely.

    This is the fixture the earlier taper was hiding. Near its widest point a
    gentle curve is flat to within a tenth of a millimetre over a strip several
    millimetres tall, so a fine tessellation puts a real slab of "flat" area
    exactly in the plane of the extreme - and a rule that only asks whether one
    side has enough flat area there calls a whole car a half one.
    """
    half = (z1 - z0) / 2
    zm = (z0 + z1) / 2
    for i in range(n):
        za = z0 + (z1 - z0) * i / n
        zb = z0 + (z1 - z0) * (i + 1) / n
        # A circular arc of the given radius, deepest at mid height.
        da = radius - (radius ** 2 - min((za - zm) ** 2, radius ** 2 * 0.99)) ** 0.5
        db = radius - (radius ** 2 - min((zb - zm) ** 2, radius ** 2 * 0.99)) ** 0.5
        ya = y_out - out * da
        yb = y_out - out * db
        quad((x0, ya, za), (x1, ya, za), (x1, yb, zb), (x0, yb, zb), verts, tris)


def bbox_of(verts):
    v = numpy.asarray(verts, dtype=float)
    lo, hi = v.min(0), v.max(0)
    return {"min": list(lo), "max": list(hi), "size": list(hi - lo)}


def tapered_side(y_out, out, x0, x1, z0, z1, verts, tris, taper=0.004):
    """A flank whose widest point is a line, not a face.

    That is the one property that tells a whole car from a half one, so the
    fixture has to have it unambiguously. An earlier version of this helper
    used a sine bulge, and near the apex two neighbouring strips differed in y
    by less than the function's own flatness tolerance - so the flank itself
    came within a hair of registering as a flat cut face, and whether this test
    passed depended on the segment count. A taper has no such point: every
    facet is tilted well away from the y plane.

    `out` is +1 or -1 and says which way is outward, rather than being guessed
    from the sign of y. Guessing is what made the previous version report the
    wrong bounding box for a car drawn entirely on one side of the origin.
    """
    y_in = y_out - out * taper
    zm = (z0 + z1) / 2
    quad((x0, y_in, z0), (x1, y_in, z0), (x1, y_out, zm), (x0, y_out, zm), verts, tris)
    quad((x0, y_out, zm), (x1, y_out, zm), (x1, y_in, z1), (x0, y_in, z1), verts, tris)


# ── 1. the real car that found this ─────────────────────────────────────────
# A half model, 227 mm long, 43 mm tall, spanning y = -36.5 to +6.1, with its
# flat cut face at +6.1.
verts, tris = [], []
quad((-0.0151, 0.0061, 0.0), (0.2119, 0.0061, 0.0),
     (0.2119, 0.0061, 0.0432), (-0.0151, 0.0061, 0.0432), verts, tris)
tapered_side(-0.0365, -1, -0.0151, 0.2119, 0.0, 0.0432, verts, tris)
y, kind = symmetry_plane(verts, tris, 1.0)
ok("a half car drawn off the origin is recognised", kind == "half", f"got {kind}")
close("and its plane is its own flat face, not zero", y, 0.0061, 1e-9)
ok("which is not what the old code used", abs(y - 0.0) > 1e-4)

# ── 2. a half car whose flat face is at the low side ────────────────────────
verts, tris = [], []
quad((0, -0.010, 0), (0.2, -0.010, 0), (0.2, -0.010, 0.05), (0, -0.010, 0.05), verts, tris)
tapered_side(0.033, +1, 0, 0.2, 0, 0.05, verts, tris)
y, kind = symmetry_plane(verts, tris, 1.0)
ok("a half car mirrored the other way is recognised", kind == "half", f"got {kind}")
close("and its plane is the low face", y, -0.010, 1e-9)

# ── 3. a whole car has no flat face at either extreme ───────────────────────
verts, tris = [], []
tapered_side(-0.0425, -1, 0, 0.2, 0, 0.05, verts, tris)
tapered_side(0.0425, +1, 0, 0.2, 0, 0.05, verts, tris)
quad((0, -0.0425, 0), (0.2, -0.0425, 0), (0.2, 0.0425, 0), (0, 0.0425, 0), verts, tris)
y, kind = symmetry_plane(verts, tris, 1.0)
ok("a whole car is not mistaken for a half one", kind == "centre", f"got {kind}")
close("and is cut down its own middle", y, 0.0, 1e-6)

# ── 4. a whole car drawn far from the origin ────────────────────────────────
verts, tris = [], []
tapered_side(0.100, -1, 0, 0.2, 0, 0.05, verts, tris)
tapered_side(0.185, +1, 0, 0.2, 0, 0.05, verts, tris)
quad((0, 0.100, 0), (0.2, 0.100, 0), (0.2, 0.185, 0), (0, 0.185, 0), verts, tris)
y, kind = symmetry_plane(verts, tris, 1.0)
ok("a whole car off the origin is still whole", kind == "centre", f"got {kind}")
close("and is cut down its own middle, not at zero", y, 0.1425, 1e-6)

# ── 4b. a whole car with a small flat panel at its widest point ─────────────
# Every fixture above this line has no y-facing flat geometry at all, so they
# all leave symmetry_plane through its early exit and none of them reaches the
# share threshold or the final return. Mutation testing found that: dropping
# the threshold to -1, and replacing the final return with a bare zero, both
# left the suite green. A real car has flat patches - a mirror housing, a
# sponsor plate - and the question is whether one is big enough to be a cut
# face. This one is not, and it must not be treated as one.
verts, tris = [], []
tapered_side(0.100, -1, 0, 0.2, 0, 0.05, verts, tris)
tapered_side(0.185, +1, 0, 0.2, 0, 0.05, verts, tris)
quad((0, 0.100, 0), (0.2, 0.100, 0), (0.2, 0.185, 0), (0, 0.185, 0), verts, tris)
# 20 mm x 20 mm of flat, against a 200 x 50 profile: 4% of it.
quad((0.09, 0.185, 0.01), (0.11, 0.185, 0.01),
     (0.11, 0.185, 0.03), (0.09, 0.185, 0.03), verts, tris)
y, kind = symmetry_plane(verts, tris, 1.0)
ok("a small flat panel is not a cut face", kind == "centre", f"got {kind}")
close("and the car is still cut down its own middle", y, 0.1425, 1e-6)

# The same car with that panel grown to most of its side, which is what an
# actual cut face looks like. The threshold has to separate these two or it is
# not a threshold.
verts, tris = [], []
tapered_side(0.100, -1, 0, 0.2, 0, 0.05, verts, tris)
quad((0, 0.185, 0), (0.2, 0.185, 0), (0.2, 0.185, 0.05), (0, 0.185, 0.05), verts, tris)
y, kind = symmetry_plane(verts, tris, 1.0)
ok("a full-height flat face is a cut face", kind == "half", f"got {kind}")
close("at that face", y, 0.185, 1e-9)

# ── 4c. a whole car with real curved flanks ─────────────────────────────────
# The case the taper fixtures could not express. Both flanks are curved, so
# both have flat area at their extremes; neither is a cut face.
verts, tris = [], []
curved_side(-0.0425, -1, 0, 0.2, 0, 0.05, verts, tris)
curved_side(0.0425, +1, 0, 0.2, 0, 0.05, verts, tris)
y, kind = symmetry_plane(verts, tris, 1.0)
ok("two curved flanks are not a cut face", kind == "centre", f"got {kind}")
close("and the car is cut down its own middle", y, 0.0, 1e-3)

# One flank curved, the other flat: that is a half model, and it has to still
# be recognised as one now that the rule compares the two sides.
verts, tris = [], []
curved_side(-0.0425, -1, 0, 0.2, 0, 0.05, verts, tris)
quad((0, 0.0, 0), (0.2, 0.0, 0), (0.2, 0.0, 0.05), (0, 0.0, 0.05), verts, tris)
y, kind = symmetry_plane(verts, tris, 1.0)
ok("one curved flank and one flat face is a half model", kind == "half", f"got {kind}")
close("cut at the flat face", y, 0.0, 1e-9)

# ── 4d. a whole car with slab sides ─────────────────────────────────────────
# Flanks so gently curved that each is itself flat over almost all of its
# height: both sides score about 0.98, past any coverage threshold that still
# accepts a real cut face. Only comparing the two sides separates this from a
# half model, and dropping that comparison left the suite green until this
# case existed.
verts, tris = [], []
curved_side(-0.0425, -1, 0, 0.2, 0, 0.05, verts, tris, radius=0.300)
curved_side(0.0425, +1, 0, 0.2, 0, 0.05, verts, tris, radius=0.300)
y, kind = symmetry_plane(verts, tris, 1.0)
ok("slab sides on both flanks are not treated as a cut face",
   kind in ("centre", "ambiguous"), f"got {kind}")

# The same car cut in half: one slab flank, one real cut face. Measured by how
# much surface sits in each end plane rather than by per-triangle flatness,
# these do separate - a 300 mm radius still only puts a 15 mm band in the
# plane, against a cut face that is all of it.
verts, tris = [], []
curved_side(-0.0425, -1, 0, 0.2, 0, 0.05, verts, tris, radius=0.300)
quad((0, 0.0, 0), (0.2, 0.0, 0), (0.2, 0.0, 0.05), (0, 0.0, 0.05), verts, tris)
y, kind = symmetry_plane(verts, tris, 1.0)
ok("a slab flank against a cut face is still a half model",
   kind == "half", f"got {kind}")
close("cut at the flat face", y, 0.0, 1e-9)

# ── 4e. a wide, low car ─────────────────────────────────────────────────────
# Every fixture above happens to be about as wide as it is tall, so measuring
# the side silhouette as length x width instead of length x height changed
# almost nothing and the suite stayed green. A STEM Racing car is twice as wide
# as it is tall, and on this one the two readings differ by more than three.
verts, tris = [], []
quad((0, 0.0, 0), (0.2, 0.0, 0), (0.2, 0.0, 0.025), (0, 0.0, 0.025), verts, tris)
tapered_side(-0.080, -1, 0, 0.2, 0, 0.025, verts, tris)
y, kind = symmetry_plane(verts, tris, 1.0)
ok("a wide low half car is recognised", kind == "half", f"got {kind}")
close("at its cut face", y, 0.0, 1e-9)

# ── 4g. a whole car whose two flanks are not identical ──────────────────────
# Every whole-car fixture above has flanks of exactly the same shape, so the
# two sides score exactly the same and any ratio above 1.0 separates them.
# Loosening the margin from 2x to 1.05x left the suite green because of that.
# A real car is not symmetric to the last triangle - a mirror on one side, a
# vent on the other - so the margin has to survive flanks that merely differ.
# Tessellated finely, because at 48 strips a 100 mm and a 130 mm radius both
# put exactly one strip in the plane and score identically - so the margin was
# never exercised and loosening it from 2x to 1.05x left the suite green. At a
# realistic density they score 0.200 and 0.175, which is the 1.14x a real pair
# of flanks differ by and what the margin has to sit above.
verts, tris = [], []
curved_side(-0.0425, -1, 0, 0.2, 0, 0.05, verts, tris, radius=0.100, n=400)
curved_side(0.0425, +1, 0, 0.2, 0, 0.05, verts, tris, radius=0.130, n=400)
y, kind = symmetry_plane(verts, tris, 1.0)
ok("flanks that merely differ are still two flanks", kind == "centre", f"got {kind}")

# ── 4i. a rectangular block ─────────────────────────────────────────────────
# Two parallel faces, both entirely in their own plane. This is the one shape
# that genuinely cannot be told apart - a blunt test block and a half of a
# blunt test block look identical from either end - and it is what the
# "ambiguous" answer is for. Calling it whole would halve a half.
verts, tris = [], []
quad((0, 0, 0), (0.2, 0, 0), (0.2, 0, 0.05), (0, 0, 0.05), verts, tris)
quad((0, -0.04, 0), (0.2, -0.04, 0), (0.2, -0.04, 0.05), (0, -0.04, 0.05), verts, tris)
y, kind = symmetry_plane(verts, tris, 1.0)
ok("a rectangular block is reported as ambiguous", kind == "ambiguous", f"got {kind}")

# ── 4h. a wide, shallow car with a modest cut face ──────────────────────────
# The cut face is 18% of this car's side profile - over the floor - but only 6%
# of its length times its width. Measuring the silhouette with the wrong pair
# of axes therefore calls this car whole and cuts it in half again. Every other
# fixture is either about as wide as it is tall, or has a cut face so large
# that both readings clear the floor, so none of them noticed.
verts, tris = [], []
L, W, H = 0.2, 0.06, 0.02
quad((0, 0, 0), (L, 0, 0), (L, 0, 0.0036), (0, 0, 0.0036), verts, tris)
quad((0, -W, 0), (L, -W, 0), (L, -W, 0.00025), (0, -W, 0.00025), verts, tris)
quad((0, -W, H), (L, -W, H), (L, 0, H), (0, 0, H), verts, tris)
y, kind = symmetry_plane(verts, tris, 1.0)
ok("a wide shallow half car is recognised", kind == "half", f"got {kind}")
close("at its cut face", y, 0.0, 1e-9)

# ── 4f. the real car, by its measured numbers ───────────────────────────────
# car(17.3).step, read off its own faces.json: 227 x 43.2 mm in profile, with
# 41.1 cm2 of y-facing flat area at y = 0 and 6.2 cm2 at the far flank. Every
# solid in it stops at y = 0, so y = 0 is the cut and the answer is not close.
#
# Two ways of getting this wrong are pinned here because both were shipped.
# The bounding box says the car reaches y = +6.1 mm - OCC's AddOptimal pads a
# B-spline - so a rule that reads the box instead of the mesh puts the plane
# 15 mm inside the car. And 41.1 cm2 is only 42% of the side profile, because
# a car does not fill its own silhouette, so a rule that wants a cut face to
# cover half of it calls this car whole.
verts, tris = [], []
LEN, HGT = 0.227, 0.0432
# the cut face at y = 0: 41.1 cm2
quad((0, 0, 0), (LEN, 0, 0), (LEN, 0, 0.0181), (0, 0, 0.0181), verts, tris)
# the flank at y = -36.5 mm: 6.2 cm2 of flat
quad((0, -0.0365, 0), (LEN, -0.0365, 0),
     (LEN, -0.0365, 0.00273), (0, -0.0365, 0.00273), verts, tris)
# something spanning the full profile, so the extents are the car's
quad((0, -0.0365, HGT), (LEN, -0.0365, HGT), (LEN, 0, HGT), (0, 0, HGT), verts, tris)
y, kind = symmetry_plane(verts, tris, 1.0)
ok("the real car is recognised as a half model", kind == "half", f"got {kind}")
close("with its plane on the cut face at y = 0", y, 0.0, 1e-9)

# ── 5. millimetres ──────────────────────────────────────────────────────────
# The same car as case 1 with the numbers in millimetres and scale 0.001. The
# tolerance inside the function is a millimetre expressed in model units, so a
# file in millimetres must give the same answer in millimetres.
verts, tris = [], []
quad((-15.1, 6.1, 0), (211.9, 6.1, 0), (211.9, 6.1, 43.2), (-15.1, 6.1, 43.2), verts, tris)
tapered_side(-36.5, -1, -15.1, 211.9, 0, 43.2, verts, tris, taper=4.0)
y, kind = symmetry_plane(verts, tris, 0.001)
ok("a millimetre file is read the same way", kind == "half", f"got {kind}")
close("in its own units", y, 6.1, 1e-6)

# ── 5b. a cut face that is not perfectly flat ───────────────────────────────
# Exported CAD is not exact: a face meant to be planar can wander by a few
# hundredths of a millimetre. The flatness tolerance is 0.1 mm expressed in the
# file's own units, and dropping the unit conversion left this suite green
# because every other fixture is flat to the bit. In millimetres, a face that
# wanders 0.05 mm is still a cut face.
verts, tris = [], []
quad((-15.1, 6.10, 0), (211.9, 6.10, 0),
     (211.9, 6.15, 43.2), (-15.1, 6.15, 43.2), verts, tris)
tapered_side(-36.5, -1, -15.1, 211.9, 0, 43.2, verts, tris, taper=4.0)
y, kind = symmetry_plane(verts, tris, 0.001)
ok("a face that wanders by 0.05 mm is still flat", kind == "half", f"got {kind}")

# ── 6. nothing to measure ───────────────────────────────────────────────────
y, kind = symmetry_plane([], [], 1.0)
ok("an empty mesh does not raise", kind == "centre")

# ── 7. the domain built from it ─────────────────────────────────────────────
# The half model from case 1, in metres.
bbox_m = {"min": [-0.0151, -0.0365, 0.0], "max": [0.2119, 0.0061, 0.0432],
          "size": [0.227, 0.0426, 0.0432]}
wheels = [{"radius_m": 0.0141, "cx_m": 0.035, "cy_m": -0.001, "cz_m": 0.0141}]

NUDGE = 2e-6
dom = build_domain(bbox_m, wheels, 1.5, 0.5, 0.3, 0.3, True, symmetry_y=0.0061)
# Not exactly on the car's face: two microns inside it.
#
# Coplanar is the degenerate case of a boolean. OCC cuts a box by a solid whose
# face lies in the box's own face and returns a shape it calls valid; SimScale
# then refuses it with model-has-invalid-geometry and a list of bad_face_face
# faults every one of which sits at Y = 2e-15. A real run was spent finding
# that out. Two microns makes the planes distinct and is four hundred times
# finer than the smallest feature the mesher is asked to keep.
close("the symmetry wall is nudged off the car's flat face",
      dom["symmetry_y"], 0.0061 - NUDGE, 1e-9)
ok("and nudged into the car, not away from it",
   dom["symmetry_y"] < 0.0061,
   "a wall short of the face leaves a two-micron sliver of air, "
   "which is worse than the coplanar case it was meant to fix")
ok("and the far wall is beyond the car", dom["side_y"] < bbox_m["min"][1],
   f'side {dom["side_y"]}, car min {bbox_m["min"][1]}')
ok("so the car is inside the tunnel, bar the nudge",
   dom["side_y"] < bbox_m["min"][1]
   and bbox_m["max"][1] >= dom["symmetry_y"] - 1e-9
   and (bbox_m["max"][1] - dom["symmetry_y"]) <= NUDGE + 1e-9)
ok("the tunnel has width", dom["symmetry_y"] - dom["side_y"] > 0.3)

# The bug, written down: with the plane pinned to zero the car pokes out of
# the box and 6 mm of it is cut away and mirrored.
old = build_domain(bbox_m, wheels, 1.5, 0.5, 0.3, 0.3, True, symmetry_y=0.0)
ok("pinning the plane to zero would cut the car",
   bbox_m["max"][1] > old["symmetry_y"] + 1e-6,
   f'car reaches {bbox_m["max"][1]}, plane at {old["symmetry_y"]}')

# ── 7b. a car mirrored the other way ────────────────────────────────────────
# The car sits entirely *above* its own plane. side_y was lo[1] - side whichever
# way round the car was, so the box ran from below the car up to the plane at
# its bottom edge: a tunnel built beside the car rather than around it. Found by
# mutating the far-wall line and watching the suite stay green, because every
# fixture until now happened to be mirrored the same way.
low = {"min": [0.0, -0.010, 0.0], "max": [0.2, 0.033, 0.05],
       "size": [0.2, 0.043, 0.05]}
dom2 = build_domain(low, wheels, 1.5, 0.5, 0.3, 0.3, True, symmetry_y=-0.010)
close("the plane is still the car's own face, nudged",
      dom2["symmetry_y"], -0.010 + NUDGE, 1e-9)
ok("and nudged into the car, which is the other way on this one",
   dom2["symmetry_y"] > -0.010)
ok("and the far wall is on the side the car is on",
   dom2["side_y"] > low["max"][1],
   f'side {dom2["side_y"]}, car max {low["max"][1]}')
# Same on this one: the wall cuts the same two microns off, from the other
# side, and everything else is inside.
ok("so the car is inside this tunnel too, bar the nudge",
   min(dom2["side_y"], dom2["symmetry_y"]) <= low["min"][1] + NUDGE + 1e-9
   and max(dom2["side_y"], dom2["symmetry_y"]) >= low["max"][1] - 1e-9,
   f'tunnel {dom2["symmetry_y"]}..{dom2["side_y"]}, car {low["min"][1]}..{low["max"][1]}')

# ── 8. a full-width tunnel has no symmetry plane and does not care ──────────
full = build_domain(bbox_m, wheels, 1.5, 0.5, 0.3, 0.3, False)
ok("a full tunnel is not symmetric", full["symmetry"] is False)
ok("its far wall clears the car", full["symmetry_y"] > bbox_m["max"][1])
ok("and its near wall clears it too", full["side_y"] < bbox_m["min"][1])

# ── 9. the road is set from the wheels, not the bodywork ────────────────────
#
# And it is 0.1 mm under them, not 30. It was 30 mm, which is not a road: a car
# with a 30 mm air gap beneath its wheels is in flight, and the ground effect
# these cars are designed around is solved against nothing. Zero is no good
# either, because a tyre resting exactly on the road touches along one line and
# the mesher cannot build a cell there.
bottom = min(w["cz_m"] - w["radius_m"] for w in wheels)
close("the road sits just under the lowest wheel", dom["ground_z"], bottom - 1e-4)
ok("the road is below the tyres, never inside them", dom["ground_z"] < bottom)
ok("and the gap is a tenth of a millimetre, not centimetres",
   abs((bottom - dom["ground_z"]) - 1e-4) < 1e-9,
   f"gap {(bottom - dom['ground_z']) * 1000:.4f} mm")
ok("the road is below the bodywork too",
   dom["ground_z"] < bbox_m["min"][2] + 1e-9)

if failures:
    print(f"FAIL  {len(failures)} of {checks} checks")
    for f in failures:
        print("   -", f)
    raise SystemExit(1)
print(f"symmetry plane: {checks} checks, the plane follows the car")
