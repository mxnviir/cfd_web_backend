"""summarise() must read the shape export_plots() actually returns.

Run 10 solved 879,511 cells for ten minutes and was then marked Failed,
because summarise() walked `plots` as {name: [row, ...]} and did `rows[-1]`
on what is really {"forces": {"drag": [...], ...}} — KeyError: -1.

No network and no API key: this is a shape contract between two functions in
the same file, and it is worth being able to check it in a second.
"""
import ast, pathlib, sys, types

SRC = pathlib.Path(__file__).resolve().parents[1] / "services" / "simscale-job" / "simscale_job.py"
tree = ast.parse(SRC.read_text(encoding="utf-8"))
fn = next(n for n in tree.body
          if isinstance(n, ast.FunctionDef) and n.name == "summarise")
mod = types.ModuleType("s")
exec(compile(ast.Module(body=[fn], type_ignores=[]), str(SRC), "exec"), mod.__dict__)
summarise = mod.summarise

fails = []
def check(what, got, want):
    if got != want:
        fails.append(f"{what}: got {got!r}, wanted {want!r}")

# The real shape, as export_plots builds it.
plots = {
    "residuals": {"iterations": [1, 2, 3], "series": {"Ux": [1e-2, 1e-4, 1e-6]}},
    "forces": {"iterations": [1, 2, 3], "drag": [5.0, 6.0, 6.4],
               "lift": [-1.0, -2.0, -2.5], "side": [0.0, 0.1, 0.05],
               "split": {"pressure": {"drag": [4.0, 5.0, 5.4]}}},
    "moments": {"iterations": [1, 2, 3], "roll": [0.1, 0.2, 0.3],
                "pitch": [1.0, 1.1, 1.2], "yaw": [0.0, 0.0, 0.0]},
    "coefficients": {"iterations": [1, 2, 3], "cd": [0.40, 0.36, 0.352],
                     "cl": [-0.10, -0.12, -0.121]},
}
got = summarise(plots)
check("drag", got.get("drag"), 6.4)
check("lift", got.get("lift"), -2.5)
check("side", got.get("side"), 0.05)
check("pitch", got.get("pitch"), 1.2)
check("cd", got.get("cd"), 0.352)
check("cl", got.get("cl"), -0.121)
check("no cm when the solver wrote none", "cm" in got, False)
check("residuals are not a summary", "Ux" in got, False)

# A run with forces but no coefficient plot, which is what Run 10 was.
check("forces alone still summarise",
      summarise({"forces": {"drag": [1.0, 2.0]}}), {"drag": 2.0})

# Trailing nulls: a CSV row can end with an empty cell.
check("trailing blanks are skipped",
      summarise({"forces": {"drag": [1.0, 2.0, None, None]}}), {"drag": 2.0})

# Nothing at all must not raise.
check("empty", summarise({}), {})
check("none", summarise(None), {})

if fails:
    print("summarise: FAILED")
    for f in fails:
        print("  " + f)
    sys.exit(1)
print("summarise: 11 checks, reads what export_plots writes")
