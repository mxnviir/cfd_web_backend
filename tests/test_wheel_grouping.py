"""Which faces turn, how fast, and which wheel they belong to.

A wheel on one of these cars is not one cylindrical face. It is an inner face
and an outer face, and coaxial with both are the axle and whatever hub the team
modelled. All of them are labelled rotating_wall, because the test for that is
"cylinder about y, on the same axis as a wheel", and an axle passes it.

What the solver is given for each group is a rotation axis and an angular
velocity, and the velocity is computed as speed / radius. So the radius that
comes out of the grouping is not a label - it is the number the wall spins at.
Getting it from the wrong face is silent: the run solves, converges, and
reports a drag for a car whose wheels were turning at the wrong speed.

The real case that came from: a STEM Racing car whose wheels are 14.125 mm came
back from the tunnel with wheel entries of 1.43 mm, 3 mm, 15 mm, 17 mm and
18 mm, eight of them on a four-wheel car. 20 m/s over 1.43 mm is 13,986 rad/s
where the answer is 1,416.

And the other half of it: for a while afterwards a four-wheel car reported two
wheels. x and z identify an *axle*; the two wheels on it are separated along y,
and y was being averaged away. Harmless to the solver - both wheels of an axle
turn about one line at one speed - and wrong on every screen, and fatal to
"spin the front wheels only", which is now a thing a person can ask for.

No OCC here: all of this reads lists of face dictionaries, and those can be
written down.

Run: python tests/test_wheel_grouping.py
"""
import pathlib, types, ast

SRC = pathlib.Path(__file__).resolve().parents[1] / "services" / "tessellate" / "main.py"

mod = types.ModuleType("wheels")
tree = ast.parse(SRC.read_text(encoding="utf-8"))
wanted = {"group_wheel_faces", "wheel_for_face", "find_wheels_from",
          "wheels_from_axles", "split_axle", "name_wheels"}
found = [n for n in tree.body
         if isinstance(n, (ast.FunctionDef, ast.Assign)) and (
             (isinstance(n, ast.FunctionDef) and n.name in wanted)
             or (isinstance(n, ast.Assign)
                 and any(getattr(t, "id", "") in ("FORE_NAMES", "SIDE_NAMES")
                         for t in n.targets)))]
missing = wanted - {n.name for n in found if isinstance(n, ast.FunctionDef)}
if missing:
    raise SystemExit(f"tessellate/main.py no longer defines: {sorted(missing)}")
exec(compile(ast.Module(body=found, type_ignores=[]), str(SRC), "exec"), mod.__dict__)
group_wheel_faces = mod.group_wheel_faces
find_wheels_from = mod.find_wheels_from
split_axle = mod.split_axle
name_wheels = mod.name_wheels

checks = 0
failures = []


def ok(what, condition, detail=""):
    global checks
    checks += 1
    if not condition:
        failures.append(f"{what}{(': ' + detail) if detail else ''}")


R = 0.014125            # a STEM Racing wheel: 28.25 mm across
REAR_X, FRONT_X = -0.1875, -0.0550
CZ = 0.01412
LEFT, RIGHT = (0.019, 0.034), (-0.034, -0.019)      # where each tyre sits in y


def cyl(i, x, z, r, y_span, axis_y=0.0):
    """One cylindrical face about y, as the survey reports it.

    axis_y is the cylinder origin, which OCC is free to put anywhere along the
    axis - so it is deliberately not where the face is. y_span is where the
    surface actually is, which is what the splitting has to use.
    """
    lo, hi = y_span
    return {"index": i, "type": "cylinder", "axis": (0.0, 1.0, 0.0),
            "axis_x_m": x, "axis_y_m": axis_y, "axis_z_m": z, "radius_m": r,
            "cx_m": x, "cy_m": (lo + hi) / 2.0, "cz_m": z,
            "bbox": {"min": [x - r, lo, z - r], "max": [x + r, hi, z + r]}}


# ── a whole four-wheel car, as the importer surveys it ──────────────────────
#
# Two faces per wheel, an outer tyre and an inner rim, at slightly different
# radii and with cylinder origins that disagree - which is the case the old
# grouping split into two wheels, and the case a naive y split would too.
SURVEY = [
    cyl(0, FRONT_X, CZ, R,        LEFT,  axis_y=-0.100),
    cyl(1, FRONT_X, CZ, 0.013725, LEFT,  axis_y=+0.400),
    cyl(2, FRONT_X, CZ, R,        RIGHT, axis_y=-0.100),
    cyl(3, FRONT_X, CZ, 0.013725, RIGHT, axis_y=+0.400),
    cyl(4, REAR_X,  CZ, R,        LEFT,  axis_y=0.0),
    cyl(5, REAR_X,  CZ, 0.013725, LEFT,  axis_y=0.0),
    cyl(6, REAR_X,  CZ, R,        RIGHT, axis_y=0.0),
    cyl(7, REAR_X,  CZ, 0.013725, RIGHT, axis_y=0.0),
    # The axle, a tenth of the radius: coaxial with the rear wheels, far too
    # small to be one.
    cyl(8, REAR_X, CZ, 0.00143, (-0.020, 0.020)),
    {"index": 9, "type": "plane", "cx_m": 0.0, "cy_m": 0.0, "cz_m": 0.0},
]

WHEELS = find_wheels_from(SURVEY, [R], 0.08)

ok("a four-wheel car comes back as four wheels", len(WHEELS) == 4,
   f"got {len(WHEELS)}: {[w['name'] for w in WHEELS]}")
ok("named for where they sit, front first and left first",
   [w["name"] for w in WHEELS] == ["Front left", "Front right",
                                   "Rear left", "Rear right"],
   str([w["name"] for w in WHEELS]))

by_name = {w["name"]: w for w in WHEELS}
ok("the front wheels are the ones nearer the wind",
   by_name["Front left"]["cx_m"] == FRONT_X and by_name["Rear left"]["cx_m"] == REAR_X,
   f"front at {by_name['Front left']['cx_m']}, rear at {by_name['Rear left']['cx_m']}")
ok("left is +y", by_name["Front left"]["cy_m"] > by_name["Front right"]["cy_m"],
   f"left {by_name['Front left']['cy_m']}, right {by_name['Front right']['cy_m']}")
ok("each wheel keeps the tyre's radius, not the rim's",
   all(w["radius_m"] == R for w in WHEELS), str([w["radius_m"] for w in WHEELS]))
ok("the axle is too small to be a wheel",
   all(8 not in w["face_indices"] for w in WHEELS),
   str([w["face_indices"] for w in WHEELS]))
ok("both faces of one wheel stay on it, whatever their cylinder origins say",
   sorted(by_name["Front left"]["face_indices"]) == [0, 1],
   str(by_name["Front left"]["face_indices"]))
ok("each wheel carries how far it reaches along its axle",
   by_name["Front left"]["y_lo_m"] == LEFT[0]
   and by_name["Front left"]["y_hi_m"] == LEFT[1],
   f"{by_name['Front left'].get('y_lo_m')} to {by_name['Front left'].get('y_hi_m')}")


# ── the tunnel labels, grouped back onto those wheels ───────────────────────
#
# Every one of these is coaxial about y with a wheel, so label_faces calls all
# of them rotating_wall - including the axle, which is not a wheel, and a hub
# shoulder wider than the tyre, which is not one either.
meta = [dict(f) for f in SURVEY]
meta.append(cyl(10, REAR_X, CZ, 0.018, (0.030, 0.036)))     # hub, wider than the tyre
meta.append({"index": 11, "type": "plane", "cx_m": 0.0, "cy_m": 0.0, "cz_m": 0.0})
per_face = {i: "rotating_wall" for i in range(9)}
per_face[9] = "inlet"
per_face[10] = "rotating_wall"
per_face[11] = "ground"

labels, tunnel = group_wheel_faces(meta, dict(per_face), WHEELS)
turning = {w["name"]: w for w in tunnel}

ok("four wheels in, four wheels out", len(tunnel) == 4,
   f"got {len(tunnel)}: {[w['name'] for w in tunnel]}")
ok("the left faces go to the left wheel",
   sorted(turning.get("Rear left", {}).get("face_indices", [])) == [4, 5, 8, 10],
   str(turning.get("Rear left", {}).get("face_indices")))
ok("and the right faces to the right wheel",
   sorted(turning.get("Rear right", {}).get("face_indices", [])) == [6, 7],
   str(turning.get("Rear right", {}).get("face_indices")))
ok("no face is on two wheels at once",
   len({i for w in tunnel for i in w["face_indices"]})
   == sum(len(w["face_indices"]) for w in tunnel))
ok("the axle turns with the wheel it is inside, rather than being one",
   8 in turning.get("Rear left", {}).get("face_indices", []),
   str(turning.get("Rear left", {}).get("face_indices")))
ok("a coaxial face wider than the tyre does not raise the radius",
   turning.get("Rear left", {}).get("radius_m") == R,
   f"got {turning.get('Rear left', {}).get('radius_m')} with an 18 mm face on the axis")
ok("every wheel keeps its own radius, not the axle's",
   all(w["radius_m"] == R for w in tunnel), str([w["radius_m"] for w in tunnel]))
ok("faces that are not wheels keep their labels",
   labels.get("inlet") == [9] and labels.get("ground") == [11], f"{labels}")
ok("every wheel face is marked rotating_wall on the face record",
   all(meta[i]["label"] == "rotating_wall" for i in list(range(9)) + [10]),
   str([meta[i].get("label") for i in range(12)]))

# The number that actually reaches the solver.
SPEED = 20.0
for w in tunnel:
    omega = SPEED / w["radius_m"]
    ok(f"{w['name']} spins near 1416 rad/s at 20 m/s",
       1400 < omega < 1430, f"got {omega:.0f} rad/s")

ok("the centre is on the axis the wheel turns about",
   turning["Rear left"]["cx_m"] == REAR_X and turning["Rear left"]["cz_m"] == CZ)


# ── half a car: one wheel per axle, and it must not be called "left" ────────
HALF = find_wheels_from(
    [f for f in SURVEY if f["index"] in (0, 1, 4, 5, 8, 9)], [R], 0.08)
ok("half a car has one wheel per axle", len(HALF) == 2,
   f"got {len(HALF)}: {[w['name'] for w in HALF]}")
ok("and they are not given a side they cannot have",
   [w["name"] for w in HALF] == ["Front", "Rear"], str([w["name"] for w in HALF]))

# One axle, two wheels: front and rear mean nothing, left and right do.
ONE_AXLE = find_wheels_from(
    [f for f in SURVEY if f["index"] in (0, 2)], [R], 0.08)
ok("a single axle is named by side alone",
   [w["name"] for w in ONE_AXLE] == ["Left", "Right"],
   str([w["name"] for w in ONE_AXLE]))

# Three axles is a truck, not a STEM Racing car, but it must not crash or
# produce two wheels both called "Front left".
THREE = name_wheels([
    {"cx_m": 0.3, "cy_m": 0.02, "cz_m": 0.0, "radius_m": 0.01},
    {"cx_m": 0.3, "cy_m": -0.02, "cz_m": 0.0, "radius_m": 0.01},
    {"cx_m": 0.1, "cy_m": 0.02, "cz_m": 0.0, "radius_m": 0.01},
    {"cx_m": 0.1, "cy_m": -0.02, "cz_m": 0.0, "radius_m": 0.01},
    {"cx_m": -0.1, "cy_m": 0.02, "cz_m": 0.0, "radius_m": 0.01},
    {"cx_m": -0.1, "cy_m": -0.02, "cz_m": 0.0, "radius_m": 0.01},
])
ok("six wheels get six different names",
   len({w["name"] for w in THREE}) == 6, str([w["name"] for w in THREE]))


# ── the two wheels of an axle must not merge back together ─────────────────
#
# The split is on where the surface is, and the threshold is half a radius.
# Pinned here because widening it is how a four-wheel car silently becomes a
# two-wheel one again.
apart = split_axle([{"index": 0, "radius": R, "y_lo": 0.019, "y_hi": 0.034},
                    {"index": 1, "radius": R, "y_lo": -0.034, "y_hi": -0.019}], R)
ok("two tyres a track-width apart are two wheels", len(apart) == 2, f"{len(apart)}")
together = split_axle([{"index": 0, "radius": R, "y_lo": 0.019, "y_hi": 0.034},
                       {"index": 1, "radius": R, "y_lo": 0.020, "y_hi": 0.033}], R)
ok("two faces of one tyre are one wheel", len(together) == 1, f"{len(together)}")
touching = split_axle([{"index": 0, "radius": R, "y_lo": 0.000, "y_hi": 0.014},
                       {"index": 1, "radius": R, "y_lo": 0.014, "y_hi": 0.028}], R)
ok("a tyre and the rim butted against it are one wheel", len(touching) == 1,
   f"{len(touching)}")


# ── a face labelled as turning that belongs to no wheel ────────────────────
stray_meta = [cyl(0, FRONT_X, CZ, R, LEFT), cyl(1, 0.5, 0.5, 0.002, (0.4, 0.6))]
stray_labels, stray_wheels = group_wheel_faces(
    [dict(f) for f in stray_meta], {0: "rotating_wall", 1: "rotating_wall"},
    [by_name["Front left"]])
ok("a rotating face matching no wheel becomes a plain wall",
   stray_labels.get("car_no_slip") == [1], f"{stray_labels}")
ok("and does not become a wheel of its own",
   len(stray_wheels) == 1, f"got {len(stray_wheels)}")


# ── a wheel with no usable radius cannot be spun ───────────────────────────
no_r = [{"name": "Front left", "radius_m": 0.0, "cx_m": FRONT_X, "cy_m": 0.026,
         "cz_m": CZ, "y_lo_m": LEFT[0], "y_hi_m": LEFT[1]}]
flat_labels, flat_wheels = group_wheel_faces(
    [dict(cyl(0, FRONT_X, CZ, R, LEFT))], {0: "rotating_wall"}, no_r)
ok("a wheel with no radius is demoted rather than divided by zero",
   flat_wheels == [] and flat_labels.get("car_no_slip") == [0],
   f"{flat_wheels} {flat_labels}")


print(f"wheel grouping: {checks} checks")
if failures:
    print(f"\nFAIL  {len(failures)} of {checks}\n")
    for f in failures:
        print("   -", f)
    raise SystemExit(1)
