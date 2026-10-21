"""A half model reports half the car, and something has to put it back.

A half tunnel is the default and it is the right default: it is a quarter of
the cells for the same answer, because the car is mirrored down its centreline
and the solver only has to do one side. What comes back, though, is one side's
worth of force. Cd survives that untouched - SimScale divided by the reference
area of the tunnel it was given, which was halved along with the force - but
drag in newtons did not, and nothing doubled it.

That number is not decorative. A STEM Racing team feeds drag in newtons into a
lap-time calculator, and TurboFlow has its own on the same site. Every half
tunnel ever run reported a car twice as slippery as it is, with no warning,
no error, and a Cd beside it that was perfectly correct.

Three of the six figures do not double, they cancel. Side force, roll and yaw
are equal and opposite between a car's two halves, so the whole car has none of
them however much the solved half reports - which is why they are reported as
nothing rather than doubled. That cancellation is exact only when moments are
taken about a point on the mirror plane; momentCentre in prepareDomain.ts makes
sure of that, and tests/test_auto_spec.mjs holds it there.

No network and no API key: this is arithmetic on the dictionary export_plots
builds.

Run: python tests/test_half_car.py
"""
import ast, pathlib, sys, types

SRC = pathlib.Path(__file__).resolve().parents[1] / "services" / "simscale-job" / "simscale_job.py"
tree = ast.parse(SRC.read_text(encoding="utf-8"))

WANT_FN = {"symmetry_factor", "whole_car", "summarise"}
WANT_CONST = {"DOUBLES", "CANCELS"}
nodes = []
for n in tree.body:
    if isinstance(n, ast.FunctionDef) and n.name in WANT_FN:
        nodes.append(n)
    elif isinstance(n, ast.Assign) and any(
            getattr(t, "id", "") in WANT_CONST for t in n.targets):
        nodes.append(n)
missing = WANT_FN - {n.name for n in nodes if isinstance(n, ast.FunctionDef)}
if missing:
    raise SystemExit(f"simscale_job.py no longer defines: {sorted(missing)}")

mod = types.ModuleType("half")
exec(compile(ast.Module(body=nodes, type_ignores=[]), str(SRC), "exec"), mod.__dict__)
symmetry_factor, whole_car, summarise = (
    mod.symmetry_factor, mod.whole_car, mod.summarise)

fails = []


def check(what, got, want):
    if got != want:
        fails.append(f"{what}: got {got!r}, wanted {want!r}")


def bc(kind, **ref):
    return {"type": kind, "topologicalReference": ref}


# ── is this half a car? ─────────────────────────────────────────────────────
check("a symmetry plane means two of everything",
      symmetry_factor({"boundaryConditions": [bc("SYMMETRY", faces=[5])]}), 2)
check("a full tunnel is one car",
      symmetry_factor({"boundaryConditions": [
          bc("WALL_V34", faces=[4]), bc("VELOCITY_INLET_V3", faces=[0])]}), 1)
check("the worker's own resolved spec names entities, not faces",
      symmetry_factor({"boundaryConditions": [bc("SYMMETRY", entities=["B1_F2"])]}), 2)
# An empty boundary condition is not a mirror. validateSetup refuses one, so
# this should never arrive - but "doubled because a key was present" is a bad
# reason to double somebody's drag.
check("a symmetry plane assigned to nothing is not a mirror",
      symmetry_factor({"boundaryConditions": [bc("SYMMETRY", faces=[])]}), 1)
check("no boundary conditions", symmetry_factor({"boundaryConditions": []}), 1)
check("no spec at all", symmetry_factor(None), 1)


# ── what doubling does, and does not do ────────────────────────────────────
def plots():
    """The shape export_plots builds, with a half car's numbers in it."""
    return {
        "residuals": {"iterations": [1, 2], "series": {"Ux": [1e-2, 1e-6]}},
        "forces": {"iterations": [1, 2, 3],
                   "drag": [0.50, 0.60, 0.64],
                   "lift": [-0.10, -0.20, -0.25],
                   "side": [0.00, 0.01, 0.005],
                   "split": {"pressure": {"drag": [0.40, 0.50, 0.54],
                                          "lift": [-0.08, -0.16, -0.20]},
                             "viscous": {"drag": [0.10, 0.10, 0.10],
                                         "lift": [-0.02, -0.04, -0.05]}}},
        "moments": {"iterations": [1, 2, 3], "roll": [0.1, 0.2, 0.3],
                    "pitch": [1.0, 1.1, 1.2], "yaw": [0.01, 0.02, 0.03]},
        "coefficients": {"iterations": [1, 2, 3], "cd": [0.40, 0.36, 0.352],
                         "cl": [-0.10, -0.12, -0.121]},
    }


whole = whole_car(plots(), 2)
check("drag is the whole car's", whole["forces"]["drag"], [1.0, 1.2, 1.28])
check("and so is lift", whole["forces"]["lift"], [-0.2, -0.4, -0.5])
check("pitch doubles with them", whole["moments"]["pitch"], [2.0, 2.2, 2.4])

check("side force cancels between the halves", whole["forces"]["side"], [0.0, 0.0, 0.0])
check("so does roll", whole["moments"]["roll"], [0.0, 0.0, 0.0])
check("and yaw", whole["moments"]["yaw"], [0.0, 0.0, 0.0])

# The single most important thing not to touch. Cd was already right, and
# doubling it would turn a correct number into a wrong one - which is worse
# than the bug this whole function exists to fix.
check("Cd is left exactly alone", whole["coefficients"]["cd"], [0.40, 0.36, 0.352])
check("and Cl", whole["coefficients"]["cl"], [-0.10, -0.12, -0.121])
check("residuals are not forces", whole["residuals"]["series"]["Ux"], [1e-2, 1e-6])
check("the iteration axis is not a force", whole["forces"]["iterations"], [1, 2, 3])

# Form drag and skin friction are the total split in two. Doubling the total
# and not the parts leaves a chart whose two bars no longer add up to the line
# above them.
check("form drag doubles with the total",
      whole["forces"]["split"]["pressure"]["drag"], [0.8, 1.0, 1.08])
check("and skin friction",
      whole["forces"]["split"]["viscous"]["drag"], [0.2, 0.2, 0.2])
parts = (whole["forces"]["split"]["pressure"]["drag"][-1]
         + whole["forces"]["split"]["viscous"]["drag"][-1])
check("the parts still add up to the whole",
      round(parts, 9), round(whole["forces"]["drag"][-1], 9))

check("the run says the doubling happened",
      whole["whole_car"], {"factor": 2, "cancels": ["roll", "side", "yaw"]})


# ── a full tunnel is untouched ─────────────────────────────────────────────
same = whole_car(plots(), 1)
check("a full tunnel keeps its drag", same["forces"]["drag"], [0.50, 0.60, 0.64])
check("a full tunnel keeps its side force", same["forces"]["side"], [0.00, 0.01, 0.005])
check("and is not stamped as doubled", "whole_car" in same, False)


# ── what the panel finally shows ───────────────────────────────────────────
check("the summary is the whole car's drag", summarise(whole).get("drag"), 1.28)
check("and the whole car's lift", summarise(whole).get("lift"), -0.5)
check("with the coefficient untouched", summarise(whole).get("cd"), 0.352)
check("and nothing pretending to be a side force", summarise(whole).get("side"), 0.0)


# ── nothing here may turn a finished run into a failed one ─────────────────
# Run 10 solved for ten minutes and was marked Failed because summarise()
# indexed a dict with -1. Post-processing gets no second chance to do that.
check("no plots at all", whole_car(None, 2), None)
check("empty plots", whole_car({}, 2), {})
check("forces with nothing in them",
      whole_car({"forces": {"iterations": [1]}}, 2)["forces"], {"iterations": [1]})
check("a gap in the trace",
      whole_car({"forces": {"drag": [1.0, None, 2.0]}}, 2)["forces"]["drag"],
      [2.0, None, 4.0])
check("moments without forces",
      whole_car({"moments": {"pitch": [1.0]}}, 2)["moments"]["pitch"], [2.0])

if fails:
    print("half car: FAILED")
    for f in fails:
        print("  " + f)
    sys.exit(1)
print("half car: 29 checks, a half model reports the whole car")
