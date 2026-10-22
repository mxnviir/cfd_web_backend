"""Run the worker's plot-export logic against a real completed SimScale run.

Imports the functions out of simscale_job.py by source-slicing, so what is
tested is the code that ships, not a copy of it.
"""
import re, sys, types, json, pathlib

# The worker moved to services/simscale-job in the queue-mode rewrite. This
# still pointed at "docker jobs", which has not existed for some time, so the
# test raised FileNotFoundError on import and nobody noticed.
SRC = pathlib.Path(pathlib.Path(__file__).resolve().parents[1] / "services" / "simscale-job" / "simscale_job.py")
text = SRC.read_text(encoding="utf-8")

start = text.index("PLOT_POINTS = 250")
end = text.index("def get_solution_field_url")
snippet = text[start:end]

env = {}
key = re.search(r'SIMSCALE_API_KEY=(.+)', pathlib.Path(
    pathlib.Path(__file__).resolve().parents[1] / ".env.deploy").read_text()).group(1).strip()

mod = types.ModuleType("plots")
import requests, logging
logging.basicConfig(level=logging.WARNING)
mod.__dict__.update({
    "requests": requests,
    "log": logging.getLogger("t"),
    "SIMSCALE_API_BASE": "https://api.simscale.com/v0",
    "SIMSCALE_PROJECT_ID": "3955117048594207313",
    "SIMSCALE_API_KEY": key,
})
exec(compile(snippet, "simscale_job.py", "exec"), mod.__dict__)

SIM, RUN = "aa4f49b9-4e78-484e-b2a5-266440438b65", "376ccaaf-f27e-4e35-983a-28edf29b024e"
out = mod.export_plots(SIM, RUN)

assert out, "no plots returned"
res, forces = out.get("residuals"), out.get("forces")
assert res and forces, f"missing section: {list(out)}"

assert len(res["iterations"]) == 250, len(res["iterations"])
assert set(res["series"]) >= {"Ux", "Uy", "Uz", "k", "omega", "p"}, list(res["series"])
for name, vals in res["series"].items():
    assert len(vals) == 250 and all(v is not None for v in vals), name
    assert vals[-1] < vals[0], f"{name} did not converge: {vals[0]} -> {vals[-1]}"

assert len(forces["drag"]) == len(forces["lift"]) == len(forces["iterations"])
assert all(v is not None for v in forces["drag"] + forces["lift"])

print(json.dumps({
    "residual_series": sorted(res["series"]),
    "iterations": [res["iterations"][0], res["iterations"][-1]],
    "p_residual": [res["series"]["p"][0], res["series"]["p"][-1]],
    "force_points": len(forces["iterations"]),
    "final_drag_N": round(forces["drag"][-1], 5),
    "final_lift_N": round(forces["lift"][-1], 5),
    "payload_bytes": len(json.dumps(out)),
}, indent=2))
print("ok - plot export matches the real run")

