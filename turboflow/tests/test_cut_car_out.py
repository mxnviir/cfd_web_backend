"""Cutting the car out of the wind tunnel, and refusing to pretend it worked.

This is the operation the whole endpoint exists to perform, and it is the one
that fails silently. A boolean that does nothing returns the box, which meshes
and solves and reports a drag of zero. A boolean that goes wrong returns almost
nothing, which also meshes and solves. Neither raises.

Both happened on one real car, a 29-body model with 2,219 faces whose two
largest bodies are not valid solids - four faces carry self-intersecting wires
and come back with negative area. Handed to OCC as 29 separate tools it removed
13% of the car; the body-at-a-time fallback then ran for over nine minutes
without finishing, and one step of it removed 262,870,338 mm3, the entire wind
tunnel, for a 246 mm3 bracket. The old code accepted that step, because all it
asked was whether anything was left.

Handing OCC the same geometry as one compound removes 98% in 7 seconds.

This uses real OCC solids, because a boolean is the thing under test and there
is no way to write one down. It builds them from primitives rather than
shipping a customer's CAD.

What this cannot reach: three of the guards below only ever fire on geometry
that misbehaves, and a solid that makes OCC misbehave in that particular way
could not be built from primitives. A figure-eight prism is invalid but fails
both strategies identically, so it distinguishes nothing. The per-body volume
invariant, the "one pass removed too little" branch and the fallback itself are
therefore exercised only by real cars. The evidence for them is the car in the
docstring above, which went from 13% removed and a nine minute hang to 98%
removed in seven seconds.

Run: python tests/test_cut_car_out.py      (needs cadquery)
"""
import pathlib, types, ast, logging

import cadquery as cq
from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut
from OCP.TopTools import TopTools_ListOfShape
from OCP.BRepCheck import BRepCheck_Analyzer

SRC = pathlib.Path(__file__).resolve().parents[1] / "services" / "tessellate" / "main.py"

mod = types.ModuleType("cut")
mod.__dict__.update({
    "BRepAlgoAPI_Cut": BRepAlgoAPI_Cut,
    "TopTools_ListOfShape": TopTools_ListOfShape,
    "BRepCheck_Analyzer": BRepCheck_Analyzer,
    "log": logging.getLogger("cut"),
})
tree = ast.parse(SRC.read_text(encoding="utf-8"))
wanted = {"cut_parallel", "cut_car_out", "is_valid_solid", "volume_of",
          "fuse_bodies", "expected_removal"}
found = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in wanted]
missing = wanted - {n.name for n in found}
if missing:
    raise SystemExit(f"tessellate/main.py no longer defines: {sorted(missing)}")
exec(compile(ast.Module(body=found, type_ignores=[]), str(SRC), "exec"), mod.__dict__)
cut_car_out = mod.cut_car_out

checks = 0
failures = []


def ok(what, condition, detail=""):
    global checks
    checks += 1
    if not condition:
        failures.append(f"{what}{(': ' + detail) if detail else ''}")


def body(x, y, z, dx, dy, dz):
    return (cq.Workplane("XY").box(dx, dy, dz, centered=False)
            .translate((x, y, z)).val())


# A car of several separate bodies, the shape of a real one: a hull and some
# smaller parts away from it, all inside a tunnel much larger than they are.
# Clear of one another on purpose. Bodies that touch exactly share a face, and
# a shared face is its own boolean edge case: the first version of this fixture
# had the wheels against the hull and OCC dropped two of them, which is a fact
# about coincident faces and not about the code under test.
BODIES = [
    body(0, -20, 0, 200, 40, 40),      # hull,   320 000
    body(30, -35, 0, 25, 10, 25),      # wheel,    6 250
    body(30, 25, 0, 25, 10, 25),       # wheel,    6 250
    body(150, -35, 0, 25, 10, 25),     # wheel,    6 250
    body(150, 25, 0, 25, 10, 25),      # wheel,    6 250
]
CAR = cq.Compound.makeCompound(BODIES)
CAR_VOLUME = sum(b.Volume() for b in BODIES)

TUNNEL = body(-500, -400, 0, 2000, 800, 400)
TUNNEL_VOLUME = TUNNEL.Volume()

ok("the fixture is what the test thinks it is",
   abs(CAR_VOLUME - 345000) < 1.0, f"car volume {CAR_VOLUME}")

# ── the ordinary case ───────────────────────────────────────────────────────
region, note = cut_car_out(TUNNEL, CAR, BODIES, CAR_VOLUME)
ok("a whole car comes out of a whole tunnel", region is not None)
if region is not None:
    removed = TUNNEL_VOLUME - region.Volume()
    ok("all of the car is removed",
       abs(removed - CAR_VOLUME) < CAR_VOLUME * 0.01,
       f"removed {removed:.1f} of {CAR_VOLUME:.1f}")
    ok("nothing is reported as left behind", note == "", note)

# ── half a tunnel takes half the car ────────────────────────────────────────
HALF = body(-500, 0, 0, 2000, 400, 400)
half_region, half_note = cut_car_out(HALF, CAR, BODIES, CAR_VOLUME * 0.5)
ok("a half tunnel cuts", half_region is not None)
if half_region is not None:
    removed = HALF.Volume() - half_region.Volume()
    ok("a half tunnel removes about half the car",
       abs(removed - CAR_VOLUME * 0.5) < CAR_VOLUME * 0.05,
       f"removed {removed:.1f}, half the car is {CAR_VOLUME*0.5:.1f}")

# ── a cut that takes far more than the car is refused ───────────────────────
#
# The real failure: 262,870,338 mm3 removed for a 246 mm3 body. Here it is
# provoked by telling the function the car is a thousand times smaller than it
# is, so a correct cut looks like a runaway one.
runaway, _ = cut_car_out(TUNNEL, CAR, BODIES, CAR_VOLUME / 1000.0)
ok("a cut that removes far more than the car is refused", runaway is None,
   f"got a region back removing {TUNNEL_VOLUME - runaway.Volume():.1f}"
   if runaway is not None else "")

# ── a car that is not in the tunnel at all is refused ───────────────────────
ELSEWHERE = [body(10_000, 10_000, 10_000, 50, 50, 50)]
away = cq.Compound.makeCompound(ELSEWHERE)
nothing, _ = cut_car_out(TUNNEL, away, ELSEWHERE, sum(b.Volume() for b in ELSEWHERE))
ok("a cut that removes nothing is refused", nothing is None,
   "a tunnel with nothing taken out of it was accepted")

# ── the region is one solid piece, and it is the tunnel minus the car ───────
if region is not None:
    pieces = cq.Workplane(obj=region).solids().vals()
    ok("the cut leaves a solid region", len(pieces) >= 1, f"{len(pieces)} pieces")
    biggest = max(pieces, key=lambda p: p.Volume())
    ok("the region is the tunnel, less the car",
       abs(biggest.Volume() - (TUNNEL_VOLUME - CAR_VOLUME)) < CAR_VOLUME * 0.02,
       f"region {biggest.Volume():.1f}, expected {TUNNEL_VOLUME - CAR_VOLUME:.1f}")
    ok("the region is a valid solid",
       BRepCheck_Analyzer(biggest.wrapped).IsValid())

# ── how it asks OCC, which is the whole fix ─────────────────────────────────
#
# On clean geometry every strategy gives the same answer, so no measurement of
# the result can tell them apart. What went wrong on the real car was the shape
# of the request: 29 tools rather than one compound. That is pinned here by
# watching the calls, because it cannot be seen in the volumes.
from OCP.TopAbs import TopAbs_COMPOUND

calls = []
real_cut_parallel = mod.cut_parallel


def watching(shape, tools):
    calls.append(list(tools))
    return real_cut_parallel(shape, tools)


mod.cut_parallel = watching
cut_car_out(TUNNEL, CAR, BODIES, CAR_VOLUME)
mod.cut_parallel = real_cut_parallel

ok("it asks OCC once to begin with", len(calls) >= 1, f"{len(calls)} calls")
if calls:
    ok("the first attempt passes the car as a single tool",
       len(calls[0]) == 1, f"first attempt used {len(calls[0])} tools")
    ok("and that tool is the whole car, not one body of it",
       calls[0] and calls[0][0].wrapped.ShapeType() == TopAbs_COMPOUND,
       "the single tool was not the car compound")


# ── and when that fails, the sound bodies go first ──────────────────────────
#
# A cut that has involved an invalid body leaves a result every later boolean
# blows up on, so the damage has to come last. Forced here by refusing the
# compound, which is the only way to reach the body-at-a-time path on geometry
# this clean.
order = []


def refuse_the_compound(shape, tools):
    if len(tools) == 1 and tools[0].wrapped.ShapeType() == TopAbs_COMPOUND:
        return None
    order.append(tools[0])
    return real_cut_parallel(shape, tools)


mod.cut_parallel = refuse_the_compound
mod.is_valid_solid = lambda one: one is not BODIES[0]   # call the hull unsound
cut_car_out(TUNNEL, CAR, BODIES, CAR_VOLUME)
mod.cut_parallel = real_cut_parallel
mod.is_valid_solid = lambda one: True

ok("every body is tried one at a time when the compound is refused",
   len(order) == len(BODIES), f"{len(order)} of {len(BODIES)}")
if order:
    ok("the body called unsound is cut last",
       order[-1] is BODIES[0],
       "an unsound body was cut before the sound ones")


mod.cut_parallel = real_cut_parallel
mod.is_valid_solid = real_is_valid_solid if "real_is_valid_solid" in globals() else mod.is_valid_solid


# ── how much a correct cut removes ──────────────────────────────────────────
#
# car-17-3 is drawn as a half car. Every good cut of it was refused because the
# estimate assumed a whole car, of which a half tunnel keeps only half.
er = mod.expected_removal
ok("a whole car in a half tunnel loses about half of itself", er(1000.0, True, "centre") == 500.0)
ok("so does an ambiguous one", er(1000.0, True, "ambiguous") == 500.0)
ok("a half-model car in a half tunnel loses all of itself", er(1000.0, True, "half") == 1000.0,
   f"got {er(1000.0, True, 'half')}")
ok("any car in a full tunnel loses all of itself", er(1000.0, False, "centre") == 1000.0)


# ── overlapping bodies, fused ───────────────────────────────────────────────
#
# Cars are drawn as bodies pushed into each other. A wing sunk 10 mm into the
# nose overlaps it by 10 x 30 x 5 = 1 500 mm3; fused, that is counted once.
HULL = body(0, -15, 0, 200, 30, 30)            # 180 000
WING = body(190, -40, 5, 30, 80, 5)            #  12 000, 10 mm of it inside the hull
fused = mod.fuse_bodies([HULL, WING])
ok("two overlapping bodies fuse", fused is not None)
if fused is not None:
    union = HULL.Volume() + WING.Volume() - 10 * 30 * 5
    ok("the fused car counts the overlap once", abs(fused.Volume() - union) < 1e-3,
       f"{fused.Volume():.3f} vs {union:.3f}")
ok("a single body has nothing to fuse", mod.fuse_bodies([HULL]) is None)

# When the compound cut is refused, the fused car is tried before body at a
# time, and a good fused cut ends it: no body is cut on its own.
one_by_one = []


def refuse_compound_count_bodies(shape, tools):
    kind = tools[0].wrapped.ShapeType()
    if len(tools) == 1 and kind == TopAbs_COMPOUND and tools[0] is not fused_seen[0]:
        return None
    if tools[0] in (HULL, WING):
        one_by_one.append(tools[0])
    return real_cut_parallel(shape, tools)


fused_seen = [None]
real_fuse = mod.fuse_bodies
mod.fuse_bodies = lambda solids: fused_seen.__setitem__(0, real_fuse(solids)) or fused_seen[0]
mod.cut_parallel = refuse_compound_count_bodies
PAIR = cq.Compound.makeCompound([HULL, WING])
region, note = cut_car_out(TUNNEL, PAIR, [HULL, WING], HULL.Volume() + WING.Volume())
mod.cut_parallel = real_cut_parallel
mod.fuse_bodies = real_fuse
ok("the fused car is cut when the compound is refused", region is not None)
ok("and no body had to be cut on its own", not one_by_one, f"{len(one_by_one)} cut singly")
ok("the fused car was built", fused_seen[0] is not None)
if region is not None and fused_seen[0] is not None:
    took = TUNNEL.Volume() - region.Volume()
    ok("the fused cut removes the union of the car", abs(took - fused_seen[0].Volume()) < 1.0,
       f"removed {took:.1f} of {fused_seen[0].Volume():.1f}")
ok("with nothing reported missing", note == "", note)


print(f"cut car out: {checks} checks")
if failures:
    print(f"\nFAIL  {len(failures)} of {checks}\n")
    for f in failures:
        print("   -", f)
    raise SystemExit(1)
