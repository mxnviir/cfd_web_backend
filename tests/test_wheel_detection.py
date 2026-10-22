"""Finding the wheels on a car made of real surfaces.

tests/test_wheel_grouping.py checks what happens to a list of face dictionaries,
which is most of the thinking and none of the join. This checks the join: that
what OCC hands back for a real cylindrical face - its axis, its radius and how
far it reaches along that axis - is what the wheel search reads.

The part that can break quietly is the extent. Two wheels on one axle are the
same cylinder in x and z and are told apart only by where they sit along y, and
the cylinder's own origin is no help: OCC puts it wherever the modelling put
it, which on a real car was four hundred millimetres away from the wheel. So
the split is on the face's bounding box, and a change there turns a four-wheel
car back into a two-wheel one with nothing raised and nothing logged.

Built from primitives rather than a customer's CAD, and deliberately awkward:
each tyre is an outer cylinder with a smaller rim butted against it, which must
come out as one wheel and not two.

Run: python tests/test_wheel_detection.py     (needs cadquery)
"""
import pathlib, types, ast, math

import cadquery as cq
from OCP.BRepAdaptor import BRepAdaptor_Surface
from OCP.GeomAbs import GeomAbs_SurfaceType

SRC = pathlib.Path(__file__).resolve().parents[1] / "services" / "tessellate" / "main.py"

mod = types.ModuleType("detect")
mod.__dict__.update({"BRepAdaptor_Surface": BRepAdaptor_Surface,
                     "GeomAbs_SurfaceType": GeomAbs_SurfaceType, "math": math})
tree = ast.parse(SRC.read_text(encoding="utf-8"))
wanted = {"find_wheels", "wheels_from_axles", "split_axle", "name_wheels",
          "cylinder_of"}
nodes = [n for n in tree.body
         if (isinstance(n, ast.FunctionDef) and n.name in wanted)
         or (isinstance(n, ast.Assign)
             and any(getattr(t, "id", "") in ("FORE_NAMES", "SIDE_NAMES")
                     for t in n.targets))]
missing = wanted - {n.name for n in nodes if isinstance(n, ast.FunctionDef)}
if missing:
    raise SystemExit(f"tessellate/main.py no longer defines: {sorted(missing)}")
exec(compile(ast.Module(body=nodes, type_ignores=[]), str(SRC), "exec"), mod.__dict__)
find_wheels = mod.find_wheels

checks = 0
failures = []


def ok(what, condition, detail=""):
    global checks
    checks += 1
    if not condition:
        failures.append(f"{what}{(': ' + detail) if detail else ''}")


R = 14.125          # mm, a STEM Racing wheel: 28.25 mm across
SCALE = 0.001       # the model is in millimetres


def tyre(x, y):
    """An outer cylinder and a slightly smaller rim against its inner face."""
    outer = cq.Workplane("XZ").workplane(offset=y).circle(R).extrude(10).val()
    rim = cq.Workplane("XZ").workplane(offset=y + 10).circle(R * 0.97).extrude(4).val()
    return [s.translate((x, 0, R)) for s in (outer, rim)]


bodies = []
for x, y in [(190, 20), (190, -30), (55, 20), (55, -30)]:
    bodies += tyre(x, y)
# A hull, so the search has something to reject as well as something to find.
bodies.append(cq.Workplane("XY").box(240, 40, 40, centered=False)
              .translate((0, -20, 5)).val())
CAR = cq.Compound.makeCompound(bodies)
FACES = cq.Workplane(obj=CAR).faces().vals()

wheels = find_wheels(FACES, [R * SCALE], 0.08, SCALE)
names = [w["name"] for w in wheels]

ok("a four-wheel car is four wheels", len(wheels) == 4, f"got {len(wheels)}: {names}")
ok("named front to back and left to right",
   names == ["Front left", "Front right", "Rear left", "Rear right"], str(names))
ok("front is the end that meets the air",
   all(w["cx_m"] == 0.19 for w in wheels[:2])
   and all(w["cx_m"] == 0.055 for w in wheels[2:]),
   str([w["cx_m"] for w in wheels]))
ok("left is +y", wheels[0]["cy_m"] > wheels[1]["cy_m"],
   f"{wheels[0]['cy_m']} vs {wheels[1]['cy_m']}")
ok("the radius is the tyre's, not the rim's",
   all(abs(w["radius_m"] - R * SCALE) < 1e-9 for w in wheels),
   str([w["radius_m"] for w in wheels]))
ok("a tyre and the rim against it are one wheel, and both faces come with it",
   all(len(w["face_indices"]) == 2 for w in wheels),
   str([w["face_indices"] for w in wheels]))
ok("no face belongs to two wheels",
   len({i for w in wheels for i in w["face_indices"]}) == 8)
ok("each wheel knows how far it reaches along its axle",
   all(w["y_hi_m"] - w["y_lo_m"] > 0.013 for w in wheels),
   str([(w["y_lo_m"], w["y_hi_m"]) for w in wheels]))
ok("the hull is not a wheel",
   all(abs(w["cz_m"] - R * SCALE) < 1e-9 for w in wheels),
   str([w["cz_m"] for w in wheels]))

# The speed the solver is actually given.
for w in wheels:
    omega = 20.0 / w["radius_m"]
    ok(f"{w['name']} spins near 1416 rad/s at 20 m/s", 1400 < omega < 1430,
       f"got {omega:.0f}")

# ── a wheel outside the tolerance is not a wheel ───────────────────────────
none_found = find_wheels(FACES, [0.030], 0.08, SCALE)
ok("a search for 30 mm wheels finds none on a 14 mm car",
   none_found == [], str([w["name"] for w in none_found]))

# ── two sizes at once, which is the front-and-rear case ────────────────────
mixed = []
for x, y in [(190, 20), (190, -30)]:
    mixed += tyre(x, y)
BIG = 17.0
for x, y in [(55, 20), (55, -30)]:
    outer = cq.Workplane("XZ").workplane(offset=y).circle(BIG).extrude(10).val()
    mixed.append(outer.translate((x, 0, BIG)))
mixed_wheels = find_wheels(
    cq.Workplane(obj=cq.Compound.makeCompound(mixed)).faces().vals(),
    [R * SCALE, BIG * SCALE], 0.08, SCALE)
ok("a car with two wheel sizes finds all four", len(mixed_wheels) == 4,
   f"got {len(mixed_wheels)}: {[w['name'] for w in mixed_wheels]}")
ok("and each keeps its own size",
   sorted(round(w["radius_m"], 6) for w in mixed_wheels)
   == [0.014125, 0.014125, 0.017, 0.017],
   str(sorted(w["radius_m"] for w in mixed_wheels)))

# ── half a car has one wheel per axle and no side to speak of ──────────────
half = [b for b in bodies[:8] if b.Center().y > 0]
half_wheels = find_wheels(
    cq.Workplane(obj=cq.Compound.makeCompound(half)).faces().vals(),
    [R * SCALE], 0.08, SCALE)
ok("half a car has two wheels", len(half_wheels) == 2,
   f"got {len(half_wheels)}: {[w['name'] for w in half_wheels]}")
ok("and they are not given a side",
   [w["name"] for w in half_wheels] == ["Front", "Rear"],
   str([w["name"] for w in half_wheels]))

print(f"wheel detection: {checks} checks")
if failures:
    print(f"\nFAIL  {len(failures)} of {checks}\n")
    for f in failures:
        print("   -", f)
    raise SystemExit(1)
