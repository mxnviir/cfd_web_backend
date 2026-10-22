"""Drag is the force along the wind, whichever way the wind blows.

The worker negated Fx on the flat assumption that the inlet points in -x. That
is true of the setup it builds for the Fusion add-in and untrue of a setup a
user built in the Workbench, so Run 11 pointed its inlet at +20 m/s in x, blew
air at a car for ten minutes and reported a drag of -0.21 N.

No network: this is arithmetic on a vector out of the spec.
"""
import ast, pathlib, sys, types, math

SRC = pathlib.Path(__file__).resolve().parents[1] / "services" / "simscale-job" / "simscale_job.py"
tree = ast.parse(SRC.read_text(encoding="utf-8"))
fn = next(n for n in tree.body
          if isinstance(n, ast.FunctionDef) and n.name == "flow_direction")
mod = types.ModuleType("f")
mod.math = math
exec(compile(ast.Module(body=[fn], type_ignores=[]), str(SRC), "exec"), mod.__dict__)
flow_direction = mod.flow_direction

fails = []
def check(what, got, want, tol=1e-9):
    ok = (all(abs(a - b) < tol for a, b in zip(got, want))
          if isinstance(want, tuple) else got == want)
    if not ok:
        fails.append(f"{what}: got {got!r}, wanted {want!r}")

def inlet(x, y=0.0, z=0.0):
    return {"boundaryConditions": [{
        "type": "VELOCITY_INLET_V3",
        "velocity": {"value": {"value": {
            "x": {"type": "CONSTANT", "value": x},
            "y": {"type": "CONSTANT", "value": y},
            "z": {"type": "CONSTANT", "value": z}}}},
    }]}

# The direction itself
check("wind along +x", flow_direction(inlet(20.0)), (1.0, 0.0, 0.0))
check("wind along -x", flow_direction(inlet(-20.0)), (-1.0, 0.0, 0.0))
check("yawed inlet is normalised",
      flow_direction(inlet(3.0, 4.0)), (0.6, 0.8, 0.0))
check("a still inlet is not a direction", flow_direction(inlet(0.0)), (-1.0, 0.0, 0.0))
check("no inlet falls back to the add-in convention",
      flow_direction({"boundaryConditions": []}), (-1.0, 0.0, 0.0))
check("no spec at all", flow_direction(None), (-1.0, 0.0, 0.0))
check("a wall is not an inlet",
      flow_direction({"boundaryConditions": [{"type": "WALL_V34"}]}), (-1.0, 0.0, 0.0))

# The projection the worker then does with it, same expressions as export_plots
def forces(u, fx, fy):
    ux, uy, _ = u
    sx, sy = -uy, ux
    return fx * ux + fy * uy, fx * sx + fy * sy

# Wind in +x, car pushed downwind: Fx positive, so drag must be positive.
drag, side = forces(flow_direction(inlet(20.0)), 0.2096, -0.0975)
check("drag is positive with the wind in +x", drag > 0, True)
check("drag magnitude survives the projection", (drag,), (0.2096,), 1e-9)
check("side is the across-wind component", (side,), (-0.0975,), 1e-9)

# The add-in's own setup, which must come out exactly as it always has.
drag_legacy, _ = forces(flow_direction(inlet(-20.0)), -1.4, 0.0)
check("legacy -x inlet still reports positive drag", (drag_legacy,), (1.4,), 1e-9)

# A car in a yawed crosswind: drag along the wind, side across it.
drag_y, side_y = forces(flow_direction(inlet(3.0, 4.0)), 0.6, 0.8)
check("yawed drag is the along-wind projection", (drag_y,), (1.0,), 1e-9)
check("yawed side is zero when the force is pure drag", (side_y,), (0.0,), 1e-9)

if fails:
    print("drag sign: FAILED")
    for f in fails:
        print("  " + f)
    sys.exit(1)
print("drag sign: 13 checks, drag follows the wind the user set")
